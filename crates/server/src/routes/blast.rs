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
    /// The caller's own NCBI API key (configured in the frontend settings,
    /// stored only in their browser) — forwarded to NCBI BLAST and the
    /// E-utilities accession fast-path below to lift NCBI's anonymous
    /// rate limits. Empty when unset.
    pub api_key: String,
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
enum ParsedInput {
    Accession(String),
    Sequence(String),
}

fn parse_blast_input(raw_seq: &str) -> Result<ParsedInput, AppError> {
    let raw_seq = raw_seq.trim();
    let content_lines: Vec<&str> = raw_seq.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('>')).collect();
    let full_content = content_lines.join(" ");

    let accession_re = Regex::new(r"([A-Za-z]{1,4}_?[0-9]{5,}(?:\.[0-9]+)?)").unwrap();
    if let Some(m) = accession_re.find(&full_content) {
        // The regex itself requires 5+ digits to match, so `full_content`
        // trivially contains a digit whenever this branch is taken —
        // Python's separate `any(c.isdigit() ...)` check is redundant.
        return Ok(ParsedInput::Accession(m.as_str().to_string()));
    }

    let mut sequence: String = content_lines.join("").to_uppercase();
    sequence.retain(|c| "ACGTNRYSWKMBDHV".contains(c));

    if sequence.len() < 20 {
        return Err(AppError::bad_request("Sequence too short (need at least 20 bp)"));
    }
    if sequence.len() > 50_000 {
        return Err(AppError::bad_request("Sequence too long (max 50,000 bp)"));
    }
    Ok(ParsedInput::Sequence(sequence))
}

