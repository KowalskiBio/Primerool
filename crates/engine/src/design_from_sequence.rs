//! Primer design from user-supplied regions (`/design_from_sequence`).
//!
//! - **Unified** (`template_seq` provided): LEFT primers picked inside the
//!   forward region and RIGHT primers inside the reverse region of the one
//!   template (`-1` on either side means "anywhere"), then paired by
//!   `picker::pick_pairs`; `score` is the pair penalty.
//!
//! - **Independent fallback** (no `template_seq`): forward/reverse regions
//!   picked as two separate sequences, then cross-paired and scored by
//!   `tm_diff + max(0, het_dg + 10) * 0.1`.

use crate::analyze::{analyze_pair, analyze_primer, PrimerAnalysis};
use crate::backend::{DimerResult, ThermoBackend, ThermoParams};
use crate::defaults::{round_or_none, DEFAULT_MAX_NS_ACCEPTED, DEFAULT_MAX_POLY_X, DEFAULT_PRIMER_GC, DEFAULT_PRIMER_SIZE, DEFAULT_PRIMER_TM};
use crate::design_internal::MAX_POOL_FOR_PAIRING;
use crate::picker::{in_region, pick_in_region, pick_oligos, pick_pairs, scan_candidates, CandidateConstraints, GcRange, OligoFilters, PairWeights, PenaltyWeights, SizeRange, Strand, TmRange};

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
/// (no target given) allows any product from 50 bp to 100 kb.
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

/// A region of the template a primer must lie in; `-1` means "anywhere"
/// (the `fwd_pos`/`rev_pos` request fields' convention).
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
    /// `[start, end)`, present only in the unified path (the independent
    /// fallback has no shared template to place primers on).
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
}

const NUM_RETURN: i32 = 5;

fn picking_setup(overrides: &FromSequenceOverrides) -> (CandidateConstraints, OligoFilters) {
    let size = |v: Option<i32>, d: u32| v.map(|x| x.max(1) as usize).unwrap_or(d as usize);
    let constraints = CandidateConstraints {
        size: SizeRange {
            min: size(overrides.size_min, DEFAULT_PRIMER_SIZE.min_size),
            opt: size(overrides.size_opt, DEFAULT_PRIMER_SIZE.opt_size),
            max: size(overrides.size_max, DEFAULT_PRIMER_SIZE.max_size),
        },
        tm: TmRange {
            min: overrides.tm_min.unwrap_or(DEFAULT_PRIMER_TM.min_tm),
            opt: overrides.tm_opt.unwrap_or(DEFAULT_PRIMER_TM.opt_tm),
            max: overrides.tm_max.unwrap_or(DEFAULT_PRIMER_TM.max_tm),
        },
        gc: GcRange { min: overrides.gc_min.unwrap_or(DEFAULT_PRIMER_GC.min_gc), max: overrides.gc_max.unwrap_or(DEFAULT_PRIMER_GC.max_gc) },
    };
    let filters = OligoFilters {
        max_poly_x: overrides.max_poly_x.unwrap_or(DEFAULT_MAX_POLY_X as i32).max(1) as usize,
        max_ns: overrides.max_ns.unwrap_or(DEFAULT_MAX_NS_ACCEPTED as i32).max(0) as usize,
        ..OligoFilters::default()
    };
    (constraints, filters)
}

fn num_return(overrides: &FromSequenceOverrides) -> usize {
    overrides.num_return.unwrap_or(NUM_RETURN).max(1) as usize
}

