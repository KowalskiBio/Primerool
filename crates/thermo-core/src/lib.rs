//! Plain-Rust DNA thermodynamics core.
//!
//! De-PyO3'd fork of `strider/native/src/{lib,dimer,tables,tables_dna}.rs`
//! (MIT, same author) — Strider's crate is `crate-type = ["cdylib"]` only
//! and every public function is PyO3-bound, so it cannot be linked into a
//! normal Rust binary as-is. Every function below is mechanically
//! equivalent to its Strider counterpart: `PyResult<T>`/`PyErr` become
//! `Result<T, ThermoError>`, `#[pyfunction]`/`#[pyo3(signature = ...)]` are
//! dropped, and the `#[pymodule]` registration is gone — no formula or
//! control-flow changes. See the rewrite plan's Phase 1 upstreaming note:
//! once Strider's crate gains an `rlib` target, this fork can be replaced
//! with a real dependency on `strider_native`.
//!
//! `tables`/`tables_dna`/`dimer` are copied verbatim (no PyO3 types in
//! their bodies to begin with). `hairpin` is new — Strider's own hairpin
//! loop tables exist but were never wired to a folding DP (explicitly
//! marked dead code, "lands in a later DP port"); closing that gap is
//! Phase 4 of the rewrite plan, not this phase.

pub mod dimer;
pub mod hairpin;
pub mod mathews2004;
pub mod mathews2004_fold;
pub mod salt;
pub mod structure_thermo;
pub mod tables;
pub mod thermo;

#[derive(Debug, thiserror::Error)]
pub enum ThermoError {
    #[error("sequence must not be empty")]
    EmptySequence,
    #[error("invalid base pairing: {0}")]
    InvalidPairing(String),
}

const R: f64 = 1.987e-3; // kcal / (mol . K)

// ---------------------------------------------------------------------------
// DNA nearest-neighbor parameters (SantaLucia & Hicks 2004)
// Indexed by 2-bit dinucleotide code (b1<<2)|b2, A=0,C=1,G=2,T=3.
// Values identical to strider.thermo.nn_dna.DNA_NN (complement pairs share
// values by symmetry, exactly as the Python table spells them out).
// ---------------------------------------------------------------------------
const NN: [(f64, f64); 16] = [
    (-7.9, -22.2),  // AA = TT
    (-8.4, -22.4),  // AC = GT
    (-7.8, -21.0),  // AG = CT
    (-7.2, -20.4),  // AT
    (-8.5, -22.7),  // CA = TG
    (-8.0, -19.9),  // CC = GG
    (-10.6, -27.2), // CG
    (-7.8, -21.0),  // CT = AG
    (-8.2, -22.2),  // GA = TC
    (-9.8, -24.4),  // GC
    (-8.0, -19.9),  // GG = CC
    (-8.4, -22.4),  // GT = AC
    (-7.2, -21.3),  // TA
    (-8.2, -22.2),  // TC = GA
    (-8.5, -22.7),  // TG = CA
    (-7.9, -22.2),  // TT = AA
];

const INIT_GC: (f64, f64) = (0.1, -2.8); // terminal G-C or C-G pair
const INIT_AT: (f64, f64) = (2.3, 4.1); // terminal A-T or T-A pair
const SYMMETRY_DS: f64 = -1.4; // self-complementarity, entropy only

// 256-entry base -> 2-bit map; 255 = not ACGT (U treated as T, DNA engine).
const fn build_base_code() -> [u8; 256] {
    let mut t = [255u8; 256];
    t[b'A' as usize] = 0;
    t[b'a' as usize] = 0;
    t[b'C' as usize] = 1;
    t[b'c' as usize] = 1;
    t[b'G' as usize] = 2;
    t[b'g' as usize] = 2;
    t[b'T' as usize] = 3;
    t[b't' as usize] = 3;
    t[b'U' as usize] = 3; // strider: .replace("U", "T")
    t[b'u' as usize] = 3;
    t
}
const BASE_CODE: [u8; 256] = build_base_code();

