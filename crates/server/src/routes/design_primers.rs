//! `POST /design_primers`, dispatched on `mode`: exon-exon junction design (`mode=="internal"` +
//! `junction_pos` present), classic internal `SEQUENCE_TARGET` design
//! (`mode=="internal"` otherwise), the best pairs anywhere in the sequence
//! (`mode=="general"`), or flanking/WGA design (any other `mode`).

use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use engine::backend::ThermoParams;
use engine::backend_native::NativeBackend;
use engine::analyze::{analyze_pair, analyze_primer};
use engine::design_flanking::design_primers_for_flanking_regions;
use engine::design_general::design_best_pairs;
use engine::design_internal::design_primers_for_region;
use engine::picker::ScoredCandidate;
use engine::design_junction::{design_junction_primer_pairs, JunctionError, JunctionParams};

use crate::error::AppError;
use crate::routes::{analysis_json_with, normalized_tuple, raw_tuple};

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct DesignPrimersRequest {
    pub mode: String,
    pub sequence: String,
    pub target_start: Option<i64>,
    pub target_end: Option<i64>,
    pub junction_pos: Option<i64>,
    pub junction_overlap_min: i64,
    pub junction_overlap_max: i64,
    pub amplicon_min: i64,
    pub amplicon_max: i64,
    pub junction_left_pad: i64,
    pub junction_right_pad: i64,
    pub junction_max_candidates: i64,
    pub upstream_seq: Option<String>,
    pub downstream_seq: Option<String>,
    /// Flanking/WGA mode only: caps primer search to the last/first N bases
    /// of `upstream_seq`/`downstream_seq` (the bases nearest the target),
    /// instead of the full flank. `None`/absent uses the full flank.
    pub flank_window: Option<i64>,
}

impl Default for DesignPrimersRequest {
    fn default() -> Self {
        Self {
            mode: "internal".to_string(),
            sequence: String::new(),
            target_start: None,
            target_end: None,
            junction_pos: None,
            junction_overlap_min: 6,
            junction_overlap_max: 12,
            amplicon_min: 80,
            amplicon_max: 220,
            junction_left_pad: 250,
            junction_right_pad: 400,
            junction_max_candidates: 25,
            upstream_seq: None,
            downstream_seq: None,
            flank_window: None,
        }
    }
}

