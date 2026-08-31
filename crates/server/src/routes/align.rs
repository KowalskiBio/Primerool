//! `POST /align`, matching Oligool's endpoint shape (`{sequences: [{id,
//! seq}]}` -> `{alignment: <raw FASTA text>}`) — the error envelope stays
//! Primerool's own `{"error": ...}` convention rather than Oligool's
//! FastAPI-style `{"detail": ...}`, for consistency with every other route
//! in this crate.

use align::{run_msa, SequenceInput};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;

#[derive(Debug, Deserialize)]
pub struct SequenceJson {
    pub id: String,
    pub seq: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct AlignRequest {
    pub sequences: Vec<SequenceJson>,
}

#[derive(Debug, Serialize)]
pub struct AlignResponse {
    pub alignment: String,
}

pub async fn align(Json(req): Json<AlignRequest>) -> Result<Json<Value>, AppError> {
    if req.sequences.len() < 2 {
        return Err(AppError::bad_request("At least two sequences are required for alignment."));
    }

    let inputs: Vec<SequenceInput> = req.sequences.into_iter().map(|s| SequenceInput { id: s.id, seq: s.seq }).collect();

    let alignment = run_msa(&inputs).await.map_err(|e| AppError::server_error(e.to_string()))?;

    Ok(Json(serde_json::to_value(AlignResponse { alignment }).unwrap()))
}
