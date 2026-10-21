//! `POST /design_conserved` — primer design over a conserved region of a
//! multi-sequence alignment (Phase 7's `engine::conserved`). Not a port of
//! any Python or Oligool route; new surface area, so the wire shape is
//! this rewrite's own design rather than something to match against a
//! reference implementation.
//!
//! Two modes, selected by whether `target_start`/`target_end` are both
//! present: single-oligo scan (`mode: "scan"`) when absent, LEFT/RIGHT
//! pair design (`mode: "pairs"`, primers flanking the target) when present
//! — mirrors `design_internal::design_pairs_via_picker`'s own
//! target-flanking convention.

use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use engine::backend::ThermoParams;
use engine::backend_native::NativeBackend;
use engine::conserved::{design_pairs_between_windows, design_pairs_in_conserved_region, majority_consensus, parse_aligned_fasta, scan_conserved_region, ConservedError, ConservedOligo, ConservedPair, DegenerateOptions};
use engine::picker::{CandidateConstraints, GcRange, PenaltyWeights, SizeRange, TmRange};

use crate::error::AppError;

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct DesignConservedRequest {
    pub alignment: String,
    pub col_start: usize,
    pub col_end: usize,
    pub target_start: Option<usize>,
    pub target_end: Option<usize>,
    /// Pair mode over two alignment-column windows, `[start, end)` each:
    /// the forward primer inside `left_cols`, the reverse inside
    /// `right_cols`. Takes precedence over `target_start`/`target_end`.
    pub left_cols: Option<(usize, usize)>,
    pub right_cols: Option<(usize, usize)>,
    pub size_min: u32,
    pub size_opt: u32,
    pub size_max: u32,
    pub tm_min: f64,
    pub tm_opt: f64,
    pub tm_max: f64,
    pub gc_min: f64,
    pub gc_max: f64,
    pub product_size_min: usize,
    pub product_size_max: usize,
    pub num_return: usize,
    /// Widen primers to IUPAC-degenerate ones covering every sequence
    /// (their 3'-terminal 5 bases stay exact), up to `max_degeneracy`
    /// plain variants each.
    pub degenerate: bool,
    pub max_degeneracy: u64,
}

impl Default for DesignConservedRequest {
    fn default() -> Self {
        Self {
            alignment: String::new(),
            col_start: 0,
            col_end: 0,
            target_start: None,
            target_end: None,
            left_cols: None,
            right_cols: None,
            size_min: 18,
            size_opt: 20,
            size_max: 25,
            tm_min: 57.0,
            tm_opt: 62.0,
            tm_max: 67.0,
            gc_min: 40.0,
            gc_max: 60.0,
            product_size_min: 100,
            product_size_max: 1000,
            num_return: 5,
            degenerate: false,
            max_degeneracy: DegenerateOptions::default().max_degeneracy,
        }
    }
}

fn map_conserved_error(e: ConservedError) -> AppError {
    match e {
        ConservedError::Empty | ConservedError::InconsistentLength { .. } | ConservedError::RangeOutOfBounds { .. } => AppError::bad_request(e.to_string()),
        ConservedError::NoConsensus => AppError::not_found(e.to_string()),
    }
}

