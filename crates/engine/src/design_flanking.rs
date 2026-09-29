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

#[derive(Debug, Clone, PartialEq)]
pub struct FlankingOligo {
    pub analysis: PrimerAnalysis,
    /// `[start, end)` into the forward strand of whichever flank sequence
    /// (`upstream_seq`/`downstream_seq`) this oligo was designed against.
    pub interval: [i32; 2],
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

fn constraints() -> CandidateConstraints {
    CandidateConstraints {
        size: SizeRange { min: DEFAULT_PRIMER_SIZE.min_size as usize, opt: DEFAULT_PRIMER_SIZE.opt_size as usize, max: DEFAULT_PRIMER_SIZE.max_size as usize },
        tm: TmRange { min: FLANKING_PRIMER_TM.min_tm, opt: FLANKING_PRIMER_TM.opt_tm, max: FLANKING_PRIMER_TM.max_tm },
        gc: GcRange { min: FLANKING_PRIMER_GC.min_gc, max: FLANKING_PRIMER_GC.max_gc },
    }
}

fn to_side(backend: &dyn ThermoBackend, picked: PickResult, thermo: ThermoParams) -> FlankingSideResult {
    FlankingSideResult {
        primers: picked
            .oligos
            .iter()
            .map(|o| FlankingOligo { analysis: analyze_primer(backend, &o.sequence, thermo), interval: [o.candidate.start as i32, o.candidate.end as i32] })
            .collect(),
        explain: Some(picked.explain()),
    }
}

/// `flank_window`: `None` uses the full flank sequence.
pub fn design_primers_for_flanking_regions(
    backend: &dyn ThermoBackend,
    upstream_seq: &str,
    downstream_seq: &str,
    flank_window: Option<i32>,
    thermo: ThermoParams,
) -> FlankingDesignResult {
    let min_size = DEFAULT_PRIMER_SIZE.min_size as usize;
    let window = |len: usize| flank_window.map(|w| (w.max(0) as usize).min(len)).unwrap_or(len);
    let c = constraints();
    let filters = OligoFilters::default();
    let mut result = FlankingDesignResult::default();

    let upstream = upstream_seq.to_uppercase().replace(' ', "");
    if upstream.len() >= min_size {
        let len = upstream.len();
        let picked = pick_in_region(backend, &upstream, (len - window(len), len), Strand::Forward, &c, &filters, thermo, MAX_RETURNED);
        result.forward = to_side(backend, picked, thermo);
    }

    let downstream = downstream_seq.to_uppercase().replace(' ', "");
    if downstream.len() >= min_size {
        let picked = pick_in_region(backend, &downstream, (0, window(downstream.len())), Strand::Reverse, &c, &filters, thermo, MAX_RETURNED);
        result.reverse = to_side(backend, picked, thermo);
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
        let result = design_primers_for_flanking_regions(&NativeBackend, UPSTREAM, DOWNSTREAM, None, ThermoParams::default());
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
        let result = design_primers_for_flanking_regions(&NativeBackend, UPSTREAM, "", Some(40), ThermoParams::default());
        for p in &result.forward.primers {
            assert!(p.interval[0] as usize >= UPSTREAM.len() - 40, "primer should fall within the last 40bp window");
        }
    }
}
