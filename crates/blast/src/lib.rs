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

// NCBI usage policy (blast.ncbi.nlm.nih.gov/doc/blast-help/developerinfo.html):
// >=10s between any calls, and no polling of the same RID more often than
// once a minute, waiting for the submission's RTOE first. Over-polling is
// documented to make NCBI DELAY the results: observed live as batch chunks
// that either completed by poll 1-2 (~13-25s) or sat in Status=WAITING
// past a 180s budget with nothing in between.
const POLL_INTERVAL: Duration = Duration::from_secs(60);
/// Poll budget for the single-query pipeline (`run_blast`), whose caller
/// (`/blast_sequence`) holds an HTTP request open for the duration.
const MAX_WAIT: Duration = Duration::from_secs(180);
/// Poll budget for the multi-query batch pipeline (`run_blast_batch`):
/// its caller serves the wait as a background job polled by the client,
/// so it can afford to outwait NCBI's slower queue without a proxy
/// cutting anything off.
const MAX_WAIT_BATCH: Duration = Duration::from_secs(300);

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

/// Cumulative offsets (from submission) at which `poll_blast` contacts
/// NCBI about one RID, as a pure function so the cadence is unit-testable
/// without network or clock.
fn poll_schedule(rtoe: u64, max_wait: Duration) -> Vec<Duration> {
    let first = Duration::from_secs(rtoe).max(Duration::from_secs(10)).min(max_wait);
    let mut schedule = vec![first];
    while let Some(&last) = schedule.last() {
        let next = last + POLL_INTERVAL;
        if next >= max_wait {
            break;
        }
        schedule.push(next);
    }
    schedule
}

/// Poll NCBI BLAST for job completion. Contacts the server on the schedule
/// `poll_schedule` lays out (see its doc for the NCBI usage policy behind
/// the cadence), and gives up with `BlastError::TimedOut` once `max_wait`
/// has elapsed without a READY/FAILED/UNKNOWN verdict.
pub async fn poll_blast(client: &reqwest::Client, rid: &str, rtoe: u64, max_wait: Duration, api_key: Option<&str>) -> Result<(), BlastError> {
    let mut prev = Duration::ZERO;
    for offset in poll_schedule(rtoe, max_wait) {
        tokio::time::sleep(offset - prev).await;
        prev = offset;

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
    poll_blast(client, &submitted.rid, submitted.rtoe, MAX_WAIT, api_key).await?;
    let xml = get_blast_results(client, &submitted.rid, api_key).await?;
    parse::parse_blast_results(&xml)
}

/// Hits kept per primer query. A specificity check is about the hits
/// *after* the intended target: with only 10, a primer's own gene (its
/// transcripts, clones and assemblies in `nt`) fills the list before any
/// secondary target can show up.
const BATCH_HITLIST_SIZE: u32 = 50;

/// Full BLAST pipeline for a whole batch of short-oligo (primer) queries
/// in ONE submission: NCBI's URL API accepts a multi-FASTA QUERY and
/// reports one `<Iteration>` per query, so N primers cost one
/// submit/poll/fetch round-trip (~30-300s total) instead of one per
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
    let submitted = submit_primer_blast(client, &fasta, "nt", BATCH_HITLIST_SIZE, organism, api_key).await?;
    poll_blast(client, &submitted.rid, submitted.rtoe, MAX_WAIT_BATCH, api_key).await?;
    let xml = get_blast_results(client, &submitted.rid, api_key).await?;
    parse::parse_blast_results_multi(&xml)
}

/// The subject range to fetch so a hit's alignment can cover the primer's
/// full length: BLAST's local alignment reports only the stretch it
/// aligned, leaving the primer's ends (positions before `query_from` and
/// after `query_to`) dangling with no subject bases shown. Returns the
/// 1-based inclusive plus-strand range spanning the HSP plus those
/// dangling ends, or `None` when the alignment already covers the whole
/// primer (nothing to fetch).
///
/// Plus-strand HSP (`hit_from <= hit_to`): the 5' flank sits just below
/// `hit_from`, the 3' flank just above `hit_to`. Minus-strand HSP
/// (`hit_from > hit_to`, the query reads the subject top-down): the 5'
/// flank sits just above `hit_from`, the 3' flank just below `hit_to`.
pub fn flank_fetch_range(hit_from: i64, hit_to: i64, query_from: i64, query_to: i64, query_len: i64) -> Option<(i64, i64)> {
    let left = query_from - 1;
    let right = query_len - query_to;
    if left <= 0 && right <= 0 {
        return None;
    }
    let (start, stop) = if hit_from > hit_to {
        (hit_to - right, hit_from + left)
    } else {
        (hit_from - left, hit_to + right)
    };
    Some((start.max(1), stop))
}

