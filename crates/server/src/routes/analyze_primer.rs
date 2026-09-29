//! `POST /analyze_primer` — recomputes Tm/GC%/hairpin/homodimer for an
//! arbitrary sequence. Reinstates, in a simpler shape, the capability
//! `lib.rs`'s module docs once called "intentionally NOT ported": the
//! frontend's interactive primer/probe editing (dragging a primer's ends or
//! its whole span across the sequence view) produces an edited interval with
//! no backend-computed analysis of its own, and this is what recomputes one.
//! Reuses `engine::analyze::analyze_primer` exactly as `/idt/analyze` does,
//! with the same `ThermoParams` shape and defaults, on Strider.

use axum::Json;
use serde::Deserialize;

use engine::analyze::{analyze_primer, PrimerAnalysis};
use engine::backend::ThermoParams;
use engine::backend_native::NativeBackend;

use crate::error::AppError;

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct AnalyzePrimerRequest {
    pub sequence: String,
    pub mv_conc: f64,
    pub dv_conc: f64,
    pub dntp_conc: f64,
    pub dna_conc: f64,
}

impl Default for AnalyzePrimerRequest {
    fn default() -> Self {
        let t = ThermoParams::default();
        Self { sequence: String::new(), mv_conc: t.mv_conc, dv_conc: t.dv_conc, dntp_conc: t.dntp_conc, dna_conc: t.dna_conc }
    }
}

pub async fn analyze_primer_route(Json(req): Json<AnalyzePrimerRequest>) -> Result<Json<PrimerAnalysis>, AppError> {
    if req.sequence.trim().is_empty() {
        return Err(AppError::bad_request("sequence is required."));
    }

    let params = ThermoParams { mv_conc: req.mv_conc, dv_conc: req.dv_conc, dntp_conc: req.dntp_conc, dna_conc: req.dna_conc };
    let analysis = analyze_primer(&NativeBackend, &req.sequence, params);
    Ok(Json(analysis))
}
