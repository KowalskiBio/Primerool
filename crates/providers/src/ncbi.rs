//! NCBI E-utilities provider, ported from `ncbi_api.py`.
//!
//! Rate-limited to ~3 req/s (`_MIN_INTERVAL = 0.34`), single attempt, no
//! retry — deliberately less robust than Ensembl's client, and deliberately
//! not sharing a rate limiter with it. Carries a load-bearing, process-
//! lifetime, stateful transcript cache (`transcript_cache`, populated by
//! `search_gene`, read by `get_transcript_details`): NCBI has no
//! per-transcript structured lookup, so `gene_table` parsing only happens
//! during `search_gene`, and `get_transcript_details` depends on that
//! having already run for the gene in this process — this preserves that
//! real, if awkward, semantics rather than silently changing request
//! behavior (see the rewrite plan's Phase 2 fidelity note #4).

use std::collections::HashMap;

use indexmap::IndexMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::species_map::ensembl_to_binomial_or_guess;
use crate::{revcomp, Feature, GeneSearchResult, Interval, ProviderError, SeqType, SequenceProvider, Strand, TranscriptInfo, TranscriptSummary};

const EUTILS: &str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const MIN_INTERVAL: Duration = Duration::from_millis(340); // ~3 req/s, no API key

pub struct NcbiProvider {
    client: reqwest::Client,
    last_request: Mutex<Instant>,
    transcript_cache: Arc<Mutex<HashMap<String, TranscriptInfo>>>,
}

impl Default for NcbiProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl NcbiProvider {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            last_request: Mutex::new(Instant::now() - Duration::from_secs(1)),
            transcript_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Direct port of `ncbi_api.py::_get`: rate-limited, single-attempt,
    /// no retry (unlike Ensembl's `_get`).
    async fn get(&self, url: &str, params: &[(&str, &str)], timeout: Duration) -> Result<reqwest::Response, ProviderError> {
        {
            let mut last = self.last_request.lock().await;
            let elapsed = last.elapsed();
            if elapsed < MIN_INTERVAL {
                tokio::time::sleep(MIN_INTERVAL - elapsed).await;
            }
            *last = Instant::now();
        }

        let resp = self.client.get(url).query(params).timeout(timeout).send().await?;
        let status = resp.status().as_u16();
        if status >= 400 {
            let message = resp.text().await.unwrap_or_default();
            return Err(ProviderError::UpstreamStatus { status, message });
        }
        Ok(resp)
    }

    async fn get_json(&self, url: &str, params: &[(&str, &str)]) -> Result<Value, ProviderError> {
        let resp = self.get(url, params, Duration::from_secs(30)).await?;
        resp.json::<Value>().await.map_err(Into::into)
    }

    /// Port of `_fetch_fasta_seq`: strips FASTA headers, joins remaining
    /// lines, uppercases. Any HTTP error (blanket) -> `None`.
    async fn fetch_fasta_seq(&self, params: &[(&str, &str)], timeout: Duration) -> Result<Option<String>, ProviderError> {
        let resp = match self.get(&format!("{EUTILS}/efetch.fcgi"), params, timeout).await {
            Ok(r) => r,
            Err(ProviderError::UpstreamStatus { .. }) => return Ok(None),
            Err(e) => return Err(e),
        };
        let text = resp.text().await?;
        let seq: String = text
            .trim()
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('>'))
            .collect::<Vec<_>>()
            .join("")
            .to_uppercase();
        Ok(if seq.is_empty() { None } else { Some(seq) })
    }

    async fn fetch_region_sequence(&self, chrom: &str, chr_accession: &str, start: u64, end: u64) -> Result<Option<String>, ProviderError> {
        if end < start {
            return Ok(Some(String::new()));
        }
        let acc = if !chr_accession.is_empty() { chr_accession } else { chrom };
        if !acc.starts_with("NC_") {
            // Python: prints a warning and returns None — can't fetch without NC_.
            return Ok(None);
        }
        let start_s = start.to_string();
        let end_s = end.to_string();
        self.fetch_fasta_seq(
            &[
                ("db", "nucleotide"),
                ("id", acc),
                ("seq_start", &start_s),
                ("seq_stop", &end_s),
                ("strand", "1"), // always plus-strand; revcomp locally
                ("rettype", "fasta"),
                ("retmode", "text"),
            ],
            Duration::from_secs(60),
        )
        .await
    }
}

