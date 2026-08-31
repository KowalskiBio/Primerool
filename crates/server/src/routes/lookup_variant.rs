//! `POST /lookup_variant` — a single known variant looked up directly by its
//! database id (an rsID, or another catalog id the source recognizes), via
//! `EnsemblProvider::lookup_variant_by_id` or `NcbiProvider::lookup_variant_by_id`
//! depending on `api_source`. Complements `/search_variants` (which scans a
//! region): this is for a user who already has a specific variant id in
//! hand and wants its location/alleles without picking a region first.

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::routes::DEFAULT_SPECIES;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct LookupVariantRequest {
    pub variant_id: String,
    pub species: String,
    pub api_source: String,
}

impl Default for LookupVariantRequest {
    fn default() -> Self {
        Self { variant_id: String::new(), species: String::new(), api_source: String::new() }
    }
}

pub async fn lookup_variant(State(state): State<AppState>, Json(req): Json<LookupVariantRequest>) -> Result<Json<Value>, AppError> {
    let variant_id = req.variant_id.trim();
    if variant_id.is_empty() {
        return Err(AppError::bad_request("variant_id is required"));
    }

    let species = {
        let s = req.species.trim();
        if s.is_empty() { DEFAULT_SPECIES } else { s }
    };
    let api_source = req.api_source.trim();

    let variant = if api_source == "ncbi" {
        state.ncbi.lookup_variant_by_id(variant_id, species).await?
    } else {
        state.ensembl.lookup_variant_by_id(variant_id, species).await?
    }
    .ok_or_else(|| AppError::not_found(format!("Variant {variant_id} not found in {} (species: {species})", state.provider_label(api_source))))?;

    Ok(Json(json!({ "variant": variant })))
}
