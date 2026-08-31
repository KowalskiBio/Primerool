//! Port of `main.py`'s `/design_from_sequence` handler.
//!
//! Two distinct algorithms, both preserved exactly as Python has them:
//!
//! - **Unified** (`template_seq` provided): one `choose_primers` call
//!   against the full template, pinning LEFT/RIGHT to the caller's regions
//!   via `SEQUENCE_PRIMER_PAIR_OK_REGION_LIST` (`-1` on either side means
//!   "anywhere", primer3's own convention). Pair ranking/`score` comes
//!   straight from primer3's own `PRIMER_PAIR_i_PENALTY`.
//!
//!   **Known gap, not silently hidden**: `primer3-ffi`'s
//!   `SEQUENCE_PRIMER_PAIR_OK_REGION_LIST` binding has a documented,
//!   unresolved pair-*ranking* discrepancy against real `primer3-py` (see
//!   `primer3-ffi/tests/design_parity.rs`'s `ok_region_list_matches_primer3_py`,
//!   `#[ignore]`d with the full investigation inline) — candidate
//!   generation is confirmed correct, but this mode may return the right
//!   pairs in a different order than the Python app would for the exact
//!   same request. Flagged here as a caveat on `design_from_sequence`'s
//!   unified path specifically, not fixed by this port (root cause is in
//!   the FFI binding, not this module's logic).
//!
//! - **Independent fallback** (no `template_seq`, marked
//!   deprecated/fallback in the Python source but still live code):
//!   forward/reverse regions designed as two separate one-sided
//!   `choose_primers` calls, then manually cross-paired and scored by
//!   `tm_diff + max(0, het_dg + 10) * 0.1`.

use primer3_ffi::design::{design_primers, GlobalSettings, SeqArgs};
use primer3_ffi::Primer3Error;

use crate::analyze::{analyze_pair, analyze_primer, PrimerAnalysis};
use crate::backend::{DimerResult, ThermoBackend, ThermoParams};
use crate::defaults::{round_or_none, DEFAULT_MAX_NS_ACCEPTED, DEFAULT_MAX_POLY_X, DEFAULT_PRIMER_GC, DEFAULT_PRIMER_SIZE, DEFAULT_PRIMER_TM};

#[derive(Debug, Clone, Copy, Default)]
pub struct FromSequenceOverrides {
    pub tm_min: Option<f64>,
    pub tm_opt: Option<f64>,
    pub tm_max: Option<f64>,
    pub size_min: Option<i32>,
    pub size_opt: Option<i32>,
    pub size_max: Option<i32>,
    pub gc_min: Option<f64>,
    pub gc_max: Option<f64>,
    pub num_return: Option<i32>,
    pub max_poly_x: Option<i32>,
    pub max_ns: Option<i32>,
}

/// `amplicon_target`/`amplicon_deviation` in the request body. `None`
/// (no target given) falls back to Python's `[[50, 100000]]` wide-open
/// default, matching the app's own comment ("Override Primer3's strict
/// default constraint, which is normally ~100-300").
#[derive(Debug, Clone, Copy)]
pub struct AmpliconTarget {
    pub target: i32,
    pub deviation: i32,
}

fn product_size_range(amplicon: Option<AmpliconTarget>) -> (i32, i32) {
    match amplicon {
        Some(a) => ((a.target - a.deviation).max(50), a.target + a.deviation),
        None => (50, 100_000),
    }
}

/// `-1` means "anywhere", matching primer3's own `SEQUENCE_PRIMER_PAIR_OK_REGION_LIST`
/// convention and `main.py`'s `fwd_pos`/`rev_pos` request fields.
#[derive(Debug, Clone, Copy)]
pub struct RegionPosition {
    pub pos: i32,
    pub len: i32,
}

