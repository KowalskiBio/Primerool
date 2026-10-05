//! BLAST XML parsing + organism/gene-symbol heuristics, ported verbatim
//! from `blast_api.py::parse_blast_results` and `organism_to_ensembl_species`.
//!
//! Note on ElementTree semantics being replicated exactly: `.find(".//tag")`
//! searches all descendants (first match, document order); a bare
//! `.find("tag")`/`.findall("tag")` searches only **direct children**. Both
//! forms are used in the original and are distinguished the same way here.

use regex::Regex;
use roxmltree::{Document, Node, ParsingOptions};
use serde::Serialize;

use crate::BlastError;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BlastHit {
    pub organism: String,
    pub gene_symbol: Option<String>,
    pub accession: String,
    pub title: String,
    pub evalue: Option<f64>,
    pub bit_score: Option<f64>,
    pub identity_pct: f64,
    pub query_cover: f64,
    pub query_from: i64,
    pub query_to: i64,
    pub hit_from: i64,
    pub hit_to: i64,
    pub query_len: i64,
    /// `Some(true)` on synthetic hits produced by direct accession
    /// resolution (no BLAST round-trip) in the `/blast_sequence` route.
    /// The Python backend only includes this key on such synthetic hits,
    /// so it is omitted from serialization on real BLAST hits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direct: Option<bool>,
    /// The best HSP's aligned query (`Hsp_qseq`), target (`Hsp_hseq`, in
    /// the query's orientation even on a minus-strand hit) and match line
    /// (`Hsp_midline`: `|` identity, space mismatch) - gaps are `-`. What
    /// lets a primer's hit be judged by *where* it mismatches (a 3'-end
    /// mismatch blocks extension), not just its overall identity. Absent on
    /// synthetic direct-accession hits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qseq: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hseq: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub midline: Option<String>,
}

fn find_child<'a, 'input>(node: Node<'a, 'input>, tag: &str) -> Option<Node<'a, 'input>> {
    node.children().find(|c| c.is_element() && c.has_tag_name(tag))
}

fn find_descendant<'a, 'input>(node: Node<'a, 'input>, tag: &str) -> Option<Node<'a, 'input>> {
    node.descendants().find(|c| c.is_element() && c.has_tag_name(tag))
}

fn text_of(node: Node) -> Option<String> {
    node.text().map(|s| s.to_string())
}

/// One query's slice of a multi-query BLAST result: the FASTA header that
/// query was submitted under (`query_def`) plus that query's hits.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueryBlastResults {
    pub query_def: String,
    pub hits: Vec<BlastHit>,
}

/// Colloquial GenBank title prefixes, mapped to the binomial used
/// everywhere else. Patent-division records title as "<common name> DNA
/// ...", which the first-two-words heuristic would otherwise report as a
/// distinct "organism" (observed live on human-only /blast_batch results:
/// "Human DNA ..." next to "Homo sapiens ..." counted as 2 organisms).
const TITLE_ORGANISM_ALIASES: &[(&str, &str)] = &[("human dna", "Homo sapiens")];

/// Normalizes a hit title's leading organism words: strips NCBI's
/// "PREDICTED:" annotation (RefSeq gene predictions), takes the first
/// two whitespace-split words, and maps colloquial prefixes (see
/// `TITLE_ORGANISM_ALIASES`) to the canonical binomial.
fn organism_from_title(title: &str) -> String {
    let stripped = title.strip_prefix("PREDICTED:").unwrap_or(title);
    let words: Vec<&str> = stripped.split_whitespace().take(2).collect();
    if words.is_empty() {
        return "Unknown".to_string();
    }
    let joined = words.join(" ");
    if let Some((_, binomial)) = TITLE_ORGANISM_ALIASES.iter().find(|(alias, _)| *alias == joined.to_lowercase()) {
        return binomial.to_string();
    }
    joined
}

