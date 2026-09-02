//! `NativeBackend`: `ThermoBackend` implemented over `thermo-core` (the
//! de-PyO3'd Strider port, Phase 1; the hairpin DP built in Phase 4; and the
//! Mathews2004 ΔH/ΔS-aware hairpin/dimer Tm — `thermo_core::thermo` —
//! ported to close the gap this module used to document below).
//!
//! `calc_hairpin`/`calc_homodimer`/`calc_heterodimer` now report real Tm,
//! matching Oligool's own default (`parameter_set="mathews2004-dna"`)
//! numbers exactly (see `thermo-core`'s `mathews2004_parity` golden-fixture
//! test, generated from the actual strider fork Oligool depends on) —
//! previously `tm: None`, since the plain SantaLucia tables this crate
//! started from (`STACK`/`INTERIOR_*`/`HAIRPIN_*`) are ΔG-at-37°C only, with
//! no ΔH to derive a melting temperature from. `dg` is now the
//! salt-corrected `dG37` (folding in `mv_conc`/`dv_conc`, effective-Mg-aware
//! like `calc_tm`), not the bare unsalted DP energy.
//!
//! `mv_conc`/`dv_conc` are threaded through in full (previously ignored for
//! `calc_homodimer`/`calc_heterodimer`); `dna_conc` doubles as the dimer
//! strand concentration (`thermo::dimer_thermo`'s `strand_conc_m`) exactly
//! as `calc_tm` already uses it for `duplex_tm`'s `oligo_conc_m`.

use crate::backend::{DimerResult, ThermoBackend, ThermoParams};

#[derive(Debug, Default, Clone, Copy)]
pub struct NativeBackend;

/// primer3-convention units (mM/mM/mM/nM, matching `ThermoParams`) to
/// `thermo-core`'s Molar-based signatures.
fn to_molar_conc(params: ThermoParams) -> (f64, f64, f64, f64) {
    (
        params.mv_conc / 1000.0,   // mM -> M
        params.dv_conc / 1000.0,   // mM -> M
        params.dntp_conc / 1000.0, // mM -> M
        params.dna_conc * 1e-9,    // nM -> M
    )
}

/// Mg2+ competitively bound by dNTPs isn't available for duplex/structure
/// stabilization — same `(dv_conc - dntp_conc).max(0)` correction
/// `calc_tm`/`duplex_tm` already applies, and Oligool's own
/// `_run_strider_analysis` applies identically (`effective_mg`) before
/// calling `hairpin_thermo`/`dimer_thermo`.
fn effective_magnesium_m(params: ThermoParams) -> f64 {
    let (_, dv_m, dntp_m, _) = to_molar_conc(params);
    (dv_m - dntp_m).max(0.0)
}

impl ThermoBackend for NativeBackend {
    fn calc_tm(&self, seq: &str, params: ThermoParams) -> f64 {
        let (sodium_m, magnesium_m, dntp_m, oligo_conc_m) = to_molar_conc(params);
        thermo_core::duplex_tm(seq, sodium_m, magnesium_m, dntp_m, oligo_conc_m).expect("calc_tm: sequence must not be empty")
    }

    fn calc_hairpin(&self, seq: &str, params: ThermoParams) -> DimerResult {
        let (sodium_m, ..) = to_molar_conc(params);
        let magnesium_m = effective_magnesium_m(params);
        // dangles=2, matching Oligool's own `hairpin_thermo(..., dangles=2)` call.
        match thermo_core::thermo::hairpin_thermo(seq, sodium_m, magnesium_m, 2) {
            Ok(h) => DimerResult { structure_found: true, tm: Some(h.tm_celsius), dg: Some(h.dg37), structure: Some(h.structure) },
            Err(_) => DimerResult { structure_found: false, tm: None, dg: None, structure: None },
        }
    }

    fn calc_homodimer(&self, seq: &str, params: ThermoParams) -> DimerResult {
        dimer_result(seq, seq, params)
    }

    fn calc_heterodimer(&self, seq1: &str, seq2: &str, params: ThermoParams) -> DimerResult {
        dimer_result(seq1, seq2, params)
    }
}

fn dimer_result(seq1: &str, seq2: &str, params: ThermoParams) -> DimerResult {
    let (sodium_m, _, _, strand_conc_m) = to_molar_conc(params);
    let magnesium_m = effective_magnesium_m(params);
    // dangles=0, matching Oligool's own `dimer_thermo(...)` call (no dangles override).
    match thermo_core::thermo::dimer_thermo(seq1, Some(seq2), sodium_m, magnesium_m, strand_conc_m, 0) {
        Ok(d) => DimerResult { structure_found: true, tm: Some(d.tm_celsius), dg: Some(d.dg37), structure: Some(d.structure) },
        Err(_) => DimerResult { structure_found: false, tm: None, dg: None, structure: None },
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
    fn calc_hairpin_reports_a_real_tm() {
        let backend = NativeBackend;
        let result = backend.calc_hairpin("GCGCGCGAAACGCGCGC", ThermoParams::default());
        assert!(result.structure_found);
        assert!(result.tm.unwrap().is_finite(), "native hairpin should now report a real Tm");
        assert!(result.dg.unwrap() < 0.0);
    }

    #[test]
    fn calc_homodimer_finds_perfect_complement() {
        let backend = NativeBackend;
        let result = backend.calc_homodimer("ACGTACGTACGT", ThermoParams::default());
        assert!(result.structure_found);
        assert!(result.tm.unwrap().is_finite());
        assert!(result.dg.unwrap() < 0.0);
    }

    #[test]
    fn calc_heterodimer_no_structure_for_non_complementary() {
        let backend = NativeBackend;
        let result = backend.calc_heterodimer("AAAAAAAA", "AAAAAAAA", ThermoParams::default());
        assert!(!result.structure_found);
        assert!(result.dg.is_none());
    }

    #[test]
    fn calc_homodimer_and_heterodimer_respect_thermo_params() {
        let backend = NativeBackend;
        let low_salt = ThermoParams { mv_conc: 10.0, dv_conc: 0.0, dntp_conc: 0.0, dna_conc: 50.0 };
        let high_salt = ThermoParams { mv_conc: 100.0, dv_conc: 5.0, dntp_conc: 0.2, dna_conc: 400.0 };
        let low = backend.calc_homodimer("ACGTACGTACGT", low_salt);
        let high = backend.calc_homodimer("ACGTACGTACGT", high_salt);
        assert_ne!(low.tm, high.tm, "salt/concentration should change the reported Tm, not be silently ignored");
    }
}
