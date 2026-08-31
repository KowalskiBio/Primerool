//! Port of `primer_flanking.py::design_primers_for_flanking_regions` (WGA
//! flanking-primer design). Real call sites never pass `primer_params`
//! (grep-confirmed), so that dead override parameter is dropped here, same
//! as `design_internal`.
//!
//! Forward (LEFT) primers are searched in the last `flank_window` bases of
//! `upstream_seq`; reverse (RIGHT) primers in the first `flank_window`
//! bases of `downstream_seq`. Each side is one independent `choose_primers`
//! call windowed via `SEQUENCE_INCLUDED_REGION`, not a paired design — like
//! Python, this module re-analyzes every returned oligo through
//! `analyze_primer` for its primary QC fields, but also keeps primer3's own
//! oligo-record QC (`primer3_tm`/`primer3_gc_percent`/etc.) alongside it,
//! matching the `"primer3": {...}` sub-dict Python attaches to each primer.

use primer3_ffi::design::{design_primers, DesignedOligo, GlobalSettings, SeqArgs};
use primer3_ffi::Primer3Error;

use crate::analyze::{analyze_pair, analyze_primer, PairAnalysis, PrimerAnalysis};
use crate::backend::{ThermoBackend, ThermoParams};
use crate::defaults::{round_or_none, DEFAULT_PRIMER_SIZE, FLANKING_PRIMER_GC, FLANKING_PRIMER_TM};

const PRODUCT_SIZE_RANGE: (i32, i32) = (50, 50_000);
const MAX_RETURNED: i32 = 5;

