//! Snapshot replay for the `/design_*` routes.
//!
//! The requests were originally captured against the legacy Python app;
//! the expected responses are snapshots of Strider's own output (picking
//! is a pure, deterministic function of its inputs), so any change in
//! what the engine picks shows up here. After an intended change, re-bless
//! with `BLESS=1 cargo test -p server --test design_golden` and review the
//! fixture diff.

use std::fs;
use std::path::Path;

use axum::body::Body;
use axum::http::Request;
use serde_json::Value;
use tower::ServiceExt;

fn fixtures_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/golden/fixtures")
}

struct Fixture {
    path: std::path::PathBuf,
    raw: Value,
    name: String,
    body: Value,
    expected_status: u16,
    expected_body: Value,
}

fn load_fixture(filename: &str) -> Fixture {
    let path = fixtures_dir().join(filename);
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {path:?}: {e}"));
    let parsed: Value = serde_json::from_str(&raw).unwrap_or_else(|e| panic!("invalid JSON in {path:?}: {e}"));
    Fixture {
        path: path.clone(),
        raw: parsed.clone(),
        name: parsed["name"].as_str().unwrap().to_string(),
        body: parsed["request"]["body"].clone(),
        expected_status: parsed["response"]["status"].as_u64().unwrap_or(200) as u16,
        expected_body: parsed["response"]["body"].clone(),
    }
}

async fn replay(app: &axum::Router, path: &str, body: &Value) -> (u16, Value) {
    let request = Request::builder().method("POST").uri(path).header("content-type", "application/json").body(Body::from(serde_json::to_vec(body).unwrap())).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body)
}

fn router() -> axum::Router {
    server::build_router(server::state::AppState::default())
}

/// Replays `filename`'s request against `path` and compares status + body
/// with the snapshot, or rewrites the snapshot when `BLESS=1`.
async fn check_snapshot(filename: &str, path: &str) {
    let f = load_fixture(filename);
    let (status, body) = replay(&router(), path, &f.body).await;
    if std::env::var("BLESS").as_deref() == Ok("1") {
        let mut raw = f.raw;
        raw["response"]["status"] = status.into();
        raw["response"]["body"] = body;
        fs::write(&f.path, serde_json::to_string_pretty(&raw).unwrap() + "\n").unwrap();
        return;
    }
    assert_eq!(status, f.expected_status, "{}: body={body}", f.name);
    assert_eq!(body, f.expected_body, "{}", f.name);
}

#[tokio::test]
async fn design_internal_classic_matches_snapshot() {
    check_snapshot("design_primers_internal_classic_tp53.json", "/design_primers").await;
}

#[tokio::test]
async fn design_flanking_matches_snapshot() {
    check_snapshot("design_primers_flanking_tp53.json", "/design_primers").await;
}

#[tokio::test]
async fn design_junction_matches_snapshot() {
    check_snapshot("design_primers_junction_tp53.json", "/design_primers").await;
}

#[tokio::test]
async fn design_probe_matches_snapshot() {
    check_snapshot("design_probe_taqman_tp53.json", "/design_probe").await;
}

#[tokio::test]
async fn design_from_sequence_independent_fallback_matches_snapshot() {
    check_snapshot("design_from_sequence_independent_fallback_no_template_tp53.json", "/design_from_sequence").await;
}

#[tokio::test]
async fn design_from_sequence_unified_matches_snapshot() {
    check_snapshot("design_from_sequence_unified_with_template_tp53.json", "/design_from_sequence").await;
}