#[async_trait::async_trait]
impl SequenceProvider for NcbiProvider {
    async fn search_gene(&self, gene_name: &str, species: &str) -> Result<Option<GeneSearchResult>, ProviderError> {
        let gene_name = gene_name.trim();
        let organism = ensembl_to_binomial_or_guess(species);

        // Step 1: esearch -> gene ID
        let term = format!("{gene_name}[sym] AND {organism}[orgn]");
        let esearch = self.get_json(&format!("{EUTILS}/esearch.fcgi"), &[("db", "gene"), ("term", &term), ("retmode", "json")]).await?;
        let gene_id = match esearch["esearchresult"]["idlist"].as_array().and_then(|a| a.first()).and_then(|v| v.as_str()) {
            Some(id) => id.to_string(),
            None => return Ok(None),
        };

        // Step 2: esummary -> gene info
        let esummary = self.get_json(&format!("{EUTILS}/esummary.fcgi"), &[("db", "gene"), ("id", &gene_id), ("retmode", "json")]).await?;
        let summary = &esummary["result"][&gene_id];

        let chrom = summary["chromosome"].as_str().unwrap_or_default().to_string();
        let genomic_info = summary["genomicinfo"].as_array();

        let mut chr_accession = String::new();
        let mut gene_start: u64 = 0;
        let mut gene_end: u64 = 0;
        let mut strand = Strand::Plus;

        if let Some(gi) = genomic_info.and_then(|a| a.first()) {
            chr_accession = gi["chraccver"].as_str().unwrap_or_default().to_string();
            let cs = gi["chrstart"].as_i64().unwrap_or(0);
            let ce = gi["chrstop"].as_i64().unwrap_or(0);
            // esummary uses 0-based coords; chrstart > chrstop means minus strand.
            if cs <= ce {
                strand = Strand::Plus;
                gene_start = (cs + 1) as u64;
                gene_end = (ce + 1) as u64;
            } else {
                strand = Strand::Minus;
                gene_start = (ce + 1) as u64;
                gene_end = (cs + 1) as u64;
            }
        }

        // Step 3: gene_table -> per-transcript exon/CDS coords
        let gene_table_resp = self
            .get(&format!("{EUTILS}/efetch.fcgi"), &[("db", "gene"), ("id", &gene_id), ("rettype", "gene_table"), ("retmode", "text")], Duration::from_secs(30))
            .await?;
        let gene_table_text = gene_table_resp.text().await?;
        let mut transcripts_data = parse_gene_table(&gene_table_text, &chrom, &chr_accession, strand, gene_start, gene_end);

        // Prokaryote fallback: bacterial genes have no annotated mRNA, so
        // gene_table comes back empty. Synthesize a single-exon transcript
        // from the esummary genomic span.
        if transcripts_data.is_empty() && gene_start != 0 && gene_end != 0 {
            let syn_id = format!("{gene_name}_CDS");
            transcripts_data.insert(
                syn_id.clone(),
                TranscriptInfo {
                    // Deliberately empty, NOT `syn_id`: Python's synthetic
                    // dict for this fallback never sets a "transcript_id"
                    // key at all, so `tinfo.get("transcript_id", "")` is
                    // falsy — this is what forces build_spliced_sequence/
                    // build_genomic_sequence/get_flanking_sequence down
                    // their per-region-fetch fallback path instead of
                    // trying (and failing) to `efetch` a fake accession
                    // like "dnaA_CDS" from NCBI. Confirmed empirically:
                    // NCBI returns HTTP 200 with a garbled text error body
                    // for such IDs, not a 4xx that Python's `except
                    // HTTPError` would catch — so this must stay empty for
                    // real correctness, not just Python-parity pedantry.
                    transcript_id: String::new(),
                    transcript_name: format!("{gene_name} (CDS)"),
                    chrom: if !chrom.is_empty() { chrom.clone() } else { chr_accession.clone() },
                    chr_accession: chr_accession.clone(),
                    strand,
                    exons: vec![(gene_start, gene_end)],
                    cds: vec![(gene_start, gene_end)],
                    utr5: vec![],
                    utr3: vec![],
                    utr: vec![],
                },
            );
        }

        // Cache all parsed transcript details.
        {
            let mut cache = self.transcript_cache.lock().await;
            for (tid, tinfo) in &transcripts_data {
                cache.insert(tid.clone(), tinfo.clone());
            }
        }

        let mut transcripts: Vec<TranscriptSummary> = transcripts_data
            .iter()
            .map(|(tid, tinfo)| TranscriptSummary {
                id: tid.clone(),
                name: tinfo.transcript_name.clone(),
                biotype: String::new(),
                exon_count: tinfo.exons.len(),
                strand,
                is_canonical: false,
            })
            .collect();

        // Sort: NM_ first, then by exon count descending.
        transcripts.sort_by(|a, b| {
            let a_key = (if a.id.starts_with("NM_") { 0 } else { 1 }, std::cmp::Reverse(a.exon_count));
            let b_key = (if b.id.starts_with("NM_") { 0 } else { 1 }, std::cmp::Reverse(b.exon_count));
            a_key.cmp(&b_key)
        });

        // Mark first NM_ as canonical; if none, mark the first transcript.
        if let Some(t) = transcripts.iter_mut().find(|t| t.id.starts_with("NM_")) {
            t.is_canonical = true;
        }
        if !transcripts.is_empty() && !transcripts.iter().any(|t| t.is_canonical) {
            transcripts[0].is_canonical = true;
        }

        Ok(Some(GeneSearchResult {
            gene_name: gene_name.to_string(),
            gene_id,
            chrom,
            strand,
            start: gene_start,
            end: gene_end,
            transcripts,
        }))
    }

