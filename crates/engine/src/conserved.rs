//! Conserved-region primer design over a multi-sequence alignment (Phase
//! 7). Genuinely new algorithmic surface, not a port of anything in the
//! Python app or in Oligool — Oligool's own conserved-region tooling is
//! entirely client-side visual inspection (`anchorGrid.ts`/`msa.ts`), it
//! never runs primer design against an alignment server-side.
//!
//! Scope, deliberately kept narrow rather than attempting full IUPAC
//! degenerate-primer support: given an alignment and a caller-identified
//! conserved column range, compute a plain ACGT **majority consensus**
//! over that range (columns where the majority vote is a gap are dropped
//! entirely, not represented as an ambiguity code), then run the existing
//! backend-agnostic `picker` pipeline against that consensus exactly as it
//! would run against any other template. Real IUPAC-ambiguous degenerate
//! primers are a materially harder problem (`calc_tm`/`calc_hairpin`
//! neither accept nor meaningfully score non-ACGT bases), so that's left as
//! a documented limitation, not attempted here.

use crate::backend::{ThermoBackend, ThermoParams};
use crate::design_internal::MAX_POOL_FOR_PAIRING;
use crate::picker::{pick_oligos, pick_pairs, scan_candidates, CandidateConstraints, OligoFilters, PairWeights, PenaltyWeights, ScoredCandidate, ScoredPair, Strand};