/// IUPAC complement, uppercased; anything unrecognized reads as `N`.
fn complement(base: u8) -> u8 {
    match base.to_ascii_uppercase() {
        b'A' => b'T',
        b'T' => b'A',
        b'C' => b'G',
        b'G' => b'C',
        b'R' => b'Y',
        b'Y' => b'R',
        b'S' => b'S',
        b'W' => b'W',
        b'K' => b'M',
        b'M' => b'K',
        b'B' => b'V',
        b'V' => b'B',
        b'D' => b'H',
        b'H' => b'D',
        _ => b'N',
    }
}

/// The target strings for a hit's dangling primer ends, cut out of the
/// subject sequence fetched by `flank_fetch_range`: `subject` is the
/// plus-strand sequence starting at 1-based coordinate `subject_start`,
/// possibly shorter than asked for when the range runs past the subject's
/// own end. Returns the 5' flank (first) and the 3' flank (second), each
/// in the query's orientation and at most the dangling length; bases
/// that don't exist (before the subject's start or past its end) are
/// dropped from the end of the flank nearest them, and the leftover
/// primer bases stay unaligned in the display.
pub fn hit_flank_strings(hit_from: i64, hit_to: i64, query_from: i64, query_to: i64, query_len: i64, subject: &str, subject_start: i64) -> (String, String) {
    let left = (query_from - 1).max(0);
    let right = (query_len - query_to).max(0);
    let minus = hit_from > hit_to;
    // The plus-strand subject base at 1-based coordinate `c`, if fetched.
    let base = |c: i64| -> Option<u8> {
        if c < subject_start {
            None
        } else {
            subject.as_bytes().get((c - subject_start) as usize).map(|b| b.to_ascii_uppercase())
        }
    };
    // Each flank's coordinates in query order. Missing bases can only
    // sit at the flank's outer end (lowest/highest subject coordinate),
    // so drop them there, keeping the bases adjacent to the HSP.
    let mut five: Vec<Option<u8>> = if minus {
        // Query position q < query_from pairs with subject coordinate
        // hit_from + (query_from - q), complemented; q ascending means the
        // coordinate descends from hit_from + left.
        ((hit_from + 1)..=(hit_from + left)).rev().map(|c| base(c).map(complement)).collect()
    } else {
        ((hit_from - left)..hit_from).map(base).collect()
    };
    let mut three: Vec<Option<u8>> = if minus {
        // Query position q > query_to pairs with hit_to - (q - query_to),
        // complemented; the coordinate descends from hit_to - 1.
        ((hit_to - right)..hit_to).rev().map(|c| base(c).map(complement)).collect()
    } else {
        ((hit_to + 1)..=(hit_to + right)).map(base).collect()
    };
    while five.first().is_some_and(|b| b.is_none()) {
        five.remove(0);
    }
    while three.last().is_some_and(|b| b.is_none()) {
        three.pop();
    }
    let flatten = |v: Vec<Option<u8>>| v.into_iter().map(|b| b.unwrap_or(b'N') as char).collect();
    (flatten(five), flatten(three))
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

    #[test]
    fn poll_schedule_follows_ncbi_usage_policy() {
        // Regression test for the SNP-batch timeouts: poll_blast used to
        // poll the same RID every 10s, violating NCBI's "no more often
        // than once a minute per RID" guideline sixfold. NCBI's documented
        // enforcement for over-polling is delaying the results, which
        // surfaced as chunks completing in <=25s (ready by poll 1-2) or
        // never within the budget, nothing in between.
        for rtoe in [0, 5, 30, 45] {
            for &budget in [&MAX_WAIT, &MAX_WAIT_BATCH] {
                let schedule = poll_schedule(rtoe, budget);
                assert!(
                    schedule.windows(2).all(|w| w[1] - w[0] >= Duration::from_secs(60)),
                    "same-RID polls must be >=60s apart for rtoe={rtoe}: {schedule:?}"
                );
                assert!(
                    schedule.iter().all(|&t| t <= budget),
                    "polls must stay within the budget for rtoe={rtoe}: {schedule:?}"
                );
            }
        }
        // The RTOE is NCBI's own estimate of when results will be ready;
        // the first poll must not predate it (nor the 10s floor between
        // any two calls to their servers).
        assert_eq!(poll_schedule(30, MAX_WAIT).first(), Some(&Duration::from_secs(30)));
        assert_eq!(poll_schedule(0, MAX_WAIT).first(), Some(&Duration::from_secs(10)));
    }

    #[test]
    fn flank_range_and_strings_minus_strand_hsp() {
        // The real NBAS hit from a live /blast_batch run: a 20nt primer
        // (TGACTCTTCCTCAACTACCG) whose HSP aligned only query 3-19 on the
        // minus strand of NG_032964.2 (hit 236061 -> 236045), leaving the
        // primer's first 2 and last 1 bases dangling.
        let (start, stop) = flank_fetch_range(236061, 236045, 3, 19, 20).unwrap();
        assert_eq!((start, stop), (236044, 236063));

        // Fabricate a subject for the fetched range [236044, 236063]:
        // coords 236044..236063 = "AAACCCGGGTTTACGTACGT".
        let subject = "AAACCCGGGTTTACGTACGT";
        let (five, three) = hit_flank_strings(236061, 236045, 3, 19, 20, subject, start);
        // 5' flank: primer positions 1-2 pair with coords 236063, 236062
        // (T, G), complemented to A, C, in that order.
        assert_eq!(five, "AC");
        // 3' flank: primer position 20 pairs with coord 236044 (A),
        // complemented to T.
        assert_eq!(three, "T");
    }

    #[test]
    fn flank_range_and_strings_plus_strand_hsp() {
        // Same dangling shape on a plus-strand HSP: query 3-19 aligned to
        // subject 100-116 of some accession.
        let (start, stop) = flank_fetch_range(100, 116, 3, 19, 20).unwrap();
        assert_eq!((start, stop), (98, 117));

        let subject = "AAACCCGGGTTTACGTACGT";
        let (five, three) = hit_flank_strings(100, 116, 3, 19, 20, subject, 98);
        // 5' flank: primer positions 1-2 pair with coords 98, 99 (A, A).
        assert_eq!(five, "AA");
        // 3' flank: primer position 20 pairs with coord 117 (T).
        assert_eq!(three, "T");
    }

    #[test]
    fn full_coverage_hit_needs_no_flank_fetch() {
        assert_eq!(flank_fetch_range(50, 70, 1, 21, 21), None);
        // Subject boundary clamping: the 5' flank would start below 1.
        assert_eq!(flank_fetch_range(2, 18, 5, 18, 24), Some((1, 24)));
    }

    #[test]
    fn flanks_trim_to_what_the_subject_actually_has() {
        // The fetch asked for [98, 117] but the subject ends at 112: only
        // 15 bases come back (coords 98-112). The 3' flank (coords
        // 113-117) is entirely past the end -> empty, and the 5' flank
        // still reads coords 98-99.
        let subject = "AAACCCGGGTTTACG";
        let (five, three) = hit_flank_strings(100, 116, 3, 19, 20, subject, 98);
        assert_eq!(five, "AA");
        assert_eq!(three, "");

        // Minus-strand HSP hugging the subject's end: primer positions 1-3
        // pair with subject coords 6, 5, 4, but only 5 and 4 exist (the
        // fetched subject is coords 1-5). The missing leading base is
        // dropped, keeping the two bases adjacent to the HSP, and the 3'
        // flank is empty (query_to = query_len).
        let (five, three) = hit_flank_strings(3, 1, 4, 10, 10, "TTTTA", 1);
        assert_eq!(five, "TA");
        assert_eq!(three, "");
    }
}
