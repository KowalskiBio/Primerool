//! `POST /search_gene`, ported from `main.py::search_gene_route`.

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use providers::{GeneMatch, Strand};

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
    /// What the user actually typed, so the UI can say e.g. "'csn2' is an
    /// alias of COPS2" when `matched_by` isn't `symbol`.
    pub query: String,
    pub matched_by: GeneMatch,
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
        AppError::not_found(if api_source == "ncbi" {
            let organism = match providers::species_map::taxid(&species) {
                Some(id) => format!("taxon {id}"),
                None => providers::species_map::ensembl_to_binomial_or_guess(&species),
            };
            format!(
                "No gene '{gene_name_raw}' found in NCBI for {organism} - neither NCBI Gene nor its annotated GenBank proteins have it. Check the spelling of the gene and organism, or BLAST the gene's sequence instead."
            )
        } else {
            format!(
                "Gene {} not found in {} (species: {}). Try the official gene symbol (e.g. 'casein' → CSN2) and check the selected organism — many genes (like caseins) are annotated in another species (e.g. Bos taurus).",
                gene_name_raw,
                state.provider_label(&api_source),
                species
            )
        })
    })?;

    Ok(Json(SearchGeneResponse::new(result, gene_name_raw)))
}

impl SearchGeneResponse {
    fn new(result: providers::GeneSearchResult, query: String) -> Self {
        Self {
            gene_name: result.gene_name,
            query,
            matched_by: result.matched_by,
            transcripts: result
                .transcripts
                .into_iter()
                .map(|t| TranscriptJson { id: t.id, name: t.name, exon_count: t.exon_count, strand: t.strand.as_str().to_string(), is_canonical: t.is_canonical })
                .collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct LoadBlastHitRequest {
    pub accession: String,
    /// The hit's subject span as BLAST reports it (1-based); `hit_from >
    /// hit_to` means the query matched the record's minus strand.
    pub hit_from: u64,
    pub hit_to: u64,
    /// What to call the loaded gene - the hit's gene symbol, or else its
    /// accession.
    pub gene_name: String,
    #[serde(default)]
    pub organism: String,
}

/// Longest span `/load_blast_hit` loads - `/blast_sequence`'s own query cap.
const MAX_HIT_SPAN: u64 = 50_000;

/// `POST /load_blast_hit`: loads the stretch of an NCBI nucleotide record
/// a BLAST hit covers as a gene (one single-region transcript), so a gene
/// with no NCBI Gene record can still be designed on. Same response shape
/// as `/search_gene`; the transcript lives in the NCBI provider, so the
/// caller continues with `api_source = "ncbi"`.
pub async fn load_blast_hit(State(state): State<AppState>, Json(req): Json<LoadBlastHitRequest>) -> Result<Json<SearchGeneResponse>, AppError> {
    let accession = req.accession.trim();
    if accession.is_empty() || accession.len() > 40 || !accession.chars().all(|c| c.is_ascii_alphanumeric() || "._".contains(c)) {
        return Err(AppError::bad_request("Invalid accession"));
    }
    let (start, end) = (req.hit_from.min(req.hit_to), req.hit_from.max(req.hit_to));
    if start == 0 || end - start + 1 > MAX_HIT_SPAN {
        return Err(AppError::bad_request("Invalid hit span"));
    }
    let strand = if req.hit_from > req.hit_to { Strand::Minus } else { Strand::Plus };
    let name = match req.gene_name.trim() {
        "" => accession,
        name => name,
    };
    let source = match req.organism.trim() {
        "" => String::new(),
        organism => format!("{organism}, "),
    };
    let label = format!("{name} (BLAST hit, {source}{accession}:{start}-{end})");
    let result = state.ncbi.load_region(name, accession, accession, start, end, strand, &label).await;
    Ok(Json(SearchGeneResponse::new(result, name.to_string())))
}