/// Parses the `<Hit>` children of one `Iteration_hits` node — the loop body
/// `parse_blast_results` originally inlined, shared with
/// `parse_blast_results_multi` below.
fn parse_hits(hits_node: Node, query_len: i64) -> Vec<BlastHit> {
    let gene_re = Regex::new(r"\(([\w\-.]+)\)").unwrap();

    let mut results = Vec::new();

    for hit in hits_node.children().filter(|c| c.is_element() && c.has_tag_name("Hit")) {
        let title = find_child(hit, "Hit_def").and_then(text_of).unwrap_or_else(|| "Unknown".to_string());
        let accession = find_child(hit, "Hit_accession").and_then(text_of).unwrap_or_default();

        let organism = organism_from_title(&title);

        // Gene-symbol heuristic: first parenthesized token, allowing hyphens/dots
        // (e.g. HLA-DQB1) — a plain \(\w+\) previously broke on such symbols.
        let gene_symbol = gene_re.captures(&title).and_then(|c| c.get(1)).map(|m| m.as_str().to_string());

        let hsps = match find_child(hit, "Hit_hsps") {
            Some(n) => n,
            None => continue,
        };
        let best_hsp = match find_child(hsps, "Hsp") {
            Some(n) => n,
            None => continue,
        };

        let get_text = |tag: &str| find_child(best_hsp, tag).and_then(text_of);

        let evalue = get_text("Hsp_evalue").and_then(|s| s.parse().ok());
        let bit_score = get_text("Hsp_bit-score").and_then(|s| s.parse().ok());

        let identity: i64 = get_text("Hsp_identity").and_then(|s| s.parse().ok()).unwrap_or(0);
        let align_len: i64 = get_text("Hsp_align-len").and_then(|s| s.parse().ok()).unwrap_or(1);
        let identity_pct = if align_len != 0 { round1(100.0 * identity as f64 / align_len as f64) } else { 0.0 };

        let query_from: i64 = get_text("Hsp_query-from").and_then(|s| s.parse().ok()).unwrap_or(0);
        let query_to: i64 = get_text("Hsp_query-to").and_then(|s| s.parse().ok()).unwrap_or(0);
        // Python's bare `round()` uses round-half-to-even; Rust's `.round()`
        // rounds half away from zero. These diverge only on exact `.5`
        // ties, which a percentage-of-integers ratio rarely lands on.
        let query_cover = if query_len != 0 {
            (100.0 * ((query_to - query_from).abs() as f64 + 1.0) / query_len as f64).round()
        } else {
            0.0
        };

        results.push(BlastHit {
            organism,
            gene_symbol,
            accession,
            title,
            evalue,
            bit_score,
            identity_pct,
            query_cover,
            query_from,
            query_to,
            hit_from: get_text("Hsp_hit-from").and_then(|s| s.parse().ok()).unwrap_or(0),
            hit_to: get_text("Hsp_hit-to").and_then(|s| s.parse().ok()).unwrap_or(0),
            query_len,
            direct: None,
            qseq: get_text("Hsp_qseq"),
            hseq: get_text("Hsp_hseq"),
            // Not `get_text`: a midline can start or end with a mismatch,
            // i.e. a space, and must keep it to stay column-aligned.
            midline: find_child(best_hsp, "Hsp_midline").map(|n| n.text().unwrap_or("").to_string()),
        });
    }

    results
}

/// Parses a single-query BLAST XML document — the first `Iteration_hits`
/// in document order with the global `BlastOutput_query-len`, exactly the
/// fields the Python original read (a multi-query document would simply
/// return the first query's hits here; use `parse_blast_results_multi`
/// for those).
pub fn parse_blast_results(xml_data: &str) -> Result<Vec<BlastHit>, BlastError> {
    // NCBI's BLAST XML output carries a `<!DOCTYPE BlastOutput PUBLIC ...>`
    // declaration; Python's ElementTree ignores external DTDs by default,
    // so allow (but don't resolve/fetch) one here too, matching behavior.
    let opts = ParsingOptions { allow_dtd: true, ..ParsingOptions::default() };
    let doc = Document::parse_with_options(xml_data, opts).map_err(|e| BlastError::XmlParse(e.to_string()))?;
    let root = doc.root_element();

    let hits_node = match find_descendant(root, "Iteration_hits") {
        Some(n) => n,
        None => return Ok(Vec::new()),
    };

    let query_len: i64 = find_descendant(root, "BlastOutput_query-len").and_then(text_of).and_then(|s| s.parse().ok()).unwrap_or(0);

    Ok(parse_hits(hits_node, query_len))
}

