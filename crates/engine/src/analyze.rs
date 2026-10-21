//! `analyze_primer`/`analyze_pair`: the per-oligo QC every design mode
//! reports. Generic over `ThermoBackend`.

use rayon::prelude::*;

use crate::backend::{DimerResult, ThermoBackend, ThermoParams};
use crate::defaults::round_or_none;
use crate::iupac;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PrimerAnalysis {
    pub sequence: String,
    pub length: usize,
    pub gc_percent: Option<f64>,
    pub tm: Option<f64>,
    pub hairpin: DimerResult,
    pub homodimer: DimerResult,
    /// Set for a degenerate (IUPAC) oligo: the spread over every plain
    /// sequence it stands for. The fields above are then its worst cases -
    /// `tm`/`gc_percent` from the lowest-Tm variant, `hairpin` the
    /// highest-Tm hairpin, `homodimer` the strongest (lowest ΔG) one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub degenerate: Option<DegenerateSummary>,
}

/// Most variants a degenerate oligo is expanded into for analysis.
pub const MAX_ANALYZED_VARIANTS: usize = 512;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct DegenerateSummary {
    /// Plain sequences the oligo stands for.
    pub degeneracy: u64,
    /// How many were analyzed: all of them, or 0 when there are more than
    /// `MAX_ANALYZED_VARIANTS` (every number is then `None`).
    pub analyzed: usize,
    pub tm_min: Option<f64>,
    pub tm_max: Option<f64>,
    pub gc_min: Option<f64>,
    pub gc_max: Option<f64>,
    /// The variants behind the worst cases, e.g. to draw their structures.
    pub lowest_tm_variant: Option<String>,
    pub strongest_hairpin_variant: Option<String>,
    pub strongest_dimer_variant: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PairAnalysis {
    pub heterodimer: DimerResult,
}

/// `primer_utils.py::_oligo_gc` — count of G/C over full (uppercased)
/// sequence length.
fn oligo_gc(seq: &str) -> f64 {
    if seq.is_empty() {
        return 0.0;
    }
    let gc = seq.bytes().filter(|b| matches!(b.to_ascii_uppercase(), b'G' | b'C')).count();
    100.0 * gc as f64 / seq.len() as f64
}

fn round_dimer(r: DimerResult) -> DimerResult {
    DimerResult { structure_found: r.structure_found, tm: round_or_none(r.tm), dg: round_or_none(r.dg), structure: r.structure }
}

/// Port of `analyze_primer`: uppercases/strips the sequence, then computes
/// Tm/GC%/hairpin/homodimer — all floats rounded to 1 decimal place.
pub fn analyze_primer(backend: &dyn ThermoBackend, seq: &str, params: ThermoParams) -> PrimerAnalysis {
    let seq = seq.trim().to_uppercase();
    if iupac::is_degenerate(&seq) {
        return analyze_degenerate(backend, seq, params);
    }

    let tm = backend.calc_tm(&seq, params);
    let hairpin = backend.calc_hairpin(&seq, params);
    let homodimer = backend.calc_homodimer(&seq, params);

    PrimerAnalysis {
        length: seq.len(),
        gc_percent: round_or_none(Some(oligo_gc(&seq))),
        tm: round_or_none(Some(tm)),
        hairpin: round_dimer(hairpin),
        homodimer: round_dimer(homodimer),
        sequence: seq,
        degenerate: None,
    }
}

/// A degenerate oligo: every variant analyzed, the worst cases reported.
fn analyze_degenerate(backend: &dyn ThermoBackend, seq: String, params: ThermoParams) -> PrimerAnalysis {
    let degeneracy = iupac::degeneracy(&seq);
    let none = DimerResult { structure_found: false, tm: None, dg: None, structure: None };
    let Some(variants) = iupac::expand(&seq, MAX_ANALYZED_VARIANTS) else {
        let summary = DegenerateSummary {
            degeneracy,
            analyzed: 0,
            tm_min: None,
            tm_max: None,
            gc_min: None,
            gc_max: None,
            lowest_tm_variant: None,
            strongest_hairpin_variant: None,
            strongest_dimer_variant: None,
        };
        return PrimerAnalysis { length: seq.len(), gc_percent: None, tm: None, hairpin: none.clone(), homodimer: none, sequence: seq, degenerate: Some(summary) };
    };
    let all: Vec<PrimerAnalysis> = variants.par_iter().map(|v| analyze_primer(backend, v, params)).collect();
    let by = |key: &dyn Fn(&PrimerAnalysis) -> f64| all.iter().min_by(|a, b| key(a).total_cmp(&key(b))).expect("at least one variant");
    let lowest_tm = by(&|a| a.tm.unwrap_or(f64::INFINITY));
    let strongest_hairpin = by(&|a| -a.hairpin.tm.unwrap_or(f64::NEG_INFINITY));
    let strongest_dimer = by(&|a| a.homodimer.dg.unwrap_or(f64::INFINITY));
    let range = |f: &dyn Fn(&PrimerAnalysis) -> Option<f64>| {
        let vals: Vec<f64> = all.iter().filter_map(f).collect();
        (vals.iter().copied().reduce(f64::min), vals.iter().copied().reduce(f64::max))
    };
    let (tm_min, tm_max) = range(&|a| a.tm);
    let (gc_min, gc_max) = range(&|a| a.gc_percent);
    PrimerAnalysis {
        length: seq.len(),
        gc_percent: lowest_tm.gc_percent,
        tm: lowest_tm.tm,
        hairpin: strongest_hairpin.hairpin.clone(),
        homodimer: strongest_dimer.homodimer.clone(),
        degenerate: Some(DegenerateSummary {
            degeneracy,
            analyzed: all.len(),
            tm_min,
            tm_max,
            gc_min,
            gc_max,
            lowest_tm_variant: Some(lowest_tm.sequence.clone()),
            strongest_hairpin_variant: Some(strongest_hairpin.sequence.clone()),
            strongest_dimer_variant: Some(strongest_dimer.sequence.clone()),
        }),
        sequence: seq,
    }
}

/// Port of `analyze_pair`: heterodimer between forward and reverse primer.
pub fn analyze_pair(backend: &dyn ThermoBackend, fwd_seq: &str, rev_seq: &str, params: ThermoParams) -> PairAnalysis {
    let heterodimer = backend.calc_heterodimer(fwd_seq, rev_seq, params);
    PairAnalysis { heterodimer: round_dimer(heterodimer) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_native::NativeBackend;

    #[test]
    fn analyze_primer_reports_plausible_values() {
        let backend = NativeBackend;
        let result = analyze_primer(&backend, " acgtacgtacgtacgtacgt ", ThermoParams::default());
        assert_eq!(result.sequence, "ACGTACGTACGTACGTACGT");
        assert_eq!(result.length, 20);
        assert_eq!(result.gc_percent, Some(50.0));
        assert!(result.tm.unwrap() > 0.0);
    }

    #[test]
    fn analyze_primer_expands_degenerate_oligos() {
        let backend = NativeBackend;
        let result = analyze_primer(&backend, "GGACTACNVGGGTWTCTAAT", ThermoParams::default());
        let d = result.degenerate.expect("degenerate summary");
        assert_eq!((d.degeneracy, d.analyzed), (24, 24));
        let (lo, hi) = (d.tm_min.unwrap(), d.tm_max.unwrap());
        assert!(lo < hi);
        assert_eq!(result.tm, Some(lo));
        assert!(!iupac::is_degenerate(d.lowest_tm_variant.as_deref().unwrap()));
    }

    #[test]
    fn analyze_pair_reports_heterodimer() {
        let backend = NativeBackend;
        let result = analyze_pair(&backend, "ACGTACGTACGT", "ACGTACGTACGT", ThermoParams::default());
        assert!(result.heterodimer.structure_found);
        assert!(result.heterodimer.dg.unwrap() < 0.0);
    }
}
