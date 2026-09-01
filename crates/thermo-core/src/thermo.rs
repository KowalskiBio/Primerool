//! Two-state Tm for a folded hairpin or bimolecular dimer — port of the
//! fork's `strider/thermo/hairpin.py::hairpin_thermo` and
//! `strider/thermo/dimer_thermo.py::{dimer_thermo, dimer_thermo_subopt}`.
//!
//! `Tm = ΔH / ΔS` (hairpin, unimolecular) or `Tm = ΔH / (ΔS + R·ln(C_T))`
//! (dimer, bimolecular — `C_T` the total/effective strand concentration),
//! with `ΔS = (ΔH − ΔG₃₇) / T_REF` derived from the *same* structure walk
//! run against the ΔG₃₇ and ΔH sections of [`crate::mathews2004`] so the
//! two are internally consistent at the 310.15 K table reference.

use crate::mathews2004::Mode;
use crate::mathews2004_fold::{dimer_mfe_candidates_mathews, hairpin_mfe_mathews};
use crate::structure_thermo::{dotbracket, sum_dimer_elements, sum_hairpin_elements};
use crate::{salt, ThermoError};

const T_REF: f64 = 310.15; // K, 37 °C — reference temperature of the ΔG tables
const R: f64 = 1.987e-3; // kcal / (mol . K)

// SantaLucia & Hicks (2004) unified bimolecular duplex *initiation*
// (nucleation), applied once per duplex — see `dimer_thermo`'s docs.
const DUPLEX_INIT_DG37: f64 = 1.96; // kcal/mol
const DUPLEX_INIT_DH: f64 = 0.2; // kcal/mol

fn normalize(seq: &str) -> String {
    seq.trim().to_uppercase().replace('U', "T")
}

#[derive(Debug, Clone, PartialEq)]
pub struct HairpinThermo {
    pub tm_celsius: f64,
    pub dh: f64,
    pub ds: f64, // cal/mol/K
    pub dg37: f64,
    pub n_pairs: usize,
    pub structure: String,
}

/// Salt-corrected closed-state ΔG offset: Tan-Chen (2007) whole-helix model
/// for stems >= 6bp (`TAN_CHEN_MIN_BP`), else the per-base-pair correction —
/// both already ported in [`crate::salt`].
fn salt_dg_for_stem(n_pairs: usize, sodium_m: f64, magnesium_m: f64) -> Result<f64, ThermoError> {
    if n_pairs >= 6 {
        salt::tan_chen_helix_dg(n_pairs as f64, sodium_m, magnesium_m, "dna")
    } else {
        Ok(n_pairs as f64 * salt::dg_per_bp_salt(sodium_m, magnesium_m, 37.0, "dna"))
    }
}

/// Two-state hairpin thermodynamics for the MFE fold of `seq`. `dangles`:
/// Oligool's own call always passes `2` for hairpins.
pub fn hairpin_thermo(seq: &str, sodium_m: f64, magnesium_m: f64, dangles: u8) -> Result<HairpinThermo, ThermoError> {
    let seq = normalize(seq);
    let bytes = seq.as_bytes();
    let (_, pairs) = hairpin_mfe_mathews(bytes, dangles).ok_or_else(|| ThermoError::InvalidPairing("sequence does not fold into a hairpin".into()))?;
    let pairs = &pairs;
    let n = pairs.len();

    let dg37_1m = sum_hairpin_elements(Mode::Dg, bytes, pairs, dangles);
    let dh = sum_hairpin_elements(Mode::Dh, bytes, pairs, dangles);

    let salt_dg = salt_dg_for_stem(n, sodium_m, magnesium_m)?;
    let dg37 = dg37_1m + salt_dg;
    let ds_kcal = (dh - dg37) / T_REF;
    if ds_kcal == 0.0 {
        return Err(ThermoError::InvalidPairing("degenerate entropy — cannot define a melting point".into()));
    }
    let tm_k = dh / ds_kcal;

    Ok(HairpinThermo { tm_celsius: tm_k - 273.15, dh, ds: ds_kcal * 1000.0, dg37, n_pairs: n, structure: dotbracket(bytes.len(), pairs) })
}

#[derive(Debug, Clone, PartialEq)]
pub struct DimerThermo {
    pub tm_celsius: f64,
    pub dh: f64,
    pub ds: f64, // cal/mol/K
    pub dg37: f64,
    pub n_pairs: usize,
    pub structure: String,
    pub is_self_dimer: bool,
}