    async fn get_transcript_details(&self, transcript_id: &str) -> Result<Option<TranscriptInfo>, ProviderError> {
        if let Some(t) = self.transcript_cache.lock().await.get(transcript_id) {
            return Ok(Some(t.clone()));
        }

        // Fallback: try to find the gene for this transcript, best-effort
        // (Python wraps this entire block in `except Exception: pass`).
        let fallback: Result<(), ProviderError> = async {
            let esearch = self.get_json(&format!("{EUTILS}/esearch.fcgi"), &[("db", "gene"), ("term", &format!("{transcript_id}[accn]")), ("retmode", "json")]).await?;
            if let Some(gid) = esearch["esearchresult"]["idlist"].as_array().and_then(|a| a.first()).and_then(|v| v.as_str()) {
                let esummary = self.get_json(&format!("{EUTILS}/esummary.fcgi"), &[("db", "gene"), ("id", gid), ("retmode", "json")]).await?;
                if let Some(sym) = esummary["result"][gid]["name"].as_str() {
                    if !sym.is_empty() {
                        self.search_gene(sym, "homo_sapiens").await?;
                    }
                }
            }
            Ok(())
        }
        .await;
        let _ = fallback; // best-effort; errors intentionally swallowed, matching `except Exception: pass`

        Ok(self.transcript_cache.lock().await.get(transcript_id).cloned())
    }

    async fn get_sequence_by_id(&self, id: &str, _seq_type: SeqType) -> Result<Option<String>, ProviderError> {
        // NCBI ignores seq_type entirely — always full FASTA by accession.
        self.fetch_fasta_seq(&[("db", "nucleotide"), ("id", id), ("rettype", "fasta"), ("retmode", "text")], Duration::from_secs(60)).await
    }

