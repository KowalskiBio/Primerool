//! IDT OligoAnalyzer OAuth2 proxy, ported from Oligool's `/idt/token` and
//! `/idt/analyze` routes (Phase 8).
//!
//! Credentials are received per-request and forwarded to IDT; never written
//! to any server-side log, file, or store. Concurrency to IDT is limited to
//! 3 in-flight requests via `tokio::sync::Semaphore`, matching Oligool's
//! `asyncio.Semaphore(3)`.
//!
//! Deliberately does **not** depend on `engine`: this crate is a thin,
//! self-contained proxy over IDT's own API, returning IDT's raw results
//! (each call independently fault-tolerant, matching Python's `hit_idt`
//! catching exceptions per-endpoint rather than aborting the whole batch).
//! Merging these with a local `engine::analyze` recompute is the calling
//! server route's job (`crates/server/src/routes/idt.rs`) — keeps this
//! crate's dependency graph minimal and its contract focused on "talk to
//! IDT," not "combine with local thermodynamics."

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Semaphore;

#[derive(Debug, thiserror::Error)]
pub enum IdtError {
    /// Carries IDT's own HTTP status code (as a `u16`) alongside the
    /// extracted error detail, so the calling route can forward the exact
    /// status IDT returned — matching Oligool's own
    /// `raise HTTPException(status_code=response.status_code, ...)`.
    #[error("IDT auth error: {message}")]
    AuthFailed { status: u16, message: String },
    #[error(transparent)]
    Http(#[from] reqwest::Error),
}

pub fn idt_host(region: &str) -> &'static str {
    if region.eq_ignore_ascii_case("us") {
        "www.idtdna.com"
    } else {
        "eu.idtdna.com"
    }
}

/// `POST /IdentityServer/connect/token` — Resource Owner Password
/// Credentials grant. Returns IDT's own JSON response verbatim (an access
/// token + metadata) — the caller is responsible for not persisting it.
pub async fn get_token(client: &reqwest::Client, client_id: &str, client_secret: &str, username: &str, password: &str, region: &str) -> Result<Value, IdtError> {
    let host = idt_host(region);
    let url = format!("https://{host}/IdentityServer/connect/token");
    let params = [("grant_type", "password"), ("scope", "test"), ("username", username), ("password", password)];

    let response = client.post(&url).basic_auth(client_id, Some(client_secret)).form(&params).send().await?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);

    if !status.is_success() {
        let message = body
            .get("error_description")
            .or_else(|| body.get("error"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(IdtError::AuthFailed { status: status.as_u16(), message });
    }

    Ok(body)
}

#[derive(Debug, Clone, Copy)]
pub struct AnalyzeParams {
    pub mv_conc: f64,
    pub mg_conc: f64,
    pub dntp_conc: f64,
    pub oligo_conc: f64,
    /// Hairpin folding temperature — IDT's own web OligoAnalyzer defaults
    /// to 25°C; matched here so ΔG/Tm correspond to the values a user
    /// would see on IDT's own site for the same sequence.
    pub folding_temp: f64,
}

impl Default for AnalyzeParams {
    fn default() -> Self {
        Self { mv_conc: 50.0, mg_conc: 10.0, dntp_conc: 0.8, oligo_conc: 0.25, folding_temp: 25.0 }
    }
}

/// One raw call to an IDT OligoAnalyzer endpoint. Never propagates a
/// request error to the caller — mirrors Python's `hit_idt`, which catches
/// exceptions per-endpoint and returns `{"error": ...}` instead, so one
/// endpoint failing (or IDT rate-limiting one call) doesn't abort the
/// whole 7-call batch in [`analyze`].
async fn hit_idt(client: &reqwest::Client, token: &str, host: &str, endpoint: &str, seq1: &str, seq2: Option<&str>, params: &AnalyzeParams) -> Value {
    let url = format!("https://{host}/restapi/v1/OligoAnalyzer/{endpoint}");
    let mut query: Vec<(&str, &str)> = Vec::new();
    let mut body = json!({
        "NaConc": params.mv_conc,
        "MgConc": params.mg_conc,
        "dNTPsConc": params.dntp_conc,
        "OligoConc": params.oligo_conc,
        "NucleotideType": "DNA",
    });

    match endpoint {
        "Hairpin" => {
            body["Sequence"] = json!(seq1);
            body["FoldingTemp"] = json!(params.folding_temp);
        }
        "SelfDimer" | "HeteroDimer" => {
            query.push(("primary", seq1));
            if let Some(s2) = seq2 {
                query.push(("secondary", s2));
            }
        }
        "Analyze" => {
            body["Sequence"] = json!(seq1);
        }
        _ => {}
    }

    let request = client.post(&url).bearer_auth(token).query(&query).json(&body);
    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => return json!({ "error": e.to_string() }),
    };

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return json!({ "error": format!("IDT {endpoint} Error: {status} - {text}") });
    }

    match response.json::<Value>().await {
        Ok(v) => v,
        Err(e) => json!({ "error": e.to_string() }),
    }
}

