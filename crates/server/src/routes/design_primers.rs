//! `POST /design_primers`, ported from `main.py`'s `mode`-dispatched
//! handler: exon-exon junction design (`mode=="internal"` +
//! `junction_pos` present), classic internal `SEQUENCE_TARGET` design
//! (`mode=="internal"` otherwise), or flanking/WGA design (any other
//! `mode`).

use axum::Json;
use primer3_ffi::design::DesignedOligo;
use serde::Deserialize;
use serde_json::{json, Value};

use engine::backend::ThermoParams;
use engine::design_flanking::design_primers_for_flanking_regions;
use engine::design_internal::design_primers_for_region;
use engine::design_junction::{design_junction_primer_pairs, JunctionError, JunctionParams};

use crate::error::AppError;
use crate::routes::{analysis_json_with, normalized_tuple, raw_tuple, select_backend};

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
    pub engine: String,
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
            engine: "primer3".to_string(),
        }
    }
}

fn clean_template(s: &str) -> String {
    s.trim().to_uppercase().chars().filter(|c| matches!(c, 'A' | 'C' | 'G' | 'T' | 'N')).collect()
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// `design_internal`'s minimal per-oligo shape (`main.py`'s classic-mode
/// dict literal): no `analyze_primer` re-analysis, no hairpin/homodimer —
/// just primer3's own raw sequence/Tm/GC%/position, with "gc" (not
/// "gc_percent") as the key name, matching that dict literal exactly.
fn internal_side_json(o: &DesignedOligo, is_right: bool) -> Value {
    json!({
        "sequence": o.sequence,
        "tm": round1(o.tm),
        "gc": round1(o.gc_percent),
        "position": raw_tuple([o.start, o.end], is_right),
    })
}

pub async fn design_primers(Json(req): Json<DesignPrimersRequest>) -> Result<Json<Value>, AppError> {
    // CPU-bound FFI work — see `design_probe.rs`'s identical comment on why
    // this runs via `spawn_blocking` rather than directly on the async
    // handler.
    tokio::task::spawn_blocking(move || design_primers_sync(&req))
        .await
        .map_err(|e| AppError::server_error(format!("Server error: design task panicked: {e}")))?
}

fn design_primers_sync(req: &DesignPrimersRequest) -> Result<Json<Value>, AppError> {
    let mode = if req.mode.is_empty() { "internal".to_string() } else { req.mode.clone() };
    let backend = select_backend(&req.engine);

    if mode == "internal" && req.junction_pos.is_some() {
        return design_junction_mode(req, backend.as_ref());
    }
    if mode == "internal" {
        return design_internal_mode(req);
    }
    design_flanking_mode(req, backend.as_ref())
}

fn design_internal_mode(req: &DesignPrimersRequest) -> Result<Json<Value>, AppError> {
    if req.sequence.is_empty() {
        return Err(AppError::bad_request("No sequence provided"));
    }
    let target_start = req.target_start.ok_or_else(|| AppError::bad_request("Invalid target positions"))?;
    let target_end = req.target_end.ok_or_else(|| AppError::bad_request("Invalid target positions"))?;

    if target_start < 0 || target_end > req.sequence.len() as i64 || target_start >= target_end {
        return Err(AppError::bad_request("Invalid target positions"));
    }

    let result = design_primers_for_region(&req.sequence, target_start as i32, target_end as i32).map_err(|e| AppError::server_error(format!("Server error: {e}")))?;

    if result.pairs.is_empty() {
        return Err(AppError::not_found("No primers found. Try different positions."));
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

    // `primer_junction.py::design_junction_primer_pairs` never raises for
    // any of these "soft" zero-candidate conditions — it returns a dict
    // with `num_pairs: 0` and its own (never-surfaced) `error` string, and
    // `main.py`'s route only checks `num_pairs == 0`, always responding
    // with the same generic 404 regardless of *which* internal reason
    // produced zero pairs. Rust models each reason as a distinct `Err`
    // variant instead of an always-`Ok`-with-empty-Vec return (the more
    // idiomatic shape here), so the three that correspond to Python's soft
    // paths are folded back into that same generic 404 below; only a
    // genuine `Primer3Error` (the FFI/C layer itself failing) matches
    // Python's actual `except Exception` 500 case.
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
        Err(e @ JunctionError::Primer3(_)) => {
            return Err(AppError::server_error(format!("Junction primer design failed: {e}")));
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

    let result = design_primers_for_flanking_regions(backend, upstream, downstream, None, ThermoParams::default()).map_err(|e| AppError::server_error(format!("Server error: {e}")))?;

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
                        (
                            "primer3",
                            json!({
                                "tm": o.primer3_tm,
                                "gc_percent": o.primer3_gc_percent,
                                // Preserves a real bug in `primer_flanking.py`: it
                                // reads `PRIMER_LEFT/RIGHT_{i}_SELF_ANY`/`_SELF_END`,
                                // but real primer3-py only ever populates the
                                // `_TH`-suffixed keys (`_SELF_ANY_TH`/`_SELF_END_TH`)
                                // — confirmed against a live install — so these two
                                // fields are always `null` in the real app's output,
                                // never the real self-complementarity score.
                                "self_any": Value::Null,
                                "self_end": Value::Null,
                                "hairpin_th": o.primer3_hairpin_th,
                            }),
                        ),
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
