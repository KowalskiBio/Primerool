//! Parses the per-SNP flanking-sequence report format produced by (at
//! least one) reference-genome lookup workflow: one block per variant,
//! each holding ~200 bp of reference sequence on either side of the
//! target SNP, laid out like:
//!
//! ```text
//! VEGFC
//! rs2333526   chr4:176782151
//! Alely T/A/C   |   RefSeq NC_000004.12   |   interval 176781951–176782351
//! 5′→3′ plus vlákno
//!    176781951  CAGAGTGGCA CTCACTCACA CGCATGACTC TTCCTCAACT
//!    ...
//!    176782151  [T/A/C]GTAAGCAAA GCACTTGTAA GAGAAAAAGA AATTAGGCTG
//!    ...
//! Poslední zobrazená báze: 176782351
//! ```
//!
//! `[REF/ALT]` marks the target variant itself (always exactly one base
//! position, however many alleles are listed) — the text immediately
//! before it becomes `upstream_seq`, immediately after becomes
//! `downstream_seq`, ready to feed `engine::design_flanking` directly.
//!
//! Two entry points: [`parse_docx`] reads the real `.docx` (a zip of
//! OOXML), walking paragraphs/tables directly rather than flattening to
//! text first — the summary table (present in this format ahead of the
//! per-SNP blocks) is what supplies `other_targets`, which a plain-text
//! paste can't. [`parse_pasted_text`] is the best-effort fallback for a
//! plain-text paste of the same content (`other_targets` always empty —
//! there's no summary table to cross-reference).

use std::collections::HashMap;
use std::io::{Cursor, Read};

use regex::Regex;
use roxmltree::Document;
use serde::Serialize;

