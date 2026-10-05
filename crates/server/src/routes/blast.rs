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

#[derive(Debug, Clone, Serialize)]
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
/// multi-query NCBI submission with a shared 300s worst-case poll budget
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
    /// Restricts the BLAST search to one organism: one of the app's
    /// Ensembl species slugs (e.g. "homo_sapiens") or a spelled-out
    /// organism name (e.g. "Homo sapiens"). Empty is rejected — the
    /// frontend always sends the picker's value, defaulting to human.
    pub organism: String,
    /// The caller's own NCBI API key, as on `/blast_sequence`.
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize)]
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

/// A `/blast_batch` job's stored outcome — `None` until the spawned task
/// finishes. The `String` error is the whole-request failure message
/// (submission/poll/parse failure), mirroring what the synchronous
/// version returned as an `AppError`.
struct JobCell {
    outcome: Option<Result<BlastBatchResponse, String>>,
    created: std::time::Instant,
}

/// In-memory store of `/blast_batch` jobs, shared through `AppState`.
/// The route used to answer one request only after the whole NCBI
/// round-trip (~30-300s), which a reverse proxy in front of the server
/// (nginx's ~60s default) cuts off with a 504 — the job API answers the
/// POST immediately and the client polls `GET /blast_batch_status/:id`
/// instead, so no request is held open for the BLAST's duration. Jobs
/// die with the process (a deploy mid-run surfaces as a 404 to the
/// poller, which the frontend reports per primer), and finished jobs are
/// pruned when an hour old or past the size cap, whichever hits first.
#[derive(Default)]
pub struct BlastJobStore {
    jobs: std::sync::Mutex<std::collections::HashMap<String, JobCell>>,
}

const JOB_TTL: std::time::Duration = std::time::Duration::from_secs(3600);
const JOB_CAP: usize = 128;

impl BlastJobStore {
    fn new_job_id() -> String {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        format!("{nanos:x}-{n:x}-{}", std::process::id())
    }

    fn insert(&self) -> String {
        let id = Self::new_job_id();
        let mut jobs = self.jobs.lock().expect("blast job store poisoned");
        self.prune(&mut jobs, std::time::Instant::now());
        jobs.insert(id.clone(), JobCell { outcome: None, created: std::time::Instant::now() });
        id
    }

    fn finish(&self, id: &str, outcome: Result<BlastBatchResponse, String>) {
        if let Some(cell) = self.jobs.lock().expect("blast job store poisoned").get_mut(id) {
            cell.outcome = Some(outcome);
        }
    }

    /// Drops finished jobs older than `JOB_TTL`, then oldest-first once
    /// the store exceeds `JOB_CAP` — running jobs are never dropped.
    fn prune(&self, jobs: &mut std::collections::HashMap<String, JobCell>, now: std::time::Instant) {
        jobs.retain(|_, cell| cell.outcome.is_none() || now.duration_since(cell.created) < JOB_TTL);
        if jobs.len() > JOB_CAP {
            let mut finished: Vec<(std::time::Instant, String)> = jobs.iter().filter(|(_, c)| c.outcome.is_some()).map(|(id, c)| (c.created, id.clone())).collect();
            finished.sort();
            for (_, id) in finished.into_iter().take(jobs.len() - JOB_CAP) {
                jobs.remove(&id);
            }
        }
    }
}

fn valid_batch_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty() && id.len() <= 200 && id.chars().all(|c| BATCH_ID_CHARS.contains(c))
}

/// Resolves `/blast_batch`'s `organism` field to the NCBI organism name
/// the search is restricted to (via ENTREZ_QUERY): a known Ensembl
/// species slug maps through `BINOMIAL_TO_ENSEMBL`'s reverse, anything
/// else passes through as an already-spelled-out organism name. The
/// charset check keeps the value from smuggling ENTREZ query syntax
/// (brackets, quotes, field tags) into the restriction.
fn resolve_organism(raw: &str) -> Result<String, AppError> {
    let organism = raw.trim();
    if organism.is_empty() || organism.len() > 200 || !organism.chars().all(|c| c.is_alphanumeric() || " ._-".contains(c)) {
        return Err(AppError::bad_request("Invalid organism (need a species slug like homo_sapiens, or an organism name like \"Homo sapiens\")"));
    }
    Ok(blast::parse::ensembl_slug_to_organism(organism).unwrap_or_else(|| organism.to_string()))
}

/// Same cleaning as `/blast_sequence`'s raw-sequence path, but with an
/// 18 bp floor instead of that route's legacy 20: the batch designer
/// returns primers as short as 18 nt (the picker's `min_size`), and
/// blastn searches those fine under the primer-tuned parameters
/// (`submit_primer_blast`) — verified against live NCBI. There is no
/// accession fast-path here because batch queries are primer sequences.
fn clean_batch_sequence(raw: &str) -> Result<String, String> {
    let mut sequence: String = raw.trim().to_uppercase();
    sequence.retain(|c| "ACGTNRYSWKMBDHV".contains(c));
    if sequence.len() < 18 {
        return Err(format!("Sequence too short for NCBI BLAST (need at least 18 bp, got {})", sequence.len()));
    }
    if sequence.len() > 50_000 {
        return Err("Sequence too long (max 50,000 bp)".to_string());
    }
    Ok(sequence)
}

#[derive(Debug, Serialize)]
pub struct BlastBatchStarted {
    pub job_id: String,
}

