//! `POST /design_probe`, ported from `main.py::design_probe`.

use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use engine::design_probe::{design_probe as engine_design_probe, ProbeDesignOverrides};

use crate::error::AppError;
use crate::routes::{analysis_json_with, clean_seq, raw_tuple, select_backend, AdvancedThermo};

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct DesignProbeRequest {
    pub probe_region: String,
    pub conditions: Option<ProbeConditions>,
    pub engine: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct ProbeConditions {
    pub advanced: Option<AdvancedThermo>,
    pub probe_tm_min: Option<f64>,
    pub probe_tm_opt: Option<f64>,
    pub probe_tm_max: Option<f64>,
    pub probe_len_min: Option<i32>,
    pub probe_len_opt: Option<i32>,
    pub probe_len_max: Option<i32>,
    pub probe_gc_min: Option<f64>,
    pub probe_gc_max: Option<f64>,
    pub num_return: Option<i32>,
}

pub async fn design_probe(Json(req): Json<DesignProbeRequest>) -> Result<Json<Value>, AppError> {
    let probe_region = clean_seq(&req.probe_region);
    if probe_region.len() < 15 {
        return Err(AppError::bad_request("Probe region too short (need at least 15 bp)"));
    }

    let cond = req.conditions.unwrap_or_default();
    let thermo = cond.advanced.unwrap_or_default().thermo_params();
    let overrides = ProbeDesignOverrides {
        tm_min: cond.probe_tm_min,
        tm_opt: cond.probe_tm_opt,
        tm_max: cond.probe_tm_max,
        size_min: cond.probe_len_min,
        size_opt: cond.probe_len_opt,
        size_max: cond.probe_len_max,
        gc_min: cond.probe_gc_min,
        gc_max: cond.probe_gc_max,
        num_return: cond.num_return,
    };

    // `choose_primers()` (behind `engine_design_probe`) is CPU-bound,
    // synchronous FFI work — potentially hundreds of milliseconds (see
    // `engine::design_internal::MAX_POOL_FOR_PAIRING`'s doc comment for a
    // measured example of how expensive primer3 FFI calls can get). Running
    // it directly on an async handler would block that tokio worker thread
    // for the whole call, starving other requests; `spawn_blocking` moves
    // it onto tokio's blocking thread pool instead.
    let engine_name = req.engine.clone();
    tokio::task::spawn_blocking(move || {
        let backend = select_backend(&engine_name);
        let (probes, explain) = engine_design_probe(backend.as_ref(), &probe_region, thermo, overrides).map_err(|e| AppError::server_error(format!("Server error: {e}")))?;

        if probes.is_empty() {
            // Preserves a real bug in `main.py`: it reads
            // `probe_result.get("PRIMER_INTERNAL_OLIGO_EXPLAIN", "")`, but real
            // `primer3-py` output only ever has `PRIMER_INTERNAL_EXPLAIN`
            // (confirmed against a live install — `int_oligo = "INTERNAL"` in
            // `thermoanalysis.pyx`, never `"INTERNAL_OLIGO"`), so Python's
            // explain is always empty here. That's a pure error-message
            // regression with no data/behavior risk, so unlike every other
            // documented Python quirk in this rewrite (which are preserved
            // faithfully), this one is deliberately NOT reproduced — the real
            // explain text is used instead, since it can only make the 404
            // response more useful.
            let explain = explain.unwrap_or_default();
            return Err(AppError::not_found(format!("No probes found. {explain}")));
        }

        let probes: Vec<Value> = probes.into_iter().map(|p| analysis_json_with(&p.analysis, [("coords", json!(raw_tuple(p.interval, false)))])).collect();

        Ok(Json(json!({ "probes": probes })))
    })
    .await
    .map_err(|e| AppError::server_error(format!("Server error: design task panicked: {e}")))?
}