const W_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("could not open as a .docx (not a valid zip archive): {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error(".docx is missing word/document.xml")]
    MissingDocumentXml,
    #[error("failed to read word/document.xml: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to parse document.xml: {0}")]
    Xml(#[from] roxmltree::Error),
    #[error("no SNP blocks found — expected 'rsID   chrN:POS' / 'Alely ... | RefSeq ... | interval START–END' / position-labeled sequence lines")]
    NoBlocks,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SnpBlock {
    pub gene: String,
    pub rsid: String,
    pub chrom: String,
    pub position: i64,
    /// Reference allele first, matching the source document's convention.
    pub alleles: Vec<String>,
    pub refseq: String,
    pub interval_start: i64,
    pub interval_end: i64,
    /// Reference bases immediately upstream (5') of the variant.
    pub upstream_seq: String,
    /// Reference bases immediately downstream (3') of the variant.
    pub downstream_seq: String,
    /// rsIDs of other SNPs (from the source list) that fall inside this
    /// same flanking window, per the summary table — a flag for manual
    /// binding-site review, not a computed position.
    pub other_targets: Vec<String>,
}

pub fn parse_docx(bytes: &[u8]) -> Result<Vec<SnpBlock>, ImportError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    let mut xml = String::new();
    archive.by_name("word/document.xml").map_err(|_| ImportError::MissingDocumentXml)?.read_to_string(&mut xml)?;
    let doc = Document::parse(&xml)?;

    let body = doc
        .root_element()
        .children()
        .find(|n| n.has_tag_name((W_NS, "body")))
        .ok_or(ImportError::NoBlocks)?;

    let mut other_targets: HashMap<String, Vec<String>> = HashMap::new();
    let mut lines: Vec<String> = Vec::new();

    for child in body.children() {
        if child.has_tag_name((W_NS, "p")) {
            let text = collect_text(child);
            if !text.trim().is_empty() {
                lines.push(text);
            }
        } else if child.has_tag_name((W_NS, "tbl")) {
            parse_summary_table(child, &mut other_targets);
        }
    }

    let mut blocks = parse_lines(&lines)?;
    for b in &mut blocks {
        if let Some(t) = other_targets.get(&b.rsid) {
            b.other_targets = t.clone();
        }
    }
    Ok(blocks)
}

/// Best-effort fallback for a plain-text paste of the same report (no
/// summary table to source `other_targets` from).
pub fn parse_pasted_text(text: &str) -> Result<Vec<SnpBlock>, ImportError> {
    let lines: Vec<String> = text.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    parse_lines(&lines)
}

fn collect_text(node: roxmltree::Node) -> String {
    let mut s = String::new();
    for t in node.descendants().filter(|n| n.has_tag_name((W_NS, "t"))) {
        if let Some(txt) = t.text() {
            s.push_str(txt);
        }
    }
    s
}

/// Reads the "Souhrn variant" table: `Gen | rsID | Pozice GRCh38 | Alely |
/// Interval | Další cíl v oblasti` — only the rsID and last column matter
/// here; everything else is re-derived per-block from the sequence text
/// itself (kept as the source of truth, since it's what's actually used
/// for the flanks).
fn parse_summary_table(tbl: roxmltree::Node, out: &mut HashMap<String, Vec<String>>) {
    for tr in tbl.children().filter(|n| n.has_tag_name((W_NS, "tr"))) {
        let cells: Vec<String> = tr.children().filter(|n| n.has_tag_name((W_NS, "tc"))).map(collect_text).collect();
        if cells.len() < 6 {
            continue;
        }
        let rsid = cells[1].trim().to_string();
        if !rsid.starts_with("rs") {
            continue; // header row
        }
        let other_raw = cells[5].trim();
        let others: Vec<String> = if other_raw.is_empty() || other_raw.chars().all(|c| matches!(c, '-' | '—' | '–')) {
            Vec::new()
        } else {
            other_raw.split([',', ';']).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
        };
        out.insert(rsid, others);
    }
}

/// Replaces a still-present `[REF/ALT...]` marker (another SNP from the
/// list, sharing this window) with just its reference allele (listed
/// first, per the source document's convention) — keeps the flank a
/// contiguous, correctly-spaced reference sequence rather than leaking the
/// bracket/slash punctuation and every alt allele's letters into it.
fn collapse_secondary_markers(s: &str) -> String {
    let marker = Regex::new(r"\[([^/\]]+)(?:/[^/\]]+)*\]").unwrap();
    marker.replace_all(s, "$1").into_owned()
}

fn parse_lines(lines: &[String]) -> Result<Vec<SnpBlock>, ImportError> {
    let rsid_line = Regex::new(r"^rs(\d+)\s+chr(\w+):(\d[\d\s]*)$").unwrap();
    let allele_line = Regex::new(r"^Alely\s+([^|]+?)\s*\|\s*RefSeq\s+(\S+)\s*\|\s*interval\s+(\d[\d\s]*)[–-](\d[\d\s]*)$").unwrap();
    let seq_line = Regex::new(r"^\d+\s+(.+)$").unwrap();
    let gene_line = Regex::new(r"^[A-Za-z][A-Za-z0-9]*$").unwrap();
    let marker_re = Regex::new(r"\[[^\]]*\]").unwrap();

    let mut blocks = Vec::new();
    let mut current_gene = String::new();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i].trim();

        if let Some(caps) = rsid_line.captures(line) {
            let rsid = format!("rs{}", &caps[1]);
            let chrom = format!("chr{}", &caps[2]);
            let position: i64 = caps[3].replace(' ', "").parse().unwrap_or(0);
            i += 1;

            let Some(allele_caps) = lines.get(i).and_then(|l| allele_line.captures(l.trim())) else {
                // Not the shape we expect right after an rsID line — skip
                // past this line rather than losing the rest of the
                // document to one malformed block.
                i += 1;
                continue;
            };
            let alleles: Vec<String> = allele_caps[1].split('/').map(|s| s.trim().to_string()).collect();
            let refseq = allele_caps[2].to_string();
            let interval_start: i64 = allele_caps[3].replace(' ', "").parse().unwrap_or(0);
            let interval_end: i64 = allele_caps[4].replace(' ', "").parse().unwrap_or(0);
            i += 1;

            // Between the Alely line and the actual sequence rows there
            // may be an orientation label ("5′→3′ plus vlákno") and/or an
            // informational aside ("Další označený SNP v této oblasti:
            // rsXXXX") when a second SNP from the list falls in this same
            // window — order/presence of either isn't guaranteed, so skip
            // forward past anything that isn't a sequence row, bailing out
            // if a new block's rsID/gene line shows up first (malformed
            // input, no sequence rows at all).
            while let Some(l) = lines.get(i) {
                let lt = l.trim();
                if seq_line.is_match(lt) || lt.starts_with("Posledn\u{ed}") {
                    break;
                }
                if rsid_line.is_match(lt) || gene_line.is_match(lt) {
                    break;
                }
                i += 1;
            }

            let mut buffer = String::new();
            while let Some(l) = lines.get(i) {
                let l = l.trim();
                if l.starts_with("Posledn\u{ed}") {
                    i += 1;
                    break;
                }
                let Some(caps) = seq_line.captures(l) else { break };
                buffer.push_str(&caps[1].replace(' ', ""));
                i += 1;
            }

            // A window can carry more than one `[REF/ALT...]` marker: its
            // own target, plus any other listed SNP that happens to fall
            // in the same 401 bp span (flagged separately as
            // `other_targets`). Replay every marker in genome order,
            // tracking the real (post-collapse) base offset each one sits
            // at — each marker collapses to exactly one base — and pick
            // whichever one lands at `position - interval_start` (200, per
            // this format) as *this* block's own target, falling back to
            // the first marker if none matches exactly (unexpected
            // spacing).
            let target_offset = position - interval_start;
            let markers: Vec<regex::Match> = marker_re.find_iter(&buffer).collect();
            if markers.is_empty() {
                continue; // no target marker found — skip this malformed block
            }

            let mut real_offset: i64 = 0;
            let mut cursor = 0usize;
            let mut chosen: Option<(usize, usize)> = None; // byte [start,end) of the main marker
            for m in &markers {
                real_offset += buffer[cursor..m.start()].chars().count() as i64;
                if chosen.is_none() && real_offset == target_offset {
                    chosen = Some((m.start(), m.end()));
                }
                real_offset += 1; // the marker itself is exactly one base
                cursor = m.end();
            }
            let (open, close_end) = chosen.unwrap_or((markers[0].start(), markers[0].end()));

            blocks.push(SnpBlock {
                gene: current_gene.clone(),
                rsid,
                chrom,
                position,
                alleles,
                refseq,
                interval_start,
                interval_end,
                // Any *other* [REF/ALT...] marker still present (a second
                // SNP from the list sharing this window) is collapsed back
                // to its reference allele so the flank stays a clean,
                // correctly-spaced reference sequence.
                upstream_seq: collapse_secondary_markers(&buffer[..open]),
                downstream_seq: collapse_secondary_markers(&buffer[close_end..]),
                other_targets: Vec::new(),
            });
            continue;
        }

        if gene_line.is_match(line) {
            current_gene = line.to_string();
        }
        i += 1;
    }

    if blocks.is_empty() {
        return Err(ImportError::NoBlocks);
    }
    Ok(blocks)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