#[derive(Debug, Serialize)]
pub struct BlastJobStatus {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<BlastBatchQueryResult>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `POST /blast_batch`: validates the request, starts the multi-query
/// NCBI BLAST (`blast::run_blast_batch`) as a background job, and
/// returns its id immediately — the results come back through
/// `GET /blast_batch_status/:job_id`, so a reverse proxy between client
/// and server can't time the request out mid-BLAST (the synchronous
/// shape 504'd behind nginx's ~60s default). Per-query problems (a
/// too-short primer, a query NCBI dropped) are reported per query in
/// the job's results; only a failure of the shared submission itself
/// fails the job.
pub async fn blast_batch(State(state): State<AppState>, Json(req): Json<BlastBatchRequest>) -> Result<(axum::http::StatusCode, Json<BlastBatchStarted>), AppError> {
    if req.queries.is_empty() {
        return Err(AppError::bad_request("No queries given"));
    }
    if req.queries.len() > MAX_BATCH_QUERIES {
        return Err(AppError::bad_request(format!("Too many queries in one batch (max {MAX_BATCH_QUERIES}); split the request")));
    }
    let api_key = match req.api_key.trim().to_string() {
        key if key.is_empty() => None,
        key => Some(key),
    };
    let organism = resolve_organism(&req.organism)?;

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

    let job_id = state.blast_jobs.insert();
    let task_job_id = job_id.clone();
    let store = state.blast_jobs.clone();
    let http_client = state.http_client.clone();
    tokio::spawn(async move {
        let outcome = match blast::run_blast_batch(&http_client, &valid, Some(&organism), api_key.as_deref()).await {
            Ok(parsed) => {
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
                Ok(BlastBatchResponse { results })
            }
            Err(e) => Err(format!("{e}")),
        };
        store.finish(&task_job_id, outcome);
    });

    Ok((axum::http::StatusCode::ACCEPTED, Json(BlastBatchStarted { job_id })))
}

/// `GET /blast_batch_status/:job_id`: the polling side of the
/// `/blast_batch` job API — `running` until the background BLAST
/// finishes, then the job's per-query results, or its error. Unknown
/// (expired, or lost to a server restart) job ids are a 404.
pub async fn blast_batch_status(State(state): State<AppState>, axum::extract::Path(job_id): axum::extract::Path<String>) -> Result<Json<BlastJobStatus>, AppError> {
    let jobs = state.blast_jobs.jobs.lock().expect("blast job store poisoned");
    match jobs.get(&job_id) {
        None => Err(AppError::not_found("Unknown or expired BLAST job id")),
        Some(cell) => match &cell.outcome {
            None => Ok(Json(BlastJobStatus { status: "running", results: None, error: None })),
            Some(Ok(response)) => Ok(Json(BlastJobStatus { status: "done", results: Some(response.results.clone()), error: None })),
            Some(Err(message)) => Ok(Json(BlastJobStatus { status: "error", results: None, error: Some(message.clone()) })),
        },
    }
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
        // 18 is the batch designer's own minimum primer length - one
        // below it must still be a per-query error, not a submission.
        assert_eq!(clean_batch_sequence("ACGTN").unwrap_err(), "Sequence too short for NCBI BLAST (need at least 18 bp, got 5)");
        assert!(clean_batch_sequence(&"A".repeat(17)).is_err());
        assert!(clean_batch_sequence(&"A".repeat(18)).is_ok());
        assert!(clean_batch_sequence(&"A".repeat(50_001)).is_err());
    }

    #[test]
    fn organism_slugs_resolve_and_names_pass_through() {
        assert_eq!(resolve_organism("homo_sapiens").unwrap(), "homo sapiens");
        assert_eq!(resolve_organism("sars_cov_2").unwrap(), "sars-cov-2");
        assert_eq!(resolve_organism("  Homo sapiens  ").unwrap(), "Homo sapiens");
        assert_eq!(resolve_organism("Gallus gallus").unwrap(), "Gallus gallus");
    }

    #[test]
    fn organism_rejects_empty_and_query_syntax() {
        assert!(resolve_organism("").is_err());
        assert!(resolve_organism("   ").is_err());
        // Bracket/quote syntax would smuggle ENTREZ query terms into the
        // organism restriction.
        assert!(resolve_organism("Homo sapiens [organism]").is_err());
        assert!(resolve_organism("homo sapiens:1").is_err());
        assert!(resolve_organism(&"x".repeat(201)).is_err());
    }

    #[test]
    fn job_store_lifecycle_and_prune() {
        let store = BlastJobStore::default();

        let a = store.insert();
        let b = store.insert();
        assert_ne!(a, b);
        // Both known and still running before any outcome lands.
        {
            let jobs = store.jobs.lock().unwrap();
            assert!(jobs.get(&a).is_some_and(|c| c.outcome.is_none()));
            assert!(jobs.get(&b).is_some_and(|c| c.outcome.is_none()));
        }

        let response = BlastBatchResponse { results: vec![BlastBatchQueryResult { id: "x.fwd".into(), status: "done", hits: Some(vec![]), error: None }] };
        store.finish(&a, Ok(response));
        assert!(store.jobs.lock().unwrap().get(&a).is_some_and(|c| c.outcome.is_some()));

        // A finished job past the TTL is pruned on the next insert; a
        // running job never is, however old.
        let mut jobs = store.jobs.lock().unwrap();
        let now = std::time::Instant::now();
        let old = now - std::time::Duration::from_secs(JOB_TTL.as_secs() + 1);
        if let Some(cell) = jobs.get_mut(&a) {
            cell.created = old;
        }
        if let Some(cell) = jobs.get_mut(&b) {
            cell.created = old;
        }
        drop(jobs);
        store.prune(&mut store.jobs.lock().unwrap(), std::time::Instant::now());
        let jobs = store.jobs.lock().unwrap();
        assert!(!jobs.contains_key(&a), "finished job past TTL must be pruned");
        assert!(jobs.contains_key(&b), "running job must survive pruning");
    }
}
