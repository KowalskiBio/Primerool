//! `POST /idt/token` and `POST /idt/analyze` (Phase 8). Credentials are
//! received per-request and forwarded straight to IDT; never logged or
//! persisted server-side (see `crates/idt`'s own docs on why that crate
//! has no logging of its own at all).
//!
//! `/idt/analyze` merges IDT's raw results with a local `engine::analyze`
//! recompute, using whichever `engine` the request selects (`"strider"`
//! default, or `"primer3"` — see `crate::routes::select_backend`). When
//! `engine="strider"`, the response also carries suboptimal-dimer and
//! dot-bracket structure data straight from `thermo_core::thermo`
//! (`dimer_thermo_subopt`/`hairpin_thermo`) — the piece of Oligool's own
//! `_run_strider_analysis` (ViennaRNA-style structure enumeration) that a
//! plain `Primer3Backend` recompute has no equivalent of, since primer3's
//! `thal()` reports only a single MFE structure with no subopt path.


use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use engine::analyze::{analyze_pair, analyze_primer};
use engine::backend::ThermoParams;
use idt::{analyze as idt_analyze, extract_delta_g, get_token, AnalyzeParams, IdtError};
use thermo_core::thermo::{dimer_thermo_subopt, hairpin_thermo, DimerThermo};

use crate::error::AppError;
use crate::routes::select_backend;
use crate::state::AppState;

const NATIVE_SUBOPT_COUNT: usize = 5;

fn dimer_thermo_json(d: &DimerThermo) -> Value {
    json!({
        "tm": d.tm_celsius,
        "dh": d.dh,
        "ds": d.ds,
        "dg37": d.dg37,
        "n_pairs": d.n_pairs,
        "structure": d.structure,
    })
}

/// Strider-only enrichment: real suboptimal dimer alignments (self and
/// hetero) plus each primer's own hairpin structure/Tm, straight from
/// `thermo_core::thermo` — bypassing the generic `ThermoBackend` trait since
/// this data has no primer3 equivalent to report instead. `DimerResult`
/// (shared with `Primer3Backend`) does carry a `structure` field now, but
/// only ever the single MFE fold; the ranked suboptimal alignments this
/// route additionally returns have no home there. `None` if the sequence
/// doesn't fold under the requested salt conditions — a normal outcome
/// (e.g. no self-complementarity at all), not an error.
fn strider_enrichment(p1_seq: &str, p2_seq: &str, mv_conc: f64, mg_conc: f64, dntp_conc: f64, oligo_conc_um: f64) -> Value {
    let sodium_m = mv_conc / 1000.0;
    let magnesium_m = ((mg_conc - dntp_conc) / 1000.0).max(0.0);
    let strand_conc_m = oligo_conc_um * 1e-6;

    let hairpin_json = |seq: &str| match hairpin_thermo(seq, sodium_m, magnesium_m, 2) {
        Ok(h) => json!({"tm": h.tm_celsius, "dh": h.dh, "ds": h.ds, "dg37": h.dg37, "n_pairs": h.n_pairs, "structure": h.structure}),
        Err(_) => Value::Null,
    };
    let subopt_json = |seq1: &str, seq2: Option<&str>| -> Vec<Value> {
        dimer_thermo_subopt(seq1, seq2, NATIVE_SUBOPT_COUNT, sodium_m, magnesium_m, strand_conc_m, 0).iter().map(dimer_thermo_json).collect()
    };

    json!({
        "m1_hairpin": hairpin_json(p1_seq),
        "m2_hairpin": hairpin_json(p2_seq),
        "m1_self_dimer_subopt": subopt_json(p1_seq, None),
        "m2_self_dimer_subopt": subopt_json(p2_seq, None),
        "hetero_dimer_subopt": subopt_json(p1_seq, Some(p2_seq)),
    })
}

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
    pub engine: String,
}

impl Default for IdtAnalyzeRequest {
    fn default() -> Self {
        Self { p1_seq: String::new(), p2_seq: String::new(), token: String::new(), mv_conc: 50.0, mg_conc: 10.0, dntp_conc: 0.8, oligo_conc: 0.25, idt_region: "eu".to_string(), engine: "strider".to_string() }
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
    let backend = select_backend(&req.engine);
    let m1_local = analyze_primer(backend.as_ref(), &req.p1_seq, thermo);
    let m2_local = analyze_primer(backend.as_ref(), &req.p2_seq, thermo);
    let pair_local = analyze_pair(backend.as_ref(), &req.p1_seq, &req.p2_seq, thermo);

    let strider = if !req.engine.eq_ignore_ascii_case("primer3") {
        Some(strider_enrichment(&req.p1_seq, &req.p2_seq, req.mv_conc, req.mg_conc, req.dntp_conc, req.oligo_conc))
    } else {
        None
    };
    let strider_field = |key: &str| strider.as_ref().and_then(|v| v.get(key)).cloned().unwrap_or(Value::Null);

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
            "strider_hairpin": strider_field("m1_hairpin"),
            "strider_self_dimer_subopt": strider_field("m1_self_dimer_subopt"),
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
            "strider_hairpin": strider_field("m2_hairpin"),
            "strider_self_dimer_subopt": strider_field("m2_self_dimer_subopt"),
        },
        "pairwise": {
            "idt": {
                "hetero_dimer": idt_result.hetero,
                "hetero_dimer_delta_g": extract_delta_g(&idt_result.hetero),
            },
            "local": pair_local,
            "strider_hetero_dimer_subopt": strider_field("hetero_dimer_subopt"),
        },
    })))
}