VEGFC
rs2333526   chr4:176782151
Alely T/A/C   |   RefSeq NC_000004.12   |   interval 176781951\u{2013}176782351
5\u{2032}\u{2192}3\u{2032} plus vl\u{e1}kno
   176781951  CAGAGTGGCA CTCACTCACA CGCATGACTC TTCCTCAACT
   176781991  ACCGCAGTGC CAAGGTCTGA TTATTTTCAC AAATGTTTCA
   176782031  TCCTTTTCCA ATATTTTAAC AAGTTGGAAC CAAAAGTATT
   176782071  ATCAAGTTCA AGACTGTTTC TTCTACATAA AAAGAATATT
   176782111  AAATAAGCAG TTATTTGAAT CCTGTTTCTA ACAATAAAAA
   176782151  [T/A/C]GTAAGCAAA GCACTTGTAA GAGAAAAAGA AATTAGGCTG
   176782191  GAACAGCGGC TCATGCCTGT AATCCCAGCA CTTTGGGAGG
   176782231  CCAAGGCAGA TCACTTGAGC CCAGGAGTTT GAGAGCAGCC
   176782271  TGGGCAACTT AGTGAGACCT CATTTCTACA AAAAATTTTA
   176782311  AAAAATAGCT GGGTGGGGTG GCACGTGCCT GTGATCCCAG
   176782351  C
Posledn\u{ed} zobrazen\u{e1} b\u{e1}ze: 176782351

rs17697515   chr4:176689270
Alely C/T   |   RefSeq NC_000004.12   |   interval 176689070\u{2013}176689470
5\u{2032}\u{2192}3\u{2032} plus vl\u{e1}kno
   176689070  ACTTCTCACT ACCTCATTTT TTCATCTAAT GTTGGTGTAG
   176689270  [C/T]AGTTACTAA GAAAGTTTTG CAGACATACT CAGTGTGACA
   176689470  T