fn clean_template(s: &str) -> String {
    s.trim().to_uppercase().chars().filter(|c| matches!(c, 'A' | 'C' | 'G' | 'T' | 'N')).collect()
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// `design_internal`'s minimal per-oligo shape: sequence/Tm/GC%/position,
/// with "gc" (not "gc_percent") as the key name.
fn internal_side_json(o: &ScoredCandidate, is_right: bool) -> Value {
    json!({
        "sequence": o.sequence,
        "tm": round1(o.tm),
        "gc": round1(o.gc_percent),
        "position": raw_tuple([o.candidate.start as i32, o.candidate.end as i32], is_right),
    })
}

pub async fn design_primers(Json(req): Json<DesignPrimersRequest>) -> Result<Json<Value>, AppError> {
    // CPU-bound design work — see `design_probe.rs`'s identical comment on why
    // this runs via `spawn_blocking` rather than directly on the async
    // handler.
    tokio::task::spawn_blocking(move || design_primers_sync(&req))
        .await
        .map_err(|e| AppError::server_error(format!("Server error: design task panicked: {e}")))?
}

fn design_primers_sync(req: &DesignPrimersRequest) -> Result<Json<Value>, AppError> {
    let mode = if req.mode.is_empty() { "internal".to_string() } else { req.mode.clone() };
    let backend = NativeBackend;

    if mode == "internal" && req.junction_pos.is_some() {
        return design_junction_mode(req, &backend);
    }
    if mode == "internal" {
        return design_internal_mode(req, &backend);
    }
    if mode == "general" {
        return design_general_mode(req, &backend);
    }
    design_flanking_mode(req, &backend)
}

fn design_internal_mode(req: &DesignPrimersRequest, backend: &dyn engine::backend::ThermoBackend) -> Result<Json<Value>, AppError> {
    if req.sequence.is_empty() {
        return Err(AppError::bad_request("No sequence provided"));
    }
    let target_start = req.target_start.ok_or_else(|| AppError::bad_request("Invalid target positions"))?;
    let target_end = req.target_end.ok_or_else(|| AppError::bad_request("Invalid target positions"))?;

    if target_start < 0 || target_end > req.sequence.len() as i64 || target_start >= target_end {
        return Err(AppError::bad_request("Invalid target positions"));
    }

    let result = design_primers_for_region(backend, &req.sequence, target_start as usize, target_end as usize);

    if result.pairs.is_empty() {
        let explain = if result.left_explain.ends_with("ok 0") {
            format!("Left: {}", result.left_explain)
        } else if result.right_explain.ends_with("ok 0") {
            format!("Right: {}", result.right_explain)
        } else {
            format!("Pairs: {}", result.pair_explain)
        };
        return Err(AppError::not_found(format!("No primers found. Try different positions. ({explain})")));
    }

    let primer_pairs: Vec<Value> = result
        .pairs
        .iter()
        .enumerate()
        .map(|(i, p)| {
            json!({
                "pair_number": i + 1,
                "left": internal_side_json(&p.left, false),
                "right": internal_side_json(&p.right, true),
                "product_size": p.product_size,
            })
        })
        .collect();

    Ok(Json(json!({
        "mode": "internal",
        "num_pairs": primer_pairs.len(),
        "primers": primer_pairs,
    })))
}

/// The best pairs anywhere in `sequence`, no target needed. Each primer
/// carries the full QC (hairpin, self-dimer) and each pair its
/// heterodimer, in the junction mode's shape; `interval` is `[start, end)`
/// into `sequence`.
fn design_general_mode(req: &DesignPrimersRequest, backend: &dyn engine::backend::ThermoBackend) -> Result<Json<Value>, AppError> {
    let template = clean_template(&req.sequence);
    if template.is_empty() {
        return Err(AppError::bad_request("No sequence provided"));
    }
    let thermo = ThermoParams::default();
    let result = design_best_pairs(backend, &template, thermo);
    if result.pairs.is_empty() {
        return Err(AppError::not_found(format!("No primer pairs found in this sequence ({}).", result.explain)));
    }

    let pairs_json: Vec<Value> = result
        .pairs
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let side = |o: &ScoredCandidate| {
                let interval = [o.candidate.start as i32, o.candidate.end as i32];
                analysis_json_with(&analyze_primer(backend, &o.sequence, thermo), [("interval", json!(interval)), ("position", json!(normalized_tuple(interval)))])
            };
            json!({
                "pair_number": i + 1,
                "left": side(&p.left),
                "right": side(&p.right),
                "product_size": p.product_size,
                "pair_metrics": analyze_pair(backend, &p.left.sequence, &p.right.sequence, thermo),
            })
        })
        .collect();

    Ok(Json(json!({
        "mode": "general",
        "num_pairs": pairs_json.len(),
        "primers": pairs_json,
    })))
}