/// `[start, end)` of `region` clamped to a template of length `len`;
/// `pos == -1` means the whole template.
fn region_bounds(region: RegionPosition, len: usize) -> (usize, usize) {
    if region.pos < 0 {
        return (0, len);
    }
    let start = (region.pos as usize).min(len);
    let end = if region.len < 0 { len } else { (start + region.len as usize).min(len) };
    (start, end)
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
    let template = template_seq.to_uppercase();
    let (constraints, filters) = picking_setup(&overrides);
    let range = product_size_range(amplicon);

    let all = scan_candidates(&template, &constraints);
    let (fs, fe) = region_bounds(fwd, template.len());
    let (rs, re) = region_bounds(rev, template.len());
    let weights = PenaltyWeights::default();
    let left = pick_oligos(backend, &template, &in_region(&all, fs, fe), Strand::Forward, &constraints, &filters, thermo, &weights, MAX_POOL_FOR_PAIRING);
    let right = pick_oligos(backend, &template, &in_region(&all, rs, re), Strand::Reverse, &constraints, &filters, thermo, &weights, MAX_POOL_FOR_PAIRING);
    let picked = pick_pairs(backend, &left.oligos, &right.oligos, (range.0.max(0) as usize, range.1.max(0) as usize), thermo, &PairWeights::default(), num_return(&overrides));

    if picked.pairs.is_empty() {
        let explain = if left.oligos.is_empty() {
            format!("Forward: {}", left.explain())
        } else if right.oligos.is_empty() {
            format!("Reverse: {}", right.explain())
        } else {
            format!("Pairs: {}", picked.explain())
        };
        return Err(DesignFromSequenceError::NoPairsFound(explain));
    }

    let mut forward_primers = Vec::with_capacity(picked.pairs.len());
    let mut reverse_primers = Vec::with_capacity(picked.pairs.len());
    let mut best_pairs = Vec::with_capacity(picked.pairs.len());

    for pair in &picked.pairs {
        let (l, r) = (&pair.left, &pair.right);
        let f_p = analyze_primer(backend, &l.sequence, thermo);
        let r_p = analyze_primer(backend, &r.sequence, thermo);
        let pair_info = analyze_pair(backend, &l.sequence, &r.sequence, thermo);
        let tm_diff = (f_p.tm.unwrap_or(0.0) - r_p.tm.unwrap_or(0.0)).abs();
        let f_coords = [l.candidate.start as i32, l.candidate.end as i32];
        let r_coords = [r.candidate.start as i32, r.candidate.end as i32];

        forward_primers.push(SeqPrimerRecord { analysis: f_p.clone(), coords: Some(f_coords) });
        reverse_primers.push(SeqPrimerRecord { analysis: r_p.clone(), coords: Some(r_coords) });
        best_pairs.push(BestPair {
            forward_seq: l.sequence.clone(),
            forward_tm: f_p.tm,
            forward_coords: Some(f_coords),
            reverse_seq: r.sequence.clone(),
            reverse_tm: r_p.tm,
            reverse_coords: Some(r_coords),
            tm_diff: round_or_none(Some(tm_diff)).unwrap(),
            heterodimer: pair_info.heterodimer,
            product_size: Some(pair.product_size as i32),
            score: pair.penalty,
        });
    }

    Ok(FromSequenceResult { forward_primers, reverse_primers, best_pairs })
}

fn design_independent(
    backend: &dyn ThermoBackend,
    forward_region: &str,
    reverse_region: &str,
    overrides: FromSequenceOverrides,
    thermo: ThermoParams,
) -> Result<FromSequenceResult, DesignFromSequenceError> {
    let (constraints, filters) = picking_setup(&overrides);
    let keep = num_return(&overrides);
    let fwd_seq = forward_region.to_uppercase();
    let rev_seq = reverse_region.to_uppercase();

    let fwd_pick = pick_in_region(backend, &fwd_seq, (0, fwd_seq.len()), Strand::Forward, &constraints, &filters, thermo, keep);
    let rev_pick = pick_in_region(backend, &rev_seq, (0, rev_seq.len()), Strand::Reverse, &constraints, &filters, thermo, keep);
    let forward: Vec<PrimerAnalysis> = fwd_pick.oligos.iter().map(|o| analyze_primer(backend, &o.sequence, thermo)).collect();
    let reverse: Vec<PrimerAnalysis> = rev_pick.oligos.iter().map(|o| analyze_primer(backend, &o.sequence, thermo)).collect();

    let mut errors = Vec::new();
    if forward.is_empty() {
        errors.push(format!("No forward primers found. {}", fwd_pick.explain()));
    }
    if reverse.is_empty() {
        errors.push(format!("No reverse primers found. {}", rev_pick.explain()));
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
        _ => design_independent(backend, forward_region, reverse_region, overrides, thermo),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_native::NativeBackend;

    #[test]
    fn independent_path_pairs_forward_and_reverse_regions() {
        let backend = NativeBackend;
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
        let backend = NativeBackend;
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
