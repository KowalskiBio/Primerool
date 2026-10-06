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
use crate::{revcomp, strip_fasta, Feature, GeneMatch, GeneSearchResult, Interval, ProviderError, SeqType, SequenceProvider, Strand, TranscriptInfo, TranscriptSummary, VariantHit};

const EUTILS: &str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const MIN_INTERVAL: Duration = Duration::from_millis(340); // ~3 req/s, no API key

/// Caps how many `db=snp` `esearch` hits a region search will pull details
/// for. Unlike Ensembl's single `/overlap/region` call, satisfying a region
/// search here is two round-trips (`esearch` for ids, then one batched
/// `esummary` for all of them) — a low, single-digit-req/s-rate-limited API
/// with no retry, so this stays a single `esummary` batch rather than
/// chunking across many, which would multiply the very latency this
/// provider exists to avoid. A region with more hits than this is
/// silently truncated to the first `MAX_REGION_HITS` (dbSNP's own id
/// order), same trade-off UI-side pagination already makes peace with.
const MAX_REGION_HITS: usize = 200;

/// Reference cohorts trusted for a "global" minor allele frequency, in
/// preference order — matches `ensembl::extract_minor_allele`'s own
/// preference list where the underlying cohorts overlap (1000 Genomes)
/// specifically so the same variant reports the same frequency regardless
/// of which provider answered the search. `global_mafs` entries can be a
/// single handle's one-off submission (e.g. a study with `count: 1`), so
/// this doesn't fall back to "whatever's present" the way that would
/// invite noise from a single observation.
const PREFERRED_STUDIES: [&str; 5] = ["1000Genomes", "1000Genomes_30X", "GnomAD_exomes", "GnomAD_genomes", "TOPMED"];

pub struct NcbiProvider {
    client: reqwest::Client,
    last_request: Mutex<Instant>,
    transcript_cache: Arc<Mutex<HashMap<String, TranscriptInfo>>>,
}