/// Parses a multi-query BLAST XML document (one submitted as a multi-FASTA
/// QUERY, so NCBI reports one `<Iteration>` per query): each query's hits
/// come back keyed by its `Iteration_query-def` — the FASTA header it was
/// submitted under — with query cover computed against that query's own
/// `Iteration_query-len` rather than any document-global length.
pub fn parse_blast_results_multi(xml_data: &str) -> Result<Vec<QueryBlastResults>, BlastError> {
    let opts = ParsingOptions { allow_dtd: true, ..ParsingOptions::default() };
    let doc = Document::parse_with_options(xml_data, opts).map_err(|e| BlastError::XmlParse(e.to_string()))?;
    let root = doc.root_element();

    let mut results = Vec::new();
    for iteration in root.descendants().filter(|c| c.is_element() && c.has_tag_name("Iteration")) {
        let query_def = find_child(iteration, "Iteration_query-def").and_then(text_of).unwrap_or_default();
        let query_len: i64 = find_child(iteration, "Iteration_query-len").and_then(text_of).and_then(|s| s.parse().ok()).unwrap_or(0);
        let hits = match find_child(iteration, "Iteration_hits") {
            Some(n) => parse_hits(n, query_len),
            None => Vec::new(),
        };
        results.push(QueryBlastResults { query_def, hits });
    }
    Ok(results)
}

/// Python's `round(x, 1)` (banker's rounding) vs Rust's `f64::round`
/// (round-half-away-from-zero) can differ on exact `.x5` boundaries;
/// identity_pct is a ratio of integers so exact half-way ties are rare in
/// practice, and this matches the common case bit-for-bit.
fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// Map common NCBI organism names to Ensembl species codes, ported verbatim
/// from `blast_api.py::_SPECIES_MAP` (its own copy, independent from
/// `ncbi_api.py`'s inverse-direction table).
pub fn organism_to_ensembl_species(organism: &str) -> String {
    let key = organism.trim().to_lowercase();
    if let Some((_, slug)) = BINOMIAL_TO_ENSEMBL.iter().find(|(name, _)| *name == key) {
        return slug.to_string();
    }
    key.replace(' ', "_")
}

pub static BINOMIAL_TO_ENSEMBL: &[(&str, &str)] = &[
    // Animals / Vertebrates
    ("homo sapiens", "homo_sapiens"),
    ("mus musculus", "mus_musculus"),
    ("rattus norvegicus", "rattus_norvegicus"),
    ("danio rerio", "danio_rerio"),
    ("gallus gallus", "gallus_gallus"),
    ("drosophila melanogaster", "drosophila_melanogaster"),
    ("caenorhabditis elegans", "caenorhabditis_elegans"),
    ("xenopus tropicalis", "xenopus_tropicalis"),
    ("sus scrofa", "sus_scrofa"),
    ("bos taurus", "bos_taurus"),
    ("ovis aries", "ovis_aries"),
    ("canis lupus familiaris", "canis_lupus_familiaris"),
    ("felis catus", "felis_catus"),
    ("macaca mulatta", "macaca_mulatta"),
    ("pan troglodytes", "pan_troglodytes"),
    ("oryctolagus cuniculus", "oryctolagus_cuniculus"),
    // Fungi
    ("saccharomyces cerevisiae", "saccharomyces_cerevisiae"),
    ("schizosaccharomyces pombe", "schizosaccharomyces_pombe"),
    ("aspergillus nidulans", "aspergillus_nidulans"),
    ("neurospora crassa", "neurospora_crassa"),
    ("candida albicans", "candida_albicans"),
    // Plants
    ("arabidopsis thaliana", "arabidopsis_thaliana"),
    ("oryza sativa", "oryza_sativa"),
    ("zea mays", "zea_mays"),
    ("triticum aestivum", "triticum_aestivum"),
    ("solanum lycopersicum", "solanum_lycopersicum"),
    ("glycine max", "glycine_max"),
    ("vitis vinifera", "vitis_vinifera"),
    ("solanum tuberosum", "solanum_tuberosum"),
    ("hordeum vulgare", "hordeum_vulgare"),
    ("nicotiana tabacum", "nicotiana_tabacum"),
    // Bacteria (Ensembl Bacteria requires GCA accession suffix)
    ("escherichia coli", "escherichia_coli_str_k_12_substr_mg1655_gca_000005845"),
    ("bacillus subtilis", "bacillus_subtilis_subsp_subtilis_str_168_gca_000009045"),
    ("staphylococcus aureus", "staphylococcus_aureus_subsp_aureus_nctc_8325_gca_000013425"),
    ("pseudomonas aeruginosa", "pseudomonas_aeruginosa_pao1_gca_000006765"),
    ("mycobacterium tuberculosis", "mycobacterium_tuberculosis_h37ra_gca_000016145"),
    (
        "salmonella enterica",
        "salmonella_enterica_subsp_enterica_serovar_typhimurium_str_lt2_gca_000006945",
    ),
    ("streptococcus pneumoniae", "streptococcus_pneumoniae_tigr4_gca_000006885"),
    // Protists
    ("plasmodium falciparum", "plasmodium_falciparum"),
    ("trypanosoma brucei", "trypanosoma_brucei"),
    ("leishmania major", "leishmania_major"),
    ("toxoplasma gondii", "toxoplasma_gondii_me49"),
    ("dictyostelium discoideum", "dictyostelium_discoideum"),
    // Viruses
    ("sars-cov-2", "sars_cov_2"),
];

