//! `POST /idt/token` and `POST /idt/analyze` (Phase 8). Credentials are
//! received per-request and forwarded straight to IDT; never logged or
//! persisted server-side (see `crates/idt`'s own docs on why that crate
//! has no logging of its own at all).
//!
//! `/idt/analyze` merges IDT's raw results with a local `engine::analyze`
//! recompute (`Primer3Backend`, matching every other route in this app) —
//! a deliberately simpler merge than Oligool's own `_run_strider_analysis`
//! (which layers on ViennaRNA dot-bracket structures and Strider ensemble/
//! competition thermodynamics Primerool has no equivalent of); see the
//! rewrite plan's Phase 8 notes.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use engine::analyze::{analyze_pair, analyze_primer};
use engine::backend::ThermoParams;
use engine::backend_primer3::Primer3Backend;
use idt::{analyze as idt_analyze, extract_delta_g, get_token, AnalyzeParams, IdtError};

use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct IdtTokenRequest {
    pub client_id: String,
    pub client_secret: String,
    pub username: String,
    pub password: String,
    pub idt_region: String,
}

impl Default for IdtTokenRequest {
    fn default() -> Self {
        Self { client_id: String::new(), client_secret: String::new(), username: String::new(), password: String::new(), idt_region: "eu".to_string() }
    }
}

pub async fn idt_token(State(state): State<AppState>, Json(req): Json<IdtTokenRequest>) -> Result<Json<Value>, AppError> {
    let token = get_token(&state.http_client, &req.client_id, &req.client_secret, &req.username, &req.password, &req.idt_region).await.map_err(|e| match e {
        // Forwards IDT's own HTTP status code, matching Oligool's
        // `raise HTTPException(status_code=response.status_code, ...)`.
        IdtError::AuthFailed { status, message } => AppError {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            message: format!("IDT Auth Error: {message}"),
        },
        IdtError::Http(err) => AppError::server_error(format!("Server error: {err}")),
    })?;
    Ok(Json(token))
}

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct IdtAnalyzeRequest {
    pub p1_seq: String,
    pub p2_seq: String,
    pub token: String,
    pub mv_conc: f64,
    pub mg_conc: f64,
    pub dntp_conc: f64,
    pub oligo_conc: f64,
    pub idt_region: String,
}

impl Default for IdtAnalyzeRequest {
    fn default() -> Self {
        Self { p1_seq: String::new(), p2_seq: String::new(), token: String::new(), mv_conc: 50.0, mg_conc: 10.0, dntp_conc: 0.8, oligo_conc: 0.25, idt_region: "eu".to_string() }
    }
}

pub async fn idt_analyze_route(State(state): State<AppState>, Json(req): Json<IdtAnalyzeRequest>) -> Result<Json<Value>, AppError> {
    if req.p1_seq.is_empty() || req.p2_seq.is_empty() {
        return Err(AppError::bad_request("Both p1_seq and p2_seq are required."));
    }
    if req.token.is_empty() {
        return Err(AppError::bad_request("A valid IDT access token is required."));
    }

    let params = AnalyzeParams { mv_conc: req.mv_conc, mg_conc: req.mg_conc, dntp_conc: req.dntp_conc, oligo_conc: req.oligo_conc, folding_temp: 25.0 };
    let idt_result = idt_analyze(&state.http_client, &req.token, &req.idt_region, &req.p1_seq, &req.p2_seq, &params).await;

    // Local recompute for comparison, using primer3's own salt-correction
    // formula (it already accounts for the Mg2+/dNTP interaction
    // internally — unlike Oligool's Strider-specific `effective_mg =
    // max(0, mg_conc - dntp_conc)` pre-subtraction, which is a detail of
    // *that* formula, not something primer3's `PRIMER_SALT_DIVALENT`/
    // `PRIMER_DNTP_CONC` pair needs replicated). `oligo_conc` is IDT's
    // µM convention; primer3's `dna_conc` is nM, hence the ×1000.
    let thermo = ThermoParams { mv_conc: req.mv_conc, dv_conc: req.mg_conc, dntp_conc: req.dntp_conc, dna_conc: req.oligo_conc * 1000.0 };
    let backend = Primer3Backend;
    let m1_local = analyze_primer(&backend, &req.p1_seq, thermo);
    let m2_local = analyze_primer(&backend, &req.p2_seq, thermo);
    let pair_local = analyze_pair(&backend, &req.p1_seq, &req.p2_seq, thermo);

    Ok(Json(json!({
        "m1": {
            "idt": {
                "hairpin": idt_result.m1_hairpin,
                "self_dimer": idt_result.m1_selfdimer,
                "analyze": idt_result.m1_analyze,
                "hairpin_delta_g": extract_delta_g(&idt_result.m1_hairpin),
                "self_dimer_delta_g": extract_delta_g(&idt_result.m1_selfdimer),
            },
            "local": m1_local,
        },
        "m2": {
            "idt": {
                "hairpin": idt_result.m2_hairpin,
                "self_dimer": idt_result.m2_selfdimer,
                "analyze": idt_result.m2_analyze,
                "hairpin_delta_g": extract_delta_g(&idt_result.m2_hairpin),
                "self_dimer_delta_g": extract_delta_g(&idt_result.m2_selfdimer),
            },
            "local": m2_local,
        },
        "pairwise": {
            "idt": {
                "hetero_dimer": idt_result.hetero,
                "hetero_dimer_delta_g": extract_delta_g(&idt_result.hetero),
            },
            "local": pair_local,
        },
    })))
}