/// Result of `resolve_accession`, mirroring `ncbi_api.py::resolve_accession`'s
/// return dict: an accession pinned to its gene, ready to become a synthetic
/// BLAST-style hit in the `/blast_sequence` route.
#[derive(Debug, Clone)]
pub struct AccessionResolution {
    pub gene_id: String,
    pub gene_symbol: Option<String>,
    pub description: String,
    pub organism: String,
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
        self.get_with_key(url, params, None, timeout).await
    }

    /// `get` plus an optional per-request NCBI API key (appended as the
    /// `api_key` query parameter). All callers go through here with `None`
    /// except the ones made key-aware by the BLAST sequence route.
    async fn get_with_key(&self, url: &str, params: &[(&str, &str)], api_key: Option<&str>, timeout: Duration) -> Result<reqwest::Response, ProviderError> {
        {
            let mut last = self.last_request.lock().await;
            let elapsed = last.elapsed();
            if elapsed < MIN_INTERVAL {
                tokio::time::sleep(MIN_INTERVAL - elapsed).await;
            }
            *last = Instant::now();
        }

        let mut req = self.client.get(url).query(params);
        if let Some(key) = api_key {
            req = req.query(&[("api_key", key)]);
        }
        let resp = req.timeout(timeout).send().await?;
        let status = resp.status().as_u16();
        if status >= 400 {
            let message = resp.text().await.unwrap_or_default();
            return Err(ProviderError::UpstreamStatus { status, message });
        }
        Ok(resp)
    }

    async fn get_json(&self, url: &str, params: &[(&str, &str)]) -> Result<Value, ProviderError> {
        self.get_json_with_key(url, params, None).await
    }

    async fn get_json_with_key(&self, url: &str, params: &[(&str, &str)], api_key: Option<&str>) -> Result<Value, ProviderError> {
        let resp = self.get_with_key(url, params, api_key, Duration::from_secs(30)).await?;
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
        Ok(strip_fasta(&text))
    }

    /// The plus-strand sequence of one GenBank accession over the 1-based
    /// inclusive range `[start, stop]`, FASTA-stripped and uppercased -
    /// what a primer's dangling BLAST-hit ends are judged against (the
    /// server route passes it to `blast::hit_flank_strings`). `Ok(None)`
    /// on any upstream error: callers degrade to leaving those primer
    /// bases unaligned rather than failing the request.
    pub async fn fetch_nuccore_range(&self, accession: &str, start: i64, stop: i64, api_key: Option<&str>) -> Result<Option<String>, ProviderError> {
        let (start_s, stop_s) = (start.to_string(), stop.to_string());
        let params = [
            ("db", "nucleotide"),
            ("id", accession),
            ("seq_start", &start_s),
            ("seq_stop", &stop_s),
            ("rettype", "fasta"),
            ("retmode", "text"),
        ];
        let resp = match self.get_with_key(&format!("{EUTILS}/efetch.fcgi"), &params, api_key, Duration::from_secs(30)).await {
            Ok(r) => r,
            Err(ProviderError::UpstreamStatus { .. }) => return Ok(None),
            Err(e) => return Err(e),
        };
        let text = resp.text().await?;
        Ok(strip_fasta(&text))
    }

    /// The genes annotated over one GenBank accession's 1-based inclusive
    /// range `[start, stop]` - which gene a BLAST hit actually lies in,
    /// from the record's own feature table rather than its title (a
    /// RefSeqGene titled after one gene also spans its neighbours).
    /// `Ok(None)` on an upstream error, so the caller can tell "lookup
    /// failed" from `Some(vec![])`, "nothing annotated there".
    pub async fn fetch_genes_at(&self, accession: &str, start: i64, stop: i64, api_key: Option<&str>) -> Result<Option<Vec<AnnotatedGene>>, ProviderError> {
        let (start_s, stop_s) = (start.to_string(), stop.to_string());
        let params = [
            ("db", "nucleotide"),
            ("id", accession),
            ("seq_start", &start_s),
            ("seq_stop", &stop_s),
            ("rettype", "ft"),
            ("retmode", "text"),
        ];
        let resp = match self.get_with_key(&format!("{EUTILS}/efetch.fcgi"), &params, api_key, Duration::from_secs(30)).await {
            Ok(r) => r,
            Err(ProviderError::UpstreamStatus { .. }) => return Ok(None),
            Err(e) => return Err(e),
        };
        let text = resp.text().await?;
        // A rate-limited or failed efetch answers 200 with an error body
        // rather than a feature table, which always starts with ">Feature".
        if !text.trim_start().starts_with(">Feature") && !text.trim().is_empty() {
            return Ok(None);
        }
        Ok(Some(parse_feature_table_genes(&text)))
    }

    /// A gene's official symbol and its other names in one organism, from
    /// NCBI Gene: the record whose symbol (else an alias) is `symbol`.
    /// Empty when nothing matches. Lets a hit labelled with an old or
    /// alternative symbol (GAPD for GAPDH) still count as the target.
    pub async fn gene_aliases(&self, symbol: &str, organism: &str, api_key: Option<&str>) -> Result<Vec<String>, ProviderError> {
        let term = format!("({symbol}[sym] OR {symbol}[gene]) AND \"{organism}\"[orgn] AND alive[prop]");
        let ids = self.esearch_ids_with_key("gene", &term, 10, api_key).await?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let esummary = self.get_json_with_key(&format!("{EUTILS}/esummary.fcgi"), &[("db", "gene"), ("id", &ids.join(",")), ("retmode", "json")], api_key).await?;
        let q = symbol.to_lowercase();
        let names = |gid: &String| -> Vec<String> {
            let g = &esummary["result"][gid.as_str()];
            let mut out = vec![g["name"].as_str().unwrap_or_default().to_string()];
            out.extend(g["otheraliases"].as_str().unwrap_or_default().split(',').map(|a| a.trim().to_string()));
            out.retain(|n| !n.is_empty());
            out
        };
        // Prefer the record whose official symbol is the query, then one
        // listing it as an alias.
        let pick = ids
            .iter()
            .find(|gid| names(gid).first().is_some_and(|n| n.to_lowercase() == q))
            .or_else(|| ids.iter().find(|gid| names(gid).iter().any(|n| n.to_lowercase() == q)));
        Ok(pick.map(names).unwrap_or_default())
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

    /// `esearch(db=snp)` by chromosome + position range, then one batched
    /// `esummary` for every hit's details — the two-round-trip analogue of
    /// Ensembl's single `/overlap/region?feature=variation` call (dbSNP's
    /// E-utils has no one-shot spatial-overlap endpoint). An empty result
    /// is the normal "no known variants here" case, not an error.
    pub async fn search_variants_in_region(&self, chrom: &str, start: u64, end: u64, species: &str) -> Result<Vec<VariantHit>, ProviderError> {
        let organism = ensembl_to_binomial_or_guess(species);
        let term = format!("{chrom}[chr] AND {start}:{end}[chrpos] AND {organism}[orgn]");
        let retmax = MAX_REGION_HITS.to_string();
        let esearch = self.get_json(&format!("{EUTILS}/esearch.fcgi"), &[("db", "snp"), ("term", &term), ("retmode", "json"), ("retmax", &retmax)]).await?;

        let ids: Vec<String> = esearch["esearchresult"]["idlist"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let id_list = ids.join(",");
        let esummary = self.get_json(&format!("{EUTILS}/esummary.fcgi"), &[("db", "snp"), ("id", &id_list), ("retmode", "json")]).await?;
        let result = &esummary["result"];

        Ok(ids.iter().filter_map(|id| parse_esummary_variant(&result[id])).collect())
    }

    /// `esummary(db=snp)` for a single id — accepts either a bare numeric
    /// dbSNP id or an `rs`-prefixed one (case-insensitive), matching what a
    /// user would paste from any dbSNP-derived source. `Ok(None)` for "not
    /// a real/known id", matching `search_gene`'s not-found convention.
    pub async fn lookup_variant_by_id(&self, variant_id: &str, _species: &str) -> Result<Option<VariantHit>, ProviderError> {
        let trimmed = variant_id.trim();
        let numeric_id = if trimmed.len() > 2 && trimmed[..2].eq_ignore_ascii_case("rs") { &trimmed[2..] } else { trimmed };
        if numeric_id.is_empty() || !numeric_id.bytes().all(|b| b.is_ascii_digit()) {
            return Ok(None);
        }

        let esummary = self.get_json(&format!("{EUTILS}/esummary.fcgi"), &[("db", "snp"), ("id", numeric_id), ("retmode", "json")]).await?;
        Ok(parse_esummary_variant(&esummary["result"][numeric_id]))
    }

    /// Port of `ncbi_api.py::_esearch_ids`.
    async fn esearch_ids(&self, db: &str, term: &str, retmax: usize) -> Result<Vec<String>, ProviderError> {
        self.esearch_ids_with_key(db, term, retmax, None).await
    }

    async fn esearch_ids_with_key(&self, db: &str, term: &str, retmax: usize, api_key: Option<&str>) -> Result<Vec<String>, ProviderError> {
        let retmax = retmax.to_string();
        let esearch = self.get_json_with_key(&format!("{EUTILS}/esearch.fcgi"), &[("db", db), ("term", term), ("retmode", "json"), ("retmax", &retmax)], api_key).await?;
        Ok(esearch["esearchresult"]["idlist"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default())
    }

    /// Port of `ncbi_api.py::_rank_name_candidates`: pick the candidate
    /// that truly matches `query` by name. An All-Fields esearch also
    /// surfaces genes whose summary text merely mentions the query
    /// (searching "casein" in Homo sapiens returns EGFR/TP53 because
    /// their summaries mention casein), so only a real name match is
    /// accepted — anything else is "not found" rather than a wrong gene.
    /// Rank: exact symbol > description starts-with > exact alias >
    /// description contains. Ties keep esearch relevance order
    /// (`min_by_key`/`min` both return the first of equal minima).
    /// Also returns *how* the winner matched, so a non-symbol hit is
    /// reported as such instead of passed off as the gene asked for, and
    /// the winner's own esummary record, so `search_gene` needn't fetch it
    /// a second time (NCBI allows only ~3 req/s without an API key).
    async fn rank_name_candidates(&self, query: &str, ids: &[String]) -> Result<Option<(String, GeneMatch, Value)>, ProviderError> {
        if ids.is_empty() {
            return Ok(None);
        }
        let id_list = ids.join(",");
        let esummary = self.get_json(&format!("{EUTILS}/esummary.fcgi"), &[("db", "gene"), ("id", &id_list), ("retmode", "json")]).await?;
        let result = &esummary["result"];
        let q = query.to_lowercase();

        let score = |gid: &str| -> u8 {
            let g = &result[gid];
            let symbol = g["name"].as_str().unwrap_or_default().to_lowercase();
            let desc = g["description"].as_str().unwrap_or_default().to_lowercase();
            let aliases = g["otheraliases"].as_str().unwrap_or_default().to_lowercase();
            if symbol == q {
                0
            } else if desc.starts_with(&q) {
                1
            } else if aliases.split(',').map(str::trim).any(|a| a == q) {
                2
            } else if desc.contains(&q) {
                3
            } else {
                99
            }
        };

        match ids.iter().min_by_key(|gid| score(gid)) {
            Some(best) => {
                let kind = match score(best) {
                    0 => GeneMatch::Symbol,
                    2 => GeneMatch::Alias,
                    99 => return Ok(None),
                    _ => GeneMatch::Name,
                };
                Ok(Some((best.clone(), kind, result[best.as_str()].clone())))
            }
            None => Ok(None),
        }
    }

    /// Port of `ncbi_api.py::_elink_protein_to_gene`. No callers right now
    /// (the only protein->gene path, `resolve_accession`, runs with a key) —
    /// kept as the keyless entry point for parity with the other helpers.
    #[allow(dead_code)]
    async fn elink_protein_to_gene(&self, protein_uid: &str) -> Result<Vec<String>, ProviderError> {
        self.elink_protein_to_gene_with_key(protein_uid, None).await
    }

    async fn elink_protein_to_gene_with_key(&self, protein_uid: &str, api_key: Option<&str>) -> Result<Vec<String>, ProviderError> {
        let elink = self.get_json_with_key(&format!("{EUTILS}/elink.fcgi"), &[("dbfrom", "protein"), ("db", "gene"), ("id", protein_uid), ("retmode", "json")], api_key).await?;
        let mut ids: Vec<String> = Vec::new();
        for linkset in elink["linksets"].as_array().into_iter().flatten() {
            for dbs in linkset["linksetdbs"].as_array().into_iter().flatten() {
                for link in dbs["links"].as_array().into_iter().flatten() {
                    if let Some(id) = link.as_str().map(str::to_string).or_else(|| link.as_i64().map(|n| n.to_string())) {
                        ids.push(id);
                    }
                }
            }
        }
        Ok(ids)
    }

    /// Port of `ncbi_api.py::resolve_accession`: resolve a
    /// nucleotide/protein accession directly to its gene via E-utilities —
    /// instant, unlike the BLAST path, which is blastn-only and cannot
    /// handle protein accessions (NP_, XP_, UniProt 'P' IDs) at all.
    /// Nucleotide accessions (NM_, NR_, XM_, XR_) are indexed in the gene
    /// db; protein accessions go protein-uid -> elink -> gene.
    pub async fn resolve_accession(&self, accession: &str) -> Result<Option<AccessionResolution>, ProviderError> {
        self.resolve_accession_with_key(accession, None).await
    }

    /// `resolve_accession` carrying a per-request NCBI API key through to
    /// every E-utilities round-trip it makes.
    pub async fn resolve_accession_with_key(&self, accession: &str, api_key: Option<&str>) -> Result<Option<AccessionResolution>, ProviderError> {
        let base = accession.trim().split('.').next().unwrap_or_default();
        if base.is_empty() {
            return Ok(None);
        }

        let mut ids = self.esearch_ids_with_key("gene", &format!("{base}[accn]"), 20, api_key).await?;
        if ids.is_empty() {
            let pids = self.esearch_ids_with_key("protein", &format!("{base}[accn]"), 20, api_key).await?;
            if let Some(pid) = pids.first() {
                ids = self.elink_protein_to_gene_with_key(pid, api_key).await?;
            }
        }
        let Some(gene_id) = ids.into_iter().next() else {
            return Ok(None);
        };

        let esummary = self.get_json_with_key(&format!("{EUTILS}/esummary.fcgi"), &[("db", "gene"), ("id", &gene_id), ("retmode", "json")], api_key).await?;
        let summary = &esummary["result"][&gene_id];
        Ok(Some(AccessionResolution {
            gene_id,
            gene_symbol: summary["name"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
            description: summary["description"].as_str().unwrap_or_default().to_string(),
            organism: summary["organism"]["scientificname"].as_str().unwrap_or_default().to_string(),
        }))
    }
}

/// One `esummary(db=snp)` record -> `VariantHit`. `None` for a uid that
/// didn't come back at all (rare: an id NCBI's `esearch` returned but
/// `esummary` doesn't recognize) or is missing the position data
/// (`chrpos`) a row can't be meaningfully shown without.
fn parse_esummary_variant(obj: &Value) -> Option<VariantHit> {
    let snp_id = obj.get("snp_id").and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))?;
    let chrpos = obj.get("chrpos").and_then(|v| v.as_str())?;
    let (chrom, pos_str) = chrpos.split_once(':')?;
    let start: u64 = pos_str.parse().ok()?;

    // SPDI (`seq_id:0-based-pos:deleted:inserted`) gives the reference
    // ("deleted") allele's length, so a multi-base deletion's genomic span
    // is reported accurately rather than collapsing every variant to a
    // single-base row. Falls back to a single-base span if `spdi` is
    // absent/unparseable — `chrpos` alone has no length information.
    let mut alleles = Vec::new();
    let mut end = start;
    if let Some(spdi) = obj.get("spdi").and_then(|v| v.as_str()) {
        let parts: Vec<&str> = spdi.split(':').collect();
        if let [_, _, deleted, inserted] = parts[..] {
            if !deleted.is_empty() {
                end = start + deleted.len() as u64 - 1;
                alleles.push(deleted.to_string());
            }
            alleles.push(inserted.to_string());
        }
    }

    let consequence_type = obj.get("fxn_class").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.split(',').next().unwrap_or(s).to_string());

    // NCBI hyphenates multi-word terms ("likely-benign"); Ensembl (and
    // this app's display) uses spaces ("likely benign") — normalized here
    // so the same term reads identically regardless of data source.
    let clinical_significance = obj
        .get("clinical_significance")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.split(',').map(|term| term.trim().replace('-', " ")).collect())
        .unwrap_or_default();

    let (minor_allele_freq, minor_allele) = obj.get("global_mafs").and_then(|v| v.as_array()).map(|mafs| extract_minor_allele(mafs)).unwrap_or((None, None));

    Some(VariantHit {
        id: format!("rs{snp_id}"),
        chrom: chrom.to_string(),
        start,
        end,
        alleles,
        strand: 1,
        consequence_type,
        clinical_significance,
        minor_allele_freq,
        minor_allele,
    })
}

