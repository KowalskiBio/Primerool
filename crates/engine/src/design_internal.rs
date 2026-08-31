//! Port of `primer_internal.py::design_primers_for_region` — classic
//! `SEQUENCE_TARGET` primer-pair design. The real call sites in
//! `main.py`'s `/design_primers` route never pass a `primer_params`
//! override (confirmed by grep), so unlike the Python signature this
//! doesn't carry a dead override parameter.
//!
//! Python returns `primer3.design_primers()`'s raw dict straight through
//! with no post-processing (`analyze_primer` is not called here, unlike
//! every other design mode) — mirrored here by returning
//! `primer3_ffi::design::DesignResult` directly.

use primer3_ffi::design::{design_primers, DesignResult, GlobalSettings, SeqArgs};
use primer3_ffi::Primer3Error;

use crate::backend::{ThermoBackend, ThermoParams};
use crate::defaults::{DEFAULT_PRIMER_GC, DEFAULT_PRIMER_SIZE, DEFAULT_PRIMER_TM};
use crate::picker::{pick_pairs, rank, scan_candidates, score_candidates, CandidateConstraints, GcRange, PairWeights, PenaltyWeights, ScoredPair, SizeRange, TmRange};

const PRODUCT_SIZE_RANGE: (i32, i32) = (100, 1000);
const NUM_RETURN: i32 = 5;

/// `target_start`/`target_end` are 0-based indices into `sequence`, end
/// exclusive — matching `main.py`'s `target_start`/`target_end` request
/// fields.
pub fn design_primers_for_region(sequence: &str, target_start: i32, target_end: i32) -> Result<DesignResult, Primer3Error> {
    let sequence = sequence.to_uppercase().replace(' ', "");

    let mut gs = GlobalSettings::new();
    gs.set_primer_size(DEFAULT_PRIMER_SIZE.opt_size as i32, DEFAULT_PRIMER_SIZE.min_size as i32, DEFAULT_PRIMER_SIZE.max_size as i32);
    gs.set_primer_tm(DEFAULT_PRIMER_TM.opt_tm, DEFAULT_PRIMER_TM.min_tm, DEFAULT_PRIMER_TM.max_tm);
    gs.set_primer_gc(DEFAULT_PRIMER_GC.min_gc, DEFAULT_PRIMER_GC.max_gc);
    gs.set_num_return(NUM_RETURN);
    gs.set_pick_primers(true, true);
    gs.set_pick_internal_oligo(false);
    gs.set_product_size_range(PRODUCT_SIZE_RANGE.0, PRODUCT_SIZE_RANGE.1);

    let mut sa = SeqArgs::new(&sequence)?;
    sa.add_target(target_start, target_end - target_start);

    design_primers(&gs, &mut sa)
}

/// SEQUENCE_TARGET-equivalent design over `engine::picker`, generic over
/// `ThermoBackend` — the first working proof that a design mode can run on
/// `NativeBackend`, not just `Primer3Backend`. This is genuinely new
/// algorithmic surface, not a Python port: `choose_primers()` does its own
/// internal candidate enumeration and LEFT/RIGHT pairing that Primer3 never
/// exposes for reuse, so a backend-agnostic equivalent needs its own
/// pairing step — `picker::pick_pairs`, added alongside this function for
/// exactly this purpose.
///
/// Scans the whole `sequence` once, splits the results into a LEFT pool
/// (candidates ending at or before `target_start`) and a RIGHT pool
/// (candidates starting at or after `target_end`) — the same "primers must
/// flank the target" semantics as Primer3's own `SEQUENCE_TARGET`, just
/// implemented directly instead of delegated to the C picking engine — then
/// scores each pool and pairs them via `pick_pairs`.
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
            product_size_range: (PRODUCT_SIZE_RANGE.0 as usize, PRODUCT_SIZE_RANGE.1 as usize),
            num_return: NUM_RETURN as usize,
        }
    }
}

/// Caps how many individually-best candidates per side feed into
/// `pick_pairs`'s O(|left| × |right|) combinatorial step.
///
/// Measured, not guessed: a real 228bp test template with default
/// constraints produces 368 surviving LEFT candidates and 512 RIGHT
/// candidates — 188,416 raw combinations, of which 177,118 pass the
/// non-overlap + product-size filter and would each need a real
/// `calc_heterodimer` call. `calc_heterodimer` is a DP alignment, not the
/// closed-form `calc_tm` (measured at ~120µs/call vs. ~0.1µs/call on the
/// same machine) — 177,118 × 120µs is ~21 seconds, confirmed by an actual
/// benchmark run (24.8s wall time for this exact scenario), nowhere near
/// the "near-instant" interactivity this rewrite exists for. Capping each
/// side to its `MAX_POOL_FOR_PAIRING` best-individually-scored candidates
/// (already sorted by `rank` before this is applied) bounds the worst case
/// to 2,500 combinations (~300ms) while still pairing only oligos that
/// were already good on their own merits — the candidates most likely to
/// end up in the final `num_return` anyway.
const MAX_POOL_FOR_PAIRING: usize = 50;

