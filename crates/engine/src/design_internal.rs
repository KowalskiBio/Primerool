//! Classic target-flanking primer-pair design (`/design_primers`,
//! `mode: "internal"`): LEFT primers must end at or before the target,
//! RIGHT primers must start at or after it.
//!
//! Scans the whole sequence once, splits the windows into a LEFT pool
//! (upstream of the target) and a RIGHT pool (downstream), picks each pool
//! through `picker::pick_oligos` and pairs them via `picker::pick_pairs`.

use crate::backend::{ThermoBackend, ThermoParams};
use crate::defaults::{DEFAULT_PRIMER_GC, DEFAULT_PRIMER_SIZE, DEFAULT_PRIMER_TM};
use crate::picker::{pick_oligos, pick_pairs, scan_candidates, CandidateConstraints, GcRange, OligoFilters, PairWeights, PenaltyWeights, ScoredPair, SizeRange, Strand, TmRange};

const PRODUCT_SIZE_RANGE: (usize, usize) = (100, 1000);
const NUM_RETURN: usize = 5;

pub struct PickerDesignParams {
    pub size: SizeRange,
    pub tm: TmRange,
    pub gc: GcRange,
    pub product_size_range: (usize, usize),
    pub num_return: usize,
}

impl Default for PickerDesignParams {
    fn default() -> Self {
        Self {
            size: SizeRange { min: DEFAULT_PRIMER_SIZE.min_size as usize, opt: DEFAULT_PRIMER_SIZE.opt_size as usize, max: DEFAULT_PRIMER_SIZE.max_size as usize },
            tm: TmRange { min: DEFAULT_PRIMER_TM.min_tm, opt: DEFAULT_PRIMER_TM.opt_tm, max: DEFAULT_PRIMER_TM.max_tm },
            gc: GcRange { min: DEFAULT_PRIMER_GC.min_gc, max: DEFAULT_PRIMER_GC.max_gc },
            product_size_range: PRODUCT_SIZE_RANGE,
            num_return: NUM_RETURN,
        }
    }
}

/// How many individually-best candidates per side feed into `pick_pairs`.
/// Pair ranking itself is cheap (the heterodimer DP only runs down the
/// ranked list), so this mainly bounds the hairpin/self-dimer DPs per side
/// while leaving enough spread for product-size constraints to be met.
pub const MAX_POOL_FOR_PAIRING: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub struct InternalDesignResult {
    pub pairs: Vec<ScoredPair>,
    /// Primer3-style rejection summary for each stage, for "no primers
    /// found" messages.
    pub left_explain: String,
    pub right_explain: String,
    pub pair_explain: String,
}

/// `target_start`/`target_end` are 0-based indices into `sequence`, end
/// exclusive.
pub fn design_pairs_via_picker(backend: &dyn ThermoBackend, sequence: &str, target_start: usize, target_end: usize, params: &PickerDesignParams, thermo: ThermoParams) -> InternalDesignResult {
    let sequence = sequence.to_uppercase().replace(' ', "");
    let constraints = CandidateConstraints { size: params.size, tm: params.tm, gc: params.gc };
    let filters = OligoFilters::default();
    let weights = PenaltyWeights::default();

    let all_candidates = scan_candidates(&sequence, &constraints);
    let left_pool: Vec<_> = all_candidates.iter().copied().filter(|c| c.end <= target_start).collect();
    let right_pool: Vec<_> = all_candidates.iter().copied().filter(|c| c.start >= target_end).collect();

    let left = pick_oligos(backend, &sequence, &left_pool, Strand::Forward, &constraints, &filters, thermo, &weights, MAX_POOL_FOR_PAIRING);
    let right = pick_oligos(backend, &sequence, &right_pool, Strand::Reverse, &constraints, &filters, thermo, &weights, MAX_POOL_FOR_PAIRING);
    let pairs = pick_pairs(backend, &left.oligos, &right.oligos, params.product_size_range, thermo, &PairWeights::default(), params.num_return);

    InternalDesignResult { left_explain: left.explain(), right_explain: right.explain(), pair_explain: pairs.explain(), pairs: pairs.pairs }
}

/// The route-facing entry point with the app's default constraints.
pub fn design_primers_for_region(backend: &dyn ThermoBackend, sequence: &str, target_start: usize, target_end: usize) -> InternalDesignResult {
    design_pairs_via_picker(backend, sequence, target_start, target_end, &PickerDesignParams::default(), ThermoParams::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_native::NativeBackend;

    const TEMPLATE: &str = "GATCGGAAGAGCACACGTCTGAACTCCAGTCACATCACGATCTCGTATGCCGTCTTCTGCTTGAAAAAAAAAAAA\
                GGCCTATCAAGCAGTGGTATCAACGCAGAGTACATGGGTACGACCTTCTGGCCTAGAGATCCGATGCTGACTGCC\
                AACTTAGTGCCTAGCTTGCCGAATATCATGGTGCACTCTCAGTACAATCTGCTCTGATGCCGCATAGTTAAGCCA";

    fn params() -> PickerDesignParams {
        PickerDesignParams { product_size_range: (100, 300), ..PickerDesignParams::default() }
    }

    #[test]
    fn finds_bounds_respecting_pairs_flanking_the_target() {
        let p = params();
        let result = design_pairs_via_picker(&NativeBackend, TEMPLATE, 100, 120, &p, ThermoParams::default());
        assert!(!result.pairs.is_empty(), "left: {} / right: {} / pair: {}", result.left_explain, result.right_explain, result.pair_explain);
        for pair in &result.pairs {
            assert!(pair.left.candidate.end <= 100, "left primer must end at or before the target");
            assert!(pair.right.candidate.start >= 120, "right primer must start at or after the target");
            assert!((p.product_size_range.0..=p.product_size_range.1).contains(&pair.product_size));
            assert!((p.size.min..=p.size.max).contains(&pair.left.candidate.len()));
            assert!((p.size.min..=p.size.max).contains(&pair.right.candidate.len()));
            assert!(pair.left.tm >= p.tm.min && pair.left.tm <= p.tm.max);
            assert!(pair.right.tm >= p.tm.min && pair.right.tm <= p.tm.max);
        }
        for w in result.pairs.windows(2) {
            assert!(w[0].penalty <= w[1].penalty);
        }
    }

    #[test]
    fn too_short_template_reports_zero_pairs_with_an_explain_string() {
        let result = design_primers_for_region(&NativeBackend, "ACGTACGTACGT", 2, 4);
        assert!(result.pairs.is_empty());
        assert!(result.left_explain.starts_with("considered 0"));
    }
}
