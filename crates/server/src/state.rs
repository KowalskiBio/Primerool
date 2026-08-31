//! Shared application state: one `SequenceProvider` per data source
//! (Ensembl/NCBI), selected per-request by the `api_source` field exactly
//! like `main.py::_api()`, plus an HTTP client for the BLAST client.

use std::sync::Arc;

use providers::ensembl::EnsemblProvider;
use providers::ncbi::NcbiProvider;
use providers::SequenceProvider;

#[derive(Clone)]
pub struct AppState {
    pub ensembl: Arc<EnsemblProvider>,
    pub ncbi: Arc<NcbiProvider>,
    pub http_client: reqwest::Client,
}

impl Default for AppState {
    fn default() -> Self {
        Self { ensembl: Arc::new(EnsemblProvider::new()), ncbi: Arc::new(NcbiProvider::new()), http_client: reqwest::Client::new() }
    }
}

impl AppState {
    /// Direct port of `main.py::_api()`: NCBI when explicitly requested,
    /// Ensembl otherwise (including when `api_source` is absent).
    pub fn provider(&self, api_source: &str) -> Arc<dyn SequenceProvider> {
        if api_source == "ncbi" {
            self.ncbi.clone()
        } else {
            self.ensembl.clone()
        }
    }

    pub fn provider_label(&self, api_source: &str) -> &'static str {
        if api_source == "ncbi" {
            "NCBI"
        } else {
            "Ensembl"
        }
    }
}
