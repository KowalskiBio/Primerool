//! Salt corrections (mirrors `strider.thermo.salt`) — scalar ports of the
//! PyO3-bound functions in `strider/native/src/lib.rs`, with `PyResult`/
//! `PyErr` stripped in favor of plain `Result<T, ThermoError>`. Every
//! formula is identical to its Strider source except the duplex Tm salt
//! correction, [`owczarzy_salt_tm`], which Primerool takes from Owczarzy
//! 2008 as published so its Tm matches IDT (as Thermool does).

use crate::ThermoError;

const T_REF_K: f64 = 310.15; // 37 °C reference

#[inline]
pub(crate) fn fgc(seq: &[u8]) -> f64 {
    // Python: seq.upper() letters in "GC"; length is full seq length.
    if seq.is_empty() {
        return 0.5;
    }
    let gc = seq
        .iter()
        .filter(|b| matches!(b.to_ascii_uppercase(), b'G' | b'C'))
        .count();
    gc as f64 / seq.len() as f64
}

/// Owczarzy et al. (2004) monovalent correction to 1/Tm (1/K), relative to 1 M Na+.
#[inline]
fn na_inv_tm_correction(fgc: f64, sodium_m: f64) -> f64 {
    let ln_na = sodium_m.ln();
    (4.29 * fgc - 3.95) * 1e-5 * ln_na + 9.40e-6 * ln_na * ln_na
}

/// Owczarzy et al. (2008) Eq. 16 Mg2+ correction to 1/Tm (1/K), relative to
/// 1 M Na+. `sodium_m` is `Some` in the mixed regime (0.22 <= R < 6), where
/// Eq. 18 makes a, d and g depend on the monovalent concentration.
#[inline]
fn mg_inv_tm_correction(fgc: f64, mg_m: f64, n_bp: usize, sodium_m: Option<f64>) -> f64 {
    let ln_mg = mg_m.ln();
    let (mut a, b, c, mut d, e, f, mut g) = (3.92e-5, -9.11e-6, 6.26e-5, 1.42e-5, -4.82e-4, 5.25e-4, 8.31e-5);
    if let Some(na) = sodium_m {
        let ln_na = na.ln();
        a *= 0.843 - 0.352 * na.sqrt() * ln_na;
        d *= 1.279 - 4.03e-3 * ln_na - 8.03e-3 * ln_na * ln_na;
        g *= 0.486 - 0.258 * ln_na + 5.25e-3 * ln_na.powi(3);
    }
    let length_factor = 1.0 / (2.0 * (n_bp.max(2) - 1) as f64);
    a + b * ln_mg + fgc * (c + d * ln_mg) + length_factor * (e + f * ln_mg + g * ln_mg * ln_mg)
}

/// Salt-corrected duplex Tm (K) from the 1 M Na+ Tm (K), as published by
/// Owczarzy et al. (2008), Biochemistry 47:5336, and used by IDT
/// OligoAnalyzer: with R = sqrt([Mg2+]) / [Na+],
/// - R < 0.22: monovalent ions dominate, Owczarzy 2004 Na+ correction;
/// - 0.22 <= R < 6: Mg2+ correction with Na+-dependent a, d, g (Eq. 18);
/// - R >= 6 (or no Na+): Mg2+ correction with the original coefficients.
///
/// Applied exactly, `1/Tm = 1/Tm(1 M) + correction`. Primerool's own
/// choice (shared with Thermool): Strider instead linearises around 340 K and, in the mixed
/// regime, converts Mg2+ to a von Ahsen sodium equivalent, which reads
/// about 3 °C above IDT at qPCR conditions.
pub fn owczarzy_salt_tm(tm_1m_k: f64, seq: &str, sodium_m: f64, magnesium_m: f64) -> f64 {
    let bytes = seq.as_bytes();
    let f = fgc(bytes);
    let n_bp = bytes.len();
    let inv = if magnesium_m > 0.0 && sodium_m > 0.0 {
        let ratio = magnesium_m.sqrt() / sodium_m;
        if ratio < 0.22 {
            na_inv_tm_correction(f, sodium_m)
        } else if ratio < 6.0 {
            mg_inv_tm_correction(f, magnesium_m, n_bp, Some(sodium_m))
        } else {
            mg_inv_tm_correction(f, magnesium_m, n_bp, None)
        }
    } else if magnesium_m > 0.0 {
        mg_inv_tm_correction(f, magnesium_m, n_bp, None)
    } else {
        na_inv_tm_correction(f, sodium_m)
    };
    1.0 / (1.0 / tm_1m_k + inv)
}

