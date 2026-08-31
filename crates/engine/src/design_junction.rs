//! Port of `primer_junction.py::design_junction_primer_pairs`
//! (exon-exon-junction-spanning primer design).
//!
//! Primer3's own picking engine can't express "primer must span this exact
//! point" directly, so unlike every other design mode this one hand-rolls
//! candidate generation: enumerate every `(left_overlap, right_overlap)`
//! combination that produces a valid-length, junction-spanning LEFT primer,
//! score each by Tm-distance-from-optimum (+ a GC penalty), then pair the
//! best-scored LEFT candidates against an independently `choose_primers`-
//! searched pool of RIGHT primers downstream of the junction. Ported
//! faithfully from the "FIXED VERSION" of `primer_junction.py`, including
//! its widened internal product-size range (the *matching* step still
//! filters against the caller's original, unwidened `product_min/max`).
//!
//! The Python source's diagnostic `print()` calls and the dead
//! unconstrained-template self-test (`DIAGNOSTIC: Testing if template can
//! produce primers without junction constraint...`) are debug scaffolding,
//! confirmed to have no effect on the returned result — dropped, not
//! ported.

use primer3_ffi::design::{design_primers, GlobalSettings, SeqArgs};
use primer3_ffi::Primer3Error;

use crate::analyze::{analyze_pair, analyze_primer, PairAnalysis, PrimerAnalysis};
use crate::backend::{ThermoBackend, ThermoParams};
use crate::defaults::{DEFAULT_PRIMER_SIZE, DEFAULT_PRIMER_TM, JUNCTION_MAX_TM_DIFF, JUNCTION_PRIMER_GC, JUNCTION_PRIMER_TM};

#[derive(Debug, Clone, PartialEq)]
pub struct JunctionOligo {
    pub analysis: PrimerAnalysis,
    /// `[start, end)` into the full (unwindowed) input `template`.
    pub interval: [i32; 2],
}

#[derive(Debug, Clone, PartialEq)]
pub struct JunctionPair {
    pub left: JunctionOligo,
    pub right: JunctionOligo,
    pub product_size: i32,
    pub pair_metrics: PairAnalysis,
}