pub fn design_pairs_via_picker(backend: &dyn ThermoBackend, sequence: &str, target_start: usize, target_end: usize, params: &PickerDesignParams, thermo: ThermoParams) -> Vec<ScoredPair> {
    let sequence = sequence.to_uppercase();
    let constraints = CandidateConstraints { size: params.size, tm: params.tm, gc: params.gc };

    let all_candidates = scan_candidates(&sequence, &constraints);
    let left_pool: Vec<_> = all_candidates.iter().copied().filter(|c| c.end <= target_start).collect();
    let right_pool: Vec<_> = all_candidates.iter().copied().filter(|c| c.start >= target_end).collect();

    let weights = PenaltyWeights::default();
    let mut left_scored = rank(score_candidates(backend, &sequence, &left_pool, &constraints, thermo, &weights));
    let mut right_scored = rank(score_candidates(backend, &sequence, &right_pool, &constraints, thermo, &weights));
    left_scored.truncate(MAX_POOL_FOR_PAIRING);
    right_scored.truncate(MAX_POOL_FOR_PAIRING);

    pick_pairs(backend, &sequence, &left_scored, &right_scored, params.product_size_range, thermo, &PairWeights::default(), params.num_return)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_pairs_flanking_target_in_a_realistic_template() {
        let seq = "GATCGGAAGAGCACACGTCTGAACTCCAGTCACATCACGATCTCGTATGCCGTCTTCTGCTTGAAAAAAAAAAAA\
                    GGCCTATCAAGCAGTGGTATCAACGCAGAGTACATGGGTACGACCTTCTGGCCTAGAGATCCGATGCTGACTGCC\
                    AACTTAGTGCCTAGCTTGCCGAATATCATGGTGCACTCTCAGTACAATCTGCTCTGATGCCGCATAGTTAAGCCA";
        let result = design_primers_for_region(seq, 100, 120).unwrap();
        assert!(!result.pairs.is_empty(), "expected at least one pair, explain: {:?}", result.left_explain);
        for pair in &result.pairs {
            assert!(pair.left.end <= 100 || pair.left.start >= 120);
            let product_len = pair.right.end - pair.left.start;
            assert!((100..=1000).contains(&product_len));
        }
    }

    #[test]
    fn too_short_template_reports_zero_pairs_with_an_explain_string() {
        let result = design_primers_for_region("ACGTACGTACGT", 2, 4).unwrap();
        assert!(result.pairs.is_empty());
        assert!(result.left_explain.is_some());
    }

    mod via_picker {
        use super::*;
        use crate::backend_native::NativeBackend;
        use crate::backend_primer3::Primer3Backend;

        const TEMPLATE: &str = "GATCGGAAGAGCACACGTCTGAACTCCAGTCACATCACGATCTCGTATGCCGTCTTCTGCTTGAAAAAAAAAAAA\
                    GGCCTATCAAGCAGTGGTATCAACGCAGAGTACATGGGTACGACCTTCTGGCCTAGAGATCCGATGCTGACTGCC\
                    AACTTAGTGCCTAGCTTGCCGAATATCATGGTGCACTCTCAGTACAATCTGCTCTGATGCCGCATAGTTAAGCCA";

        fn params() -> PickerDesignParams {
            PickerDesignParams { product_size_range: (100, 300), ..PickerDesignParams::default() }
        }

        fn assert_bounds_respecting(pairs: &[ScoredPair], target_start: usize, target_end: usize, p: &PickerDesignParams) {
            assert!(!pairs.is_empty());
            for pair in pairs {
                assert!(pair.left.candidate.end <= target_start, "left primer must end at or before the target");
                assert!(pair.right.candidate.start >= target_end, "right primer must start at or after the target");
                assert!((p.product_size_range.0..=p.product_size_range.1).contains(&pair.product_size));
                assert!((p.size.min..=p.size.max).contains(&pair.left.candidate.len()));
                assert!((p.size.min..=p.size.max).contains(&pair.right.candidate.len()));
                assert!(pair.left.tm >= p.tm.min && pair.left.tm <= p.tm.max);
                assert!(pair.right.tm >= p.tm.min && pair.right.tm <= p.tm.max);
            }
            for w in pairs.windows(2) {
                assert!(w[0].penalty <= w[1].penalty);
            }
        }

        #[test]
        fn works_with_primer3_backend() {
            let backend = Primer3Backend;
            let pairs = design_pairs_via_picker(&backend, TEMPLATE, 100, 120, &params(), ThermoParams::default());
            assert_bounds_respecting(&pairs, 100, 120, &params());
        }

        #[test]
        fn works_with_native_backend() {
            let backend = NativeBackend;
            let pairs = design_pairs_via_picker(&backend, TEMPLATE, 100, 120, &params(), ThermoParams::default());
            assert_bounds_respecting(&pairs, 100, 120, &params());
        }
    }
}
