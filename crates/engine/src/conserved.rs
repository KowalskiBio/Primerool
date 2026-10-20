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
use crate::picker::{pick_oligos, pick_pairs, scan_candidates, Candidate, CandidateConstraints, OligoFilters, PairWeights, PenaltyWeights, ScoredCandidate, ScoredPair, Strand};

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
    consensus_with_columns(records, col_start, col_end).map(|(consensus, _)| consensus)
}

/// `majority_consensus` plus, for each consensus base, the alignment
/// column it came from - the map from consensus offsets (what the picker
/// works in) back to columns (what coverage and windows work in).
pub fn consensus_with_columns(records: &[AlignedRecord], col_start: usize, col_end: usize) -> Result<(String, Vec<usize>), ConservedError> {
    let len = validate_alignment(records)?;
    if col_start >= col_end || col_end > len {
        return Err(ConservedError::RangeOutOfBounds { start: col_start, end: col_end, len });
    }

    const ORDER: [u8; 5] = [b'A', b'C', b'G', b'T', b'N'];
    let mut consensus = String::with_capacity(col_end - col_start);
    let mut columns = Vec::with_capacity(col_end - col_start);

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
        columns.push(col);
    }

    if consensus.is_empty() {
        return Err(ConservedError::NoConsensus);
    }
    Ok((consensus, columns))
}

/// Bases at the primer's 3' end where a mismatch is counted separately:
/// polymerase extends from there, so a mismatch in these is what stops
/// a primer amplifying a sequence.
pub const THREE_PRIME_WINDOW: usize = 5;

/// How many of the aligned sequences an oligo matches exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Coverage {
    pub matching_rows: usize,
    pub total_rows: usize,
    /// Rows with a mismatch (or gap) in the oligo's 3'-terminal
    /// `THREE_PRIME_WINDOW` bases.
    pub three_prime_mismatch_rows: usize,
}

impl Coverage {
    /// Sort key: fewest 3'-end failures, then fewest mismatching rows.
    fn rank(&self) -> (usize, usize) {
        (self.three_prime_mismatch_rows, self.total_rows - self.matching_rows)
    }
}

/// Compares the consensus span `candidate` covers against every record
/// at the same alignment columns (plus any column between them, so a
/// sequence with an insertion there counts as mismatching). A forward
/// primer's 3' end is the span's right edge; a reverse primer's, its
/// left edge.
pub fn oligo_coverage(records: &[AlignedRecord], consensus: &str, columns: &[usize], candidate: Candidate, strand: Strand) -> Coverage {
    let cons = consensus.as_bytes();
    let (first, last) = (columns[candidate.start], columns[candidate.end - 1]);
    let three_prime = match strand {
        Strand::Forward => columns[candidate.end.saturating_sub(THREE_PRIME_WINDOW).max(candidate.start)]..=last,
        Strand::Reverse => first..=columns[(candidate.start + THREE_PRIME_WINDOW).min(candidate.end) - 1],
    };
    let mut coverage = Coverage { matching_rows: 0, total_rows: records.len(), three_prime_mismatch_rows: 0 };
    for r in records {
        let row = r.seq.as_bytes();
        let mut i = candidate.start;
        let (mut mismatch, mut three_prime_mismatch) = (false, false);
        for col in first..=last {
            let base = row[col].to_ascii_uppercase();
            let differs = if i < candidate.end && columns[i] == col {
                i += 1;
                base != cons[i - 1]
            } else {
                // A column the consensus dropped (gap majority): a base
                // here is an insertion in this row.
                base != b'-' && base != b'.'
            };
            if differs {
                mismatch = true;
                three_prime_mismatch |= three_prime.contains(&col);
            }
        }
        if !mismatch {
            coverage.matching_rows += 1;
        }
        if three_prime_mismatch {
            coverage.three_prime_mismatch_rows += 1;
        }
    }
    coverage
}

