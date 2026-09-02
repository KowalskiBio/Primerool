//! `Primer3Backend`: `ThermoBackend` implemented over `primer3-ffi`
//! (real Primer3 C thermodynamics, validated to 1e-6 against live
//! `primer3-py` output — see `primer3-ffi/tests/parity.rs`).

use crate::backend::{DimerResult, ThermoBackend, ThermoParams};

#[derive(Debug, Default, Clone, Copy)]
pub struct Primer3Backend;

fn to_dimer_result(r: primer3_ffi::ThermoResult) -> DimerResult {
    // `primer3-ffi` intentionally passes `thal()`'s raw dg straight through
    // (its own parity test validates the FFI binding against live
    // `primer3-py` in primer3's *native* units) — but that raw unit is
    // cal/mol (see `primer3-py`'s own `thermoanalysis.pyx` docstring on
    // `.dg`), not kcal/mol like `NativeBackend`'s `dg37`. `DimerResult` is
    // the app-wide, engine-agnostic contract that promises kcal/mol
    // (matching real biology and the UI's ΔG thresholds/labels), so this is
    // the boundary that converts.
    let dg_kcal = r.dg.map(|cal_per_mol| cal_per_mol / 1000.0);
    // `structure: None` - primer3-ffi doesn't extract `thal_results`' own
    // structure output, unlike `NativeBackend` (see `DimerResult::structure`'s docs).
    DimerResult { structure_found: r.structure_found, tm: r.tm, dg: dg_kcal, structure: None }
}

impl ThermoBackend for Primer3Backend {
    fn calc_tm(&self, seq: &str, params: ThermoParams) -> f64 {
        primer3_ffi::calc_tm(seq, params.mv_conc, params.dv_conc, params.dntp_conc, params.dna_conc)
            .expect("calc_tm: sequence must not contain interior NUL bytes")
    }

    fn calc_hairpin(&self, seq: &str, params: ThermoParams) -> DimerResult {
        let r = primer3_ffi::calc_hairpin(seq, params.mv_conc, params.dv_conc, params.dntp_conc, params.dna_conc)
            .expect("calc_hairpin: sequence must not contain interior NUL bytes");
        to_dimer_result(r)
    }

    fn calc_homodimer(&self, seq: &str, params: ThermoParams) -> DimerResult {
        let r = primer3_ffi::calc_homodimer(seq, params.mv_conc, params.dv_conc, params.dntp_conc, params.dna_conc)
            .expect("calc_homodimer: sequence must not contain interior NUL bytes");
        to_dimer_result(r)
    }

    fn calc_heterodimer(&self, seq1: &str, seq2: &str, params: ThermoParams) -> DimerResult {
        let r = primer3_ffi::calc_heterodimer(seq1, seq2, params.mv_conc, params.dv_conc, params.dntp_conc, params.dna_conc)
            .expect("calc_heterodimer: sequences must not contain interior NUL bytes");
        to_dimer_result(r)
    }
}