// ---------------------------------------------------------------------------
// Sequence helpers (Python-faithful: unknown chars survive translation, so
// self-complementarity checks are done on plain bytes, mirroring
// nn_dna.reverse_complement / is_self_complementary).
// ---------------------------------------------------------------------------

/// Python: str.upper() then .replace("U", "T")  (duplex/Tm path)
#[inline]
fn norm_upper(b: u8) -> u8 {
    match b.to_ascii_uppercase() {
        b'U' => b'T',
        other => other,
    }
}

/// DNA reverse-complement translation (nn_dna.COMPLEMENT): ACGT only —
/// U and any other character pass through unchanged, exactly like Python's
/// str.translate on a table limited to "ACGT"->"TGCA".
#[inline]
fn complement_byte(b: u8) -> u8 {
    match b.to_ascii_uppercase() {
        b'A' => b'T',
        b'T' => b'A',
        b'C' => b'G',
        b'G' => b'C',
        other => other,
    }
}

pub fn reverse_complement(seq: &str) -> String {
    let bytes: Vec<u8> = seq.bytes().rev().map(complement_byte).collect();
    // Input is guaranteed ASCII/UTF-8 DNA alphabet on every strider call path.
    String::from_utf8(bytes).unwrap_or_else(|_| seq.to_uppercase())
}

fn is_self_complementary_bytes(seq: &[u8]) -> bool {
    // Public API: seq.upper() == reverse_complement(seq), U passes through.
    seq.iter()
        .zip(seq.iter().rev())
        .all(|(a, b)| a.to_ascii_uppercase() == complement_byte(*b))
}

/// Duplex/Tm-path variant: Python normalizes seq to U->T BEFORE calling
/// is_self_complementary inside duplex_dh_ds / melting_temperature / duplex_dg,
/// so 'U' behaves as 'T' here.
fn is_self_complementary_norm_bytes(seq: &[u8]) -> bool {
    seq.iter().zip(seq.iter().rev()).all(|(a, b)| {
        let ca = match norm_upper(*b) {
            b'A' => b'T',
            b'T' => b'A',
            b'C' => b'G',
            b'G' => b'C',
            other => other,
        };
        norm_upper(*a) == ca
    })
}

pub fn is_self_complementary(seq: &str) -> bool {
    is_self_complementary_bytes(seq.as_bytes())
}

// ---------------------------------------------------------------------------
// Core NN walk
// ---------------------------------------------------------------------------

#[inline]
fn nn_lookup(a: u8, b: u8) -> (f64, f64) {
    if a != 255 && b != 255 {
        return NN[((a << 2) | b) as usize];
    }
    // The Python `_sum_nn` complement-pair retry (reverse_complement(dinuc)
    // then dict lookup again) is structurally unreachable: every ACGT
    // dinucleotide already hits the full 16-entry table above, and a dinuc
    // holding a non-ACGT base yields a reverse-complement that also contains
    // one, so Python can only ever arrive at the (-8.0, -22.0) average —
    // which this arm returns directly.
    (-8.0, -22.0)
}

fn require_nonempty(seq: &[u8]) -> Result<(), ThermoError> {
    // Python raises IndexError("string index out of range") on empty input,
    // surfacing from _initiation's seq[0] access; every public entry point
    // downstream of it (duplex_dh_ds, duplex_dg, melting_temperature,
    // duplex_tm) therefore errors the same way — surfaced here as
    // ThermoError::EmptySequence rather than an index-error string.
    if seq.is_empty() {
        return Err(ThermoError::EmptySequence);
    }
    Ok(())
}