/// A designed oligo with how many sequences it matches.
#[derive(Debug, Clone, PartialEq)]
pub struct ConservedOligo {
    pub oligo: ScoredCandidate,
    pub coverage: Coverage,
    /// The alignment columns it spans, `[start, end)`.
    pub columns: (usize, usize),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConservedPair {
    pub pair: ScoredPair,
    pub left: ConservedOligo,
    pub right: ConservedOligo,
}

fn with_coverage(records: &[AlignedRecord], consensus: &str, columns: &[usize], oligo: ScoredCandidate) -> ConservedOligo {
    let coverage = oligo_coverage(records, consensus, columns, oligo.candidate, oligo.strand);
    let span = (columns[oligo.candidate.start], columns[oligo.candidate.end - 1] + 1);
    ConservedOligo { oligo, coverage, columns: span }
}

/// Best-covering first, then lowest penalty.
fn sort_by_coverage(oligos: &mut [ConservedOligo]) {
    oligos.sort_by(|a, b| a.coverage.rank().cmp(&b.coverage.rank()).then(a.oligo.penalty.total_cmp(&b.oligo.penalty)));
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
) -> Result<Vec<ConservedOligo>, ConservedError> {
    let (consensus, columns) = consensus_with_columns(records, col_start, col_end)?;
    let candidates = scan_candidates(&consensus, constraints);
    // Score a wide pool, then rank it by coverage: the best-scoring
    // oligos are worthless if they miss half the sequences.
    let pool = pick_oligos(backend, &consensus, &candidates, Strand::Forward, constraints, &OligoFilters::default(), thermo, weights, MAX_POOL_FOR_PAIRING).oligos;
    let mut oligos: Vec<ConservedOligo> = pool.into_iter().map(|o| with_coverage(records, &consensus, &columns, o)).collect();
    sort_by_coverage(&mut oligos);
    oligos.truncate(num_return);
    Ok(oligos)
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
) -> Result<Vec<ConservedPair>, ConservedError> {
    let (consensus, columns) = consensus_with_columns(records, col_start, col_end)?;
    let all_candidates = scan_candidates(&consensus, constraints);
    let left_pool: Vec<_> = all_candidates.iter().copied().filter(|c| c.end <= target_start).collect();
    let right_pool: Vec<_> = all_candidates.iter().copied().filter(|c| c.start >= target_end).collect();
    Ok(pairs_from_pools(backend, records, &consensus, &columns, &left_pool, &right_pool, constraints, product_size_range, thermo, num_return))
}

/// Pairs a forward primer lying entirely in the alignment columns
/// `left` with a reverse primer entirely in `right` (both `[start,
/// end)`, `left` before `right`) - e.g. two conserved windows.
#[allow(clippy::too_many_arguments)]
pub fn design_pairs_between_windows(
    backend: &dyn ThermoBackend,
    records: &[AlignedRecord],
    left: (usize, usize),
    right: (usize, usize),
    constraints: &CandidateConstraints,
    product_size_range: (usize, usize),
    thermo: ThermoParams,
    num_return: usize,
) -> Result<Vec<ConservedPair>, ConservedError> {
    let (consensus, columns) = consensus_with_columns(records, left.0, right.1.max(left.1))?;
    let within = |c: &Candidate, (from, to): (usize, usize)| columns[c.start] >= from && columns[c.end - 1] < to;
    let all_candidates = scan_candidates(&consensus, constraints);
    let left_pool: Vec<_> = all_candidates.iter().copied().filter(|c| within(c, left)).collect();
    let right_pool: Vec<_> = all_candidates.iter().copied().filter(|c| within(c, right)).collect();
    Ok(pairs_from_pools(backend, records, &consensus, &columns, &left_pool, &right_pool, constraints, product_size_range, thermo, num_return))
}

/// Scores both pools, keeps the best-covering oligos of each, pairs them,
/// and ranks the pairs by their worse primer's coverage, then penalty.
#[allow(clippy::too_many_arguments)]
fn pairs_from_pools(
    backend: &dyn ThermoBackend,
    records: &[AlignedRecord],
    consensus: &str,
    columns: &[usize],
    left_pool: &[Candidate],
    right_pool: &[Candidate],
    constraints: &CandidateConstraints,
    product_size_range: (usize, usize),
    thermo: ThermoParams,
    num_return: usize,
) -> Vec<ConservedPair> {
    let weights = PenaltyWeights::default();
    let filters = OligoFilters::default();
    let scored = |pool: &[Candidate], strand: Strand| -> Vec<ConservedOligo> {
        let picked = pick_oligos(backend, consensus, pool, strand, constraints, &filters, thermo, &weights, MAX_POOL_FOR_PAIRING).oligos;
        let mut oligos: Vec<ConservedOligo> = picked.into_iter().map(|o| with_coverage(records, consensus, columns, o)).collect();
        sort_by_coverage(&mut oligos);
        oligos.truncate(PAIRING_POOL);
        oligos
    };
    let left = scored(left_pool, Strand::Forward);
    let right = scored(right_pool, Strand::Reverse);

    let left_oligos: Vec<ScoredCandidate> = left.iter().map(|o| o.oligo.clone()).collect();
    let right_oligos: Vec<ScoredCandidate> = right.iter().map(|o| o.oligo.clone()).collect();
    let pairs = pick_pairs(backend, &left_oligos, &right_oligos, product_size_range, thermo, &PairWeights::default(), num_return.saturating_mul(10)).pairs;

    let find = |pool: &[ConservedOligo], oligo: &ScoredCandidate| pool.iter().find(|o| o.oligo.candidate == oligo.candidate).cloned().expect("paired oligo comes from its pool");
    let mut out: Vec<ConservedPair> = pairs.into_iter().map(|pair| ConservedPair { left: find(&left, &pair.left), right: find(&right, &pair.right), pair }).collect();
    let worse = |p: &ConservedPair| p.left.coverage.rank().max(p.right.coverage.rank());
    out.sort_by(|a, b| worse(a).cmp(&worse(b)).then(a.pair.penalty.total_cmp(&b.pair.penalty)));
    out.truncate(num_return);
    out
}

/// Oligos per side carried into pairing, after ranking by coverage.
const PAIRING_POOL: usize = 60;

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
        for sc in result.iter().map(|o| &o.oligo) {
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
            assert!(p.pair.right.candidate.start >= p.pair.left.candidate.end);
        }
    }

    #[test]
    fn consensus_columns_skip_gap_majority_columns() {
        let records = vec![rec("a", "AC-GT"), rec("b", "AC-GT"), rec("c", "ACAGT")];
        let (consensus, columns) = consensus_with_columns(&records, 0, 5).unwrap();
        assert_eq!(consensus, "ACGT");
        assert_eq!(columns, [0, 1, 3, 4]);
    }

    #[test]
    fn coverage_counts_mismatching_rows_and_three_prime_failures() {
        //                      0123456789
        let records = vec![
            rec("a", "ACGTACGTAC"),
            rec("b", "ACGTACGTAC"),
            rec("c", "TCGTACGTAC"), // 5' end mismatch
            rec("d", "ACGTACGTAG"), // 3' end mismatch (forward)
            rec("e", "ACGTA-GTAC"), // gap at column 5
        ];
        let (consensus, columns) = consensus_with_columns(&records, 0, 10).unwrap();
        let whole = Candidate { start: 0, end: 10 };
        // Forward: the 3' window is columns 5..=9 - rows d and e fail there.
        let fwd = oligo_coverage(&records, &consensus, &columns, whole, Strand::Forward);
        assert_eq!(fwd, Coverage { matching_rows: 2, total_rows: 5, three_prime_mismatch_rows: 2 });
        // Reverse: the 3' end is the left edge, columns 0..=4 - only row c.
        let rev = oligo_coverage(&records, &consensus, &columns, whole, Strand::Reverse);
        assert_eq!(rev, Coverage { matching_rows: 2, total_rows: 5, three_prime_mismatch_rows: 1 });
    }

    #[test]
    fn coverage_counts_an_insertion_inside_the_span() {
        let records = vec![rec("a", "ACG-TAC"), rec("b", "ACG-TAC"), rec("c", "ACGGTAC")];
        let (consensus, columns) = consensus_with_columns(&records, 0, 7).unwrap();
        let cov = oligo_coverage(&records, &consensus, &columns, Candidate { start: 0, end: 6 }, Strand::Forward);
        assert_eq!(cov.matching_rows, 2);
    }

    #[test]
    fn pairs_between_windows_stay_inside_them() {
        let base = "ACGTGACCTGATCGATCGGATCGTAGCTAGCATGCACCTGATCGATCGGATCGTAGCTAGCATGCAGGACTTAGTGCCTAGCTTGCCGAATATCATGGTGCACTCTCAGTACAATCTGCTCTGATGCCGCATAGTTAAGCCA";
        let records = vec![rec("a", base), rec("b", base)];
        let (left, right) = ((0, 45), (90, base.len()));
        let pairs = design_pairs_between_windows(&NativeBackend, &records, left, right, &constraints(), (60, 150), ThermoParams::default(), 5).unwrap();
        assert!(!pairs.is_empty());
        for p in &pairs {
            assert!(p.left.columns.0 >= left.0 && p.left.columns.1 <= left.1, "{:?}", p.left.columns);
            assert!(p.right.columns.0 >= right.0 && p.right.columns.1 <= right.1, "{:?}", p.right.columns);
            assert_eq!(p.left.coverage.matching_rows, 2);
        }
    }
}
