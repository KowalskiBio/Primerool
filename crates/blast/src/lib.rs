//! NCBI BLAST client, ported from `blast_api.py` (Phase 2).
//!
//! `submit_blast` / `poll_blast` / `get_blast_results` / `run_blast` land
//! here verbatim, including NCBI's own usage-policy timing constants.
//! Library-only until Phase 6 wires an async job-polling route on top of
//! it (the plan recommends replacing this ~180s-worst-case blocking call
//! with a job-submission API to survive a ~100s-timeout reverse proxy).

pub mod parse;

use std::time::Duration;

use regex::Regex;

const BLAST_URL: &str = "https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi";

// NCBI usage policy: >=10s between any calls, >=60s between polls for the same RID.
const POLL_INTERVAL: Duration = Duration::from_secs(10);
const MAX_WAIT: Duration = Duration::from_secs(180);

#[derive(Debug, thiserror::Error)]
pub enum BlastError {
    #[error("failed to parse RID from NCBI BLAST response")]
    NoRequestId,
    #[error("NCBI BLAST search failed")]
    SearchFailed,
    #[error("NCBI BLAST RID unknown or expired")]
    RidExpired,
    #[error("BLAST search did not complete within {0:?}")]
    TimedOut(Duration),
    #[error("failed to parse BLAST XML: {0}")]
    XmlParse(String),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
}

pub struct SubmitResult {
    pub rid: String,
    pub rtoe: u64,
}

/// Append the NCBI API key (E-utilities convention; NCBI BLAST accepts the
/// same parameter) to a request when one was configured — an absent/`None`
/// key leaves the request byte-identical to before.
fn with_api_key<'a>(mut params: Vec<(&'a str, &'a str)>, api_key: Option<&'a str>) -> Vec<(&'a str, &'a str)> {
    if let Some(key) = api_key {
        params.push(("api_key", key));
    }
    params
}

/// Submit a BLAST search. Defaults to the 'nt' database for broader
/// genomic coverage, `hitlist_size=10`, matching `submit_blast`'s Python
/// defaults exactly.
pub async fn submit_blast(client: &reqwest::Client, sequence: &str, database: &str, hitlist_size: u32, api_key: Option<&str>) -> Result<SubmitResult, BlastError> {
    let hitlist_size_s = hitlist_size.to_string();
    let params = with_api_key(
        vec![
            ("CMD", "Put"),
            ("PROGRAM", "blastn"),
            ("DATABASE", database),
            ("QUERY", sequence),
            ("HITLIST_SIZE", &hitlist_size_s),
            ("FORMAT_TYPE", "XML"),
            ("MEGABLAST", "on"),
            ("tool", "primeroonline"),
        ],
        api_key,
    );
    submit_params(client, params).await
}

/// Submit a short-oligo (primer) BLAST search. `submit_blast`'s defaults
/// are tuned for identifying a long sequence and drop exactly what a
/// primer-specificity check looks for in a 18-30nt query: megablast's
/// 28-word finds no seed at all below that length, and a perfect 20nt
/// match only scores ~40 bits (E ~ 20 against core_nt), above the default
/// E<10 cutoff. Hence standard blastn (word 11), `EXPECT=1000` and no
/// low-complexity filtering — verified against live NCBI with a 20nt
/// primer that returns 0 hits the default way and 10 this way.
///
/// `organism` restricts the search to one organism via ENTREZ_QUERY
/// (e.g. "Homo sapiens [organism]"), so a specificity check reports hits
/// in the target organism only; `None` searches everything.
pub async fn submit_primer_blast(client: &reqwest::Client, sequence: &str, database: &str, hitlist_size: u32, organism: Option<&str>, api_key: Option<&str>) -> Result<SubmitResult, BlastError> {
    let hitlist_size_s = hitlist_size.to_string();
    let entrez_query = organism.map(|o| format!("{o} [organism]"));
    let mut params = vec![
        ("CMD", "Put"),
        ("PROGRAM", "blastn"),
        ("DATABASE", database),
        ("QUERY", sequence),
        ("HITLIST_SIZE", &hitlist_size_s),
        ("EXPECT", "1000"),
        ("FILTER", "off"),
        ("FORMAT_TYPE", "XML"),
        ("MEGABLAST", "off"),
        ("tool", "primeroonline"),
    ];
    if let Some(query) = &entrez_query {
        params.push(("ENTREZ_QUERY", query));
    }
    submit_params(client, with_api_key(params, api_key)).await
}

