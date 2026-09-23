//! On-demand, richer structural analysis for ONE selected primer — the
//! Strider-only counterpart to `analyze::analyze_primer`'s cheap per-
//! candidate `DimerResult` (which only ever reports a single MFE fold).
//! Computes BOTH a bulge-allowing (true global MFE) and a no-bulge
//! ("pure sliding window", the model simpler self-dimer checkers like
//! IDT's OligoAnalyzer use) structure for the hairpin and homodimer (plus
//! heterodimer, when a partner sequence is given), each with its own
//! population-fraction share within its own model's top-N subopt
//! ensemble — mirrors Oligool's own `Population_Fraction` field, an
//! enumeration-based Boltzmann share over the top-N displayed candidates
//! rather than a full partition-function DP (see Oligool's
//! `backend/main.py`, which documents this exact simplification and why:
//! a real McCaskill-style partition function is a separate, much larger
//! undertaking this deliberately doesn't attempt).
//!
//! Deliberately expensive — only ever called for the one primer (or pair)
//! the user has selected, never for a whole candidate list (see
//! `PrimerCard`'s `selected`-gated fetch and `PrimerStructureModal`'s
//! click-gated fetch on the frontend, mirroring Oligool's own
//! `analyzeStriderIndividual`-on-"Use" pattern).

use crate::backend::ThermoParams;

const SUBOPT_COUNT: usize = 5;
const R_GAS: f64 = 1.987e-3; // kcal / (mol . K) — matches thermo_core::thermo's own constant
const T_REF: f64 = 310.15; // K, 37 degC — ditto

/// One subopt candidate's own stats - `StructureVariant.candidates` holds
/// up to `SUBOPT_COUNT` of these, best (index 0) first.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StructureCandidate {
    pub dg: f64,
    pub tm: f64,
    pub structure: String,
    /// Boltzmann share of this candidate's ΔG within this model's own
    /// top-N subopt ensemble (bulge-allowing or no-bulge — never mixed).
    pub population_fraction: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StructureVariant {
    pub structure_found: bool,
    /// Mirrors `candidates[0]` — kept as plain scalars (rather than
    /// requiring every caller to index into `candidates`) since
    /// `PrimerCard.tsx` only ever shows the single best structure.
    pub dg: Option<f64>,
    pub tm: Option<f64>,
    pub structure: Option<String>,
    pub population_fraction: Option<f64>,
    /// Every subopt candidate found, up to `SUBOPT_COUNT` — added for
    /// callers that want to show more than just the top structure (see
    /// `PrimerStructureModal.tsx`).
    pub candidates: Vec<StructureCandidate>,
}

