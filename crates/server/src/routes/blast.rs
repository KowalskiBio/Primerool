//! `POST /blast_sequence`, ported from `main.py::blast_sequence`.
//!
//! Kept as a single blocking-shaped request for now (matching the current
//! Flask behavior exactly) — the plan's recommended async job API
//! (`POST .../jobs` + `GET .../jobs/{id}`) is Phase 6 follow-up work, not
//! required for behavioral parity with the existing app.

use axum::extract::State;
use axum::Json;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct BlastSequenceRequest {
    pub sequence: String,
}

#[derive(Debug, Serialize)]
pub struct BlastHitJson {
    #[serde(flatten)]
    pub hit: blast::parse::BlastHit,
    pub ensembl_species: String,
}

#[derive(Debug, Serialize)]
pub struct BlastSequenceResponse {
    pub hits: Vec<BlastHitJson>,
}

/// Parses the input exactly like `main.py::blast_sequence`: if the
/// non-header content looks like an accession ID (`[A-Za-z]{1,4}_?[0-9]{5,}`,
/// optionally versioned), treat it as one; otherwise clean it as a raw
/// sequence and enforce the 20bp-50kb length bounds.
fn parse_blast_input(raw_seq: &str) -> Result<String, AppError> {
    let raw_seq = raw_seq.trim();
    let content_lines: Vec<&str> = raw_seq.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('>')).collect();
    let full_content = content_lines.join(" ");

    let accession_re = Regex::new(r"([A-Za-z]{1,4}_?[0-9]{5,}(?:\.[0-9]+)?)").unwrap();
    if let Some(m) = accession_re.find(&full_content) {
        // The regex itself requires 5+ digits to match, so `full_content`
        // trivially contains a digit whenever this branch is taken —
        // Python's separate `any(c.isdigit() ...)` check is redundant.
        return Ok(m.as_str().to_string());
    }

    let mut sequence: String = content_lines.join("").to_uppercase();
    sequence.retain(|c| "ACGTNRYSWKMBDHV".contains(c));

    if sequence.len() < 20 {
        return Err(AppError::bad_request("Sequence too short (need at least 20 bp)"));
    }
    if sequence.len() > 50_000 {
        return Err(AppError::bad_request("Sequence too long (max 50,000 bp)"));
    }
    Ok(sequence)
}

pub async fn blast_sequence(State(state): State<AppState>, Json(req): Json<BlastSequenceRequest>) -> Result<Json<BlastSequenceResponse>, AppError> {
    let sequence = parse_blast_input(&req.sequence)?;

    let hits = blast::run_blast(&state.http_client, &sequence).await?;

    if hits.is_empty() {
        return Err(AppError::not_found("No significant matches found."));
    }

    let hits = hits
        .into_iter()
        .map(|hit| {
            let ensembl_species = blast::parse::organism_to_ensembl_species(&hit.organism);
            BlastHitJson { hit, ensembl_species }
        })
        .collect();

    Ok(Json(BlastSequenceResponse { hits }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_blast_input_detects_accession() {
        assert_eq!(parse_blast_input("NM_001407269.1").unwrap(), "NM_001407269.1");
        assert_eq!(parse_blast_input(">header\nNM_001407269.1\n").unwrap(), "NM_001407269.1");
    }

    #[test]
    fn parse_blast_input_cleans_raw_sequence() {
        let seq = "A".repeat(25);
        let input = format!(">header\n{seq}\n");
        assert_eq!(parse_blast_input(&input).unwrap(), seq);
    }

    #[test]
    fn parse_blast_input_rejects_too_short() {
        assert!(parse_blast_input("ACGT").is_err());
    }

    #[test]
    fn parse_blast_input_rejects_too_long() {
        let seq = "A".repeat(50_001);
        assert!(parse_blast_input(&seq).is_err());
    }
}
