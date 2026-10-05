//! Flanking/WGA primer design (`/design_primers`, `mode: "flanking"`).
//!
//! Forward (LEFT) primers are searched in the last `flank_window` bases of
//! `upstream_seq`; reverse (RIGHT) primers in the first `flank_window`
//! bases of `downstream_seq`. Each side is an independent one-sided pick,
//! not a paired design; every returned oligo is re-analysed through
//! `analyze_primer` for the fields the UI shows.

use crate::analyze::{analyze_pair, analyze_primer, PairAnalysis, PrimerAnalysis};
use crate::backend::{ThermoBackend, ThermoParams};
use crate::defaults::{DEFAULT_PRIMER_SIZE, FLANKING_PRIMER_GC, FLANKING_PRIMER_TM};
use crate::picker::{pick_in_region, CandidateConstraints, GcRange, OligoFilters, PickResult, SizeRange, Strand, TmRange};

const MAX_RETURNED: usize = 5;
/// Cap for `FlankingOptions::one_per_end` - one oligo per 5'-end position
/// across a full 200bp flank never gets near it.
const MAX_RETURNED_PER_END: usize = 400;

#[derive(Debug, Clone, PartialEq)]
pub struct FlankingOligo {
    pub analysis: PrimerAnalysis,
    /// `[start, end)` into the forward strand of whichever flank sequence
    /// (`upstream_seq`/`downstream_seq`) this oligo was designed against.
    pub interval: [i32; 2],
    /// The picker's weighted distance from the Tm/GC/size optimum - lower
    /// is better, comparable across both sides of one design call.
    pub penalty: f64,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FlankingSideResult {
    pub primers: Vec<FlankingOligo>,
    pub explain: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FlankingDesignResult {
    pub forward: FlankingSideResult,
    pub reverse: FlankingSideResult,
    pub pair_metrics: Option<PairAnalysis>,
}

/// Caller overrides for a flanking design; `Default` is the stock design.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct FlankingOptions {
    /// Caps the search to the last/first N bases of each flank; `None` uses
    /// the full flank.
    pub flank_window: Option<i32>,
    /// Replaces `FLANKING_PRIMER_TM`.
    pub tm: Option<TmRange>,
    /// Replaces `FLANKING_PRIMER_GC` (its midpoint is the GC optimum).
    pub gc: Option<GcRange>,
    /// Returns the single best oligo for every distinct 5'-end position
    /// instead of the top `MAX_RETURNED` overall - what a caller pairing
    /// sides up to hit a product size needs, since the 5' ends alone set
    /// the product length and the overall top few tend to cluster.
    pub one_per_end: bool,
}

fn constraints(opts: &FlankingOptions) -> CandidateConstraints {
    CandidateConstraints {
        size: SizeRange { min: DEFAULT_PRIMER_SIZE.min_size as usize, opt: DEFAULT_PRIMER_SIZE.opt_size as usize, max: DEFAULT_PRIMER_SIZE.max_size as usize },
        tm: opts.tm.unwrap_or(TmRange { min: FLANKING_PRIMER_TM.min_tm, opt: FLANKING_PRIMER_TM.opt_tm, max: FLANKING_PRIMER_TM.max_tm }),
        gc: opts.gc.unwrap_or(GcRange { min: FLANKING_PRIMER_GC.min_gc, max: FLANKING_PRIMER_GC.max_gc }),
    }
}

fn to_side(backend: &dyn ThermoBackend, picked: PickResult, strand: Strand, one_per_end: bool, thermo: ThermoParams) -> FlankingSideResult {
    let explain = Some(picked.explain());
    let mut oligos = picked.oligos;
    if one_per_end {
        // Ranked ascending by penalty, so the first seen per 5' end is its best.
        let mut seen = std::collections::HashSet::new();
        oligos.retain(|o| seen.insert(if strand == Strand::Forward { o.candidate.start } else { o.candidate.end }));
        oligos.truncate(MAX_RETURNED_PER_END);
    }
    FlankingSideResult {
        primers: oligos
            .iter()
            .map(|o| FlankingOligo { analysis: analyze_primer(backend, &o.sequence, thermo), interval: [o.candidate.start as i32, o.candidate.end as i32], penalty: o.penalty })
            .collect(),
        explain,
    }
}

pub fn design_primers_for_flanking_regions(
    backend: &dyn ThermoBackend,
    upstream_seq: &str,
    downstream_seq: &str,
    opts: &FlankingOptions,
    thermo: ThermoParams,
) -> FlankingDesignResult {
    let min_size = DEFAULT_PRIMER_SIZE.min_size as usize;
    let window = |len: usize| opts.flank_window.map(|w| (w.max(0) as usize).min(len)).unwrap_or(len);
    let c = constraints(opts);
    let filters = OligoFilters::default();
    let keep = if opts.one_per_end { usize::MAX } else { MAX_RETURNED };
    let mut result = FlankingDesignResult::default();

    let upstream = upstream_seq.to_uppercase().replace(' ', "");
    if upstream.len() >= min_size {
        let len = upstream.len();
        let picked = pick_in_region(backend, &upstream, (len - window(len), len), Strand::Forward, &c, &filters, thermo, keep);
        result.forward = to_side(backend, picked, Strand::Forward, opts.one_per_end, thermo);
    }

    let downstream = downstream_seq.to_uppercase().replace(' ', "");
    if downstream.len() >= min_size {
        let picked = pick_in_region(backend, &downstream, (0, window(downstream.len())), Strand::Reverse, &c, &filters, thermo, keep);
        result.reverse = to_side(backend, picked, Strand::Reverse, opts.one_per_end, thermo);
    }

    if let (Some(f0), Some(r0)) = (result.forward.primers.first(), result.reverse.primers.first()) {
        result.pair_metrics = Some(analyze_pair(backend, &f0.analysis.sequence, &r0.analysis.sequence, thermo));
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_native::NativeBackend;

    const UPSTREAM: &str = "GATCGGAAGAGCACACGTCTGAACTCCAGTCACATCACGATCTCGTATGCCGTCTTCTGCTTGAGGCCTATCAAGCAGTGGTATCAACGCAGAGTACATGGGTACGACC";
    const DOWNSTREAM: &str = "TTCTGGCCTAGAGATCCGATGCTGACTGCCAACTTAGTGCCTAGCTTGCCGAATATCATGGTGCACTCTCAGTACAATCTGCTCTGATGCCGCATAGTTAAGCCAGGTA";

    #[test]
    fn finds_flanking_primers_on_both_sides() {
        let result = design_primers_for_flanking_regions(&NativeBackend, UPSTREAM, DOWNSTREAM, &FlankingOptions::default(), ThermoParams::default());
        assert!(!result.forward.primers.is_empty(), "forward explain: {:?}", result.forward.explain);
        assert!(!result.reverse.primers.is_empty(), "reverse explain: {:?}", result.reverse.explain);
        assert!(result.pair_metrics.is_some());
        // Reverse primers read as the reverse complement of their window.
        for p in &result.reverse.primers {
            let [s, e] = p.interval;
            assert_eq!(p.analysis.sequence, thermo_core::reverse_complement(&DOWNSTREAM[s as usize..e as usize]));
        }
    }

    #[test]
    fn flank_window_narrows_the_search_region() {
        let result = design_primers_for_flanking_regions(&NativeBackend, UPSTREAM, "", &FlankingOptions { flank_window: Some(40), ..Default::default() }, ThermoParams::default());
        for p in &result.forward.primers {
            assert!(p.interval[0] as usize >= UPSTREAM.len() - 40, "primer should fall within the last 40bp window");
        }
    }

    #[test]
    fn one_per_end_returns_distinct_five_prime_ends() {
        let opts = FlankingOptions { one_per_end: true, ..Default::default() };
        let result = design_primers_for_flanking_regions(&NativeBackend, UPSTREAM, DOWNSTREAM, &opts, ThermoParams::default());
        assert!(result.forward.primers.len() > MAX_RETURNED);
        let starts: std::collections::HashSet<_> = result.forward.primers.iter().map(|p| p.interval[0]).collect();
        assert_eq!(starts.len(), result.forward.primers.len());
        let ends: std::collections::HashSet<_> = result.reverse.primers.iter().map(|p| p.interval[1]).collect();
        assert_eq!(ends.len(), result.reverse.primers.len());
    }

    #[test]
    fn tm_override_is_honoured() {
        let opts = FlankingOptions { tm: Some(TmRange { min: 58.0, opt: 60.0, max: 61.0 }), one_per_end: true, ..Default::default() };
        let result = design_primers_for_flanking_regions(&NativeBackend, UPSTREAM, DOWNSTREAM, &opts, ThermoParams::default());
        for p in result.forward.primers.iter().chain(&result.reverse.primers) {
            let tm = p.analysis.tm.unwrap();
            assert!((57.9..=61.1).contains(&tm), "tm {tm} outside override");
        }
    }
}
