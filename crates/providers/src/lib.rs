//! `SequenceProvider` trait plus Ensembl/NCBI implementations.
//!
//! Ported from `ensembl_api.py` / `ncbi_api.py` (Phase 2). Every method
//! here fetches plus-strand sequence and reverse-complements locally —
//! never trusts either API's own strand parameter, for consistency between
//! providers (see the rewrite plan's fidelity checklist, Phase 2).
//!
//! `cds_annotations_in_transcript_coords` is identical pure computation in
//! both Python originals, so it lives once in `coords`, not per-provider.

pub mod coords;
pub mod ensembl;
pub mod ncbi;
pub mod species_map;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("http request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("upstream returned HTTP {status}: {message}")]
    UpstreamStatus { status: u16, message: String },
    #[error("upstream returned an unexpected shape: {0}")]
    UnexpectedShape(String),
    #[error("{0}")]
    Failed(String),
}

impl ProviderError {
    /// Mirrors the Python call sites that catch `requests.HTTPError` and
    /// treat specific status codes as "not found" (return `None`) while
    /// re-raising everything else.
    pub fn is_not_found(&self, treat_as_missing: &[u16]) -> bool {
        matches!(self, ProviderError::UpstreamStatus { status, .. } if treat_as_missing.contains(status))
    }
}

/// 1-based, inclusive genomic (or transcript-relative) interval — matches
/// the Python tuples `(start, end)` exactly; no reinterpretation of the
/// coordinate system happens in this crate.
pub type Interval = (u64, u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strand {
    Plus,
    Minus,
}

impl Strand {
    pub fn as_str(self) -> &'static str {
        match self {
            Strand::Plus => "+",
            Strand::Minus => "-",
        }
    }

    pub fn from_ensembl_i8(v: i64) -> Self {
        if v == 1 {
            Strand::Plus
        } else {
            Strand::Minus
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeqType {
    Genomic,
    Cdna,
    Cds,
}

impl SeqType {
    fn as_ensembl_str(self) -> &'static str {
        match self {
            SeqType::Genomic => "genomic",
            SeqType::Cdna => "cdna",
            SeqType::Cds => "cds",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feature {
    Exons,
    Cds,
}

#[derive(Debug, Clone)]
pub struct TranscriptSummary {
    pub id: String,
    pub name: String,
    pub biotype: String,
    pub strand: Strand,
    pub exon_count: usize,
    pub is_canonical: bool,
}

#[derive(Debug, Clone)]
pub struct GeneSearchResult {
    pub gene_name: String,
    pub gene_id: String,
    pub chrom: String,
    pub strand: Strand,
    pub start: u64,
    pub end: u64,
    pub transcripts: Vec<TranscriptSummary>,
}

/// A known variant (SNP/indel), sourced from either provider's own variant
/// database (Ensembl's dbSNP-backed `/overlap/region`+`/variation`, or
/// NCBI's `db=snp` E-utils). Both providers normalize into this one shape
/// so the server/frontend never need to know which source answered a
/// given search.
#[derive(Debug, Clone, serde::Serialize)]
pub struct VariantHit {
    pub id: String,
    pub chrom: String,
    /// 1-based inclusive genomic.
    pub start: u64,
    pub end: u64,
    /// Order NOT guaranteed ref-first by either provider; callers must let
    /// the user confirm which allele is which, never assume `alleles[0]`.
    pub alleles: Vec<String>,
    pub strand: i8,
    pub consequence_type: Option<String>,
    pub clinical_significance: Vec<String>,
    /// Global minor allele frequency from a large reference cohort
    /// (preferring 1000 Genomes phase 3 on both providers, so switching
    /// data source doesn't change the number for the same variant) — only
    /// populated by a direct by-id lookup; a region/overlap search always
    /// returns `None` here (neither provider's region endpoint carries
    /// per-variant frequency), left for the caller to fetch on demand.
    pub minor_allele_freq: Option<f64>,
    pub minor_allele: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TranscriptInfo {
    pub transcript_id: String,
    pub transcript_name: String,
    pub chrom: String,
    /// NCBI-only: the `NC_` accession needed for `get_region_sequence`.
    /// Empty for Ensembl, which resolves regions by species+chrom instead.
    pub chr_accession: String,
    pub strand: Strand,
    pub exons: Vec<Interval>,
    pub cds: Vec<Interval>,
    pub utr5: Vec<Interval>,
    pub utr3: Vec<Interval>,
    pub utr: Vec<Interval>,
}

/// Shared behavior between Ensembl and NCBI, mirroring the identical
/// function signatures both Python modules expose today.
#[async_trait::async_trait]
pub trait SequenceProvider: Send + Sync {
    async fn search_gene(&self, gene_name: &str, species: &str) -> Result<Option<GeneSearchResult>, ProviderError>;

    async fn get_transcript_details(&self, transcript_id: &str) -> Result<Option<TranscriptInfo>, ProviderError>;

    async fn get_sequence_by_id(&self, id: &str, seq_type: SeqType) -> Result<Option<String>, ProviderError>;

    async fn get_region_sequence(
        &self,
        tinfo: &TranscriptInfo,
        start: u64,
        end: u64,
        species: &str,
    ) -> Result<Option<String>, ProviderError>;

    async fn build_spliced_sequence(
        &self,
        tinfo: &TranscriptInfo,
        feature: Feature,
        species: &str,
    ) -> Result<Option<String>, ProviderError>;

    async fn build_genomic_sequence(&self, tinfo: &TranscriptInfo, species: &str) -> Result<Option<String>, ProviderError>;

    async fn get_flanking_sequence(
        &self,
        tinfo: &TranscriptInfo,
        upstream_bp: u64,
        downstream_bp: u64,
        use_cds_anchor: bool,
        species: &str,
    ) -> Result<(String, String), ProviderError>;
}

/// DNA reverse-complement matching `str.maketrans("ACGTacgt", "TGCAtgca")`
/// followed by `[::-1]` — unmapped characters pass through unchanged.
/// Every provider always fetches plus-strand and calls this locally rather
/// than trusting either API's own strand parameter (see module docs).
pub(crate) fn revcomp(seq: &str) -> String {
    seq.bytes()
        .rev()
        .map(|b| match b {
            b'A' => b'T',
            b'T' => b'A',
            b'C' => b'G',
            b'G' => b'C',
            b'a' => b't',
            b't' => b'a',
            b'c' => b'g',
            b'g' => b'c',
            other => other,
        })
        .map(|b| b as char)
        .collect()
}