impl StructureVariant {
    fn none() -> Self {
        Self { structure_found: false, dg: None, tm: None, structure: None, population_fraction: None, candidates: Vec::new() }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DualStructure {
    pub with_bulge: StructureVariant,
    pub no_bulge: StructureVariant,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FullStructureAnalysis {
    pub hairpin: DualStructure,
    /// Always `seq` folded against itself, regardless of whether a
    /// partner sequence was given - unlike before this field existed
    /// alongside `heterodimer`, a partner no longer *replaces* what this
    /// means (see `analyze_structure`'s doc).
    pub homodimer: DualStructure,
    /// `seq` against `seq2` - `None` when no partner sequence was given.
    pub heterodimer: Option<DualStructure>,
}

/// `population_i = exp(-dG_i/RT) / sum_j exp(-dG_j/RT)` — algebraically the
/// same share Oligool computes via `ensemble_dG = -RT*ln(Z)` then
/// `exp(-(dG_i - ensemble_dG)/RT)`, just without the intermediate value.
fn population_fractions(dgs: &[f64]) -> Vec<f64> {
    let weights: Vec<f64> = dgs.iter().map(|dg| (-dg / (R_GAS * T_REF)).exp()).collect();
    let z: f64 = weights.iter().sum();
    if z <= 0.0 {
        return vec![0.0; dgs.len()];
    }
    weights.iter().map(|w| w / z).collect()
}

fn hairpin_variant_from_subopt(subopt: Vec<thermo_core::thermo::HairpinThermo>) -> StructureVariant {
    if subopt.is_empty() {
        return StructureVariant::none();
    }
    let dgs: Vec<f64> = subopt.iter().map(|h| h.dg37).collect();
    let shares = population_fractions(&dgs);
    let candidates: Vec<StructureCandidate> = subopt
        .iter()
        .zip(shares.iter())
        .map(|(h, &population_fraction)| StructureCandidate { dg: h.dg37, tm: h.tm_celsius, structure: h.structure.clone(), population_fraction })
        .collect();
    let best = &candidates[0];
    StructureVariant { structure_found: true, dg: Some(best.dg), tm: Some(best.tm), structure: Some(best.structure.clone()), population_fraction: Some(best.population_fraction), candidates }
}

fn dimer_variant_from_subopt(subopt: Vec<thermo_core::thermo::DimerThermo>) -> StructureVariant {
    if subopt.is_empty() {
        return StructureVariant::none();
    }
    let dgs: Vec<f64> = subopt.iter().map(|d| d.dg37).collect();
    let shares = population_fractions(&dgs);
    let candidates: Vec<StructureCandidate> = subopt
        .iter()
        .zip(shares.iter())
        .map(|(d, &population_fraction)| StructureCandidate { dg: d.dg37, tm: d.tm_celsius, structure: d.structure.clone(), population_fraction })
        .collect();
    let best = &candidates[0];
    StructureVariant { structure_found: true, dg: Some(best.dg), tm: Some(best.tm), structure: Some(best.structure.clone()), population_fraction: Some(best.population_fraction), candidates }
}

/// `seq2`: `None` skips the heterodimer entirely; `Some(partner)` computes
/// it *in addition to* (not instead of) `seq`'s own homodimer.
pub fn analyze_structure(seq: &str, seq2: Option<&str>, params: ThermoParams) -> FullStructureAnalysis {
    // Same molar-unit conversion and effective-Mg2+ correction as
    // `backend_native::to_molar_conc`/`effective_magnesium_m` — duplicated
    // rather than shared because those are private to that module and this
    // is the only other call site that needs them.
    let sodium_m = params.mv_conc / 1000.0;
    let dv_m = params.dv_conc / 1000.0;
    let dntp_m = params.dntp_conc / 1000.0;
    let magnesium_m = (dv_m - dntp_m).max(0.0);
    let strand_conc_m = params.dna_conc * 1e-9;

    let hairpin = DualStructure {
        with_bulge: hairpin_variant_from_subopt(thermo_core::thermo::hairpin_thermo_subopt(seq, SUBOPT_COUNT, sodium_m, magnesium_m, 2)),
        no_bulge: hairpin_variant_from_subopt(thermo_core::thermo::hairpin_thermo_no_bulge_subopt(seq, SUBOPT_COUNT, sodium_m, magnesium_m, 2)),
    };
    let homodimer = DualStructure {
        with_bulge: dimer_variant_from_subopt(thermo_core::thermo::dimer_thermo_subopt(seq, None, SUBOPT_COUNT, sodium_m, magnesium_m, strand_conc_m, 0)),
        no_bulge: dimer_variant_from_subopt(thermo_core::thermo::dimer_thermo_no_bulge_subopt(seq, None, SUBOPT_COUNT, sodium_m, magnesium_m, strand_conc_m, 0)),
    };
    let heterodimer = seq2.map(|partner| DualStructure {
        with_bulge: dimer_variant_from_subopt(thermo_core::thermo::dimer_thermo_subopt(seq, Some(partner), SUBOPT_COUNT, sodium_m, magnesium_m, strand_conc_m, 0)),
        no_bulge: dimer_variant_from_subopt(thermo_core::thermo::dimer_thermo_no_bulge_subopt(seq, Some(partner), SUBOPT_COUNT, sodium_m, magnesium_m, strand_conc_m, 0)),
    });

    FullStructureAnalysis { hairpin, homodimer, heterodimer }
}
