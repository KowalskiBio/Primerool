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
use engine::backend_primer3::Primer3Backend;
use engine::conserved::{design_pairs_in_conserved_region, majority_consensus, parse_aligned_fasta, scan_conserved_region, ConservedError};
use engine::picker::{CandidateConstraints, GcRange, PenaltyWeights, SizeRange, TmRange};
use engine::ThermoBackend;

use crate::error::AppError;

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct DesignConservedRequest {
    pub alignment: String,
    pub col_start: usize,
    pub col_end: usize,
    pub target_start: Option<usize>,
    pub target_end: Option<usize>,
    pub backend: String, // "strider" (default) or "primer3"
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
}

impl Default for DesignConservedRequest {
    fn default() -> Self {
        Self {
            alignment: String::new(),
            col_start: 0,
            col_end: 0,
            target_start: None,
            target_end: None,
            backend: "strider".to_string(),
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

    // CPU-bound work (candidate scanning/scoring, and for Primer3Backend an
    // FFI call per candidate) — see `design_probe.rs`'s identical comment
    // on why this runs via `spawn_blocking`.
    tokio::task::spawn_blocking(move || {
        let backend: Box<dyn ThermoBackend> = if req.backend.eq_ignore_ascii_case("primer3") { Box::new(Primer3Backend) } else { Box::new(NativeBackend) };

        if let (Some(target_start), Some(target_end)) = (req.target_start, req.target_end) {
            let pairs = design_pairs_in_conserved_region(
                backend.as_ref(),
                &records,
                req.col_start,
                req.col_end,
                target_start,
                target_end,
                &constraints,
                (req.product_size_min, req.product_size_max),
                thermo,
                req.num_return,
            )
            .map_err(map_conserved_error)?;

            if pairs.is_empty() {
                return Err(AppError::not_found("No primer pairs found flanking the target within this conserved region."));
            }

            let consensus = majority_consensus(&records, req.col_start, req.col_end).map_err(map_conserved_error)?;
            let pairs_json: Vec<Value> = pairs
                .iter()
                .map(|p| {
                    json!({
                        "left": { "sequence": p.left.candidate.sequence(&consensus), "start": p.left.candidate.start, "end": p.left.candidate.end, "tm": p.left.tm, "gc_percent": p.left.gc_percent, "penalty": p.left.penalty },
                        "right": { "sequence": p.right.candidate.sequence(&consensus), "start": p.right.candidate.start, "end": p.right.candidate.end, "tm": p.right.tm, "gc_percent": p.right.gc_percent, "penalty": p.right.penalty },
                        "product_size": p.product_size,
                        "heterodimer": p.heterodimer,
                        "penalty": p.penalty,
                    })
                })
                .collect();

            Ok(Json(json!({ "mode": "pairs", "consensus_length": consensus.len(), "pairs": pairs_json })))
        } else {
            let scored = scan_conserved_region(backend.as_ref(), &records, req.col_start, req.col_end, &constraints, thermo, &PenaltyWeights::default(), req.num_return).map_err(map_conserved_error)?;

            if scored.is_empty() {
                return Err(AppError::not_found("No candidates found in this conserved region satisfying the given constraints."));
            }

            let consensus = majority_consensus(&records, req.col_start, req.col_end).map_err(map_conserved_error)?;
            let candidates_json: Vec<Value> = scored
                .iter()
                .map(|sc| {
                    json!({
                        "sequence": sc.candidate.sequence(&consensus),
                        "start": sc.candidate.start,
                        "end": sc.candidate.end,
                        "tm": sc.tm,
                        "gc_percent": sc.gc_percent,
                        "hairpin": sc.hairpin,
                        "self_dimer": sc.self_dimer,
                        "penalty": sc.penalty,
                    })
                })
                .collect();

            Ok(Json(json!({ "mode": "scan", "consensus_length": consensus.len(), "candidates": candidates_json })))
        }
    })
    .await
    .map_err(|e| AppError::server_error(format!("Server error: design task panicked: {e}")))?
}
