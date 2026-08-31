//! `Primer3Backend`: `ThermoBackend` implemented over `primer3-ffi`
//! (real Primer3 C thermodynamics, validated to 1e-6 against live
//! `primer3-py` output — see `primer3-ffi/tests/parity.rs`).

use crate::backend::{DimerResult, ThermoBackend, ThermoParams};

#[derive(Debug, Default, Clone, Copy)]
pub struct Primer3Backend;

fn to_dimer_result(r: primer3_ffi::ThermoResult) -> DimerResult {
    DimerResult { structure_found: r.structure_found, tm: r.tm, dg: r.dg }
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