/// Reverse of `BINOMIAL_TO_ENSEMBL`: the NCBI organism name to restrict a
/// BLAST search to, given one of the app's Ensembl species slugs. `None`
/// for a slug the table doesn't know (callers then treat the input as an
/// already-spelled-out organism name).
pub fn ensembl_slug_to_organism(slug: &str) -> Option<String> {
    BINOMIAL_TO_ENSEMBL
        .iter()
        .find(|(_, s)| *s == slug)
        .map(|(name, _)| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_XML: &str = r#"<?xml version="1.0"?>
<BlastOutput>
  <BlastOutput_query-len>300</BlastOutput_query-len>
  <BlastOutput_iterations>
    <Iteration>
      <Iteration_hits>
        <Hit>
          <Hit_num>1</Hit_num>
          <Hit_def>Homo sapiens tumor protein p53 (TP53), mRNA</Hit_def>
          <Hit_accession>NM_000546</Hit_accession>
          <Hit_hsps>
            <Hsp>
              <Hsp_evalue>1e-150</Hsp_evalue>
              <Hsp_bit-score>550.5</Hsp_bit-score>
              <Hsp_identity>298</Hsp_identity>
              <Hsp_align-len>300</Hsp_align-len>
              <Hsp_query-from>1</Hsp_query-from>
              <Hsp_query-to>300</Hsp_query-to>
              <Hsp_hit-from>10</Hsp_hit-from>
              <Hsp_hit-to>309</Hsp_hit-to>
            </Hsp>
          </Hit_hsps>
        </Hit>
        <Hit>
          <Hit_def>Homo sapiens (HLA-DQB1) gene</Hit_def>
          <Hit_accession>NM_002123</Hit_accession>
          <Hit_hsps>
            <Hsp>
              <Hsp_identity>150</Hsp_identity>
              <Hsp_align-len>200</Hsp_align-len>
              <Hsp_query-from>1</Hsp_query-from>
              <Hsp_query-to>200</Hsp_query-to>
            </Hsp>
          </Hit_hsps>
        </Hit>
      </Iteration_hits>
    </Iteration>
  </BlastOutput_iterations>
</BlastOutput>"#;

    #[test]
    fn parses_hits_with_organism_and_gene_symbol_heuristics() {
        let hits = parse_blast_results(SAMPLE_XML).unwrap();
        assert_eq!(hits.len(), 2);

        assert_eq!(hits[0].organism, "Homo sapiens");
        assert_eq!(hits[0].gene_symbol.as_deref(), Some("TP53"));
        assert_eq!(hits[0].accession, "NM_000546");
        assert_eq!(hits[0].identity_pct, round1(100.0 * 298.0 / 300.0));
        assert_eq!(hits[0].query_cover, 100.0);

        // Hyphenated gene symbol must be captured (this is exactly the bug
        // the `\(\w+\)` -> `\(([\w\-.]+)\)` regex fix addressed upstream).
        assert_eq!(hits[1].gene_symbol.as_deref(), Some("HLA-DQB1"));
    }

    #[test]
    fn no_iteration_hits_returns_empty() {
        let xml = r#"<BlastOutput><BlastOutput_query-len>10</BlastOutput_query-len></BlastOutput>"#;
        assert_eq!(parse_blast_results(xml).unwrap(), Vec::new());
    }

    #[test]
    fn organism_normalizes_predicted_and_patent_title_prefixes() {
        // Both shapes observed live in /blast_batch results restricted to
        // "Homo sapiens [organism]": RefSeq Gnomon predictions title as
        // "PREDICTED: Homo sapiens ..." and patent-division records as
        // "Human DNA ...", which used to parse as two extra "organisms"
        // for a search that is human-only.
        let xml = r#"<?xml version="1.0"?>
<BlastOutput>
  <BlastOutput_query-len>18</BlastOutput_query-len>
  <BlastOutput_iterations>
    <Iteration>
      <Iteration_hits>
        <Hit>
          <Hit_def>PREDICTED: Homo sapiens musashi RNA binding protein 2 (MSI2), mRNA</Hit_def>
          <Hit_accession>XR_001738056</Hit_accession>
          <Hit_hsps>
            <Hsp>
              <Hsp_identity>18</Hsp_identity>
              <Hsp_align-len>18</Hsp_align-len>
              <Hsp_query-from>1</Hsp_query-from>
              <Hsp_query-to>18</Hsp_query-to>
            </Hsp>
          </Hit_hsps>
        </Hit>
        <Hit>
          <Hit_def>Human DNA sequence from patent EP0743343</Hit_def>
          <Hit_accession>A18533</Hit_accession>
          <Hit_hsps>
            <Hsp>
              <Hsp_identity>18</Hsp_identity>
              <Hsp_align-len>18</Hsp_align-len>
              <Hsp_query-from>1</Hsp_query-from>
              <Hsp_query-to>18</Hsp_query-to>
            </Hsp>
          </Hit_hsps>
        </Hit>
      </Iteration_hits>
    </Iteration>
  </BlastOutput_iterations>
</BlastOutput>"#;
        let hits = parse_blast_results(xml).unwrap();
        assert_eq!(hits[0].organism, "Homo sapiens");
        assert_eq!(hits[1].organism, "Homo sapiens");
        // The gene-symbol heuristic must still see through the prefix.
        assert_eq!(hits[0].gene_symbol.as_deref(), Some("MSI2"));
    }

    #[test]
    fn hit_without_hsps_is_skipped() {
        let xml = r#"<BlastOutput><BlastOutput_iterations><Iteration><Iteration_hits>
            <Hit><Hit_def>No HSP Hit</Hit_def></Hit>
        </Iteration_hits></Iteration></BlastOutput_iterations></BlastOutput>"#;
        assert_eq!(parse_blast_results(xml).unwrap(), Vec::new());
    }

    #[test]
    fn organism_mapping_known_and_unknown() {
        assert_eq!(organism_to_ensembl_species("Homo sapiens"), "homo_sapiens");
        assert_eq!(
            organism_to_ensembl_species("Escherichia coli"),
            "escherichia_coli_str_k_12_substr_mg1655_gca_000005845"
        );
        assert_eq!(organism_to_ensembl_species("Unknown Organism"), "unknown_organism");
    }

    #[test]
    fn invalid_xml_returns_parse_error() {
        assert!(parse_blast_results("<not valid xml").is_err());
    }

    #[test]
    fn multi_parser_splits_hits_per_query_def() {
        let xml = r#"<?xml version="1.0"?>
<BlastOutput>
  <BlastOutput_query-len>25</BlastOutput_query-len>
  <BlastOutput_iterations>
    <Iteration>
      <Iteration_query-def>rs1.fwd</Iteration_query-def>
      <Iteration_query-len>25</Iteration_query-len>
      <Iteration_hits>
        <Hit>
          <Hit_def>Homo sapiens tumor protein p53 (TP53), mRNA</Hit_def>
          <Hit_accession>NM_000546</Hit_accession>
          <Hit_hsps>
            <Hsp>
              <Hsp_identity>25</Hsp_identity>
              <Hsp_align-len>25</Hsp_align-len>
              <Hsp_query-from>1</Hsp_query-from>
              <Hsp_query-to>25</Hsp_query-to>
            </Hsp>
          </Hit_hsps>
        </Hit>
      </Iteration_hits>
    </Iteration>
    <Iteration>
      <Iteration_query-def>rs1.rev</Iteration_query-def>
      <Iteration_query-len>20</Iteration_query-len>
      <Iteration_hits>
        <Hit>
          <Hit_def>Bos taurus (CSN2) gene</Hit_def>
          <Hit_accession>NM_001003662</Hit_accession>
          <Hit_hsps>
            <Hsp>
              <Hsp_identity>10</Hsp_identity>
              <Hsp_align-len>20</Hsp_align-len>
              <Hsp_query-from>1</Hsp_query-from>
              <Hsp_query-to>10</Hsp_query-to>
            </Hsp>
          </Hit_hsps>
        </Hit>
      </Iteration_hits>
    </Iteration>
  </BlastOutput_iterations>
</BlastOutput>"#;
        let results = parse_blast_results_multi(xml).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].query_def, "rs1.fwd");
        assert_eq!(results[0].hits.len(), 1);
        assert_eq!(results[0].hits[0].organism, "Homo sapiens");
        // Query cover must use this iteration's own query length (25), not
        // the document-global first-query length.
        assert_eq!(results[0].hits[0].query_cover, 100.0);
        assert_eq!(results[1].query_def, "rs1.rev");
        assert_eq!(results[1].hits[0].query_cover, 50.0);
    }

    #[test]
    fn multi_parser_iteration_without_hits_is_empty_not_dropped() {
        let xml = r#"<BlastOutput><BlastOutput_iterations>
            <Iteration><Iteration_query-def>rs2.fwd</Iteration_query-def><Iteration_query-len>22</Iteration_query-len></Iteration>
            <Iteration><Iteration_query-def>rs2.rev</Iteration_query-def><Iteration_query-len>22</Iteration_query-len>
              <Iteration_hits><Hit><Hit_def>No HSP Hit</Hit_def></Hit></Iteration_hits>
            </Iteration>
        </BlastOutput_iterations></BlastOutput>"#;
        let results = parse_blast_results_multi(xml).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].hits, Vec::new());
        assert_eq!(results[1].hits, Vec::new());
    }

    #[test]
    fn keeps_hsp_alignment_strings_with_edge_spaces() {
        // A midline starting and ending in a mismatch (a space) must keep
        // both spaces, or it falls out of column with qseq/hseq.
        let xml = r#"<BlastOutput><BlastOutput_query-len>8</BlastOutput_query-len><BlastOutput_iterations><Iteration><Iteration_hits>
<Hit><Hit_def>Homo sapiens chromosome 1</Hit_def><Hit_accession>NC_000001</Hit_accession><Hit_hsps><Hsp>
<Hsp_identity>6</Hsp_identity><Hsp_align-len>8</Hsp_align-len><Hsp_query-from>1</Hsp_query-from><Hsp_query-to>8</Hsp_query-to>
<Hsp_hit-from>108</Hsp_hit-from><Hsp_hit-to>101</Hsp_hit-to>
<Hsp_qseq>ACGTACGT</Hsp_qseq><Hsp_hseq>TCGTACGA</Hsp_hseq><Hsp_midline> |||||| </Hsp_midline>
</Hsp></Hit_hsps></Hit>
</Iteration_hits></Iteration></BlastOutput_iterations></BlastOutput>"#;
        let hits = parse_blast_results(xml).unwrap();
        assert_eq!(hits[0].qseq.as_deref(), Some("ACGTACGT"));
        assert_eq!(hits[0].hseq.as_deref(), Some("TCGTACGA"));
        assert_eq!(hits[0].midline.as_deref(), Some(" |||||| "));
    }

    #[test]
    fn multi_parser_no_iterations_is_empty() {
        assert_eq!(parse_blast_results_multi(r#"<BlastOutput></BlastOutput>"#).unwrap(), Vec::new());
    }
}