pub async fn blast_sequence(State(state): State<AppState>, Json(req): Json<BlastSequenceRequest>) -> Result<Json<BlastSequenceResponse>, AppError> {
    let (sequence, is_accession) = match parse_blast_input(&req.sequence)? {
        ParsedInput::Accession(a) => (a, true),
        ParsedInput::Sequence(s) => (s, false),
    };
    let api_key = match req.api_key.trim() {
        "" => None,
        key => Some(key),
    };

    // Fast path (ported from `main.py::blast_sequence`): resolve accession
    // IDs directly via NCBI E-utilities. Instant, and the only working
    // route for protein accessions (NP_, XP_, UniProt 'P' IDs) —
    // blastn/"nt" cannot handle those. On any failure, fall through to
    // the real BLAST run (old behavior).
    if is_accession {
        match state.ncbi.resolve_accession_with_key(&sequence, api_key).await {
            Ok(Some(res)) => {
                let ensembl_species = blast::parse::organism_to_ensembl_species(&res.organism);
                let hit = blast::parse::BlastHit {
                    organism: res.organism,
                    gene_symbol: res.gene_symbol,
                    accession: sequence.clone(),
                    title: if res.description.is_empty() { sequence.clone() } else { res.description },
                    evalue: None,
                    bit_score: None,
                    identity_pct: 100.0,
                    query_cover: 100.0,
                    query_from: 0,
                    query_to: 0,
                    hit_from: 0,
                    hit_to: 0,
                    query_len: 0,
                    direct: Some(true),
                };
                return Ok(Json(BlastSequenceResponse { hits: vec![BlastHitJson { hit, ensembl_species }] }));
            }
            Ok(None) => {}
            Err(e) => eprintln!("Direct accession resolution failed for {sequence}: {e}"),
        }
    }

    let hits = blast::run_blast(&state.http_client, &sequence, api_key).await?;

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

/// Upper bound on one `/blast_batch` request. The whole request is one
/// multi-query NCBI submission with a shared 180s worst-case poll budget
/// (see `blast::run_blast_batch`), so an unbounded query list would both
/// stretch that budget thin across queries and risk a multi-megabyte
/// submission; the frontend chunks larger batches itself.
const MAX_BATCH_QUERIES: usize = 100;

/// Characters permitted in a `/blast_batch` query id. The id becomes a
/// FASTA header verbatim, so whitespace would truncate it (NCBI keeps only
/// the first token of a defline), `>` would start a new record, and `|`
/// gets reinterpreted by NCBI's pipe-separated defline convention.
const BATCH_ID_CHARS: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-";

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct BlastBatchQuery {
    pub id: String,
    pub sequence: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct BlastBatchRequest {
    pub queries: Vec<BlastBatchQuery>,
    /// The caller's own NCBI API key, as on `/blast_sequence`.
    pub api_key: String,
}

#[derive(Debug, Serialize)]
pub struct BlastBatchQueryResult {
    pub id: String,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hits: Option<Vec<BlastHitJson>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BlastBatchResponse {
    pub results: Vec<BlastBatchQueryResult>,
}

/// `POST /blast_batch`: BLASTs many named sequences against `nt` in ONE
/// multi-query NCBI submission (`blast::run_blast_batch`), so a whole
/// primer panel costs a single ~30-180s round-trip instead of one per
/// primer. Per-query problems (a too-short primer, a query NCBI dropped)
/// are reported per query in the response; only a failure of the shared
/// submission itself fails the request.
fn valid_batch_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty() && id.len() <= 200 && id.chars().all(|c| BATCH_ID_CHARS.contains(c))
}

/// Same cleaning and length bounds as `/blast_sequence`'s raw-sequence
/// path; there is no accession fast-path here because batch queries are
/// primer sequences.
fn clean_batch_sequence(raw: &str) -> Result<String, String> {
    let mut sequence: String = raw.trim().to_uppercase();
    sequence.retain(|c| "ACGTNRYSWKMBDHV".contains(c));
    if sequence.len() < 20 {
        return Err(format!("Sequence too short for NCBI BLAST (need at least 20 bp, got {})", sequence.len()));
    }
    if sequence.len() > 50_000 {
        return Err("Sequence too long (max 50,000 bp)".to_string());
    }
    Ok(sequence)
}

pub async fn blast_batch(State(state): State<AppState>, Json(req): Json<BlastBatchRequest>) -> Result<Json<BlastBatchResponse>, AppError> {
    if req.queries.is_empty() {
        return Err(AppError::bad_request("No queries given"));
    }
    if req.queries.len() > MAX_BATCH_QUERIES {
        return Err(AppError::bad_request(format!("Too many queries in one batch (max {MAX_BATCH_QUERIES}); split the request")));
    }
    let api_key = match req.api_key.trim() {
        "" => None,
        key => Some(key),
    };

    let mut results: Vec<BlastBatchQueryResult> = Vec::new();
    let mut valid: Vec<(String, String)> = Vec::new();
    for q in &req.queries {
        let id = q.id.trim();
        if !valid_batch_id(&q.id) {
            return Err(AppError::bad_request(format!("Invalid query id {:?} (need 1-200 chars from A-Z, a-z, 0-9, . _ + -)", q.id)));
        }
        if valid.iter().any(|(vid, _)| vid == id) {
            return Err(AppError::bad_request(format!("Duplicate query id {id:?}")));
        }

        match clean_batch_sequence(&q.sequence) {
            Ok(sequence) => {
                results.push(BlastBatchQueryResult { id: id.to_string(), status: "running", hits: None, error: None });
                valid.push((id.to_string(), sequence));
            }
            Err(error) => results.push(BlastBatchQueryResult { id: id.to_string(), status: "error", hits: None, error: Some(error) }),
        }
    }

    if !valid.is_empty() {
        let parsed = blast::run_blast_batch(&state.http_client, &valid, api_key).await?;
        let by_def = parsed.into_iter().map(|q| (q.query_def, q.hits)).collect::<std::collections::HashMap<_, _>>();
        for (id, _) in &valid {
            if let Some(slot) = results.iter_mut().find(|r| &r.id == id) {
                let hits = by_def.get(id).cloned().unwrap_or_default();
                *slot = BlastBatchQueryResult {
                    id: id.clone(),
                    status: "done",
                    hits: Some(
                        hits.into_iter()
                            .map(|hit| {
                                let ensembl_species = blast::parse::organism_to_ensembl_species(&hit.organism);
                                BlastHitJson { hit, ensembl_species }
                            })
                            .collect(),
                    ),
                    error: None,
                };
            }
        }
    }

    Ok(Json(BlastBatchResponse { results }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_blast_input_detects_accession() {
        assert!(matches!(parse_blast_input("NM_001407269.1").unwrap(), ParsedInput::Accession(a) if a == "NM_001407269.1"));
        assert!(matches!(parse_blast_input(">header\nNM_001407269.1\n").unwrap(), ParsedInput::Accession(a) if a == "NM_001407269.1"));
    }

    #[test]
    fn parse_blast_input_cleans_raw_sequence() {
        let seq = "A".repeat(25);
        let input = format!(">header\n{seq}\n");
        assert!(matches!(parse_blast_input(&input).unwrap(), ParsedInput::Sequence(s) if s == seq));
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

    #[test]
    fn batch_ids_accept_safe_charset_only() {
        assert!(valid_batch_id("rs2333526.fwd"));
        assert!(valid_batch_id("rs1+rs2.rev"));
        assert!(valid_batch_id("a"));
        // Whitespace truncates a FASTA defline, `>` starts a new record,
        // `|` gets reinterpreted by NCBI's defline convention.
        assert!(!valid_batch_id("rs1 fwd"));
        assert!(!valid_batch_id("rs1|fwd"));
        assert!(!valid_batch_id(">rs1"));
        assert!(!valid_batch_id(""));
        assert!(!valid_batch_id(&"x".repeat(201)));
    }

    #[test]
    fn batch_sequences_cleaned_and_bounded() {
        let cleaned = clean_batch_sequence(" acgt acgt acgt acgt acgt nn ").unwrap();
        assert_eq!(cleaned, "ACGTACGTACGTACGTACGTNN");
        assert_eq!(clean_batch_sequence("ACGTN").unwrap_err(), "Sequence too short for NCBI BLAST (need at least 20 bp, got 5)");
        assert!(clean_batch_sequence(&"A".repeat(50_001)).is_err());
        assert!(clean_batch_sequence(&"A".repeat(20)).is_ok());
    }
}