/// `global_mafs` entries look like `{"study": "1000Genomes", "freq":
/// "T=0.0750799/376"}` — `allele=frequency/allele_count`. Picks the first
/// preferred-cohort entry present (see `PREFERRED_STUDIES`), not the
/// largest or first-listed, so a variant lacking any of those trusted
/// cohorts reports no frequency at all rather than a single handle's
/// noisy one-off submission.
fn extract_minor_allele(global_mafs: &[Value]) -> (Option<f64>, Option<String>) {
    for &study in PREFERRED_STUDIES.iter() {
        let Some(freq_str) = global_mafs.iter().find(|m| m.get("study").and_then(|v| v.as_str()) == Some(study)).and_then(|m| m.get("freq")).and_then(|v| v.as_str()) else {
            continue;
        };
        if let Some((allele, freq)) = freq_str.split_once('=').and_then(|(allele, rest)| rest.split_once('/').map(|(freq, _count)| (allele, freq))) {
            if let Ok(freq) = freq.parse::<f64>() {
                return (Some(freq), Some(allele.to_string()));
            }
        }
    }
    (None, None)
}

#[async_trait::async_trait]
impl SequenceProvider for NcbiProvider {
    async fn search_gene(&self, gene_name: &str, species: &str) -> Result<Option<GeneSearchResult>, ProviderError> {
        let gene_name = gene_name.trim();
        let organism = ensembl_to_binomial_or_guess(species);

        // Step 1: esearch -> gene ID
        // 1a: exact symbol match (fast path, e.g. MTHFR)
        // `[sym]` matches aliases too, in no useful order - "CSN2" returns
        // COPS2 (alias CSN2) ahead of CSN2 itself - so rank the hits rather
        // than taking the first.
        let term = format!("{gene_name}[sym] AND {organism}[orgn]");
        let ids = self.esearch_ids("gene", &term, 20).await?;
        let ranked = self.rank_name_candidates(gene_name, &ids).await?;
        let (gene_id, matched_by, summary) = match ranked {
            Some(hit) => hit,
            None => {
                // 1b: name/protein-family fallback (e.g. "casein" -> CSN2),
                // ranked strictly so summary-text mentions never win
                let term2 = format!("{gene_name} AND {organism}[orgn]");
                let candidates = self.esearch_ids("gene", &term2, 50).await?;
                match self.rank_name_candidates(gene_name, &candidates).await? {
                    Some(hit) => hit,
                    None => return Ok(None),
                }
            }
        };

        // Step 2: gene info - the winner's esummary record, already
        // fetched by `rank_name_candidates` above.
        let summary = &summary;

        // Official symbol (e.g. "casein" -> "CSN2", "mthfr" -> "MTHFR") —
        // what the frontend displays and downstream searches should use.
        let official_name = summary["name"].as_str().filter(|s| !s.is_empty()).unwrap_or(gene_name).to_string();

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
            let syn_id = format!("{official_name}_CDS");
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
                    transcript_name: format!("{official_name} (CDS)"),
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
            gene_name: official_name,
            matched_by,
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

    async fn build_spliced_sequence(&self, tinfo: &TranscriptInfo, feature: Feature, _species: &str, orient_plus: bool) -> Result<Option<String>, ProviderError> {
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
                // Fetched by accession, this is the transcript in its own
                // (gene-sense) orientation - flip it back when the caller
                // asked for the genomic plus strand.
                if orient_plus && tinfo.strand == Strand::Minus {
                    return Ok(Some(revcomp(&seq).to_uppercase()));
                }
                return Ok(Some(seq.to_uppercase()));
            }
        }