pub fn na_correction_dg(seq: &str, sodium_m: f64, celsius: f64) -> f64 {
    let n = seq.len() as i64 - 1; // number of phosphates
    if n <= 0 || sodium_m <= 0.0 {
        return 0.0;
    }
    let dg_correction = 0.368 * (n as f64) * sodium_m.ln() * 1.987e-3 * (celsius + 273.15) / 1000.0;
    -dg_correction
}

pub fn dg_per_bp_salt(sodium_m: f64, magnesium_m: f64, celsius: f64, material: &str) -> f64 {
    let effective_na = sodium_m + 3.4 * magnesium_m.max(0.0).sqrt();
    if effective_na <= 0.0 {
        return 0.0;
    }
    const DG_PER_BP_NA: f64 = -0.114;
    const RNA_SALT_FACTOR: f64 = 1.06;
    let coeff = if material.eq_ignore_ascii_case("rna") {
        DG_PER_BP_NA * RNA_SALT_FACTOR
    } else {
        DG_PER_BP_NA
    };
    let frac = (celsius + 273.15) / T_REF_K;
    coeff * effective_na.ln() * frac
}

pub fn duplex_salt_dg(seq: &str, sodium_m: f64, magnesium_m: f64, celsius: f64, material: &str) -> f64 {
    seq.len() as f64 * dg_per_bp_salt(sodium_m, magnesium_m, celsius, material)
}

pub fn tan_chen_helix_dg(
    n_pairs: f64,
    sodium_m: f64,
    magnesium_m: f64,
    material: &str,
) -> Result<f64, ThermoError> {
    const MIN_BP: i64 = 6;
    if !n_pairs.is_finite() {
        // Python: int(NaN) -> ValueError; int(+-inf) -> OverflowError
        if n_pairs.is_nan() {
            return Err(ThermoError::InvalidPairing(
                "cannot convert float NaN to integer".into(),
            ));
        }
        return Err(ThermoError::InvalidPairing(
            "cannot convert float infinity to integer".into(),
        ));
    }
    // Python: int(n_pairs) — truncation toward zero.
    let n = n_pairs as i64;
    if n < MIN_BP {
        return Err(ThermoError::InvalidPairing(format!(
            "Tan-Chen helix salt model is fit for stems >= {} bp; got N={}. Use the per-base-pair model for short stems.",
            MIN_BP, n
        )));
    }
    let mat = material.to_ascii_lowercase();
    let is_rna = match mat.as_str() {
        "dna" => false,
        "rna" => true,
        _ => return Err(ThermoError::InvalidPairing("material must be 'dna' or 'rna'".into())),
    };

    let ln_na = if sodium_m > 0.0 { sodium_m.ln() } else { 0.0 };
    let (a1, b1) = if !is_rna {
        (-0.07 * ln_na + 0.012 * ln_na * ln_na, 0.013 * ln_na * ln_na)
    } else {
        (-0.075 * ln_na + 0.012 * ln_na * ln_na, 0.018 * ln_na * ln_na)
    };
    let dg1 = a1 + b1 / n as f64;
    if magnesium_m <= 0.0 {
        return Ok((n as f64 - 1.0) * dg1);
    }

    let ln_mg = magnesium_m.ln();
    let nf = n as f64;
    let (a2, b2) = if !is_rna {
        (
            0.02 * ln_mg + 0.0068 * ln_mg * ln_mg,
            1.18 * ln_mg + 0.344 * ln_mg * ln_mg,
        )
    } else {
        (
            -0.6 / nf + 0.025 * ln_mg + 0.0068 * ln_mg * ln_mg,
            ln_mg + 0.38 * ln_mg * ln_mg,
        )
    };
    let dg2 = a2 + b2 / (nf * nf);
    if sodium_m <= 0.0 {
        return Ok((nf - 1.0) * dg2);
    }

    let x1 = sodium_m / (sodium_m + (8.1 - 32.4 / nf) * (5.2 - ln_na) * magnesium_m);
    let x2 = 1.0 - x1;
    let arg = (1.0 / x1 - 1.0) * sodium_m;
    let dg12 = if arg > 0.0 {
        -0.6 * x1 * x2 * ln_na * arg.ln() / nf
    } else {
        0.0
    };
    Ok((nf - 1.0) * (x1 * dg1 + x2 * dg2) + dg12)
}
