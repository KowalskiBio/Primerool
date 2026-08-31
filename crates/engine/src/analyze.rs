//! `analyze_primer`/`analyze_pair`, ported from `primer_utils.py`. Generic
//! over `ThermoBackend` so both `Primer3Backend` (today) and
//! `NativeBackend` (Phase 5) share this exact logic.

use crate::backend::{DimerResult, ThermoBackend, ThermoParams};
use crate::defaults::round_or_none;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PrimerAnalysis {
    pub sequence: String,
    pub length: usize,
    pub gc_percent: Option<f64>,
    pub tm: Option<f64>,
    pub hairpin: DimerResult,
    pub homodimer: DimerResult,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
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
    DimerResult { structure_found: r.structure_found, tm: round_or_none(r.tm), dg: round_or_none(r.dg) }
}

/// Port of `analyze_primer`: uppercases/strips the sequence, then computes
/// Tm/GC%/hairpin/homodimer — all floats rounded to 1 decimal place.
pub fn analyze_primer(backend: &dyn ThermoBackend, seq: &str, params: ThermoParams) -> PrimerAnalysis {
    let seq = seq.trim().to_uppercase();

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
    use crate::backend_primer3::Primer3Backend;

    #[test]
    fn analyze_primer_reports_plausible_values() {
        let backend = Primer3Backend;
        let result = analyze_primer(&backend, " acgtacgtacgtacgtacgt ", ThermoParams::default());
        assert_eq!(result.sequence, "ACGTACGTACGTACGTACGT");
        assert_eq!(result.length, 20);
        assert_eq!(result.gc_percent, Some(50.0));
        assert!(result.tm.unwrap() > 0.0);
    }

    #[test]
    fn analyze_pair_reports_heterodimer() {
        let backend = Primer3Backend;
        let result = analyze_pair(&backend, "ACGTACGTACGT", "ACGTACGTACGT", ThermoParams::default());
        assert!(result.heterodimer.structure_found);
        assert!(result.heterodimer.dg.unwrap() < 0.0);
    }
}