    async fn get_region_sequence(&self, tinfo: &TranscriptInfo, start: u64, end: u64, _species: &str) -> Result<Option<String>, ProviderError> {
        self.fetch_region_sequence(&tinfo.chrom, &tinfo.chr_accession, start, end).await
    }

    async fn build_spliced_sequence(&self, tinfo: &TranscriptInfo, feature: Feature, _species: &str) -> Result<Option<String>, ProviderError> {
        let intervals: &[Interval] = match feature {
            Feature::Exons => &tinfo.exons,
            Feature::Cds => &tinfo.cds,
        };
        if intervals.is_empty() {
            return Ok(None);
        }

        if !tinfo.transcript_id.is_empty() && feature == Feature::Exons {
            // Fetch full mRNA by accession (already IS the spliced transcript for RefSeq).
            if let Some(seq) = self.get_sequence_by_id(&tinfo.transcript_id, SeqType::Cdna).await? {
                return Ok(Some(seq.to_uppercase()));
            }
        }

        if !tinfo.transcript_id.is_empty() && feature == Feature::Cds {
            if let Some(mrna) = self.get_sequence_by_id(&tinfo.transcript_id, SeqType::Genomic).await? {
                let cds_ann = crate::coords::cds_annotations_in_transcript_coords(tinfo);
                if let (Some(first), Some(last)) = (cds_ann.first(), cds_ann.last()) {
                    let cds_start = first.0 as usize;
                    let cds_end = last.1 as usize;
                    if cds_start <= mrna.len() && cds_end <= mrna.len() && cds_start <= cds_end {
                        return Ok(Some(mrna[cds_start..cds_end].to_uppercase()));
                    }
                }
            }
        }

        // Fallback: per-region fetch.
        let mut intervals_sorted = intervals.to_vec();
        intervals_sorted.sort();
        let mut parts = Vec::with_capacity(intervals_sorted.len());
        for (start, end) in intervals_sorted {
            match self.fetch_region_sequence(&tinfo.chrom, &tinfo.chr_accession, start, end).await? {
                Some(seq) => parts.push(seq),
                None => return Ok(None),
            }
        }
        let mut full = parts.concat();
        if tinfo.strand == Strand::Minus {
            full = revcomp(&full);
        }
        Ok(Some(full.to_uppercase()))
    }

    async fn build_genomic_sequence(&self, tinfo: &TranscriptInfo, _species: &str) -> Result<Option<String>, ProviderError> {
        if tinfo.exons.is_empty() {
            return Ok(None);
        }
        let gene_start = tinfo.exons.iter().map(|(s, _)| *s).min().unwrap();
        let gene_end = tinfo.exons.iter().map(|(_, e)| *e).max().unwrap();

        let seq = match self.fetch_region_sequence(&tinfo.chrom, &tinfo.chr_accession, gene_start, gene_end).await? {
            Some(seq) => seq,
            None => return Ok(None),
        };
        let seq = if tinfo.strand == Strand::Minus { revcomp(&seq) } else { seq };
        Ok(Some(seq.to_uppercase()))
    }

