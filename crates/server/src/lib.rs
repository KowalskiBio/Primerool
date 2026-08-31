//! axum HTTP/JSON server.
//!
//! Contains no business logic — routing, request validation, and response
//! shaping only, delegating to `engine`/`providers`/`blast`/`align`/`idt`.
//! This is deliberate (see the rewrite plan's guiding architecture
//! decisions): it's what keeps a future live-rescoring layer additive, and
//! it's what makes this crate embeddable by Tauri (desktop) while also
//! being independently deployable as a headless VM binary (`main.rs`).
//!
//! **Status**: `/search_gene`, `/get_sequence`, `/blast_sequence`,
//! `/design_primers`, `/design_from_sequence`, `/design_probe` are all
//! wired and golden-fixture-tested (`tests/golden.rs`, `tests/design_golden.rs`).
//! `/align` and `/design_conserved` (Phase 7), `/idt/token`+`/idt/analyze`
//! (Phase 8), and `/search_variants`+`/design_arms` (the SNP/ARMS-PCR primer
//! mode) are wired but not golden-fixture-tested (there's no Python
//! original to capture a fixture from — these are new surface area, see
//! the plan). The React frontend (Phase 6c) is served as
//! static files at `/` via `tower-http::ServeDir` — a fallback service, so
//! every API route above still takes precedence over it. `GET /_health` is
//! a minimal placeholder/health route independent of whether a frontend
//! build exists at all (a fresh VM checkout before `npm run build`, or a
//! Tauri build pointed at a missing `frontendDist`, would otherwise just
//! 404 at `/` with no diagnostic).
//!
//! `/design_manual_primer` was intentionally NOT ported — confirmed unused
//! by the current frontend, dropped per the rewrite plan's locked-in
//! decision. `/analyze_manual_primers` was dropped for the same reason at
//! the time, but the underlying need came back once the frontend grew
//! interactive primer/probe editing (dragging a primer's ends or its whole
//! span across the sequence view): `POST /analyze_primer` reinstates just
//! the Tm/GC/hairpin/homodimer recompute, in a simpler shape than the
//! original route.

pub mod error;
pub mod routes;
pub mod state;

use axum::response::Html;
use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

async fn health() -> Html<&'static str> {
    Html(concat!(
        "<!doctype html><html><head><title>Primerool</title></head><body style=\"font-family:sans-serif\">",
        "<h1>Primerool server is running</h1><p>version ",
        env!("CARGO_PKG_VERSION"),
        "</p></body></html>"
    ))
}

/// Directory the built React frontend (`frontend/dist`, after `npm
/// run build`) is served from. Overridable via `PRIMEROOL_FRONTEND_DIST`
/// for deployments where the binary and the frontend build don't share a
/// working directory (Phase 9's VM deployment, an installed Tauri bundle).
fn frontend_dist_dir() -> String {
    std::env::var("PRIMEROOL_FRONTEND_DIST").unwrap_or_else(|_| "frontend/dist".to_string())
}

pub fn build_router(state: state::AppState) -> Router {
    Router::new()
        .route("/_health", get(health))
        .route("/search_gene", post(routes::gene::search_gene))
        .route("/get_sequence", post(routes::sequence::get_sequence))
        .route("/blast_sequence", post(routes::blast::blast_sequence))
        .route("/design_primers", post(routes::design_primers::design_primers))
        .route("/design_from_sequence", post(routes::design_from_sequence::design_from_sequence))
        .route("/design_probe", post(routes::design_probe::design_probe))
        .route("/search_variants", post(routes::search_variants::search_variants))
        .route("/design_arms", post(routes::design_arms::design_arms))
        .route("/align", post(routes::align::align))
        .route("/design_conserved", post(routes::design_conserved::design_conserved))
        .route("/idt/token", post(routes::idt::idt_token))
        .route("/idt/analyze", post(routes::idt::idt_analyze_route))
        .route("/analyze_primer", post(routes::analyze_primer::analyze_primer_route))
        // No app-level auth: access control for a VM deployment is
        // delegated to the network layer (e.g. a Cloudflare Tunnel),
        // matching Oligool's model and this rewrite's locked-in decision.
        .layer(CorsLayer::permissive())
        .with_state(state)
        // Anything not matched by a route above (including "/" itself,
        // which is deliberately not registered as its own route) falls
        // through to serving the built frontend — a real, hand-verified
        // 404 (not a panic) when `frontend_dist_dir()` doesn't exist yet.
        .fallback_service(ServeDir::new(frontend_dist_dir()))
}
