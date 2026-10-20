//! `POST /ncbi/test` + `GET /ncbi/test/:rid`: the Settings "Test NCBI"
//! button, same checks as Oligool's. Is E-utilities reachable, and does
//! it accept the API key? Does BLAST accept a tiny search, and has that
//! search left the queue a minute later? Split into two short requests:
//! NCBI allows one status check per search per minute, and a request
//! held open for that minute would hit the reverse proxy's timeout.

use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::AppState;

/// How long the frontend waits before asking about the test search -
/// NCBI's one-status-check-per-minute rule. Reported in the queue result.
const QUEUE_WAIT_SECS: u64 = 60;

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct NcbiTestRequest {
    /// The key as typed in Settings (empty = test without one).
    pub api_key: String,
}

#[derive(Debug, Serialize)]
pub struct NcbiCheck {
    pub ok: bool,
    pub seconds: f64,
    pub detail: String,
}

#[derive(Debug, Serialize)]
pub struct NcbiTestResponse {
    pub eutils: NcbiCheck,
    pub blast_submit: NcbiCheck,
    /// Present when the test search was accepted - pass it to
    /// `GET /ncbi/test/:rid` after `QUEUE_WAIT_SECS`.
    pub rid: Option<String>,
}

fn seconds(since: Instant) -> f64 {
    (since.elapsed().as_secs_f64() * 100.0).round() / 100.0
}

pub async fn ncbi_test(State(state): State<AppState>, Json(req): Json<NcbiTestRequest>) -> Json<NcbiTestResponse> {
    let api_key = Some(req.api_key.trim()).filter(|k| !k.is_empty());

    // Step 1: E-utilities, which also says whether the API key is accepted.
    let t0 = Instant::now();
    let mut params = vec![("db", "nucleotide"), ("retmode", "json"), ("tool", "primeroonline")];
    if let Some(key) = api_key {
        params.push(("api_key", key));
    }
    let eutils = match state.http_client.get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi").query(&params).timeout(Duration::from_secs(15)).send().await {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if status.as_u16() == 400 && body.to_lowercase().contains("api key") {
                NcbiCheck { ok: false, seconds: seconds(t0), detail: "NCBI rejected the API key.".into() }
            } else if status.is_success() {
                NcbiCheck { ok: true, seconds: seconds(t0), detail: if api_key.is_some() { "API key accepted." } else { "Reachable (no API key set)." }.into() }
            } else {
                NcbiCheck { ok: false, seconds: seconds(t0), detail: format!("HTTP {}", status.as_u16()) }
            }
        }
        Err(e) => NcbiCheck { ok: false, seconds: seconds(t0), detail: format!("Unreachable: {}", if e.is_timeout() { "timed out" } else { "connection failed" }) },
    };

    // Step 2: submit a tiny BLAST search.
    let t0 = Instant::now();
    let (blast_submit, rid) = match blast::submit_test_search(&state.http_client, api_key).await {
        Ok(rid) => (NcbiCheck { ok: true, seconds: seconds(t0), detail: format!("Job accepted (RID {rid}).") }, Some(rid)),
        Err(blast::BlastError::NoRequestId) => (NcbiCheck { ok: false, seconds: seconds(t0), detail: "NCBI returned no job ID.".into() }, None),
        Err(e) => (NcbiCheck { ok: false, seconds: seconds(t0), detail: format!("Submit failed: {e}") }, None),
    };

    Json(NcbiTestResponse { eutils, blast_submit, rid })
}

/// Asks NCBI once whether the test search from `/ncbi/test` has finished.
pub async fn ncbi_test_queue(State(state): State<AppState>, Path(rid): Path<String>) -> Result<Json<NcbiCheck>, AppError> {
    if rid.is_empty() || rid.len() > 40 || !rid.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(AppError::bad_request("Invalid RID"));
    }
    let seconds = QUEUE_WAIT_SECS as f64;
    let check = match blast::search_status(&state.http_client, &rid, None).await {
        Ok(Some(true)) => NcbiCheck { ok: true, seconds, detail: format!("Test search finished within {QUEUE_WAIT_SECS} s.") },
        Ok(Some(false)) => NcbiCheck { ok: false, seconds, detail: "NCBI reported the test search as failed.".into() },
        Ok(None) => NcbiCheck {
            ok: false,
            seconds,
            detail: format!("Still queued after {QUEUE_WAIT_SECS} s. The NCBI BLAST API queue is lingering; real searches will likely time out."),
        },
        Err(e) => NcbiCheck { ok: false, seconds, detail: format!("Status check failed: {e}") },
    };
    Ok(Json(check))
}
