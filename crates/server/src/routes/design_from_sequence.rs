//! `POST /design_from_sequence`, ported from `main.py::design_from_sequence`.

use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use engine::design_from_sequence::{
    design_from_sequence as engine_design_from_sequence, AmpliconTarget, DesignFromSequenceError, FromSequenceOverrides, RegionPosition,
};

use crate::error::AppError;
use crate::routes::{analysis_json_with, raw_tuple, select_backend, AdvancedThermo};

fn clean_dna(s: &str) -> String {
    s.trim().to_uppercase().chars().filter(|c| matches!(c, 'A' | 'C' | 'G' | 'T' | 'N')).collect()
}

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct DesignFromSequenceRequest {
    pub forward_region: String,
    pub reverse_region: String,
    pub template_seq: String,
    pub fwd_pos: i32,
    pub rev_pos: i32,
    pub amplicon_target: Option<i32>,
    pub amplicon_deviation: Option<i32>,
    pub conditions: Option<FromSequenceConditions>,
    pub engine: String,
}

impl Default for DesignFromSequenceRequest {
    fn default() -> Self {
        Self {
            forward_region: String::new(),
            reverse_region: String::new(),
            template_seq: String::new(),
            fwd_pos: -1,
            rev_pos: -1,
            amplicon_target: None,
            amplicon_deviation: None,
            conditions: None,
            engine: "strider".to_string(),
        }
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct FromSequenceConditions {
    pub advanced: Option<AdvancedThermo>,
    pub tm_min: Option<f64>,
    pub tm_opt: Option<f64>,
    pub tm_max: Option<f64>,
    pub len_min: Option<i32>,
    pub len_opt: Option<i32>,
    pub len_max: Option<i32>,
    pub gc_min: Option<f64>,
    pub gc_max: Option<f64>,
    pub num_return: Option<i32>,
}

pub async fn design_from_sequence(Json(req): Json<DesignFromSequenceRequest>) -> Result<Json<Value>, AppError> {
    let fwd_region = clean_dna(&req.forward_region);
    let rev_region = clean_dna(&req.reverse_region);

    if fwd_region.len() < 18 {
        return Err(AppError::bad_request("Forward region too short (need at least 18 bp)"));
    }
    if rev_region.len() < 18 {
        return Err(AppError::bad_request("Reverse region too short (need at least 18 bp)"));
    }

    let template_seq = clean_dna(&req.template_seq);
    let cond = req.conditions.unwrap_or_default();
    let adv = cond.advanced.unwrap_or_default();
    let thermo = adv.thermo_params();

    let overrides = FromSequenceOverrides {
        tm_min: cond.tm_min,
        tm_opt: cond.tm_opt,
        tm_max: cond.tm_max,
        size_min: cond.len_min,
        size_opt: cond.len_opt,
        size_max: cond.len_max,
        gc_min: cond.gc_min,
        gc_max: cond.gc_max,
        num_return: cond.num_return,
        max_poly_x: adv.max_poly_x,
        max_ns: adv.max_ns,
    };

    let amplicon = req.amplicon_target.map(|target| AmpliconTarget { target, deviation: req.amplicon_deviation.unwrap_or(50) });

    let fwd = if req.fwd_pos != -1 { RegionPosition { pos: req.fwd_pos, len: fwd_region.len() as i32 } } else { RegionPosition::unspecified() };
    let rev = if req.rev_pos != -1 { RegionPosition { pos: req.rev_pos, len: rev_region.len() as i32 } } else { RegionPosition::unspecified() };
    let engine_name = req.engine.clone();

    // CPU-bound FFI work — see `design_probe.rs`'s identical comment on why
    // this runs via `spawn_blocking` rather than directly on the async
    // handler.
    tokio::task::spawn_blocking(move || {
        let backend = select_backend(&engine_name);
        let template = if template_seq.is_empty() { None } else { Some(template_seq.as_str()) };
        let is_unified = template.is_some();

        let result = engine_design_from_sequence(backend.as_ref(), &fwd_region, &rev_region, template, fwd, rev, amplicon, overrides, thermo).map_err(|e| match e {
            DesignFromSequenceError::NoPairsFound(msg) => AppError::not_found(msg),
            DesignFromSequenceError::Primer3(e) => AppError::server_error(format!("Server error: {e}")),
        })?;

        let forward_primers: Vec<Value> = result
            .forward_primers
            .iter()
            .map(|r| match r.coords {
                Some(iv) => analysis_json_with(&r.analysis, [("coords", json!(raw_tuple(iv, false)))]),
                None => serde_json::to_value(&r.analysis).unwrap(),
            })
            .collect();
        let reverse_primers: Vec<Value> = result
            .reverse_primers
            .iter()
            .map(|r| match r.coords {
                Some(iv) => analysis_json_with(&r.analysis, [("coords", json!(raw_tuple(iv, true)))]),
                None => serde_json::to_value(&r.analysis).unwrap(),
            })
            .collect();

        let best_pairs: Vec<Value> = result
            .best_pairs
            .iter()
            .map(|p| {
                let mut v = json!({
                    "forward_seq": p.forward_seq,
                    "forward_tm": p.forward_tm,
                    "reverse_seq": p.reverse_seq,
                    "reverse_tm": p.reverse_tm,
                    "tm_diff": p.tm_diff,
                    "heterodimer": p.heterodimer,
                    "score": p.score,
                });
                let obj = v.as_object_mut().unwrap();
                if let Some(iv) = p.forward_coords {
                    obj.insert("forward_coords".to_string(), json!(raw_tuple(iv, false)));
                }
                if let Some(iv) = p.reverse_coords {
                    obj.insert("reverse_coords".to_string(), json!(raw_tuple(iv, true)));
                }
                if is_unified {
                    // Only the unified path reports a real product size (from
                    // primer3's own pair record) — matches Python, which never
                    // includes a "product_size" key in the independent-fallback
                    // path's best_pairs dicts at all.
                    obj.insert("product_size".to_string(), json!(p.product_size));
                }
                v
            })
            .collect();

        Ok(Json(json!({
            "forward_primers": forward_primers,
            "reverse_primers": reverse_primers,
            "best_pairs": best_pairs,
        })))
    })
    .await
    .map_err(|e| AppError::server_error(format!("Server error: design task panicked: {e}")))?
}
