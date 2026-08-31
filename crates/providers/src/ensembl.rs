//! Ensembl REST API provider, ported from `ensembl_api.py`.
//!
//! Rate-limited to ~14 req/s (`_MIN_INTERVAL = 0.07`), 3-attempt retry with
//! exponential backoff on connection/timeout errors, honors `Retry-After`
//! on HTTP 429 (which also consumes one of the 3 attempts, exactly as the
//! Python `for attempt in range(3): ... continue` structure does).
//! `search_gene`/`get_transcript_details` results are cached (maxsize 256,
//! LRU), mirroring `@lru_cache(maxsize=256)` — only successful lookups
//! (including a cached `None` for "not found") are cached; errors are
//! never cached, matching `lru_cache`'s behavior of not caching a raised
//! exception.

use std::sync::Arc;
use std::time::{Duration, Instant};

use lru::LruCache;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    revcomp, Feature, GeneSearchResult, Interval, ProviderError, SeqType, SequenceProvider, Strand, TranscriptInfo,
    TranscriptSummary,
};

const ENSEMBL_REST: &str = "https://rest.ensembl.org";
const MIN_INTERVAL: Duration = Duration::from_millis(70); // ~14 req/s

/// A known variant (SNP/indel) returned by Ensembl's
/// `/overlap/region?feature=variation` — dbSNP-backed. `alleles` order is
/// NOT guaranteed ref-first by Ensembl; callers must let the user confirm
/// which allele is which, never assume `alleles[0]` is the reference.
#[derive(Debug, Clone, serde::Serialize)]
pub struct VariantHit {
    pub id: String,
    /// 1-based inclusive genomic.
    pub start: u64,
    pub end: u64,
    pub alleles: Vec<String>,
    pub strand: i8,
    pub consequence_type: Option<String>,
    pub clinical_significance: Vec<String>,
}

pub struct EnsemblProvider {
    client: reqwest::Client,
    last_request: Mutex<Instant>,
    search_gene_cache: Mutex<LruCache<(String, String), Option<GeneSearchResult>>>,
    transcript_cache: Mutex<LruCache<String, Option<TranscriptInfo>>>,
    variant_region_cache: Mutex<LruCache<(String, u64, u64, String), Vec<VariantHit>>>,
}

