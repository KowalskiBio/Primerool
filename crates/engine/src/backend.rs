//! `ThermoBackend` trait: the thermodynamic primitives shared by both
//! calculation backends. Ported from `primer_utils.py::_thermo_kwargs`'s
//! parameter shape (`mv_conc`/`dv_conc`/`dntp_conc`/`dna_conc` per call,
//! since Primerool's manual design panel lets a user override these via
//! the "Advanced" conditions panel — they are not fixed per backend
//! instance).

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThermoParams {
    pub mv_conc: f64,
    pub dv_conc: f64,
    pub dntp_conc: f64,
    pub dna_conc: f64,
}

impl Default for ThermoParams {
    /// Matches `primer_utils.py::_thermo_kwargs`'s defaults exactly.
    fn default() -> Self {
        Self { mv_conc: 50.0, dv_conc: 1.5, dntp_conc: 0.2, dna_conc: 50.0 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct DimerResult {
    pub structure_found: bool,
    pub tm: Option<f64>,
    pub dg: Option<f64>,
}

/// `Sync` is a supertrait, not an afterthought: `engine::picker` scores
/// candidates in parallel via `rayon`, and both real backends are already
/// safe to share across threads (`Primer3Backend` serializes FFI calls
/// behind a global `Mutex`; `NativeBackend` is pure functions over
/// `thermo-core`) — this bound just makes that a compile-time guarantee
/// for any future backend too.
pub trait ThermoBackend: Sync {
    fn calc_tm(&self, seq: &str, params: ThermoParams) -> f64;
    fn calc_hairpin(&self, seq: &str, params: ThermoParams) -> DimerResult;
    fn calc_homodimer(&self, seq: &str, params: ThermoParams) -> DimerResult;
    fn calc_heterodimer(&self, seq1: &str, seq2: &str, params: ThermoParams) -> DimerResult;
}