    async fn get_flanking_sequence(
        &self,
        tinfo: &TranscriptInfo,
        upstream_bp: u64,
        downstream_bp: u64,
        use_cds_anchor: bool,
        _species: &str,
    ) -> Result<(String, String), ProviderError> {
        if tinfo.exons.is_empty() {
            return Ok((String::new(), String::new()));
        }

        let (anchor_start, anchor_end) = if use_cds_anchor && !tinfo.cds.is_empty() {
            (tinfo.cds.iter().map(|(s, _)| *s).min().unwrap(), tinfo.cds.iter().map(|(_, e)| *e).max().unwrap())
        } else {
            (tinfo.exons.iter().map(|(s, _)| *s).min().unwrap(), tinfo.exons.iter().map(|(_, e)| *e).max().unwrap())
        };

        if tinfo.strand == Strand::Plus {
            let upstream_seq = if upstream_bp > 0 {
                let us = anchor_start.saturating_sub(upstream_bp).max(1);
                let ue = anchor_start.saturating_sub(1);
                self.fetch_region_sequence(&tinfo.chrom, &tinfo.chr_accession, us, ue).await?.unwrap_or_default()
            } else {
                String::new()
            };
            let downstream_seq = if downstream_bp > 0 {
                let ds = anchor_end + 1;
                let de = anchor_end + downstream_bp;
                self.fetch_region_sequence(&tinfo.chrom, &tinfo.chr_accession, ds, de).await?.unwrap_or_default()
            } else {
                String::new()
            };
            Ok((upstream_seq, downstream_seq))
        } else {
            let upstream_seq = if upstream_bp > 0 {
                let us = anchor_end + 1;
                let ue = anchor_end + upstream_bp;
                let raw = self.fetch_region_sequence(&tinfo.chrom, &tinfo.chr_accession, us, ue).await?.unwrap_or_default();
                revcomp(&raw).to_uppercase()
            } else {
                String::new()
            };
            let downstream_seq = if downstream_bp > 0 {
                let ds = anchor_start.saturating_sub(downstream_bp).max(1);
                let de = anchor_start.saturating_sub(1);
                let raw = self.fetch_region_sequence(&tinfo.chrom, &tinfo.chr_accession, ds, de).await?.unwrap_or_default();
                revcomp(&raw).to_uppercase()
            } else {
                String::new()
            };
            Ok((upstream_seq, downstream_seq))
        }
    }
}

// ---------------------------------------------------------------------------
// gene_table parser
// ---------------------------------------------------------------------------

