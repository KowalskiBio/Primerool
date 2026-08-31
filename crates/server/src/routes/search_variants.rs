//! `POST /search_variants` — known SNPs/indels (dbSNP-backed) overlapping a
//! genomic region, via `EnsemblProvider::search_variants_in_region`. New
//! surface area, no Python original (see the primer-mode-revamp plan) —
//! Ensembl-only per the locked-in product decision, so this always uses
//! `state.ensembl` directly rather than going through `state.provider()`'s
//! `api_source`-dispatch (NCBI has no variant-search capability).

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::routes::DEFAULT_SPECIES;
use crate::state::AppState;

const MAX_REGION_LEN: u64 = 50_000;

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct SearchVariantsRequest {
    pub chrom: String,
    pub species: String,
    /// 1-based inclusive genomic.
    pub start: u64,
    pub end: u64,
}

impl Default for SearchVariantsRequest {
    fn default() -> Self {
        Self { chrom: String::new(), species: String::new(), start: 0, end: 0 }
    }
}

pub async fn search_variants(State(state): State<AppState>, Json(req): Json<SearchVariantsRequest>) -> Result<Json<Value>, AppError> {
    let chrom = req.chrom.trim();
    if chrom.is_empty() {
        return Err(AppError::bad_request("chrom is required"));
    }
    if req.end < req.start {
        return Err(AppError::bad_request("end must be >= start"));
    }
    if req.end - req.start > MAX_REGION_LEN {
        return Err(AppError::bad_request(format!("region too large (max {MAX_REGION_LEN} bp)")));
    }

    let species = {
        let s = req.species.trim();
        if s.is_empty() { DEFAULT_SPECIES } else { s }
    };

    let hits = state.ensembl.search_variants_in_region(chrom, req.start, req.end, species).await?;

    Ok(Json(json!({ "variants": hits })))
}