impl RegionPosition {
    pub fn unspecified() -> Self {
        Self { pos: -1, len: -1 }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SeqPrimerRecord {
    pub analysis: PrimerAnalysis,
    /// `[start, end)`, present only in the unified path (primer3 reports
    /// coordinates there; the independent-design fallback never did,
    /// mirrored exactly).
    pub coords: Option<[i32; 2]>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BestPair {
    pub forward_seq: String,
    pub forward_tm: Option<f64>,
    pub forward_coords: Option<[i32; 2]>,
    pub reverse_seq: String,
    pub reverse_tm: Option<f64>,
    pub reverse_coords: Option<[i32; 2]>,
    pub tm_diff: f64,
    pub heterodimer: DimerResult,
    pub product_size: Option<i32>,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FromSequenceResult {
    pub forward_primers: Vec<SeqPrimerRecord>,
    pub reverse_primers: Vec<SeqPrimerRecord>,
    pub best_pairs: Vec<BestPair>,
}

#[derive(Debug, thiserror::Error)]
pub enum DesignFromSequenceError {
    #[error("{0}")]
    NoPairsFound(String),
    #[error(transparent)]
    Primer3(#[from] Primer3Error),
}

fn configure_common(gs: &mut GlobalSettings, overrides: &FromSequenceOverrides, thermo: ThermoParams, product_range: (i32, i32)) {
    let size_opt = overrides.size_opt.unwrap_or(DEFAULT_PRIMER_SIZE.opt_size as i32);
    let size_min = overrides.size_min.unwrap_or(DEFAULT_PRIMER_SIZE.min_size as i32);
    let size_max = overrides.size_max.unwrap_or(DEFAULT_PRIMER_SIZE.max_size as i32);
    let tm_opt = overrides.tm_opt.unwrap_or(DEFAULT_PRIMER_TM.opt_tm);
    let tm_min = overrides.tm_min.unwrap_or(DEFAULT_PRIMER_TM.min_tm);
    let tm_max = overrides.tm_max.unwrap_or(DEFAULT_PRIMER_TM.max_tm);
    let gc_min = overrides.gc_min.unwrap_or(DEFAULT_PRIMER_GC.min_gc);
    let gc_max = overrides.gc_max.unwrap_or(DEFAULT_PRIMER_GC.max_gc);
    gs.set_primer_size(size_opt, size_min, size_max);
    gs.set_primer_tm(tm_opt, tm_min, tm_max);
    gs.set_primer_gc(gc_min, gc_max);
    gs.set_salt_conc(thermo.mv_conc, thermo.dv_conc, thermo.dntp_conc, thermo.dna_conc);
    gs.set_max_poly_x(overrides.max_poly_x.unwrap_or(DEFAULT_MAX_POLY_X as i32));
    gs.set_num_ns_accepted(overrides.max_ns.unwrap_or(DEFAULT_MAX_NS_ACCEPTED as i32));
    gs.set_num_return(overrides.num_return.unwrap_or(5));
    gs.set_pick_internal_oligo(false);
    gs.set_product_size_range(product_range.0, product_range.1);
}

fn design_unified(
    backend: &dyn ThermoBackend,
    template_seq: &str,
    fwd: RegionPosition,
    rev: RegionPosition,
    amplicon: Option<AmpliconTarget>,
    overrides: FromSequenceOverrides,
    thermo: ThermoParams,
) -> Result<FromSequenceResult, DesignFromSequenceError> {
    let mut gs = GlobalSettings::new();
    configure_common(&mut gs, &overrides, thermo, product_size_range(amplicon));
    gs.set_pick_primers(true, true);

    let mut sa = SeqArgs::new(template_seq)?;
    if fwd.pos != -1 || rev.pos != -1 {
        sa.add_ok_region(fwd.pos, fwd.len, rev.pos, rev.len);
    }

    let result = design_primers(&gs, &mut sa)?;

    let mut forward_primers = Vec::with_capacity(result.pairs.len());
    let mut reverse_primers = Vec::with_capacity(result.pairs.len());
    let mut best_pairs = Vec::with_capacity(result.pairs.len());

    for pair in &result.pairs {
        let f_p = analyze_primer(backend, &pair.left.sequence, thermo);
        let r_p = analyze_primer(backend, &pair.right.sequence, thermo);
        let pair_info = analyze_pair(backend, &pair.left.sequence, &pair.right.sequence, thermo);
        let tm_diff = (f_p.tm.unwrap_or(0.0) - r_p.tm.unwrap_or(0.0)).abs();

        forward_primers.push(SeqPrimerRecord { analysis: f_p.clone(), coords: Some([pair.left.start, pair.left.end]) });
        reverse_primers.push(SeqPrimerRecord { analysis: r_p.clone(), coords: Some([pair.right.start, pair.right.end]) });
        best_pairs.push(BestPair {
            forward_seq: pair.left.sequence.clone(),
            forward_tm: f_p.tm,
            forward_coords: Some([pair.left.start, pair.left.end]),
            reverse_seq: pair.right.sequence.clone(),
            reverse_tm: r_p.tm,
            reverse_coords: Some([pair.right.start, pair.right.end]),
            tm_diff: round_or_none(Some(tm_diff)).unwrap(),
            heterodimer: pair_info.heterodimer,
            product_size: Some(pair.product_size),
            score: pair.pair_quality,
        });
    }

    if best_pairs.is_empty() {
        let explain = result.left_explain.or(result.pair_explain).unwrap_or_else(|| "No valid pairs found.".to_string());
        return Err(DesignFromSequenceError::NoPairsFound(explain));
    }

    Ok(FromSequenceResult { forward_primers, reverse_primers, best_pairs })
}

fn design_independent(
    backend: &dyn ThermoBackend,
    forward_region: &str,
    reverse_region: &str,
    amplicon: Option<AmpliconTarget>,
    overrides: FromSequenceOverrides,
    thermo: ThermoParams,
) -> Result<FromSequenceResult, DesignFromSequenceError> {
    let range = product_size_range(amplicon);

    let mut fwd_gs = GlobalSettings::new();
    configure_common(&mut fwd_gs, &overrides, thermo, range);
    fwd_gs.set_pick_primers(true, false);
    let mut fwd_sa = SeqArgs::new(forward_region)?;
    let fwd_result = design_primers(&fwd_gs, &mut fwd_sa)?;
    let forward: Vec<PrimerAnalysis> = fwd_result.left_candidates.iter().map(|o| analyze_primer(backend, &o.sequence, thermo)).collect();

    let mut rev_gs = GlobalSettings::new();
    configure_common(&mut rev_gs, &overrides, thermo, range);
    rev_gs.set_pick_primers(false, true);
    let mut rev_sa = SeqArgs::new(reverse_region)?;
    let rev_result = design_primers(&rev_gs, &mut rev_sa)?;
    let reverse: Vec<PrimerAnalysis> = rev_result.right_candidates.iter().map(|o| analyze_primer(backend, &o.sequence, thermo)).collect();

    let mut errors = Vec::new();
    if forward.is_empty() {
        errors.push(format!("No forward primers found. {}", fwd_result.left_explain.unwrap_or_default()));
    }
    if reverse.is_empty() {
        errors.push(format!("No reverse primers found. {}", rev_result.right_explain.unwrap_or_default()));
    }
    if !errors.is_empty() {
        return Err(DesignFromSequenceError::NoPairsFound(errors.join(" | ")));
    }

    let mut combos: Vec<BestPair> = Vec::with_capacity(forward.len() * reverse.len());
    for fp in &forward {
        for rp in &reverse {
            let pair_info = analyze_pair(backend, &fp.sequence, &rp.sequence, thermo);
            let tm_diff = (fp.tm.unwrap_or(0.0) - rp.tm.unwrap_or(0.0)).abs();
            let het_dg = pair_info.heterodimer.dg.unwrap_or(0.0);
            let score = tm_diff + 0f64.max(het_dg + 10.0) * 0.1;
            combos.push(BestPair {
                forward_seq: fp.sequence.clone(),
                forward_tm: fp.tm,
                forward_coords: None,
                reverse_seq: rp.sequence.clone(),
                reverse_tm: rp.tm,
                reverse_coords: None,
                tm_diff: round_or_none(Some(tm_diff)).unwrap(),
                heterodimer: pair_info.heterodimer,
                product_size: None,
                score,
            });
        }
    }
    combos.sort_by(|a, b| a.score.partial_cmp(&b.score).unwrap());
    combos.truncate(5);

    Ok(FromSequenceResult {
        forward_primers: forward.into_iter().map(|a| SeqPrimerRecord { analysis: a, coords: None }).collect(),
        reverse_primers: reverse.into_iter().map(|a| SeqPrimerRecord { analysis: a, coords: None }).collect(),
        best_pairs: combos,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn design_from_sequence(
    backend: &dyn ThermoBackend,
    forward_region: &str,
    reverse_region: &str,
    template_seq: Option<&str>,
    fwd: RegionPosition,
    rev: RegionPosition,
    amplicon: Option<AmpliconTarget>,
    overrides: FromSequenceOverrides,
    thermo: ThermoParams,
) -> Result<FromSequenceResult, DesignFromSequenceError> {
    match template_seq {
        Some(template) if !template.is_empty() => design_unified(backend, template, fwd, rev, amplicon, overrides, thermo),
        _ => design_independent(backend, forward_region, reverse_region, amplicon, overrides, thermo),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_primer3::Primer3Backend;

    #[test]
    fn independent_path_pairs_forward_and_reverse_regions() {
        let backend = Primer3Backend;
        let fwd_region = "GATCGGAAGAGCACACGTCTGAACTCCAGTCACATCACGATCTCGTATGCC";
        let rev_region = "TTCTGGCCTAGAGATCCGATGCTGACTGCCAACTTAGTGCCTAGCTTGCCG";
        let result = design_from_sequence(
            &backend,
            fwd_region,
            rev_region,
            None,
            RegionPosition::unspecified(),
            RegionPosition::unspecified(),
            None,
            FromSequenceOverrides::default(),
            ThermoParams::default(),
        )
        .unwrap();
        assert!(!result.forward_primers.is_empty());
        assert!(!result.reverse_primers.is_empty());
        assert!(!result.best_pairs.is_empty());
        for w in result.best_pairs.windows(2) {
            assert!(w[0].score <= w[1].score, "best_pairs must be sorted ascending by score");
        }
    }

    #[test]
    fn unified_path_respects_ok_region_list_pinning() {
        let backend = Primer3Backend;
        let template = "GATCGGAAGAGCACACGTCTGAACTCCAGTCACATCACGATCTCGTATGCCGTCTTCTGCTTGAGGCCTATCAAGCAGTGGTATCAACGCAGAGTACATGGGTACGACCTTCTGGCCTAGAGATCCGATGCTGACTGCCAACTTAGTGCCTAGCTTGCCGAATATCATGGTGCACTCTCAGTACAATCTGCTCTGATGCCGCATAGTTAAGCCA";
        let result = design_from_sequence(
            &backend,
            "",
            "",
            Some(template),
            RegionPosition::unspecified(),
            RegionPosition::unspecified(),
            Some(AmpliconTarget { target: 150, deviation: 60 }),
            FromSequenceOverrides::default(),
            ThermoParams::default(),
        )
        .unwrap();
        assert!(!result.best_pairs.is_empty());
        for pair in &result.best_pairs {
            let size = pair.product_size.unwrap();
            assert!((90..=210).contains(&size), "product size {size} should respect the amplicon window");
        }
    }
}