/// Direct port of `_parse_gene_table`'s line-oriented state machine. Note:
/// a header line like "RNA transcript variant 14 NR_176326.1, 10 exons"
/// does NOT match the `mRNA|ncRNA|misc_RNA` prefix (only literal "RNA" —
/// missing the "m"/"nc"/"misc_" prefix), so that transcript is silently
/// skipped, exactly as the Python regex does. This is real, observed NCBI
/// output (TP53's first `gene_table` entry) — preserved, not "fixed".
///
/// Returns an `IndexMap`, not a `HashMap`: Python's `dict` (3.7+) preserves
/// insertion order, and `search_gene`'s later `sort_by` (NM_ first, then
/// by exon count descending) is a *stable* sort in both languages — ties
/// break by pre-sort order, which is parse order. A `HashMap`'s
/// unspecified iteration order would silently reshuffle which same-rank
/// transcript ends up marked canonical; confirmed as a real, observed
/// divergence against a live golden-fixture replay before switching to
/// `IndexMap`, not a hypothetical concern.
pub fn parse_gene_table(text: &str, chrom: &str, chr_accession: &str, strand: Strand, gene_start: u64, gene_end: u64) -> IndexMap<String, TranscriptInfo> {
    let mrna_header_re = Regex::new(r"^(?:mRNA|ncRNA|misc_RNA)\s+(.*?)\s+((?:NM_|NR_|XM_|XR_)\S+),\s*(\d+)\s+exons?").unwrap();
    let dash_re = Regex::new(r"^-{20,}").unwrap();
    let interval_re = Regex::new(r"(\d+)-(\d+)").unwrap();
    let mrna_or_ncrna_prefix_re = Regex::new(r"^(?:mRNA|ncRNA)").unwrap();

    let mut transcripts: IndexMap<String, TranscriptInfo> = IndexMap::new();
    let mut current_tid: Option<String> = None;
    let mut in_exon_table = false;

    for raw_line in text.trim().lines() {
        let line = raw_line.trim_end();

        if let Some(caps) = mrna_header_re.captures(line) {
            let tid = caps.get(2).unwrap().as_str().to_string();
            current_tid = Some(tid.clone());
            transcripts.insert(
                tid.clone(),
                TranscriptInfo {
                    transcript_id: tid,
                    transcript_name: caps.get(1).unwrap().as_str().trim().to_string(),
                    chrom: chrom.to_string(),
                    chr_accession: chr_accession.to_string(),
                    strand,
                    exons: Vec::new(),
                    cds: Vec::new(),
                    utr5: Vec::new(),
                    utr3: Vec::new(),
                    utr: Vec::new(),
                },
            );
            in_exon_table = false;
            continue;
        }

        if dash_re.is_match(line) {
            in_exon_table = true;
            continue;
        }

        if line.starts_with("Exon table") || line.starts_with("Genomic Interval") {
            continue;
        }
        if line.starts_with("protein ") {
            continue;
        }

        if line.starts_with("Reference") || mrna_or_ncrna_prefix_re.is_match(line) {
            in_exon_table = false;
            // No `continue` here — matches Python's fallthrough exactly.
        }

        if in_exon_table {
            if let Some(tid) = &current_tid {
                if !line.trim().is_empty() {
                    let intervals: Vec<(u64, u64)> = interval_re
                        .captures_iter(line)
                        .map(|c| (c[1].parse::<u64>().unwrap(), c[2].parse::<u64>().unwrap()))
                        .collect();

                    if !intervals.is_empty() {
                        let (mut exon_s, mut exon_e) = intervals[0];
                        if exon_s > exon_e {
                            std::mem::swap(&mut exon_s, &mut exon_e);
                        }
                        let tinfo = transcripts.get_mut(tid).unwrap();
                        tinfo.exons.push((exon_s, exon_e));

                        if intervals.len() >= 2 {
                            let (mut cds_s, mut cds_e) = intervals[1];
                            if cds_s > cds_e {
                                std::mem::swap(&mut cds_s, &mut cds_e);
                            }
                            if cds_s >= gene_start.saturating_sub(1) && cds_e <= gene_end + 1 {
                                tinfo.cds.push((cds_s, cds_e));
                            }
                        }
                    }
                }
            }
        }

        if line.trim().is_empty() {
            in_exon_table = false;
        }
    }

    for tinfo in transcripts.values_mut() {
        tinfo.exons.sort();
        tinfo.cds.sort();
        let (utr5, utr3) = compute_utrs(&tinfo.exons, &tinfo.cds, tinfo.strand);
        tinfo.utr5 = utr5;
        tinfo.utr3 = utr3;
        let mut utr = tinfo.utr5.clone();
        utr.extend(tinfo.utr3.clone());
        utr.sort();
        tinfo.utr = utr;
    }

    transcripts
}