#[derive(Debug, thiserror::Error)]
pub enum JunctionError {
    #[error("Empty template")]
    EmptyTemplate,
    #[error("junction_pos out of range")]
    JunctionPosOutOfRange,
    #[error("No junction candidates in window")]
    NoCandidatesInWindow,
    #[error("Window too small for right primers")]
    WindowTooSmallForRightPrimers,
    #[error("No RIGHT primers found in downstream region. {0}")]
    NoRightPrimersFound(String),
    #[error(transparent)]
    Primer3(#[from] Primer3Error),
}

pub struct JunctionParams {
    pub overlap_min: i32,
    pub overlap_max: i32,
    pub product_min: i32,
    pub product_max: i32,
    pub left_pad: i32,
    pub right_pad: i32,
    pub max_candidates: usize,
}

impl Default for JunctionParams {
    fn default() -> Self {
        use crate::defaults::*;
        Self {
            overlap_min: JUNCTION_DEFAULT_OVERLAP_MIN as i32,
            overlap_max: JUNCTION_DEFAULT_OVERLAP_MAX as i32,
            product_min: JUNCTION_DEFAULT_AMPLICON_MIN as i32,
            product_max: JUNCTION_DEFAULT_AMPLICON_MAX as i32,
            left_pad: JUNCTION_DEFAULT_LEFT_PAD as i32,
            right_pad: JUNCTION_DEFAULT_RIGHT_PAD as i32,
            max_candidates: JUNCTION_DEFAULT_MAX_CANDIDATES as usize,
        }
    }
}

fn clamp(v: i32, lo: i32, hi: i32) -> i32 {
    v.max(lo).min(hi)
}

pub fn design_junction_primer_pairs(
    backend: &dyn ThermoBackend,
    template: &str,
    junction_pos: i32,
    params: &JunctionParams,
    thermo: ThermoParams,
) -> Result<Vec<JunctionPair>, JunctionError> {
    let template = template.to_uppercase().replace(' ', "");
    let n_full = template.len() as i32;
    if n_full == 0 {
        return Err(JunctionError::EmptyTemplate);
    }
    if !(0 < junction_pos && junction_pos < n_full) {
        return Err(JunctionError::JunctionPosOutOfRange);
    }

    let primer_min = DEFAULT_PRIMER_SIZE.min_size as i32;
    let primer_max = DEFAULT_PRIMER_SIZE.max_size as i32;

    // "KEY FIX" in the Python source: widen the product-size range used
    // for the actual choose_primers call well beyond the caller's request,
    // since the strict range often finds nothing; the caller's original
    // product_min/product_max is still enforced later, in the manual
    // LEFT x RIGHT matching step below.
    let product_min_actual = (params.product_min - 50).max(50);
    let product_max_actual = (params.product_max + 300).min(1000);

    let win_start = clamp(junction_pos - params.left_pad, 0, n_full);
    let win_end = clamp(junction_pos + params.right_pad, 0, n_full);
    let local = &template[win_start as usize..win_end as usize];
    let j_local = junction_pos - win_start;
    let n = local.len() as i32;

    let mut candidates: Vec<(i32, i32)> = Vec::new();
    for left_ov in params.overlap_min..=params.overlap_max {
        for right_ov in params.overlap_min..=params.overlap_max {
            let l = left_ov + right_ov;
            if l < primer_min || l > primer_max {
                continue;
            }
            let start = j_local - left_ov;
            let end = j_local + right_ov;
            if start < 0 || end > n {
                continue;
            }
            candidates.push((start, end));
        }
    }
    if candidates.is_empty() {
        return Err(JunctionError::NoCandidatesInWindow);
    }

    let opt_tm = DEFAULT_PRIMER_TM.opt_tm;
    let mut scored: Vec<(f64, (i32, i32), PrimerAnalysis)> = candidates
        .into_iter()
        .map(|(start, end)| {
            let left_seq = &local[start as usize..end as usize];
            let a = analyze_primer(backend, left_seq, thermo);
            let tm = a.tm.unwrap_or(0.0);
            let gc = a.gc_percent.unwrap_or(0.0);
            let mut score = (tm - opt_tm).abs();
            if !(35.0..=65.0).contains(&gc) {
                score += 5.0;
            }
            (score, (start, end), a)
        })
        .collect();
    scored.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    scored.truncate(params.max_candidates);

    let right_region_start = j_local;
    let right_region_len = n - right_region_start;
    if right_region_len < primer_min {
        return Err(JunctionError::WindowTooSmallForRightPrimers);
    }

    let mut gs = GlobalSettings::new();
    gs.set_primer_size(DEFAULT_PRIMER_SIZE.opt_size as i32, primer_min, primer_max);
    gs.set_primer_tm(JUNCTION_PRIMER_TM.opt_tm, JUNCTION_PRIMER_TM.min_tm, JUNCTION_PRIMER_TM.max_tm);
    gs.set_primer_gc(JUNCTION_PRIMER_GC.min_gc, JUNCTION_PRIMER_GC.max_gc);
    gs.set_num_return(20);
    gs.set_pick_primers(false, true);
    gs.set_pick_internal_oligo(false);
    gs.set_product_size_range(product_min_actual, product_max_actual);

    let mut sa = SeqArgs::new(local)?;
    sa.set_included_region(right_region_start, right_region_len);
    let right_result = design_primers(&gs, &mut sa)?;

    if right_result.right_candidates.is_empty() {
        return Err(JunctionError::NoRightPrimersFound(right_result.right_explain.unwrap_or_default()));
    }

    let max_tm_diff = JUNCTION_MAX_TM_DIFF;
    let mut pairs_out: Vec<JunctionPair> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    'outer: for (_, (start, end), left_a) in &scored {
        let left_seq = &local[*start as usize..*end as usize];
        let left_tm = left_a.tm.unwrap_or(0.0);
        let left_interval_full = [win_start + start, win_start + end];

        for rc in &right_result.right_candidates {
            if (left_tm - rc.tm).abs() > max_tm_diff {
                continue;
            }
            let product_size = rc.end - start;
            if product_size < params.product_min || product_size > params.product_max {
                continue;
            }
            let key = (left_seq.to_string(), rc.sequence.clone(), product_size);
            if !seen.insert(key) {
                continue;
            }

            let right_interval_full = [win_start + rc.start, win_start + rc.end];
            let right_a = analyze_primer(backend, &rc.sequence, thermo);
            let pair_metrics = analyze_pair(backend, left_seq, &rc.sequence, thermo);

            pairs_out.push(JunctionPair {
                left: JunctionOligo { analysis: left_a.clone(), interval: left_interval_full },
                right: JunctionOligo { analysis: right_a, interval: right_interval_full },
                product_size,
                pair_metrics,
            });

            if pairs_out.len() >= 10 {
                break 'outer;
            }
        }
    }

    Ok(pairs_out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_primer3::Primer3Backend;

    #[test]
    fn finds_junction_spanning_pairs_around_a_realistic_junction() {
        let backend = Primer3Backend;
        let template = "ACGTGACCTGATCGATCGGATCGTAGCTAGCATGCA".repeat(30);
        let junction_pos = template.len() as i32 / 2;
        let params = JunctionParams::default();
        let pairs = design_junction_primer_pairs(&backend, &template, junction_pos, &params, ThermoParams::default()).unwrap();
        assert!(!pairs.is_empty());
        for p in &pairs {
            assert!(p.left.interval[0] < junction_pos && junction_pos < p.left.interval[1], "left primer must span the junction");
            assert!(p.product_size >= params.product_min && p.product_size <= params.product_max);
        }
    }

    #[test]
    fn rejects_junction_pos_out_of_range() {
        let backend = Primer3Backend;
        let template = "ACGT".repeat(50);
        let result = design_junction_primer_pairs(&backend, &template, 0, &JunctionParams::default(), ThermoParams::default());
        assert!(matches!(result, Err(JunctionError::JunctionPosOutOfRange)));
    }
}