impl Default for EnsemblProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl EnsemblProvider {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            last_request: Mutex::new(Instant::now() - Duration::from_secs(1)),
            search_gene_cache: Mutex::new(LruCache::new(std::num::NonZeroUsize::new(256).unwrap())),
            transcript_cache: Mutex::new(LruCache::new(std::num::NonZeroUsize::new(256).unwrap())),
            variant_region_cache: Mutex::new(LruCache::new(std::num::NonZeroUsize::new(256).unwrap())),
        }
    }

    /// `GET /overlap/region/:species/:region?feature=variation` — known
    /// variants (dbSNP-backed) overlapping a genomic region. An empty
    /// result is the normal "no known variants here" case, not an error.
    pub async fn search_variants_in_region(&self, chrom: &str, start: u64, end: u64, species: &str) -> Result<Vec<VariantHit>, ProviderError> {
        let cache_key = (chrom.to_string(), start, end, species.to_string());
        if let Some(hit) = self.variant_region_cache.lock().await.get(&cache_key) {
            return Ok(hit.clone());
        }

        let region = format!("{chrom}:{start}..{end}:1"); // same format as fetch_region_sequence
        let data = self.get_json(&format!("/overlap/region/{species}/{region}"), &[("feature", "variation")]).await?;

        let hits: Vec<VariantHit> = data
            .as_array()
            .map(|arr| arr.iter().map(Self::parse_variant_hit).collect())
            .unwrap_or_default();

        self.variant_region_cache.lock().await.put(cache_key, hits.clone());
        Ok(hits)
    }

    fn parse_variant_hit(v: &Value) -> VariantHit {
        VariantHit {
            id: v.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
            start: v.get("start").and_then(|x| x.as_u64()).unwrap_or(0),
            end: v.get("end").and_then(|x| x.as_u64()).unwrap_or(0),
            alleles: v
                .get("alleles")
                .and_then(|x| x.as_array())
                .map(|arr| arr.iter().filter_map(|a| a.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            strand: v.get("strand").and_then(|x| x.as_i64()).unwrap_or(1) as i8,
            consequence_type: v.get("consequence_type").and_then(|x| x.as_str()).map(str::to_string),
            clinical_significance: v
                .get("clinical_significance")
                .and_then(|x| x.as_array())
                .map(|arr| arr.iter().filter_map(|a| a.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
        }
    }

    /// Direct port of `ensembl_api.py::_get`: rate-limited GET with 3-attempt
    /// retry/backoff on connection errors and Retry-After handling on 429.
    async fn get_json(&self, endpoint: &str, params: &[(&str, &str)]) -> Result<Value, ProviderError> {
        let url = format!("{ENSEMBL_REST}{endpoint}");

        for attempt in 0..3u32 {
            {
                let mut last = self.last_request.lock().await;
                let elapsed = last.elapsed();
                if elapsed < MIN_INTERVAL {
                    tokio::time::sleep(MIN_INTERVAL - elapsed).await;
                }
                *last = Instant::now();
            }

            let send_result = self
                .client
                .get(&url)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .query(params)
                .timeout(Duration::from_secs(60))
                .send()
                .await;

            let resp = match send_result {
                Ok(resp) => resp,
                Err(e) if e.is_timeout() || e.is_connect() => {
                    if attempt < 2 {
                        let backoff = 2u64.pow(attempt + 1);
                        tokio::time::sleep(Duration::from_secs(backoff)).await;
                        continue;
                    }
                    return Err(e.into());
                }
                Err(e) => return Err(e.into()),
            };

            if resp.status().as_u16() == 429 {
                let retry_after: f64 = resp
                    .headers()
                    .get("Retry-After")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(2.0);
                tokio::time::sleep(Duration::from_secs_f64(retry_after)).await;
                continue;
            }

            let status = resp.status().as_u16();
            if status >= 400 {
                let message = resp.text().await.unwrap_or_default();
                return Err(ProviderError::UpstreamStatus { status, message });
            }

            return resp.json::<Value>().await.map_err(Into::into);
        }

        Err(ProviderError::Failed("Ensembl API request failed after 3 attempts".into()))
    }

    async fn fetch_sequence_by_id(&self, ensembl_id: &str, seq_type: SeqType) -> Result<Option<String>, ProviderError> {
        // Python: `except requests.HTTPError: return None` — blanket, unlike
        // search_gene/get_transcript_details which only swallow specific codes.
        match self.get_json(&format!("/sequence/id/{ensembl_id}"), &[("type", seq_type.as_ensembl_str())]).await {
            Ok(data) => Ok(data.get("seq").and_then(|v| v.as_str()).map(|s| s.to_string())),
            Err(ProviderError::UpstreamStatus { .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn fetch_region_sequence(&self, chrom: &str, start: u64, end: u64, species: &str) -> Result<Option<String>, ProviderError> {
        if end < start {
            return Ok(Some(String::new()));
        }
        let region = format!("{chrom}:{start}..{end}:1"); // always plus-strand; revcomp locally
        match self.get_json(&format!("/sequence/region/{species}/{region}"), &[]).await {
            Ok(data) => Ok(data.get("seq").and_then(|v| v.as_str()).map(|s| s.to_string())),
            Err(ProviderError::UpstreamStatus { .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn parse_gene_search(gene_name: &str, data: &Value) -> Option<GeneSearchResult> {
        if data.get("object_type").and_then(|v| v.as_str()) != Some("Gene") {
            return None;
        }

        let transcripts = data
            .get("Transcript")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|t| {
                        let id = t.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                        TranscriptSummary {
                            name: t.get("display_name").and_then(|v| v.as_str()).unwrap_or(&id).to_string(),
                            biotype: t.get("biotype").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                            strand: Strand::from_ensembl_i8(t.get("strand").and_then(|v| v.as_i64()).unwrap_or(1)),
                            exon_count: t.get("Exon").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
                            is_canonical: t.get("is_canonical").map(truthy).unwrap_or(false),
                            id,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        Some(GeneSearchResult {
            gene_name: gene_name.to_string(),
            gene_id: data.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            chrom: data.get("seq_region_name").map(value_to_display_string).unwrap_or_default(),
            strand: Strand::from_ensembl_i8(data.get("strand").and_then(|v| v.as_i64()).unwrap_or(1)),
            start: data.get("start").and_then(|v| v.as_u64()).unwrap_or(0),
            end: data.get("end").and_then(|v| v.as_u64()).unwrap_or(0),
            transcripts,
        })
    }

    fn parse_transcript_details(transcript_id: &str, data: &Value) -> TranscriptInfo {
        let chrom = data.get("seq_region_name").map(value_to_display_string).unwrap_or_default();
        let strand = Strand::from_ensembl_i8(data.get("strand").and_then(|v| v.as_i64()).unwrap_or(1));

        let mut exons: Vec<Interval> = data
            .get("Exon")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|ex| {
                        let s = ex.get("start")?.as_u64()?;
                        let e = ex.get("end")?.as_u64()?;
                        Some((s, e))
                    })
                    .collect()
            })
            .unwrap_or_default();
        exons.sort();

        let mut cds: Vec<Interval> = Vec::new();
        let mut utr5: Vec<Interval> = Vec::new();
        let mut utr3: Vec<Interval> = Vec::new();

        if let Some(translation) = data.get("Translation") {
            let cds_start = translation.get("start").and_then(|v| v.as_u64());
            let cds_end = translation.get("end").and_then(|v| v.as_u64());
            if let (Some(cds_genomic_start), Some(cds_genomic_end)) = (cds_start, cds_end) {
                for &(ex_start, ex_end) in &exons {
                    let ov_start = ex_start.max(cds_genomic_start);
                    let ov_end = ex_end.min(cds_genomic_end);
                    if ov_start <= ov_end {
                        cds.push((ov_start, ov_end));
                    }

                    if strand == Strand::Plus {
                        if ex_start < cds_genomic_start {
                            let utr5_end = ex_end.min(cds_genomic_start - 1);
                            if ex_start <= utr5_end {
                                utr5.push((ex_start, utr5_end));
                            }
                        }
                        if ex_end > cds_genomic_end {
                            let utr3_start = ex_start.max(cds_genomic_end + 1);
                            if utr3_start <= ex_end {
                                utr3.push((utr3_start, ex_end));
                            }
                        }
                    } else {
                        if ex_end > cds_genomic_end {
                            let utr5_start = ex_start.max(cds_genomic_end + 1);
                            if utr5_start <= ex_end {
                                utr5.push((utr5_start, ex_end));
                            }
                        }
                        if ex_start < cds_genomic_start {
                            let utr3_end = ex_end.min(cds_genomic_start - 1);
                            if ex_start <= utr3_end {
                                utr3.push((ex_start, utr3_end));
                            }
                        }
                    }
                }
            }
        }

        cds.sort();
        utr5.sort();
        utr3.sort();
        let mut utr = utr5.clone();
        utr.extend(utr3.clone());
        utr.sort();

        TranscriptInfo {
            transcript_name: data.get("display_name").and_then(|v| v.as_str()).unwrap_or(transcript_id).to_string(),
            transcript_id: transcript_id.to_string(),
            chr_accession: String::new(), // Ensembl doesn't need one; region lookups use species+chrom
            chrom,
            strand,
            exons,
            cds,
            utr5,
            utr3,
            utr,
        }
    }
}

/// Ensembl's `is_canonical` field is an integer 0/1, not a JSON bool.
/// Python does `bool(t.get("is_canonical", False))`, so replicate Python's
/// truthiness: 0/0.0/""/null/false are falsy, everything else is truthy.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Null => false,
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn value_to_display_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

#[async_trait::async_trait]
impl SequenceProvider for EnsemblProvider {
    async fn search_gene(&self, gene_name: &str, species: &str) -> Result<Option<GeneSearchResult>, ProviderError> {
        let gene_name = gene_name.trim();
        let cache_key = (gene_name.to_string(), species.to_string());
        if let Some(hit) = self.search_gene_cache.lock().await.get(&cache_key) {
            return Ok(hit.clone());
        }

        let result = match self.get_json(&format!("/lookup/symbol/{species}/{gene_name}"), &[("expand", "1")]).await {
            Ok(data) => Self::parse_gene_search(gene_name, &data),
            Err(e) if e.is_not_found(&[400, 404]) => None,
            Err(e) => return Err(e),
        };

        self.search_gene_cache.lock().await.put(cache_key, result.clone());
        Ok(result)
    }

    async fn get_transcript_details(&self, transcript_id: &str) -> Result<Option<TranscriptInfo>, ProviderError> {
        if let Some(hit) = self.transcript_cache.lock().await.get(transcript_id) {
            return Ok(hit.clone());
        }

        let result = match self.get_json(&format!("/lookup/id/{transcript_id}"), &[("expand", "1")]).await {
            Ok(data) => Some(Self::parse_transcript_details(transcript_id, &data)),
            Err(e) if e.is_not_found(&[404]) => None,
            Err(e) => return Err(e),
        };

        self.transcript_cache.lock().await.put(transcript_id.to_string(), result.clone());
        Ok(result)
    }

    async fn get_sequence_by_id(&self, id: &str, seq_type: SeqType) -> Result<Option<String>, ProviderError> {
        self.fetch_sequence_by_id(id, seq_type).await
    }

    async fn get_region_sequence(&self, _tinfo: &TranscriptInfo, start: u64, end: u64, species: &str) -> Result<Option<String>, ProviderError> {
        // Ensembl resolves regions by species + chrom, not by an accession
        // carried on tinfo — chrom is passed by the caller via tinfo.chrom
        // in the higher-level helpers below, so this trait method exists
        // mainly to satisfy the shared interface; callers here use
        // fetch_region_sequence directly with tinfo.chrom.
        self.fetch_region_sequence(&_tinfo.chrom, start, end, species).await
    }

    async fn build_spliced_sequence(&self, tinfo: &TranscriptInfo, feature: Feature, species: &str) -> Result<Option<String>, ProviderError> {
        let intervals: &[Interval] = match feature {
            Feature::Exons => &tinfo.exons,
            Feature::Cds => &tinfo.cds,
        };
        if intervals.is_empty() {
            return Ok(None);
        }

        if !tinfo.transcript_id.is_empty() {
            let seq_type = if feature == Feature::Cds { SeqType::Cds } else { SeqType::Cdna };
            if let Some(seq) = self.fetch_sequence_by_id(&tinfo.transcript_id, seq_type).await? {
                if !seq.is_empty() {
                    return Ok(Some(seq.to_uppercase()));
                }
            }
        }

        let mut intervals_sorted = intervals.to_vec();
        intervals_sorted.sort();

        let mut parts = Vec::with_capacity(intervals_sorted.len());
        for (start, end) in intervals_sorted {
            match self.fetch_region_sequence(&tinfo.chrom, start, end, species).await? {
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

    async fn build_genomic_sequence(&self, tinfo: &TranscriptInfo, species: &str) -> Result<Option<String>, ProviderError> {
        if tinfo.exons.is_empty() {
            return Ok(None);
        }
        let gene_start = tinfo.exons.iter().map(|(s, _)| *s).min().unwrap();
        let gene_end = tinfo.exons.iter().map(|(_, e)| *e).max().unwrap();

        let seq = match self.fetch_region_sequence(&tinfo.chrom, gene_start, gene_end, species).await? {
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
        species: &str,
    ) -> Result<(String, String), ProviderError> {
        if tinfo.exons.is_empty() {
            return Ok((String::new(), String::new()));
        }

        let (anchor_start, anchor_end) = if use_cds_anchor && !tinfo.cds.is_empty() {
            (
                tinfo.cds.iter().map(|(s, _)| *s).min().unwrap(),
                tinfo.cds.iter().map(|(_, e)| *e).max().unwrap(),
            )
        } else {
            (
                tinfo.exons.iter().map(|(s, _)| *s).min().unwrap(),
                tinfo.exons.iter().map(|(_, e)| *e).max().unwrap(),
            )
        };

        if tinfo.strand == Strand::Plus {
            let upstream_seq = if upstream_bp > 0 {
                let us = anchor_start.saturating_sub(upstream_bp).max(1);
                let ue = anchor_start.saturating_sub(1);
                self.fetch_region_sequence(&tinfo.chrom, us, ue, species).await?.unwrap_or_default()
            } else {
                String::new()
            };
            let downstream_seq = if downstream_bp > 0 {
                let ds = anchor_end + 1;
                let de = anchor_end + downstream_bp;
                self.fetch_region_sequence(&tinfo.chrom, ds, de, species).await?.unwrap_or_default()
            } else {
                String::new()
            };
            Ok((upstream_seq, downstream_seq))
        } else {
            let upstream_seq = if upstream_bp > 0 {
                let us = anchor_end + 1;
                let ue = anchor_end + upstream_bp;
                let raw = self.fetch_region_sequence(&tinfo.chrom, us, ue, species).await?.unwrap_or_default();
                revcomp(&raw).to_uppercase()
            } else {
                String::new()
            };
            let downstream_seq = if downstream_bp > 0 {
                let ds = anchor_start.saturating_sub(downstream_bp).max(1);
                let de = anchor_start.saturating_sub(1);
                let raw = self.fetch_region_sequence(&tinfo.chrom, ds, de, species).await?.unwrap_or_default();
                revcomp(&raw).to_uppercase()
            } else {
                String::new()
            };
            Ok((upstream_seq, downstream_seq))
        }
    }
}

#[allow(dead_code)]
type ArcEnsembl = Arc<EnsemblProvider>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_gene_search_rejects_non_gene_object_type() {
        let data = serde_json::json!({"object_type": "Transcript"});
        assert!(EnsemblProvider::parse_gene_search("X", &data).is_none());
    }

    #[test]
    fn parse_gene_search_extracts_transcripts() {
        let data = serde_json::json!({
            "object_type": "Gene",
            "id": "ENSG000001",
            "seq_region_name": "17",
            "strand": -1,
            "start": 100,
            "end": 200,
            "Transcript": [
                {"id": "ENST01", "display_name": "T1", "biotype": "protein_coding", "strand": -1, "Exon": [{}, {}], "is_canonical": 1},
                {"id": "ENST02", "strand": -1, "Exon": [{}]},
            ]
        });
        let result = EnsemblProvider::parse_gene_search("BRCA1", &data).unwrap();
        assert_eq!(result.gene_id, "ENSG000001");
        assert_eq!(result.strand, Strand::Minus);
        assert_eq!(result.transcripts.len(), 2);
        assert_eq!(result.transcripts[0].exon_count, 2);
        assert!(result.transcripts[0].is_canonical);
        assert_eq!(result.transcripts[1].name, "ENST02"); // falls back to id when no display_name
        assert!(!result.transcripts[1].is_canonical);
    }

    #[test]
    fn parse_transcript_details_plus_strand_utr_split() {
        // One exon [1,100], CDS genomic [51,80] -> UTR5=[1,50], CDS=[51,80], UTR3=[81,100]
        let data = serde_json::json!({
            "seq_region_name": "1",
            "strand": 1,
            "display_name": "T1",
            "Exon": [{"start": 1, "end": 100}],
            "Translation": {"start": 51, "end": 80},
        });
        let t = EnsemblProvider::parse_transcript_details("T1", &data);
        assert_eq!(t.exons, vec![(1, 100)]);
        assert_eq!(t.cds, vec![(51, 80)]);
        assert_eq!(t.utr5, vec![(1, 50)]);
        assert_eq!(t.utr3, vec![(81, 100)]);
    }

    #[test]
    fn parse_transcript_details_minus_strand_utr_swap() {
        // Minus strand: 5'UTR is at HIGHER genomic coords.
        let data = serde_json::json!({
            "seq_region_name": "1",
            "strand": -1,
            "Exon": [{"start": 1, "end": 100}],
            "Translation": {"start": 51, "end": 80},
        });
        let t = EnsemblProvider::parse_transcript_details("T1", &data);
        assert_eq!(t.utr5, vec![(81, 100)]); // higher coords = 5' on minus strand
        assert_eq!(t.utr3, vec![(1, 50)]);
    }
}