/// Direct port of `_compute_utrs`.
fn compute_utrs(exons: &[Interval], cds: &[Interval], strand: Strand) -> (Vec<Interval>, Vec<Interval>) {
    if cds.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let cds_start = cds.iter().map(|(s, _)| *s).min().unwrap();
    let cds_end = cds.iter().map(|(_, e)| *e).max().unwrap();

    let mut utr5 = Vec::new();
    let mut utr3 = Vec::new();

    for &(ex_s, ex_e) in exons {
        if strand == Strand::Plus {
            if ex_s < cds_start {
                let u_end = ex_e.min(cds_start.saturating_sub(1));
                if ex_s <= u_end {
                    utr5.push((ex_s, u_end));
                }
            }
            if ex_e > cds_end {
                let u_start = ex_s.max(cds_end + 1);
                if u_start <= ex_e {
                    utr3.push((u_start, ex_e));
                }
            }
        } else {
            if ex_e > cds_end {
                let u_start = ex_s.max(cds_end + 1);
                if u_start <= ex_e {
                    utr5.push((u_start, ex_e));
                }
            }
            if ex_s < cds_start {
                let u_end = ex_e.min(cds_start.saturating_sub(1));
                if ex_s <= u_end {
                    utr3.push((ex_s, u_end));
                }
            }
        }
    }

    utr5.sort();
    utr3.sort();
    (utr5, utr3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dnaa_prokaryote_gene_table_has_no_transcripts() {
        let text = include_str!("../tests/fixtures/dnaa_gene_table.txt");
        let transcripts = parse_gene_table(text, "", "NC_000913.3", Strand::Minus, 3882021, 3883376);
        assert!(transcripts.is_empty(), "prokaryote gene_table should parse to zero transcripts (no annotated mRNA)");
    }

    #[test]
    fn malat1_noncoding_gene_table_parses_three_ncrna_transcripts() {
        let text = include_str!("../tests/fixtures/malat1_gene_table.txt");
        let transcripts = parse_gene_table(text, "11", "NC_000011.10", Strand::Plus, 65497738, 65506516);
        assert_eq!(transcripts.len(), 3, "MALAT1 gene_table has 3 ncRNA transcript variants");

        let t2 = transcripts.get("NR_144567.1").expect("NR_144567.1 present");
        assert_eq!(t2.exons, vec![(65497738, 65498734), (65498969, 65506516)]);
        assert!(t2.cds.is_empty(), "ncRNA transcripts have no CDS");
        assert!(t2.utr5.is_empty() && t2.utr3.is_empty(), "no CDS => no UTR split (compute_utrs returns empty)");

        let t3 = transcripts.get("NR_144568.1").expect("NR_144568.1 present");
        assert_eq!(t3.exons.len(), 3);

        let t1 = transcripts.get("NR_002819.5").expect("NR_002819.5 present");
        assert_eq!(t1.exons, vec![(65499045, 65506516)]);
    }

    #[test]
    fn tp53_gene_table_skips_bare_rna_header_but_parses_mrna_entries() {
        let text = include_str!("../tests/fixtures/tp53_gene_table.txt");
        let transcripts = parse_gene_table(text, "17", "NC_000017.11", Strand::Minus, 7668421, 7687490);

        // "RNA transcript variant 14 NR_176326.1, 10 exons" does not match
        // mRNA|ncRNA|misc_RNA prefix -> must NOT appear as a parsed transcript.
        assert!(!transcripts.contains_key("NR_176326.1"), "bare 'RNA' header must be skipped, matching the Python regex exactly");

        // But real mRNA entries following it must still parse correctly.
        let t = transcripts.get("NM_001276761.3").expect("NM_001276761.3 present");
        assert_eq!(t.exons.len(), 11);
        assert!(!t.cds.is_empty(), "mRNA transcript should have CDS parsed from the second interval column");

        // Minus strand: at least one entry should show 5'UTR at higher coords.
        assert!(!t.utr.is_empty());
    }

    #[test]
    fn parse_gene_table_preserves_document_order() {
        // Regression test for a real bug: HashMap's unspecified iteration
        // order silently changed which transcript search_gene's stable
        // (NM_ first, then exon-count-descending) sort marked canonical
        // among same-rank ties, caught only by a live golden-fixture
        // replay diverging from the captured Python output. IndexMap must
        // yield transcripts in the exact order their headers appear in
        // the gene_table text.
        let text = include_str!("../tests/fixtures/tp53_gene_table.txt");
        let transcripts = parse_gene_table(text, "17", "NC_000017.11", Strand::Minus, 7668421, 7687490);
        let ids: Vec<&str> = transcripts.keys().map(String::as_str).collect();
        // First three mRNA entries in the real captured file, in order.
        assert_eq!(&ids[0..3], &["NM_001276761.3", "NM_001126112.3", "NM_001407269.1"]);
    }

    #[test]
    fn compute_utrs_plus_strand() {
        let exons = vec![(1, 100)];
        let cds = vec![(51, 80)];
        let (utr5, utr3) = compute_utrs(&exons, &cds, Strand::Plus);
        assert_eq!(utr5, vec![(1, 50)]);
        assert_eq!(utr3, vec![(81, 100)]);
    }

    #[test]
    fn compute_utrs_no_cds_returns_empty() {
        let (utr5, utr3) = compute_utrs(&[(1, 100)], &[], Strand::Plus);
        assert!(utr5.is_empty() && utr3.is_empty());
    }
}