/// Extracts a real IDT ΔG from a result object, dropping IDT's placeholder
/// values for unfoldable sequences (e.g. `+997.97` kcal/mol) — ported
/// directly from Oligool's `_extract_idt_delta_g`: real oligo hairpin/dimer
/// ΔG sits well inside `(-200, 50)`; anything outside that range is a
/// sentinel, not a measurement.
pub fn extract_delta_g(obj: &Value) -> Option<f64> {
    const KEYS: [&str; 7] = ["DeltaG", "deltaG", "deltag", "delta_g", "dG", "Energy", "energy"];
    for key in KEYS {
        if let Some(val) = obj.get(key) {
            if let Some(f) = val.as_f64() {
                return if f > -200.0 && f < 50.0 { Some(f) } else { None };
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct AnalyzeResult {
    pub m1_hairpin: Value,
    pub m1_selfdimer: Value,
    pub m1_analyze: Value,
    pub m2_hairpin: Value,
    pub m2_selfdimer: Value,
    pub m2_analyze: Value,
    pub hetero: Value,
}

/// Runs IDT's `Hairpin`/`SelfDimer`/`Analyze` for both `p1_seq` and
/// `p2_seq`, plus one `HeteroDimer` call between them — seven calls total,
/// all in parallel, concurrency capped at 3 in flight via a shared
/// `Semaphore` (matching Oligool's `asyncio.Semaphore(3)`, there to avoid
/// IDT flagging/throttling a burst of requests from one client).
pub async fn analyze(client: &reqwest::Client, token: &str, region: &str, p1_seq: &str, p2_seq: &str, params: &AnalyzeParams) -> AnalyzeResult {
    let host = idt_host(region);
    let semaphore = Arc::new(Semaphore::new(3));

    async fn bounded(semaphore: Arc<Semaphore>, client: &reqwest::Client, token: &str, host: &str, endpoint: &str, seq1: &str, seq2: Option<&str>, params: &AnalyzeParams) -> Value {
        let _permit = semaphore.acquire().await.expect("semaphore is never closed");
        hit_idt(client, token, host, endpoint, seq1, seq2, params).await
    }

    let (m1_hairpin, m1_selfdimer, m1_analyze, m2_hairpin, m2_selfdimer, m2_analyze, hetero) = tokio::join!(
        bounded(semaphore.clone(), client, token, host, "Hairpin", p1_seq, None, params),
        bounded(semaphore.clone(), client, token, host, "SelfDimer", p1_seq, None, params),
        bounded(semaphore.clone(), client, token, host, "Analyze", p1_seq, None, params),
        bounded(semaphore.clone(), client, token, host, "Hairpin", p2_seq, None, params),
        bounded(semaphore.clone(), client, token, host, "SelfDimer", p2_seq, None, params),
        bounded(semaphore.clone(), client, token, host, "Analyze", p2_seq, None, params),
        bounded(semaphore.clone(), client, token, host, "HeteroDimer", p1_seq, Some(p2_seq), params),
    );

    AnalyzeResult { m1_hairpin, m1_selfdimer, m1_analyze, m2_hairpin, m2_selfdimer, m2_analyze, hetero }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idt_host_maps_regions_correctly() {
        assert_eq!(idt_host("us"), "www.idtdna.com");
        assert_eq!(idt_host("US"), "www.idtdna.com");
        assert_eq!(idt_host("eu"), "eu.idtdna.com");
        assert_eq!(idt_host("anything-else"), "eu.idtdna.com");
    }

    #[test]
    fn extract_delta_g_accepts_plausible_values() {
        assert_eq!(extract_delta_g(&json!({"DeltaG": -5.2})), Some(-5.2));
        assert_eq!(extract_delta_g(&json!({"deltaG": 3.1})), Some(3.1));
    }

    #[test]
    fn extract_delta_g_rejects_idt_sentinel_values() {
        assert_eq!(extract_delta_g(&json!({"DeltaG": 997.97})), None);
        assert_eq!(extract_delta_g(&json!({"DeltaG": -997.97})), None);
    }

    #[test]
    fn extract_delta_g_returns_none_when_absent() {
        assert_eq!(extract_delta_g(&json!({"SomethingElse": 1.0})), None);
        assert_eq!(extract_delta_g(&json!({})), None);
    }
}
