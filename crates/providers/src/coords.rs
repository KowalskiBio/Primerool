//! `cds_annotations_in_transcript_coords` — identical pure computation in
//! both `ensembl_api.py` and `ncbi_api.py` (confirmed byte-for-byte
//! identical source), so it lives here once rather than being duplicated
//! per provider.
//!
//! Maps genomic CDS intervals onto transcript-relative (0-based,
//! end-exclusive) coordinates of the exon-concatenated (spliced) sequence.
//! Walks exons in sorted genomic order with a two-pointer merge against
//! sorted CDS intervals — note `j` is a single index that persists across
//! the whole exon loop (only ever advances), it is intentionally **not**
//! reset per exon; replicated exactly as written in the Python original.

use crate::{Interval, Strand, TranscriptInfo};

pub fn cds_annotations_in_transcript_coords(tinfo: &TranscriptInfo) -> Vec<Interval> {
    if tinfo.exons.is_empty() || tinfo.cds.is_empty() {
        return Vec::new();
    }

    let mut exons_sorted = tinfo.exons.clone();
    exons_sorted.sort();
    let mut cds_sorted = tinfo.cds.clone();
    cds_sorted.sort();

    let mut ann: Vec<Interval> = Vec::new();
    let mut exon_offset: u64 = 0;
    let mut j: usize = 0;

    for &(exon_start, exon_end) in &exons_sorted {
        let exon_len = exon_end - exon_start + 1;

        while j < cds_sorted.len() && cds_sorted[j].1 < exon_start {
            j += 1;
        }

        let mut k = j;
        while k < cds_sorted.len() && cds_sorted[k].0 <= exon_end {
            let (cds_start, cds_end) = cds_sorted[k];
            let ov_start = exon_start.max(cds_start);
            let ov_end = exon_end.min(cds_end);
            if ov_start <= ov_end {
                let rel_start = exon_offset + (ov_start - exon_start);
                let rel_end = exon_offset + (ov_end - exon_start) + 1;
                ann.push((rel_start, rel_end));
            }
            k += 1;
        }

        exon_offset += exon_len;
    }

    if tinfo.strand == Strand::Minus {
        let total_len: u64 = exons_sorted.iter().map(|(s, e)| e - s + 1).sum();
        ann = ann.into_iter().map(|(start, end)| (total_len - end, total_len - start)).collect();
        ann.sort();
    }

    ann
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tinfo(strand: Strand, exons: Vec<Interval>, cds: Vec<Interval>) -> TranscriptInfo {
        TranscriptInfo {
            transcript_id: "T1".into(),
            transcript_name: "T1".into(),
            chrom: "1".into(),
            chr_accession: "".into(),
            strand,
            exons,
            cds,
            utr5: vec![],
            utr3: vec![],
            utr: vec![],
        }
    }

    #[test]
    fn empty_exons_or_cds_returns_empty() {
        assert!(cds_annotations_in_transcript_coords(&tinfo(Strand::Plus, vec![], vec![(1, 10)])).is_empty());
        assert!(cds_annotations_in_transcript_coords(&tinfo(Strand::Plus, vec![(1, 10)], vec![])).is_empty());
    }

    #[test]
    fn plus_strand_single_exon_full_cds() {
        // One exon [1,100], CDS exactly matches -> transcript coords [0,100)
        let t = tinfo(Strand::Plus, vec![(1, 100)], vec![(1, 100)]);
        assert_eq!(cds_annotations_in_transcript_coords(&t), vec![(0, 100)]);
    }

    #[test]
    fn plus_strand_utr_then_cds() {
        // Exon [1,100], CDS only in [51,100] -> UTR5 occupies transcript [0,50), CDS [50,100)
        let t = tinfo(Strand::Plus, vec![(1, 100)], vec![(51, 100)]);
        assert_eq!(cds_annotations_in_transcript_coords(&t), vec![(50, 100)]);
    }

    #[test]
    fn multi_exon_cds_spanning_two_exons() {
        // Exon1 [1,50] (len 50), Exon2 [101,150] (len 50). CDS = [30,50] + [101,120].
        // Exon1 CDS overlap: [30,50] -> rel (29, 50)
        // Exon2 CDS overlap: [101,120] -> offset 50 + (101-101)=50 .. 50+(120-101)+1=70
        let t = tinfo(Strand::Plus, vec![(1, 50), (101, 150)], vec![(30, 50), (101, 120)]);
        assert_eq!(cds_annotations_in_transcript_coords(&t), vec![(29, 50), (50, 70)]);
    }

    #[test]
    fn minus_strand_mirrors_intervals() {
        // Same as plus_strand_single_exon_full_cds but minus strand: total_len=100,
        // ann=[(0,100)] -> mirrored to [(100-100, 100-0)] = [(0,100)] (symmetric case).
        let t = tinfo(Strand::Minus, vec![(1, 100)], vec![(1, 100)]);
        assert_eq!(cds_annotations_in_transcript_coords(&t), vec![(0, 100)]);

        // Asymmetric case: exon [1,100], CDS [1,50] -> plus-strand ann=(0,50).
        // Minus strand mirrors: total_len=100 -> (100-50, 100-0) = (50, 100).
        let t2 = tinfo(Strand::Minus, vec![(1, 100)], vec![(1, 50)]);
        assert_eq!(cds_annotations_in_transcript_coords(&t2), vec![(50, 100)]);
    }
}