#[derive(Debug, Clone, PartialEq)]
pub struct AlignedRecord {
    pub id: String,
    pub seq: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ConservedError {
    #[error("alignment has no records")]
    Empty,
    #[error("aligned records have inconsistent lengths (expected {expected}, found {found} in record {index})")]
    InconsistentLength { expected: usize, found: usize, index: usize },
    #[error("column range [{start}, {end}) is out of bounds for an alignment of length {len}")]
    RangeOutOfBounds { start: usize, end: usize, len: usize },
    #[error("no non-gap consensus could be formed over this column range (every column's majority vote was a gap)")]
    NoConsensus,
}

/// Minimal FASTA parser — just enough to read back what `align::run_msa`
/// produces (one `>id` header per record, sequence possibly wrapped across
/// multiple lines). Deliberately not exposed from `crates/align` itself:
/// the `/align` route's own contract is a raw-string passthrough with *no*
/// server-side parsing (the frontend does all interpretation for display),
/// so this parser exists only to feed conserved-region *design*, a
/// separate feature that genuinely needs to understand alignment structure.
pub fn parse_aligned_fasta(text: &str) -> Vec<AlignedRecord> {
    let mut records = Vec::new();
    let mut current_id: Option<String> = None;
    let mut current_seq = String::new();

    for line in text.lines() {
        let line = line.trim_end();
        if let Some(id) = line.strip_prefix('>') {
            if let Some(prev_id) = current_id.take() {
                records.push(AlignedRecord { id: prev_id, seq: std::mem::take(&mut current_seq) });
            }
            current_id = Some(id.trim().to_string());
        } else if current_id.is_some() {
            current_seq.push_str(line.trim());
        }
    }
    if let Some(id) = current_id {
        records.push(AlignedRecord { id, seq: current_seq });
    }
    records
}

fn validate_alignment(records: &[AlignedRecord]) -> Result<usize, ConservedError> {
    let len = records.first().ok_or(ConservedError::Empty)?.seq.len();
    for (i, r) in records.iter().enumerate() {
        if r.seq.len() != len {
            return Err(ConservedError::InconsistentLength { expected: len, found: r.seq.len(), index: i });
        }
    }
    Ok(len)
}

/// Majority-vote consensus over `[col_start, col_end)`, uppercase ACGT
/// only. A column whose most common character (across all records) is a
/// gap is dropped from the output entirely, rather than represented as a
/// placeholder — the output is a plain, contiguous ACGT string suitable
/// for `picker::scan_candidates`, never a gapped one. Ties break in a
/// fixed `A > C > G > T > N` order, purely for determinism (a real tie
/// means the "conserved" region wasn't as conserved as assumed at that
/// position — this doesn't try to be clever about it).
pub fn majority_consensus(records: &[AlignedRecord], col_start: usize, col_end: usize) -> Result<String, ConservedError> {
    let len = validate_alignment(records)?;
    if col_start >= col_end || col_end > len {
        return Err(ConservedError::RangeOutOfBounds { start: col_start, end: col_end, len });
    }

    const ORDER: [u8; 5] = [b'A', b'C', b'G', b'T', b'N'];
    let mut consensus = String::with_capacity(col_end - col_start);

    for col in col_start..col_end {
        let mut counts = [0usize; 5]; // A C G T N; gap counted separately
        let mut gap_count = 0usize;
        for r in records {
            match r.seq.as_bytes()[col].to_ascii_uppercase() {
                b'A' => counts[0] += 1,
                b'C' => counts[1] += 1,
                b'G' => counts[2] += 1,
                b'T' => counts[3] += 1,
                b'-' | b'.' => gap_count += 1,
                _ => counts[4] += 1, // ambiguity codes / N in an input sequence
            }
        }
        let (best_idx, &best_count) = counts.iter().enumerate().max_by_key(|&(_, &c)| c).unwrap();
        if gap_count > best_count {
            continue; // majority is a gap at this column - drop it
        }
        if best_count == 0 {
            continue; // an all-gap column (shouldn't normally happen mid-alignment)
        }
        consensus.push(ORDER[best_idx] as char);
    }

    if consensus.is_empty() {
        return Err(ConservedError::NoConsensus);
    }
    Ok(consensus)
}

/// Runs the `picker` pipeline (`scan_candidates` -> `pick_oligos`) against the majority consensus of a
/// conserved column range — single-oligo candidates, not pairs (see
/// [`design_pairs_in_conserved_region`] for pairs).
#[allow(clippy::too_many_arguments)]
pub fn scan_conserved_region(
    backend: &dyn ThermoBackend,
    records: &[AlignedRecord],
    col_start: usize,
    col_end: usize,
    constraints: &CandidateConstraints,
    thermo: ThermoParams,
    weights: &PenaltyWeights,
    num_return: usize,
) -> Result<Vec<ScoredCandidate>, ConservedError> {
    let consensus = majority_consensus(records, col_start, col_end)?;
    let candidates = scan_candidates(&consensus, constraints);
    Ok(pick_oligos(backend, &consensus, &candidates, Strand::Forward, constraints, &OligoFilters::default(), thermo, weights, num_return).oligos)
}

/// Same idea, but pairs a LEFT pool (upstream of `target_start`) against a
/// RIGHT pool (downstream of `target_end`, both relative to the consensus
/// string) — the conserved-region analogue of
/// `design_internal::design_pairs_via_picker`, with the same pool cap.
#[allow(clippy::too_many_arguments)]
pub fn design_pairs_in_conserved_region(
    backend: &dyn ThermoBackend,
    records: &[AlignedRecord],
    col_start: usize,
    col_end: usize,
    target_start: usize,
    target_end: usize,
    constraints: &CandidateConstraints,
    product_size_range: (usize, usize),
    thermo: ThermoParams,
    num_return: usize,
) -> Result<Vec<ScoredPair>, ConservedError> {
    let consensus = majority_consensus(records, col_start, col_end)?;
    let all_candidates = scan_candidates(&consensus, constraints);
    let left_pool: Vec<_> = all_candidates.iter().copied().filter(|c| c.end <= target_start).collect();
    let right_pool: Vec<_> = all_candidates.iter().copied().filter(|c| c.start >= target_end).collect();

    let weights = PenaltyWeights::default();
    let filters = OligoFilters::default();
    let left = pick_oligos(backend, &consensus, &left_pool, Strand::Forward, constraints, &filters, thermo, &weights, MAX_POOL_FOR_PAIRING);
    let right = pick_oligos(backend, &consensus, &right_pool, Strand::Reverse, constraints, &filters, thermo, &weights, MAX_POOL_FOR_PAIRING);

    Ok(pick_pairs(backend, &left.oligos, &right.oligos, product_size_range, thermo, &PairWeights::default(), num_return).pairs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_native::NativeBackend;
    use crate::picker::{GcRange, SizeRange, TmRange};

    fn rec(id: &str, seq: &str) -> AlignedRecord {
        AlignedRecord { id: id.to_string(), seq: seq.to_string() }
    }

    #[test]
    fn parse_aligned_fasta_reads_wrapped_sequences() {
        let text = ">seq1\nACGT\nACGT\n>seq2\nACGTACGT\n";
        let records = parse_aligned_fasta(text);
        assert_eq!(records, vec![rec("seq1", "ACGTACGT"), rec("seq2", "ACGTACGT")]);
    }

    #[test]
    fn majority_consensus_picks_the_most_common_base_per_column() {
        let records = vec![rec("a", "ACGT"), rec("b", "ACGT"), rec("c", "ATGT")]; // column 1: C,C,T -> C wins
        let consensus = majority_consensus(&records, 0, 4).unwrap();
        assert_eq!(consensus, "ACGT");
    }

    #[test]
    fn majority_consensus_drops_columns_where_gap_wins() {
        let records = vec![rec("a", "AC-T"), rec("b", "AC-T"), rec("c", "ACGT")]; // column 2: -,-,G -> gap wins, dropped
        let consensus = majority_consensus(&records, 0, 4).unwrap();
        assert_eq!(consensus, "ACT");
    }

    #[test]
    fn majority_consensus_rejects_inconsistent_lengths() {
        let records = vec![rec("a", "ACGT"), rec("b", "ACG")];
        assert!(matches!(majority_consensus(&records, 0, 4), Err(ConservedError::InconsistentLength { .. })));
    }

    #[test]
    fn majority_consensus_rejects_out_of_bounds_range() {
        let records = vec![rec("a", "ACGT")];
        assert!(matches!(majority_consensus(&records, 0, 10), Err(ConservedError::RangeOutOfBounds { .. })));
    }

    fn constraints() -> CandidateConstraints {
        CandidateConstraints {
            size: SizeRange { min: 18, opt: 20, max: 25 },
            tm: TmRange { min: 55.0, opt: 60.0, max: 65.0 },
            gc: GcRange { min: 30.0, max: 70.0 },
        }
    }

    /// A real, non-trivial "conserved region across several near-identical
    /// sequences" scenario — proves the whole pipeline (consensus ->
    /// scan -> score -> rank) end-to-end, not just the consensus step in
    /// isolation.
    #[test]
    fn scan_conserved_region_finds_bounds_respecting_candidates() {
        let base = "ACGTGACCTGATCGATCGGATCGTAGCTAGCATGCACCTGATCGATCGGATCGTAGCTAGCATGCA";
        let records = vec![rec("a", base), rec("b", base), rec("c", base)];
        let backend = NativeBackend;
        let result = scan_conserved_region(&backend, &records, 0, base.len(), &constraints(), ThermoParams::default(), &PenaltyWeights::default(), 5).unwrap();
        assert!(!result.is_empty());
        for sc in &result {
            assert!(sc.tm >= constraints().tm.min && sc.tm <= constraints().tm.max);
            assert!((constraints().size.min..=constraints().size.max).contains(&sc.candidate.len()));
        }
    }

    #[test]
    fn design_pairs_in_conserved_region_finds_flanking_pairs() {
        let base = "ACGTGACCTGATCGATCGGATCGTAGCTAGCATGCACCTGATCGATCGGATCGTAGCTAGCATGCAGGACTTAGTGCCTAGCTTGCCGAATATCATGGTGCACTCTCAGTACAATCTGCTCTGATGCCGCATAGTTAAGCCA";
        let records = vec![rec("a", base), rec("b", base)];
        let target_start = base.len() / 2;
        let target_end = target_start + 10;

        let pairs = design_pairs_in_conserved_region(&NativeBackend, &records, 0, base.len(), target_start, target_end, &constraints(), (60, 130), ThermoParams::default(), 5).unwrap();
        assert!(!pairs.is_empty());
        for p in &pairs {
            assert!(p.right.candidate.start >= p.left.candidate.end);
        }
    }
}
