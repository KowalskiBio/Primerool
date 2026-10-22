//! `POST /fetch_nucleotide`: one NCBI nucleotide record (or a range of it)
//! by accession - a sequence to align that isn't pasted, e.g. a new
//! reference for the alignment's query row.

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use providers::ProviderError;

use crate::error::AppError;
use crate::state::AppState;

/// Longest record (or range) fetched: far past any gene, short of a genome.
const MAX_LEN: u64 = 200_000;

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct FetchNucleotideRequest {
    /// `CP151816.1`, or a 1-based inclusive range of it,
    /// `CP151816.1:5733700-5735400` (start > end reads the minus strand).
    pub accession: String,
}

#[derive(Debug, Serialize)]
pub struct FetchNucleotideResponse {
    /// The accession (with its range), as the record's name.
    pub id: String,
    pub title: String,
    pub sequence: String,
}

/// `ACC` or `ACC:start-end` to the accession, the range in ascending
/// order, and whether it's read off the minus strand.
fn parse_accession(input: &str) -> Option<(String, Option<(u64, u64)>, bool)> {
    let input = input.trim();
    let (acc, range) = match input.split_once(':') {
        Some((acc, range)) => (acc.trim(), Some(range.trim())),
        None => (input, None),
    };
    if acc.is_empty() || acc.len() > 40 || !acc.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.') {
        return None;
    }
    let Some(range) = range else { return Some((acc.to_string(), None, false)) };
    let (a, b) = range.split_once('-')?;
    let (a, b): (u64, u64) = (a.trim().replace(',', "").parse().ok()?, b.trim().replace(',', "").parse().ok()?);
    if a == 0 || b == 0 {
        return None;
    }
    Some((acc.to_string(), Some((a.min(b), a.max(b))), a > b))
}

pub async fn fetch_nucleotide(State(state): State<AppState>, Json(req): Json<FetchNucleotideRequest>) -> Result<Json<FetchNucleotideResponse>, AppError> {
    let Some((acc, range, minus)) = parse_accession(&req.accession) else {
        return Err(AppError::bad_request("Give an NCBI nucleotide accession, like CP151816.1, or a range of one, like CP151816.1:5733700-5735400."));
    };
    match state.ncbi.fetch_nucleotide(&acc, range, minus, MAX_LEN).await {
        Ok(Some((title, sequence))) => Ok(Json(FetchNucleotideResponse { id: req.accession.trim().to_string(), title, sequence })),
        Ok(None) => Err(AppError::not_found(format!("NCBI has no nucleotide record {acc}."))),
        // A range past the record's end, or a record too long to align.
        Err(ProviderError::Failed(message)) => Err(AppError::bad_request(message)),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_accession;

    #[test]
    fn reads_accessions_and_ranges() {
        assert_eq!(parse_accession(" CP151816.1 "), Some(("CP151816.1".into(), None, false)));
        assert_eq!(parse_accession("CP151816.1:100-2,000"), Some(("CP151816.1".into(), Some((100, 2000)), false)));
        assert_eq!(parse_accession("NC_000001.11:2000-100"), Some(("NC_000001.11".into(), Some((100, 2000)), true)));
        assert_eq!(parse_accession("CP1:0-5"), None);
        assert_eq!(parse_accession("CP1 AND x[orgn]"), None);
        assert_eq!(parse_accession("CP1:5"), None);
    }
}
