//! `POST /collect_homologs` + `GET /collect_homologs_status/:job_id`: one
//! CDS of a gene per species within a taxon (`NcbiProvider::
//! collect_homologs`), for a cross-species alignment. A background job
//! (`crate::jobs`) because keyless NCBI takes minutes for this.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use providers::ncbi::{Homolog, REQUEST_API_KEY};
use providers::species_map::ncbi_organism_term;

use crate::error::AppError;
use crate::state::AppState;

pub type HomologJobStore = crate::jobs::JobStore<Vec<Homolog>>;

const DEFAULT_MAX_SPECIES: usize = 25;
const MAX_SPECIES_CAP: usize = 60;

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct CollectHomologsRequest {
    pub gene: String,
    /// A taxon name ("Pseudomonas") or NCBI Taxonomy ID ("286").
    pub taxon: String,
    pub max_species: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct CollectHomologsStarted {
    pub job_id: String,
}

#[derive(Debug, Serialize)]
pub struct HomologJobStatus {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homologs: Option<Vec<Homolog>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Both values become E-utilities query terms, so anything that could
/// carry query syntax (brackets, quotes, boolean operators' parentheses)
/// is rejected.
fn valid_term(s: &str, extra: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

pub async fn collect_homologs(State(state): State<AppState>, Json(req): Json<CollectHomologsRequest>) -> Result<(StatusCode, Json<CollectHomologsStarted>), AppError> {
    let gene = req.gene.trim().to_string();
    let taxon = req.taxon.trim().to_string();
    if !valid_term(&gene, "-_.") {
        return Err(AppError::bad_request("Invalid gene name"));
    }
    if !valid_term(&taxon, " -_.") {
        return Err(AppError::bad_request("Invalid taxon (need a name like \"Pseudomonas\" or a taxonomy ID like 286)"));
    }
    let max_species = req.max_species.unwrap_or(DEFAULT_MAX_SPECIES).clamp(2, MAX_SPECIES_CAP);

    let job_id = state.homolog_jobs.insert();
    let task_job_id = job_id.clone();
    let store = state.homolog_jobs.clone();
    let ncbi = state.ncbi.clone();
    // The spawned task leaves this request's scope, so carry its NCBI key.
    let api_key = REQUEST_API_KEY.try_with(|k| k.clone()).ok().flatten();
    tokio::spawn(REQUEST_API_KEY.scope(api_key, async move {
        let outcome = match ncbi.collect_homologs(&gene, &ncbi_organism_term(&taxon), max_species).await {
            Ok(homologs) if homologs.is_empty() => Err(format!("No GenBank protein named '{gene}' with a genome location was found in {taxon}. Check the gene symbol and taxon spelling.")),
            Ok(homologs) => Ok(homologs),
            Err(e) => Err(e.to_string()),
        };
        store.finish(&task_job_id, outcome);
    }));

    Ok((StatusCode::ACCEPTED, Json(CollectHomologsStarted { job_id })))
}

pub async fn collect_homologs_status(State(state): State<AppState>, Path(job_id): Path<String>) -> Result<Json<HomologJobStatus>, AppError> {
    match state.homolog_jobs.status(&job_id) {
        None => Err(AppError::not_found("Unknown or expired homolog job id")),
        Some(None) => Ok(Json(HomologJobStatus { status: "running", homologs: None, error: None })),
        Some(Some(Ok(homologs))) => Ok(Json(HomologJobStatus { status: "done", homologs: Some(homologs), error: None })),
        Some(Some(Err(message))) => Ok(Json(HomologJobStatus { status: "error", homologs: None, error: Some(message) })),
    }
}