async fn submit_params(client: &reqwest::Client, params: Vec<(&str, &str)>) -> Result<SubmitResult, BlastError> {
    // POST (not GET) to support long sequences (>2kb), matching Python.
    let resp = client.post(BLAST_URL).form(&params).timeout(Duration::from_secs(30)).send().await?;
    let text = resp.text().await?;

    let rid_re = Regex::new(r"RID = (\S+)").unwrap();
    let rtoe_re = Regex::new(r"RTOE = (\d+)").unwrap();

    let rid = rid_re.captures(&text).and_then(|c| c.get(1)).map(|m| m.as_str().to_string()).ok_or(BlastError::NoRequestId)?;
    let rtoe = rtoe_re.captures(&text).and_then(|c| c.get(1)).and_then(|m| m.as_str().parse().ok()).unwrap_or(30);

    Ok(SubmitResult { rid, rtoe })
}

/// Poll NCBI BLAST for job completion. Sleeps `POLL_INTERVAL` (10s) between
/// checks — deliberately does NOT sleep the initial `rtoe` estimate
/// upfront, so fast completions are caught earlier while still respecting
/// NCBI's ">=10s between polls" policy, matching the Python comment.
pub async fn poll_blast(client: &reqwest::Client, rid: &str, max_wait: Duration, api_key: Option<&str>) -> Result<(), BlastError> {
    let mut elapsed = Duration::ZERO;
    while elapsed < max_wait {
        tokio::time::sleep(POLL_INTERVAL).await;
        elapsed += POLL_INTERVAL;

        let resp = client
            .get(BLAST_URL)
            .query(&with_api_key(vec![("CMD", "Get"), ("FORMAT_OBJECT", "SearchInfo"), ("RID", rid)], api_key))
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        let text = resp.text().await?;

        if text.contains("Status=READY") {
            return Ok(());
        }
        if text.contains("Status=FAILED") {
            return Err(BlastError::SearchFailed);
        }
        if text.contains("Status=UNKNOWN") {
            return Err(BlastError::RidExpired);
        }
        // Status=WAITING -> keep polling.
    }
    Err(BlastError::TimedOut(max_wait))
}

/// Retrieve BLAST results in XML format.
pub async fn get_blast_results(client: &reqwest::Client, rid: &str, api_key: Option<&str>) -> Result<String, BlastError> {
    let resp = client
        .get(BLAST_URL)
        .query(&with_api_key(vec![("CMD", "Get"), ("FORMAT_TYPE", "XML"), ("RID", rid)], api_key))
        .timeout(Duration::from_secs(60))
        .send()
        .await?;
    Ok(resp.text().await?)
}

/// Full BLAST pipeline: submit, poll, retrieve, parse. Blocking (in the
/// sense of taking a long time) — may take up to ~3 minutes.
pub async fn run_blast(client: &reqwest::Client, sequence: &str, api_key: Option<&str>) -> Result<Vec<parse::BlastHit>, BlastError> {
    let submitted = submit_blast(client, sequence, "nt", 10, api_key).await?;
    poll_blast(client, &submitted.rid, MAX_WAIT, api_key).await?;
    let xml = get_blast_results(client, &submitted.rid, api_key).await?;
    parse::parse_blast_results(&xml)
}

/// Full BLAST pipeline for a whole batch of short-oligo (primer) queries
/// in ONE submission: NCBI's URL API accepts a multi-FASTA QUERY and
/// reports one `<Iteration>` per query, so N primers cost one
/// submit/poll/fetch round-trip (~30-180s total) instead of one per
/// primer. Uses `submit_primer_blast`'s short-oligo parameters (see its
/// doc for why megablast defaults would return nothing for a primer) and
/// its `organism` restriction. Each query's hits come back keyed by its
/// FASTA header (`id`). Callers must supply ids that are unique and safe
/// as a FASTA header (no whitespace, `>`, or `|` — the last because NCBI
/// reinterprets pipe-separated deflines); `/blast_batch` enforces that.
pub async fn run_blast_batch(client: &reqwest::Client, queries: &[(String, String)], organism: Option<&str>, api_key: Option<&str>) -> Result<Vec<parse::QueryBlastResults>, BlastError> {
    let fasta = queries
        .iter()
        .map(|(id, sequence)| format!(">{id}\n{sequence}"))
        .collect::<Vec<_>>()
        .join("\n");
    let submitted = submit_primer_blast(client, &fasta, "nt", 10, organism, api_key).await?;
    poll_blast(client, &submitted.rid, MAX_WAIT, api_key).await?;
    let xml = get_blast_results(client, &submitted.rid, api_key).await?;
    parse::parse_blast_results_multi(&xml)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rid_and_rtoe_regex_extract_from_html_response() {
        let text = "some html ... RID = ABC123XYZ ... RTOE = 42 ... more html";
        let rid_re = Regex::new(r"RID = (\S+)").unwrap();
        let rtoe_re = Regex::new(r"RTOE = (\d+)").unwrap();
        assert_eq!(rid_re.captures(text).unwrap().get(1).unwrap().as_str(), "ABC123XYZ");
        assert_eq!(rtoe_re.captures(text).unwrap().get(1).unwrap().as_str(), "42");
    }
}
