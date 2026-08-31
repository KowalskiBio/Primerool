//! `NativeBackend`: `ThermoBackend` implemented over `thermo-core` (the
//! de-PyO3'd Strider port, Phase 1, plus the hairpin DP built in Phase 4).
//!
//! **Known, documented gaps vs. `Primer3Backend`** (not oversights —
//! see Phase 4's plan notes):
//! - `calc_hairpin`/`calc_homodimer`/`calc_heterodimer` report `tm: None`.
//!   `thermo-core`'s tables (`STACK`/`INTERIOR_*`/`HAIRPIN_*`/
//!   `TERMINAL_PENALTY`) are Turner/Zuker-style ΔG-at-37°C values with no
//!   companion ΔH table, so there's no data to back out a melting
//!   temperature from for these structural (as opposed to duplex) ΔGs —
//!   unlike `calc_tm`, which *does* have a real ΔH/ΔS path via
//!   `thermo_core::duplex_tm`.
//! - `calc_homodimer`/`calc_heterodimer` ignore `ThermoParams` entirely:
//!   `thermo_core::dimer_mfe_candidates` takes no salt/concentration
//!   arguments (a fixed-table DP, unlike Primer3's `thal()` which folds
//!   salt correction into the alignment itself). `calc_tm` and
//!   `calc_hairpin` *do* use the packed `ThermoParams` fully.

use crate::backend::{DimerResult, ThermoBackend, ThermoParams};

#[derive(Debug, Default, Clone, Copy)]
pub struct NativeBackend;

/// primer3-convention units (mM/mM/mM/nM, matching `ThermoParams`) to
/// `thermo-core`'s Molar-based `duplex_tm` signature.
fn to_molar_conc(params: ThermoParams) -> (f64, f64, f64, f64) {
    (
        params.mv_conc / 1000.0,   // mM -> M
        params.dv_conc / 1000.0,   // mM -> M
        params.dntp_conc / 1000.0, // mM -> M
        params.dna_conc * 1e-9,    // nM -> M
    )
}

impl ThermoBackend for NativeBackend {
    fn calc_tm(&self, seq: &str, params: ThermoParams) -> f64 {
        let (sodium_m, magnesium_m, dntp_m, oligo_conc_m) = to_molar_conc(params);
        thermo_core::duplex_tm(seq, sodium_m, magnesium_m, dntp_m, oligo_conc_m).expect("calc_tm: sequence must not be empty")
    }

    fn calc_hairpin(&self, seq: &str, _params: ThermoParams) -> DimerResult {
        match thermo_core::hairpin::hairpin_mfe(seq.as_bytes()) {
            Some(r) => DimerResult { structure_found: true, tm: None, dg: Some(r.dg) },
            None => DimerResult { structure_found: false, tm: None, dg: None },
        }
    }

    fn calc_homodimer(&self, seq: &str, _params: ThermoParams) -> DimerResult {
        dimer_result(seq, seq)
    }

    fn calc_heterodimer(&self, seq1: &str, seq2: &str, _params: ThermoParams) -> DimerResult {
        dimer_result(seq1, seq2)
    }
}

fn dimer_result(seq1: &str, seq2: &str) -> DimerResult {
    let candidates = thermo_core::dimer_mfe_candidates(seq1, seq2);
    match candidates.first() {
        Some((energy, _pairs)) => DimerResult { structure_found: true, tm: None, dg: Some(*energy) },
        None => DimerResult { structure_found: false, tm: None, dg: None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calc_tm_matches_direct_thermo_core_call() {
        let backend = NativeBackend;
        let params = ThermoParams::default();
        let got = backend.calc_tm("ACGTACGTACGTACGTACGT", params);
        let (na, mg, dntp, oligo) = to_molar_conc(params);
        let want = thermo_core::duplex_tm("ACGTACGTACGTACGTACGT", na, mg, dntp, oligo).unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn calc_hairpin_reports_no_tm() {
        let backend = NativeBackend;
        let result = backend.calc_hairpin("GCGCAAAAGCGC", ThermoParams::default());
        assert!(result.structure_found);
        assert!(result.tm.is_none(), "native hairpin has no Tm data source");
        assert!(result.dg.unwrap() < 0.0);
    }

    #[test]
    fn calc_homodimer_finds_perfect_complement() {
        let backend = NativeBackend;
        let result = backend.calc_homodimer("ACGTACGT", ThermoParams::default());
        assert!(result.structure_found);
        assert!(result.tm.is_none());
    }

    #[test]
    fn calc_heterodimer_no_structure_for_non_complementary() {
        let backend = NativeBackend;
        let result = backend.calc_heterodimer("AAAAAAAA", "AAAAAAAA", ThermoParams::default());
        assert!(!result.structure_found);
        assert!(result.dg.is_none());
    }
}