        if !tinfo.transcript_id.is_empty() && feature == Feature::Cds {
            if let Some(mrna) = self.get_sequence_by_id(&tinfo.transcript_id, SeqType::Genomic).await? {
                // Slice the CDS out of the accession-fetched mRNA (always
                // gene-sense) - in plus orientation the same transcript
                // interval holds the plus-strand CDS, reverse-complemented.
                let cds_ann = crate::coords::cds_annotations_in_transcript_coords(tinfo);
                if let (Some(first), Some(last)) = (cds_ann.first(), cds_ann.last()) {
                    let cds_start = first.0 as usize;
                    let cds_end = last.1 as usize;
                    if cds_start <= mrna.len() && cds_end <= mrna.len() && cds_start <= cds_end {
                        let slice = &mrna[cds_start..cds_end];
                        return Ok(Some(if orient_plus && tinfo.strand == Strand::Minus {
                            revcomp(slice).to_uppercase()
                        } else {
                            slice.to_uppercase()
                        }));
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
        if tinfo.strand == Strand::Minus && !orient_plus {
            full = revcomp(&full);
        }
        Ok(Some(full.to_uppercase()))
    }

    async fn build_genomic_sequence(&self, tinfo: &TranscriptInfo, _species: &str, orient_plus: bool) -> Result<Option<String>, ProviderError> {
        if tinfo.exons.is_empty() {
            return Ok(None);
        }
        let gene_start = tinfo.exons.iter().map(|(s, _)| *s).min().unwrap();
        let gene_end = tinfo.exons.iter().map(|(_, e)| *e).max().unwrap();

        let seq = match self.fetch_region_sequence(&tinfo.chrom, &tinfo.chr_accession, gene_start, gene_end).await? {
            Some(seq) => seq,
            None => return Ok(None),
        };
        let seq = if tinfo.strand == Strand::Minus && !orient_plus { revcomp(&seq) } else { seq };
        Ok(Some(seq.to_uppercase()))
    }

    async fn get_flanking_sequence(
        &self,
        tinfo: &TranscriptInfo,
        upstream_bp: u64,
        downstream_bp: u64,
        use_cds_anchor: bool,
        _species: &str,
        orient_plus: bool,
    ) -> Result<(String, String), ProviderError> {
        if tinfo.exons.is_empty() {
            return Ok((String::new(), String::new()));
        }

        let (anchor_start, anchor_end) = if use_cds_anchor && !tinfo.cds.is_empty() {
            (tinfo.cds.iter().map(|(s, _)| *s).min().unwrap(), tinfo.cds.iter().map(|(_, e)| *e).max().unwrap())
        } else {
            (tinfo.exons.iter().map(|(s, _)| *s).min().unwrap(), tinfo.exons.iter().map(|(_, e)| *e).max().unwrap())
        };

        if tinfo.strand == Strand::Plus || orient_plus {
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

/// One gene a GenBank record annotates (see `fetch_genes_at`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct AnnotatedGene {
    pub symbol: String,
    pub synonyms: Vec<String>,
    /// NCBI Gene ID, when the feature cross-references one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gene_id: Option<String>,
}

/// The genes in an efetch `rettype=ft` feature table: every feature
/// carrying a `gene` qualifier (gene features, but also mRNA/CDS ones in
/// records without a separate gene feature), merged per symbol with their
/// `gene_syn` synonyms and `db_xref GeneID:`. Feature header lines are
/// `<from>\t<to>\t<type>`, extra intervals `<from>\t<to>`, qualifiers
/// `\t\t\t<key>\t<value>`.
pub fn parse_feature_table_genes(text: &str) -> Vec<AnnotatedGene> {
    let mut genes: Vec<AnnotatedGene> = Vec::new();
    let mut current: Option<AnnotatedGene> = None;
    let flush = |g: Option<AnnotatedGene>, genes: &mut Vec<AnnotatedGene>| {
        let Some(g) = g else { return };
        if g.symbol.is_empty() {
            return;
        }
        match genes.iter_mut().find(|e| e.symbol == g.symbol) {
            Some(e) => {
                for syn in g.synonyms {
                    if !e.synonyms.contains(&syn) {
                        e.synonyms.push(syn);
                    }
                }
                if e.gene_id.is_none() {
                    e.gene_id = g.gene_id;
                }
            }
            None => genes.push(g),
        }
    };
    for line in text.lines() {
        if line.starts_with('>') || line.trim().is_empty() {
            continue;
        }
        if let Some(q) = line.strip_prefix("\t\t\t") {
            let Some(g) = current.as_mut() else { continue };
            let mut kv = q.splitn(2, '\t');
            let (key, value) = (kv.next().unwrap_or(""), kv.next().unwrap_or("").trim());
            match key {
                "gene" if g.symbol.is_empty() => g.symbol = value.to_string(),
                "gene_syn" if !value.is_empty() && !g.synonyms.iter().any(|s| s == value) => g.synonyms.push(value.to_string()),
                "db_xref" => {
                    if let Some(id) = value.strip_prefix("GeneID:") {
                        g.gene_id.get_or_insert_with(|| id.to_string());
                    }
                }
                _ => {}
            }
            continue;
        }
        // A new feature header (3 columns) starts a feature; an extra
        // interval of the current one (2 columns) changes nothing.
        if line.split('\t').filter(|c| !c.is_empty()).count() >= 3 {
            flush(current.take(), &mut genes);
            current = Some(AnnotatedGene { symbol: String::new(), synonyms: Vec::new(), gene_id: None });
        }
    }
    flush(current.take(), &mut genes);
    genes
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

    #[test]
    fn parse_esummary_variant_extracts_snv_with_frequency() {
        // Shape of a real `esummary(db=snp)` record for rs7412 (trimmed to
        // the fields this parser reads).
        let obj = serde_json::json!({
            "snp_id": 7412,
            "chr": "19",
            "chrpos": "19:44908822",
            "spdi": "NC_000019.10:44908821:C:T",
            "fxn_class": "missense_variant,coding_sequence_variant",
            "clinical_significance": "drug-response,risk-factor,benign,likely-benign",
            "global_mafs": [
                {"study": "1000Genomes", "freq": "T=0.0750799/376"},
                {"study": "TOPMED", "freq": "T=0.0781216/20678"},
            ],
        });
        let hit = parse_esummary_variant(&obj).expect("should parse");
        assert_eq!(hit.id, "rs7412");
        assert_eq!(hit.chrom, "19");
        assert_eq!(hit.start, 44908822);
        assert_eq!(hit.end, 44908822); // single-base deleted_sequence "C" -> span of 1
        assert_eq!(hit.alleles, vec!["C".to_string(), "T".to_string()]);
        assert_eq!(hit.consequence_type.as_deref(), Some("missense_variant"));
        assert_eq!(hit.clinical_significance, vec!["drug response", "risk factor", "benign", "likely benign"]);
        assert_eq!(hit.minor_allele.as_deref(), Some("T")); // prefers 1000Genomes over TOPMED
        assert!((hit.minor_allele_freq.unwrap() - 0.0750799).abs() < 1e-6);
    }

    #[test]
    fn parse_esummary_variant_multibase_deletion_spans_correctly() {
        let obj = serde_json::json!({
            "snp_id": 123,
            "chr": "1",
            "chrpos": "1:1000",
            "spdi": "NC_000001.11:999:AAA:A",
        });
        let hit = parse_esummary_variant(&obj).expect("should parse");
        assert_eq!(hit.start, 1000);
        assert_eq!(hit.end, 1002); // 3-base deletion spans positions 1000-1002
    }

    #[test]
    fn parse_esummary_variant_missing_chrpos_returns_none() {
        let obj = serde_json::json!({"snp_id": 123, "chr": "1"});
        assert!(parse_esummary_variant(&obj).is_none());
    }

    #[test]
    fn extract_minor_allele_skips_unrecognized_singleton_study() {
        // Only a single-observation study present (e.g. one lab's GNOMAD
        // submission) — none of PREFERRED_STUDIES matches "SGDP_PRJ", so
        // this must report no frequency rather than a noisy singleton.
        let mafs = serde_json::json!([{"study": "SGDP_PRJ", "freq": "C=0.453125/29"}]);
        assert_eq!(extract_minor_allele(mafs.as_array().unwrap()), (None, None));
    }

    #[test]
    fn extract_minor_allele_prefers_1000genomes_over_gnomad() {
        let mafs = serde_json::json!([
            {"study": "GnomAD_exomes", "freq": "T=0.0740017/98492"},
            {"study": "1000Genomes", "freq": "T=0.0750799/376"},
        ]);
        let (freq, allele) = extract_minor_allele(mafs.as_array().unwrap());
        assert_eq!(allele.as_deref(), Some("T"));
        assert!((freq.unwrap() - 0.0750799).abs() < 1e-6);
    }

    #[test]
    fn feature_table_genes_merge_per_symbol_with_synonyms_and_id() {
        let ft = ">Feature ref|NG_028283.4|\n<1\t>20\tgene\n\t\t\tgene\tVEGFA\n\t\t\tgene_syn\tVEGF\n\t\t\tgene_syn\tVPF\n\t\t\tgene_desc\tvascular endothelial growth factor A\n\t\t\tdb_xref\tGeneID:7422\n<1\t>20\tmRNA\n5\t9\n\t\t\tgene\tVEGFA\n\t\t\tproduct\tvascular endothelial growth factor A\n<1\t>20\tCDS\n\t\t\tproduct\tsome protein\n";
        let genes = parse_feature_table_genes(ft);
        assert_eq!(genes, vec![AnnotatedGene { symbol: "VEGFA".into(), synonyms: vec!["VEGF".into(), "VPF".into()], gene_id: Some("7422".into()) }]);
    }

    #[test]
    fn feature_table_without_genes_is_empty() {
        assert!(parse_feature_table_genes(">Feature gb|AC006064.1|\n").is_empty());
        assert!(parse_feature_table_genes(">Feature gb|M10277.1|\n<1\t>21\tCDS\n\t\t\tproduct\tbeta-actin\n").is_empty());
    }
}