#[derive(Debug, Clone, PartialEq)]
pub struct FlankingOligo {
    pub analysis: PrimerAnalysis,
    /// `[start, end)` into the forward strand of whichever flank sequence
    /// (`upstream_seq`/`downstream_seq`) this oligo was designed against.
    pub interval: [i32; 2],
    /// Primer3's own oligo-record QC — kept alongside `analysis` because
    /// Python attaches both independently (`analyze_primer`'s recompute
    /// plus a raw `"primer3": {...}` sub-dict off the same
    /// `choose_primers()` call), not because the two ever meaningfully
    /// disagree (same C thermodynamics either way).
    pub primer3_tm: f64,
    pub primer3_gc_percent: f64,
    pub primer3_self_any: f64,
    pub primer3_self_end: f64,
    pub primer3_hairpin_th: f64,
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

fn to_flanking_oligo(backend: &dyn ThermoBackend, oligo: &DesignedOligo, thermo: ThermoParams) -> FlankingOligo {
    FlankingOligo {
        analysis: analyze_primer(backend, &oligo.sequence, thermo),
        interval: [oligo.start, oligo.end],
        primer3_tm: round_or_none(Some(oligo.tm)).unwrap(),
        primer3_gc_percent: round_or_none(Some(oligo.gc_percent)).unwrap(),
        primer3_self_any: round_or_none(Some(oligo.self_any)).unwrap(),
        primer3_self_end: round_or_none(Some(oligo.self_end)).unwrap(),
        primer3_hairpin_th: round_or_none(Some(oligo.hairpin_th)).unwrap(),
    }
}

fn design_side(template: &str, included_start: i32, included_len: i32, pick_left: bool) -> Result<primer3_ffi::design::DesignResult, Primer3Error> {
    let mut gs = GlobalSettings::new();
    gs.set_primer_size(DEFAULT_PRIMER_SIZE.opt_size as i32, DEFAULT_PRIMER_SIZE.min_size as i32, DEFAULT_PRIMER_SIZE.max_size as i32);
    gs.set_primer_tm(FLANKING_PRIMER_TM.opt_tm, FLANKING_PRIMER_TM.min_tm, FLANKING_PRIMER_TM.max_tm);
    gs.set_primer_gc(FLANKING_PRIMER_GC.min_gc, FLANKING_PRIMER_GC.max_gc);
    gs.set_num_return(MAX_RETURNED);
    gs.set_pick_primers(pick_left, !pick_left);
    gs.set_pick_internal_oligo(false);
    gs.set_product_size_range(PRODUCT_SIZE_RANGE.0, PRODUCT_SIZE_RANGE.1);

    let mut sa = SeqArgs::new(template)?;
    sa.set_included_region(included_start, included_len);
    design_primers(&gs, &mut sa)
}

/// `flank_window`: `None` uses the full flank sequence, matching Python's
/// `Optional[int]` semantics.
pub fn design_primers_for_flanking_regions(
    backend: &dyn ThermoBackend,
    upstream_seq: &str,
    downstream_seq: &str,
    flank_window: Option<i32>,
    thermo: ThermoParams,
) -> Result<FlankingDesignResult, Primer3Error> {
    let min_size = DEFAULT_PRIMER_SIZE.min_size as usize;
    let mut result = FlankingDesignResult::default();

    let upstream = upstream_seq.to_uppercase().replace(' ', "");
    if upstream.len() >= min_size {
        let up_len = upstream.len() as i32;
        let win = flank_window.map(|w| w.min(up_len)).unwrap_or(up_len);
        let up_start = up_len - win;

        let side = design_side(&upstream, up_start, win, true)?;
        result.forward = FlankingSideResult {
            primers: side.left_candidates.iter().map(|o| to_flanking_oligo(backend, o, thermo)).collect(),
            explain: side.left_explain,
        };
    }

    let downstream = downstream_seq.to_uppercase().replace(' ', "");
    if downstream.len() >= min_size {
        let down_len = downstream.len() as i32;
        let win = flank_window.map(|w| w.min(down_len)).unwrap_or(down_len);

        let side = design_side(&downstream, 0, win, false)?;
        result.reverse = FlankingSideResult {
            primers: side.right_candidates.iter().map(|o| to_flanking_oligo(backend, o, thermo)).collect(),
            explain: side.right_explain,
        };
    }

    if let (Some(f0), Some(r0)) = (result.forward.primers.first(), result.reverse.primers.first()) {
        result.pair_metrics = Some(analyze_pair(backend, &f0.analysis.sequence, &r0.analysis.sequence, thermo));
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_primer3::Primer3Backend;

    #[test]
    fn finds_flanking_primers_on_both_sides() {
        let backend = Primer3Backend;
        let upstream = "GATCGGAAGAGCACACGTCTGAACTCCAGTCACATCACGATCTCGTATGCCGTCTTCTGCTTGAGGCCTATCAAGCAGTGGTATCAACGCAGAGTACATGGGTACGACC";
        let downstream = "TTCTGGCCTAGAGATCCGATGCTGACTGCCAACTTAGTGCCTAGCTTGCCGAATATCATGGTGCACTCTCAGTACAATCTGCTCTGATGCCGCATAGTTAAGCCAGGTA";
        let result = design_primers_for_flanking_regions(&backend, upstream, downstream, None, ThermoParams::default()).unwrap();
        assert!(!result.forward.primers.is_empty(), "forward explain: {:?}", result.forward.explain);
        assert!(!result.reverse.primers.is_empty(), "reverse explain: {:?}", result.reverse.explain);
        assert!(result.pair_metrics.is_some());
    }

    #[test]
    fn flank_window_narrows_the_search_region() {
        let backend = Primer3Backend;
        let upstream = "GATCGGAAGAGCACACGTCTGAACTCCAGTCACATCACGATCTCGTATGCCGTCTTCTGCTTGAGGCCTATCAAGCAGTGGTATCAACGCAGAGTACATGGGTACGACC";
        let result = design_primers_for_flanking_regions(&backend, upstream, "", Some(40), ThermoParams::default()).unwrap();
        for p in &result.forward.primers {
            assert!(p.interval[0] as usize >= upstream.len() - 40, "primer should fall within the last 40bp window");
        }
    }
}