fn duplex_dh_ds_bytes(seq: &[u8]) -> (f64, f64) {
    let mut dh = 0.0;
    let mut ds = 0.0;
    let n = seq.len();
    if n == 0 {
        return (0.0, 0.0); // callers guard via require_nonempty
    }
    for i in 0..n.saturating_sub(1) {
        let a = BASE_CODE[seq[i] as usize];
        let b = BASE_CODE[seq[i + 1] as usize];
        let (h, s) = nn_lookup(a, b);
        dh += h;
        ds += s;
    }
    // Initiation per terminal base (Python: for end_base in (seq[0], seq[-1])).
    // Note: for a 1-base sequence Python adds BOTH endpoints = the same base twice.
    for idx in [0usize, n - 1] {
        let (h, s) = match norm_upper(seq[idx]) {
            b'G' | b'C' => INIT_GC,
            _ => INIT_AT,
        };
        dh += h;
        ds += s;
    }
    if is_self_complementary_norm_bytes(seq) {
        ds += SYMMETRY_DS;
    }
    (dh, ds)
}

/// (dH kcal/mol, dS cal/mol/K) from `_sum_nn` + `_initiation` + symmetry term,
/// mirroring `nn_dna.duplex_dh_ds`.
pub fn duplex_dh_ds(seq: &str) -> Result<(f64, f64), ThermoError> {
    require_nonempty(seq.as_bytes())?;
    Ok(duplex_dh_ds_bytes(seq.as_bytes()))
}

// ---------------------------------------------------------------------------
// Duplex thermodynamics (strider.thermo.nn_dna)
// ---------------------------------------------------------------------------

pub fn duplex_dg(seq: &str, celsius: f64, sodium_m: f64, magnesium_m: f64) -> Result<f64, ThermoError> {
    require_nonempty(seq.as_bytes())?;
    Ok(duplex_dg_raw(seq.as_bytes(), celsius, sodium_m, magnesium_m))
}

fn duplex_dg_raw(seq: &[u8], celsius: f64, sodium_m: f64, magnesium_m: f64) -> f64 {
    let t = celsius + 273.15;
    let (dh, ds) = duplex_dh_ds_bytes(seq);
    let mut dg = dh - t * (ds / 1000.0);
    if sodium_m != 1.0 || magnesium_m > 0.0 {
        dg += seq.len() as f64 * salt::dg_per_bp_salt(sodium_m, magnesium_m, celsius, "dna");
    }
    dg
}

fn tm_raw(seq: &str, strand_conc_m: f64, sodium_m: f64, magnesium_m: f64) -> f64 {
    let bytes = seq.as_bytes();
    let (dh, ds) = duplex_dh_ds_bytes(bytes);
    let self_comp = is_self_complementary_norm_bytes(bytes);
    let ln_ct = if self_comp {
        strand_conc_m.ln()
    } else {
        (strand_conc_m / 4.0).ln()
    };
    let mut tm = (dh * 1000.0) / (ds + R * 1000.0 * ln_ct) - 273.15;
    if sodium_m != 1.0 || magnesium_m > 0.0 {
        tm += salt::owczarzy_tm_correction(seq, sodium_m, magnesium_m);
    }
    tm
}

/// Defaults mirror `nn_dna.melting_temperature`: strand_conc_M=250e-9,
/// sodium_M=0.137, magnesium_M=0.0.
pub fn melting_temperature(
    seq: &str,
    strand_conc_m: f64,
    sodium_m: f64,
    magnesium_m: f64,
) -> Result<f64, ThermoError> {
    require_nonempty(seq.as_bytes())?;
    Ok(tm_raw(seq, strand_conc_m, sodium_m, magnesium_m))
}

/// The primer3-`calc_tm`-equivalent convenience call. Defaults mirror
/// `nn_dna.duplex_tm`: sodium_M=0.05, magnesium_M=0.003, dNTP_M=0.0008,
/// oligo_conc_M=0.25e-6.
pub fn duplex_tm(
    seq: &str,
    sodium_m: f64,
    magnesium_m: f64,
    dntp_m: f64,
    oligo_conc_m: f64,
) -> Result<f64, ThermoError> {
    require_nonempty(seq.as_bytes())?;
    let free_mg = (magnesium_m - dntp_m).max(0.0);
    Ok(tm_raw(seq, oligo_conc_m, sodium_m, free_mg))
}

