//! `POST /analyze_primer` — recomputes Tm/GC%/hairpin/homodimer for an
//! arbitrary sequence. Reinstates, in a simpler shape, the capability
//! `lib.rs`'s module docs once called "intentionally NOT ported": the
//! frontend's interactive primer/probe editing (dragging a primer's ends or
//! its whole span across the sequence view) produces an edited interval with
//! no backend-computed analysis of its own, and this is what recomputes one.
//! Reuses `engine::analyze::analyze_primer` exactly as `/idt/analyze` does,
//! with the same `ThermoParams` shape and defaults. `engine` picks the
//! backend via `select_backend` (`"strider"` or `"primer3"`), but an
//! omitted field means primer3 here, not Strider - this route predates the
//! engine choice and its original callers expect primer3 numbers.

use axum::Json;
use serde::Deserialize;

use engine::analyze::{analyze_primer, PrimerAnalysis};
use engine::backend::ThermoParams;

use crate::error::AppError;
use crate::routes::select_backend;

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct AnalyzePrimerRequest {
    pub sequence: String,
    pub mv_conc: f64,
    pub dv_conc: f64,
    pub dntp_conc: f64,
    pub dna_conc: f64,
    pub engine: String,
}

impl Default for AnalyzePrimerRequest {
    fn default() -> Self {
        Self { sequence: String::new(), mv_conc: 50.0, dv_conc: 10.0, dntp_conc: 0.8, dna_conc: 250.0, engine: "primer3".to_string() }
    }
}

pub async fn analyze_primer_route(Json(req): Json<AnalyzePrimerRequest>) -> Result<Json<PrimerAnalysis>, AppError> {
    if req.sequence.trim().is_empty() {
        return Err(AppError::bad_request("sequence is required."));
    }

    let params = ThermoParams { mv_conc: req.mv_conc, dv_conc: req.dv_conc, dntp_conc: req.dntp_conc, dna_conc: req.dna_conc };
    let backend = select_backend(&req.engine);
    let analysis = analyze_primer(backend.as_ref(), &req.sequence, params);
    Ok(Json(analysis))
}