pub async fn design_conserved(Json(req): Json<DesignConservedRequest>) -> Result<Json<Value>, AppError> {
    let records = parse_aligned_fasta(&req.alignment);
    if records.len() < 2 {
        return Err(AppError::bad_request("Alignment must contain at least two records."));
    }

    let constraints = CandidateConstraints {
        size: SizeRange { min: req.size_min as usize, opt: req.size_opt as usize, max: req.size_max as usize },
        tm: TmRange { min: req.tm_min, opt: req.tm_opt, max: req.tm_max },
        gc: GcRange { min: req.gc_min, max: req.gc_max },
    };
    let thermo = ThermoParams::default();
    let degenerate = req.degenerate.then_some(DegenerateOptions { max_degeneracy: req.max_degeneracy.clamp(1, 256) });

    // CPU-bound candidate scanning/scoring — see `design_probe.rs`'s
    // identical comment on why this runs via `spawn_blocking`.
    tokio::task::spawn_blocking(move || {
        let backend = NativeBackend;

        let windows = match (req.left_cols, req.right_cols) {
            (Some(left), Some(right)) => {
                if left.0 >= left.1 || right.0 >= right.1 || left.1 > right.0 {
                    return Err(AppError::bad_request("The left window must end before the right window starts."));
                }
                Some((left, right))
            }
            _ => None,
        };

        let pairs = if let Some((left, right)) = windows {
            Some(design_pairs_between_windows(&backend, &records, left, right, &constraints, (req.product_size_min, req.product_size_max), thermo, req.num_return, degenerate).map_err(map_conserved_error)?)
        } else if let (Some(target_start), Some(target_end)) = (req.target_start, req.target_end) {
            Some(
                design_pairs_in_conserved_region(
                    &backend,
                    &records,
                    req.col_start,
                    req.col_end,
                    target_start,
                    target_end,
                    &constraints,
                    (req.product_size_min, req.product_size_max),
                    thermo,
                    req.num_return,
                    degenerate,
                )
                .map_err(map_conserved_error)?,
            )
        } else {
            None
        };

        if let Some(pairs) = pairs {
            if pairs.is_empty() {
                return Err(AppError::not_found(if windows.is_some() {
                    "No primer pairs found with the forward primer in the first window and the reverse in the second - try longer windows or a wider product size range."
                } else {
                    "No primer pairs found flanking the target within this conserved region."
                }));
            }

            let (from, to) = windows.map_or((req.col_start, req.col_end), |(left, right)| (left.0, right.1));
            let consensus = majority_consensus(&records, from, to).map_err(map_conserved_error)?;
            let pairs_json: Vec<Value> = pairs.iter().map(pair_json).collect();
            Ok(Json(json!({ "mode": "pairs", "consensus_length": consensus.len(), "pairs": pairs_json })))
        } else {
            let scored = scan_conserved_region(&backend, &records, req.col_start, req.col_end, &constraints, thermo, &PenaltyWeights::default(), req.num_return, degenerate).map_err(map_conserved_error)?;

            if scored.is_empty() {
                return Err(AppError::not_found("No candidates found in this conserved region satisfying the given constraints."));
            }

            let consensus = majority_consensus(&records, req.col_start, req.col_end).map_err(map_conserved_error)?;
            let candidates_json: Vec<Value> = scored
                .iter()
                .map(|o| {
                    let mut v = oligo_json(o);
                    let d = o.degenerate.as_ref();
                    v["hairpin"] = json!(d.and_then(|d| d.hairpin.as_ref()).unwrap_or(&o.oligo.hairpin));
                    v["self_dimer"] = json!(d.and_then(|d| d.self_dimer.as_ref()).unwrap_or(&o.oligo.self_dimer));
                    v
                })
                .collect();

            Ok(Json(json!({ "mode": "scan", "consensus_length": consensus.len(), "candidates": candidates_json })))
        }
    })
    .await
    .map_err(|e| AppError::server_error(format!("Server error: design task panicked: {e}")))?
}

/// One oligo's JSON: consensus offsets (`start`/`end`), the alignment
/// columns it spans, and how many sequences it matches. A degenerate oligo
/// reports its IUPAC `sequence` (`consensus_sequence` is the plain one it
/// was widened from, `tm` that one's Tm) with its variants' Tm/GC spread.
fn oligo_json(o: &ConservedOligo) -> Value {
    let d = o.degenerate.as_ref();
    json!({
        "sequence": d.map_or(&o.oligo.sequence, |d| &d.sequence),
        "consensus_sequence": o.oligo.sequence,
        "degeneracy": d.map_or(1, |d| d.degeneracy),
        "tm_min": d.map(|d| d.tm_range.0),
        "tm_max": d.map(|d| d.tm_range.1),
        "gc_min": d.map(|d| d.gc_range.0),
        "gc_max": d.map(|d| d.gc_range.1),
        "start": o.oligo.candidate.start,
        "end": o.oligo.candidate.end,
        "col_start": o.columns.0,
        "col_end": o.columns.1,
        "tm": o.oligo.tm,
        "gc_percent": o.oligo.gc_percent,
        "penalty": o.oligo.penalty,
        "coverage": o.coverage,
    })
}

fn pair_json(p: &ConservedPair) -> Value {
    json!({
        "left": oligo_json(&p.left),
        "right": oligo_json(&p.right),
        "product_size": p.pair.product_size,
        "heterodimer": p.pair.heterodimer,
        "penalty": p.pair.penalty,
    })
}
