//! `ThermoBackend` trait: the thermodynamic primitives the design engine
//! needs. Parameter shape (`mv_conc`/`dv_conc`/`dntp_conc`/`dna_conc` per call,
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
    /// The app-wide reaction conditions: 50 mM Na+/K+, 3 mM Mg2+,
    /// 0.8 mM dNTPs, 200 nM (0.2 µM) oligo — IDT OligoAnalyzer's qPCR
    /// preset, so Tm/hairpin/dimer numbers line up with what a user sees
    /// there. Every route and design path falls back to this.
    fn default() -> Self {
        Self { mv_conc: 50.0, dv_conc: 3.0, dntp_conc: 0.8, dna_conc: 200.0 }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct DimerResult {
    pub structure_found: bool,
    pub tm: Option<f64>,
    pub dg: Option<f64>,
    /// The single MFE dot-bracket structure, when the backend computes one
    /// (`NativeBackend` does). For a dimer, defined over the concatenation
    /// `seq1 + seq2` (see `DimerSvg`'s doc comment on the frontend).
    /// `/idt/analyze`'s own enrichment computes a ranked list of
    /// *suboptimal* structures straight from `thermo_core::thermo`; this
    /// field only ever carries the one MFE fold.
    pub structure: Option<String>,
}

/// `Sync` is a supertrait, not an afterthought: `engine::picker` scores
/// candidates in parallel via `rayon`.
pub trait ThermoBackend: Sync {
    fn calc_tm(&self, seq: &str, params: ThermoParams) -> f64;
    fn calc_hairpin(&self, seq: &str, params: ThermoParams) -> DimerResult;
    fn calc_homodimer(&self, seq: &str, params: ThermoParams) -> DimerResult;
    fn calc_heterodimer(&self, seq1: &str, seq2: &str, params: ThermoParams) -> DimerResult;
}