Posledn\u{ed} zobrazen\u{e1} b\u{e1}ze: 176689470
";

    #[test]
    fn parses_gene_and_target_marker() {
        let blocks = parse_pasted_text(SAMPLE).unwrap();
        assert_eq!(blocks.len(), 2);

        let b0 = &blocks[0];
        assert_eq!(b0.gene, "VEGFC");
        assert_eq!(b0.rsid, "rs2333526");
        assert_eq!(b0.chrom, "chr4");
        assert_eq!(b0.position, 176782151);
        assert_eq!(b0.alleles, vec!["T", "A", "C"]);
        assert_eq!(b0.refseq, "NC_000004.12");
        assert_eq!(b0.interval_start, 176781951);
        assert_eq!(b0.interval_end, 176782351);
        assert_eq!(b0.upstream_seq.len(), 200);
        assert_eq!(b0.downstream_seq.len(), 200);
        assert!(b0.upstream_seq.ends_with("AAATAAGCAGTTATTTGAATCCTGTTTCTAACAATAAAAA"));
        assert!(b0.upstream_seq.chars().all(|c| "ACGTN".contains(c)));
        assert!(b0.downstream_seq.starts_with("GTAAGCAAA"));

        // Second block re-uses the gene carried over from the first (only
        // stated once per gene in the real document).
        assert_eq!(blocks[1].gene, "VEGFC");
        assert_eq!(blocks[1].rsid, "rs17697515");
    }

    /// A window that also contains a second listed SNP carries an extra
    /// aside paragraph plus a second `[REF/ALT]` marker (the other SNP's
    /// own, mid-sequence) — regression for both: the aside must not break
    /// the sequence-line scan, and the *second* marker must collapse to
    /// its reference allele rather than being mistaken for this block's
    /// own target or leaking into the flank.
    const PAIRED_SAMPLE: &str = "\
MSI2
rs277072   chr17:57483169
Alely G/A/C/T   |   RefSeq NC_000017.11   |   interval 57482969\u{2013}57483369
Dal\u{161}\u{ed} ozna\u{10d}en\u{fd} SNP v t\u{e9}to oblasti: rs277073
5\u{2032}\u{2192}3\u{2032} plus vl\u{e1}kno
    57482969  GGAGGTTTTT CTCAAATCAG ATTTTAAAAC TTTGCTCTGA
    57483009  AAGACCAACA ACAATAACCT AATCCAATAT CCTTGTATAT
    57483049  TTGATTCTAC TGACCATAAC ATTTCTTAAT TTCTGCTTTT
    57483089  GGCTTCTGTA GCCTAATATA CTAATGATAA TAAGTATTAG
    57483129  TGTTGTATTA GGAGGTAGAT GCTATTATCC CTCTTGCATT
    57483169  [G/A/C/T]GTTGGAGTC TAGTTAGGGG ATAGAAACCA TGCTAGTTGA
    57483209  GCTGTTCTGC TTATAGAGTA GCCATTCTTT ATTCCTTTAC
    57483249  TTTTTTAATA AACTTGCCTT AAAAAA[A/C/T]AAA AAAGAAAACA
    57483289  TGCTAGTTGT TTGTACACAG AGAGTTAAGC TAAGGAAGTG
    57483329  TTCATGGGGA TGTAAAATTA ACTAACTGAA AGAGTAAAAA
    57483369  G
Posledn\u{ed} zobrazen\u{e1} b\u{e1}ze: 57483369
";

    #[test]
    fn collapses_a_second_snp_marker_sharing_the_window() {
        let blocks = parse_pasted_text(PAIRED_SAMPLE).unwrap();
        assert_eq!(blocks.len(), 1);
        let b = &blocks[0];
        assert_eq!(b.rsid, "rs277072");
        // 200/200 only holds if the second [A/C/T] marker collapsed to
        // exactly one base rather than leaking 5 extra characters.
        assert_eq!(b.upstream_seq.len(), 200);
        assert_eq!(b.downstream_seq.len(), 200);
        assert!(!b.upstream_seq.contains('[') && !b.downstream_seq.contains('['));
        assert!(b.upstream_seq.chars().all(|c| "ACGTN".contains(c)));
        assert!(b.downstream_seq.chars().all(|c| "ACGTN".contains(c)));
        assert_eq!(b.other_targets, Vec::<String>::new()); // plain-text path: no summary table to source this from
    }
}
