//! Blanket error type -> `{"error": ...}` JSON + status code, matching
//! `main.py`'s global `@app.errorhandler(Exception)` exactly: routes that
//! explicitly detect a condition (missing field, not-found, timeout)
//! return their own status code; anything else (an unhandled
//! `ProviderError`/`BlastError` bubbling up) becomes a 500 with
//! `f"Server error: {e}"` — ported here as `AppError::from` impls rather
//! than a catch-all panic handler, since axum handlers return `Result`
//! explicitly rather than relying on Python's exception propagation.

use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::json;

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub message: String,
}

impl AppError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, message: message.into() }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_FOUND, message: message.into() }
    }

    pub fn server_error(message: impl Into<String>) -> Self {
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, message: message.into() }
    }

    pub fn gateway_timeout(message: impl Into<String>) -> Self {
        Self { status: StatusCode::GATEWAY_TIMEOUT, message: message.into() }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl From<providers::ProviderError> for AppError {
    fn from(e: providers::ProviderError) -> Self {
        // Matches Python: an uncaught exception from api.search_gene/etc.
        // bubbles to the global handler as 500 "Server error: {e}".
        AppError::server_error(format!("Server error: {e}"))
    }
}

impl From<blast::BlastError> for AppError {
    fn from(e: blast::BlastError) -> Self {
        match e {
            blast::BlastError::TimedOut(_) => AppError::gateway_timeout("BLAST search timed out. Please try again."),
            other => AppError::server_error(format!("BLAST search failed: {other}")),
        }
    }
}
