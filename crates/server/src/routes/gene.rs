//! `POST /search_gene`, ported from `main.py::search_gene_route`.

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::routes::DEFAULT_SPECIES;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct SearchGeneRequest {
    pub gene_name: String,
    pub species: String,
    pub api_source: String,
}

impl Default for SearchGeneRequest {
    fn default() -> Self {
        Self { gene_name: String::new(), species: String::new(), api_source: "ensembl".to_string() }
    }
}

#[derive(Debug, Serialize)]
pub struct TranscriptJson {
    pub id: String,
    pub name: String,
    pub exon_count: usize,
    pub strand: String,
    pub is_canonical: bool,
}

#[derive(Debug, Serialize)]
pub struct SearchGeneResponse {
    pub gene_name: String,
    pub transcripts: Vec<TranscriptJson>,
}

pub async fn search_gene(State(state): State<AppState>, Json(req): Json<SearchGeneRequest>) -> Result<Json<SearchGeneResponse>, AppError> {
    let gene_name_raw = req.gene_name.trim().to_string();
    let species = {
        let s = req.species.trim();
        if s.is_empty() { DEFAULT_SPECIES.to_string() } else { s.to_string() }
    };
    let api_source = req.api_source;

    if gene_name_raw.is_empty() {
        return Err(AppError::bad_request("Please provide a gene name"));
    }

    let provider = state.provider(&api_source);

    // Try original case first (important for bacteria: dnaA, recA, etc.)
    let mut result = provider.search_gene(&gene_name_raw, &species).await?;

    // Fallback: try uppercase (standard for human/animal genes).
    if result.is_none() && gene_name_raw != gene_name_raw.to_uppercase() {
        result = provider.search_gene(&gene_name_raw.to_uppercase(), &species).await?;
    }

    let result = result.ok_or_else(|| {
        AppError::not_found(format!("Gene {} not found in {} (species: {})", gene_name_raw, state.provider_label(&api_source), species))
    })?;

    Ok(Json(SearchGeneResponse {
        gene_name: result.gene_name,
        transcripts: result
            .transcripts
            .into_iter()
            .map(|t| TranscriptJson { id: t.id, name: t.name, exon_count: t.exon_count, strand: t.strand.as_str().to_string(), is_canonical: t.is_canonical })
            .collect(),
    }))
}
