//! `POST /blast_hit_genes` and `POST /gene_aliases`: which gene a BLAST hit
//! actually lies in (from the hit record's feature table, not its title -
//! a RefSeqGene titled after one gene also spans its neighbours), and a
//! gene's alternative symbols, so the client can tell a hit on the target
//! gene - under any of its names - from a real off-target.

use axum::extract::State;
use axum::Json;
use providers::ncbi::AnnotatedGene;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::AppState;

/// Characters a GenBank/RefSeq accession (with version) can contain.
const ACCESSION_CHARS: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._";

fn api_key(raw: &str) -> Option<&str> {
    match raw.trim() {
        "" => None,
        key => Some(key),
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct HitGenesRequest {
    pub accession: String,
    /// 1-based inclusive span of the hit on the record, either order.
    pub from: i64,
    pub to: i64,
    pub api_key: String,
}

#[derive(Debug, Serialize)]
pub struct HitGenesResponse {
    /// `false` when the lookup failed upstream (try again later) - as
    /// opposed to `true` with no genes, "nothing annotated there".
    pub ok: bool,
    pub genes: Vec<AnnotatedGene>,
}

pub async fn blast_hit_genes(State(state): State<AppState>, Json(req): Json<HitGenesRequest>) -> Result<Json<HitGenesResponse>, AppError> {
    if req.accession.is_empty() || !req.accession.chars().all(|c| ACCESSION_CHARS.contains(c)) {
        return Err(AppError::bad_request("Invalid accession"));
    }
    let (start, stop) = (req.from.min(req.to), req.from.max(req.to));
    if start < 1 || stop - start > 10_000 {
        return Err(AppError::bad_request("Invalid hit coordinates"));
    }
    let genes = state.ncbi.fetch_genes_at(&req.accession, start, stop, api_key(&req.api_key)).await.unwrap_or(None);
    Ok(Json(HitGenesResponse { ok: genes.is_some(), genes: genes.unwrap_or_default() }))
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct GeneAliasesRequest {
    pub symbol: String,
    /// One of the app's Ensembl species slugs, or an organism name.
    pub organism: String,
    pub api_key: String,
}

#[derive(Debug, Serialize)]
pub struct GeneAliasesResponse {
    /// `false` when the lookup failed upstream (try again later).
    pub ok: bool,
    /// Official symbol first, then the other names; empty when unknown.
    pub aliases: Vec<String>,
}

pub async fn gene_aliases(State(state): State<AppState>, Json(req): Json<GeneAliasesRequest>) -> Result<Json<GeneAliasesResponse>, AppError> {
    let symbol = req.symbol.trim();
    if symbol.is_empty() || !symbol.chars().all(|c| c.is_ascii_alphanumeric() || "-._".contains(c)) {
        return Err(AppError::bad_request("Invalid gene symbol"));
    }
    let organism = blast::parse::ensembl_slug_to_organism(req.organism.trim()).unwrap_or_else(|| req.organism.trim().replace('_', " "));
    if organism.is_empty() || !organism.chars().all(|c| c.is_ascii_alphanumeric() || " -.".contains(c)) {
        return Err(AppError::bad_request("Invalid organism"));
    }
    Ok(Json(match state.ncbi.gene_aliases(symbol, &organism, api_key(&req.api_key)).await {
        Ok(aliases) => GeneAliasesResponse { ok: true, aliases },
        Err(_) => GeneAliasesResponse { ok: false, aliases: Vec::new() },
    }))
}