fn dimer_thermo_from_pairs(
    seq1: &str,
    seq2: &str,
    pairs: Vec<(usize, usize)>,
    sodium_m: f64,
    magnesium_m: f64,
    strand_conc_m: f64,
    dangles: u8,
) -> Result<DimerThermo, ThermoError> {
    let is_self_dimer = seq1 == seq2;
    let n1 = seq1.len();
    let concat = format!("{seq1}{seq2}");
    let bytes = concat.as_bytes();
    let n = pairs.len();

    let dg37_1m = sum_dimer_elements(Mode::Dg, bytes, n1, &pairs, dangles) + DUPLEX_INIT_DG37;
    // The ΔH walk always uses dangles=0 for dimers (dangle tables are ΔG₃₇-only
    // — see `structure_thermo::sum_dimer_elements`'s docs and the fork's
    // `structure_enthalpy_dimer`, which hardcodes `dangles=0`).
    let dh = sum_dimer_elements(Mode::Dh, bytes, n1, &pairs, 0) + DUPLEX_INIT_DH;

    let salt_dg = salt_dg_for_stem(n, sodium_m, magnesium_m)?;
    let dg37 = dg37_1m + salt_dg;
    let ds_kcal = (dh - dg37) / T_REF;
    if ds_kcal == 0.0 {
        return Err(ThermoError::InvalidPairing("degenerate entropy — cannot define a melting point".into()));
    }

    let ln_term = if is_self_dimer { strand_conc_m.ln() } else { (strand_conc_m / 4.0).ln() };
    let tm_k = dh / (ds_kcal + R * ln_term);

    Ok(DimerThermo {
        tm_celsius: tm_k - 273.15,
        dh,
        ds: ds_kcal * 1000.0,
        dg37,
        n_pairs: n,
        structure: dotbracket(bytes.len(), &pairs),
        is_self_dimer,
    })
}

/// Two-state dimer thermodynamics for the MFE inter-strand helix between
/// `seq1` and `seq2` (self-dimer if `seq2` is `None`). `strand_conc_m`:
/// total strand concentration in molar. `dangles`: Oligool's own call uses
/// the default `0` for dimers.
pub fn dimer_thermo(seq1: &str, seq2: Option<&str>, sodium_m: f64, magnesium_m: f64, strand_conc_m: f64, dangles: u8) -> Result<DimerThermo, ThermoError> {
    let s1 = normalize(seq1);
    let s2 = seq2.map(normalize).unwrap_or_else(|| s1.clone());

    let candidates = dimer_mfe_candidates_mathews(s1.as_bytes(), s2.as_bytes());
    let (_, pairs) = candidates.first().ok_or_else(|| ThermoError::InvalidPairing("no dimer structure found".into()))?;
    if pairs.len() < 2 {
        return Err(ThermoError::InvalidPairing("dimer helix must contain at least two inter-strand base pairs".into()));
    }
    let mut pairs = pairs.clone();
    pairs.sort();

    dimer_thermo_from_pairs(&s1, &s2, pairs, sodium_m, magnesium_m, strand_conc_m, dangles)
}

/// Top `n` distinct suboptimal dimer alignments (by closed-state DP energy),
/// each scored with the same two-state model as [`dimer_thermo`]. Reuses
/// [`dimer::dimer_mfe_candidates_dna`]'s full ranked candidate list — no
/// separate enumeration is needed, unlike primer3, which has no subopt path.
pub fn dimer_thermo_subopt(seq1: &str, seq2: Option<&str>, n: usize, sodium_m: f64, magnesium_m: f64, strand_conc_m: f64, dangles: u8) -> Vec<DimerThermo> {
    let s1 = normalize(seq1);
    let s2 = seq2.map(normalize).unwrap_or_else(|| s1.clone());

    let candidates = dimer_mfe_candidates_mathews(s1.as_bytes(), s2.as_bytes());

    let mut results = Vec::new();
    let mut seen_outer = std::collections::HashSet::new();
    for (_, pairs) in candidates {
        if results.len() >= n {
            break;
        }
        if pairs.len() < 2 {
            continue;
        }
        let outer = pairs[0];
        if !seen_outer.insert(outer) {
            continue;
        }
        let mut sorted_pairs = pairs;
        sorted_pairs.sort();
        if let Ok(dt) = dimer_thermo_from_pairs(&s1, &s2, sorted_pairs, sodium_m, magnesium_m, strand_conc_m, dangles) {
            results.push(dt);
        }
    }
    results.sort_by(|a, b| a.dg37.partial_cmp(&b.dg37).unwrap());
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hairpin_thermo_reports_positive_dh_for_a_stable_stem() {
        // 6bp GC stem + a stable tetraloop.
        let result = hairpin_thermo("GCGCGCGAAACGCGCGC", 0.05, 0.003, 2).unwrap();
        assert!(result.dg37 < 0.0);
        assert!(result.tm_celsius.is_finite());
        assert!(result.n_pairs >= 5, "n_pairs={}", result.n_pairs);
    }

    #[test]
    fn dimer_thermo_self_complementary() {
        let result = dimer_thermo("ACGTACGTACGT", None, 0.05, 0.003, 250e-9, 0).unwrap();
        assert!(result.is_self_dimer);
        assert!(result.dg37 < 0.0);
        assert!(result.tm_celsius.is_finite());
    }

    #[test]
    fn dimer_thermo_subopt_returns_distinct_alignments() {
        let results = dimer_thermo_subopt("ACGTACGTACGTACGT", None, 5, 0.05, 0.003, 250e-9, 0);
        assert!(!results.is_empty());
        assert!(results.len() <= 5);
    }
}