fn design_junction_mode(req: &DesignPrimersRequest, backend: &dyn engine::backend::ThermoBackend) -> Result<Json<Value>, AppError> {
    let template = clean_template(&req.sequence);
    if template.is_empty() {
        return Err(AppError::bad_request("No template sequence provided"));
    }

    let junction_pos = req.junction_pos.unwrap();
    if junction_pos <= 0 || junction_pos >= template.len() as i64 {
        return Err(AppError::bad_request("junction_pos out of range for provided sequence"));
    }

    let ov_min = req.junction_overlap_min.max(1);
    let ov_max = req.junction_overlap_max.max(ov_min);
    let left_pad = req.junction_left_pad.clamp(80, 800);
    let right_pad = req.junction_right_pad.clamp(120, 1200);
    let max_candidates = req.junction_max_candidates.clamp(5, 60);

    let params = JunctionParams {
        overlap_min: ov_min as i32,
        overlap_max: ov_max as i32,
        product_min: req.amplicon_min as i32,
        product_max: req.amplicon_max as i32,
        left_pad: left_pad as i32,
        right_pad: right_pad as i32,
        max_candidates: max_candidates as usize,
    };

    // Every zero-pair reason maps to the same generic 404.
    let pairs = match design_junction_primer_pairs(backend, &template, junction_pos as i32, &params, ThermoParams::default()) {
        Ok(pairs) => pairs,
        Err(JunctionError::EmptyTemplate) | Err(JunctionError::JunctionPosOutOfRange) => {
            // Unreachable in practice — the route already validated both
            // conditions above, exactly mirroring `main.py`'s own redundant
            // early guards ahead of calling into this function.
            return Err(AppError::not_found("No exon-exon junction primer pairs found. Try a different junction or relax constraints."));
        }
        Err(JunctionError::NoCandidatesInWindow) | Err(JunctionError::WindowTooSmallForRightPrimers) | Err(JunctionError::NoRightPrimersFound(_)) => {
            return Err(AppError::not_found("No exon-exon junction primer pairs found. Try a different junction or relax constraints."));
        }
    };

    if pairs.is_empty() {
        return Err(AppError::not_found("No exon-exon junction primer pairs found. Try a different junction or relax constraints."));
    }

    let pairs_json: Vec<Value> = pairs
        .iter()
        .enumerate()
        .map(|(i, p)| {
            json!({
                "pair_number": i + 1,
                "junction_pos": junction_pos,
                "junction_spanning": "left",
                "left": analysis_json_with(&p.left.analysis, [
                    ("interval", json!(p.left.interval)),
                    ("position", json!(normalized_tuple(p.left.interval))),
                ]),
                "right": analysis_json_with(&p.right.analysis, [
                    ("interval", json!(p.right.interval)),
                    ("position", json!(normalized_tuple(p.right.interval))),
                ]),
                "product_size": p.product_size,
                "pair_metrics": p.pair_metrics,
            })
        })
        .collect();

    Ok(Json(json!({
        "mode": "internal",
        "num_pairs": pairs_json.len(),
        "primers": { "pairs": pairs_json },
    })))
}

fn design_flanking_mode(req: &DesignPrimersRequest, backend: &dyn engine::backend::ThermoBackend) -> Result<Json<Value>, AppError> {
    let upstream = req.upstream_seq.as_deref().unwrap_or("");
    let downstream = req.downstream_seq.as_deref().unwrap_or("");
    if upstream.is_empty() || downstream.is_empty() {
        return Err(AppError::bad_request("No flanking sequences provided"));
    }

    let flank_window = req.flank_window.map(|w| w as i32);
    let result = design_primers_for_flanking_regions(backend, upstream, downstream, flank_window, ThermoParams::default());

    if result.forward.primers.is_empty() || result.reverse.primers.is_empty() {
        let mut details = Vec::new();
        if result.forward.primers.is_empty() {
            let explain = result.forward.explain.clone().unwrap_or_default();
            details.push(if explain.is_empty() { "Forward: no candidates".to_string() } else { format!("Forward: {explain}") });
        }
        if result.reverse.primers.is_empty() {
            let explain = result.reverse.explain.clone().unwrap_or_default();
            details.push(if explain.is_empty() { "Reverse: no candidates".to_string() } else { format!("Reverse: {explain}") });
        }
        return Err(AppError::not_found(format!("No primers found. {}", details.join(" | "))));
    }

    let side_json = |primers: &[engine::design_flanking::FlankingOligo], is_right: bool| -> Vec<Value> {
        primers
            .iter()
            .map(|o| {
                let position = normalized_tuple(o.interval);
                let position_raw = raw_tuple(o.interval, is_right);
                analysis_json_with(
                    &o.analysis,
                    [
                        ("interval", json!(o.interval)),
                        ("position", json!(position)),
                        ("position_raw", json!(position_raw)),
                    ],
                )
            })
            .collect()
    };

    Ok(Json(json!({
        "mode": "flanking",
        "primers": {
            "forward": {
                "num_returned": result.forward.primers.len(),
                "explain": result.forward.explain,
                "primers": side_json(&result.forward.primers, false),
            },
            "reverse": {
                "num_returned": result.reverse.primers.len(),
                "explain": result.reverse.explain,
                "primers": side_json(&result.reverse.primers, true),
            },
            "pair_metrics": result.pair_metrics,
        },
    })))
}
