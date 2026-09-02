//! `POST /analyze_structure` — the rich, dual-model (bulge-allowing vs.
//! no-bulge) hairpin/homodimer breakdown for ONE selected primer, with a
//! per-structure population fraction. Strider-only (see
//! `engine::structure_variant`'s module docs on why) and deliberately not
//! part of any bulk `/design_*` response — only ever called for the one
//! primer a `PrimerCard` has selected, same "expensive, on-demand" shape
//! as `/idt/analyze`'s native/Strider enrichment.

use axum::Json;
use serde::Deserialize;

use engine::backend::ThermoParams;
use engine::structure_variant::{analyze_structure, FullStructureAnalysis};

use crate::error::AppError;

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct AnalyzeStructureRequest {
    pub sequence: String,
    /// Absent for a self-dimer; present for a heterodimer against a
    /// different sequence.
    pub partner_sequence: Option<String>,
    pub mv_conc: f64,
    pub dv_conc: f64,
    pub dntp_conc: f64,
    pub dna_conc: f64,
}

impl Default for AnalyzeStructureRequest {
    fn default() -> Self {
        Self { sequence: String::new(), partner_sequence: None, mv_conc: 50.0, dv_conc: 1.5, dntp_conc: 0.2, dna_conc: 50.0 }
    }
}

pub async fn analyze_structure_route(Json(req): Json<AnalyzeStructureRequest>) -> Result<Json<FullStructureAnalysis>, AppError> {
    if req.sequence.trim().is_empty() {
        return Err(AppError::bad_request("sequence is required."));
    }

    let params = ThermoParams { mv_conc: req.mv_conc, dv_conc: req.dv_conc, dntp_conc: req.dntp_conc, dna_conc: req.dna_conc };
    // CPU-bound (several O(n^2) enumerations) — see `design_probe.rs`'s
    // identical comment on why this runs via `spawn_blocking`.
    let sequence = req.sequence;
    let partner = req.partner_sequence;
    let result = tokio::task::spawn_blocking(move || analyze_structure(&sequence, partner.as_deref(), params))
        .await
        .map_err(|e| AppError::server_error(format!("Server error: structure analysis task panicked: {e}")))?;
    Ok(Json(result))
}