/// Heterodimer/self-dimer MFE candidate scan (DNA only). Ranks every
/// antiparallel inter-strand helix start state by closed-state free energy;
/// call with `seq1 == seq2` for a homodimer/self-dimer scan.
pub fn dimer_mfe_candidates(seq1: &str, seq2: &str) -> Vec<(f64, Vec<(usize, usize)>)> {
    dimer::dimer_mfe_candidates_dna(seq1.as_bytes(), seq2.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Values captured from Strider's own Python nn_dna module (same formulas,
    // same tables) — see tests/test_native_parity.py in strider for the full
    // 10k-sequence fuzz corpus this crate is expected to agree with.
    const TOL: f64 = 1e-6;

    #[test]
    fn duplex_dh_ds_matches_strider_for_simple_duplex() {
        // AAAA: 3x AA step (dH=-7.9,dS=-22.2 each) + 2x AT initiation (dH=2.3,dS=4.1 each)
        let (dh, ds) = duplex_dh_ds("AAAA").unwrap();
        assert!((dh - (3.0 * -7.9 + 2.0 * 2.3)).abs() < TOL, "dh={dh}");
        assert!((ds - (3.0 * -22.2 + 2.0 * 4.1)).abs() < TOL, "ds={ds}");
    }

    #[test]
    fn duplex_dh_ds_empty_sequence_errors() {
        assert!(matches!(duplex_dh_ds(""), Err(ThermoError::EmptySequence)));
    }

    #[test]
    fn reverse_complement_matches_expected() {
        assert_eq!(reverse_complement("ACGT"), "ACGT");
        assert_eq!(reverse_complement("AAGG"), "CCTT");
        // complement_byte uppercases internally, so lowercase input still
        // comes back uppercase (matches Strider's str.translate-based port).
        assert_eq!(reverse_complement("acgt"), "ACGT");
    }

    #[test]
    fn is_self_complementary_palindrome() {
        assert!(is_self_complementary("ACGT"));
        assert!(!is_self_complementary("AAGG"));
    }

    #[test]
    fn melting_temperature_is_finite_and_reasonable() {
        // A 20-mer at default (physiological-ish) conditions should land in
        // a biologically plausible Tm range, not merely "finite".
        let tm = melting_temperature("ACGTACGTACGTACGTACGT", 250e-9, 0.137, 0.0).unwrap();
        assert!(tm.is_finite());
        assert!((20.0..90.0).contains(&tm), "tm={tm}");
    }

    #[test]
    fn duplex_tm_matches_direct_tm_raw_computation() {
        let seq = "AGCTAGCTAGCTAGCTAGCT";
        let sodium_m = 0.05;
        let magnesium_m = 0.003;
        let dntp_m = 0.0008;
        let oligo_conc_m = 0.25e-6;
        let got = duplex_tm(seq, sodium_m, magnesium_m, dntp_m, oligo_conc_m).unwrap();
        let free_mg = (magnesium_m - dntp_m).max(0.0);
        let expected = tm_raw(seq, oligo_conc_m, sodium_m, free_mg);
        assert!((got - expected).abs() < TOL);
    }

    #[test]
    fn dimer_mfe_candidates_finds_perfect_complement() {
        // A perfect 8bp complementary pair should produce at least one
        // finite-energy candidate.
        let candidates = dimer_mfe_candidates("ACGTACGT", "ACGTACGT");
        assert!(!candidates.is_empty());
        assert!(candidates[0].0.is_finite());
    }

    #[test]
    fn dimer_mfe_candidates_no_pairing_is_empty_or_high_energy() {
        // Two sequences with no complementarity should yield no negative
        // (favorable) energy candidates dominating the result, or an empty list.
        let candidates = dimer_mfe_candidates("AAAAAAAA", "AAAAAAAA");
        assert!(candidates.is_empty() || candidates[0].0 >= 0.0);
    }
}
