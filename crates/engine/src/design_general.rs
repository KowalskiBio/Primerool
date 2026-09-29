//! General PCR primer design (`/design_primers`, `mode: "general"`): the
//! best primer pairs anywhere in a sequence, with nothing asked of the
//! user. Best means matched Tm first, then as little hairpin, self-dimer
//! and heterodimer structure as possible, within the app's usual size, Tm
//! and GC limits.
//!
//! The whole-sequence search can't simply pick the best N primers per
//! strand and pair them: on a 100 kb gene with introns, the individually
//! best primers are scattered, and almost none sit within amplicon distance
//! of each other. So the sequence is cut into `BIN`-sized stretches, the
//! best few candidates per strand are kept in every stretch, and pairs are
//! only formed between candidates close enough for the product-size range.
//!
//! Hairpins, self-dimers and heterodimers melting above
//! `DEFAULT_MAX_*_TM` are still rejected outright (the picker's hard
//! filters); below that they cost a soft penalty, so a structure-free pair
//! wins over one that merely passes.

use rayon::prelude::*;

use crate::backend::{DimerResult, ThermoBackend, ThermoParams};
use crate::defaults::{DEFAULT_MAX_PAIR_DIMER_TM, DEFAULT_PRIMER_GC, DEFAULT_PRIMER_SIZE, DEFAULT_PRIMER_TM};
use crate::picker::{pick_oligos, scan_candidates, Candidate, CandidateConstraints, GcRange, OligoFilters, PenaltyWeights, ScoredCandidate, ScoredPair, SizeRange, Strand, TmRange};

/// Product sizes a general PCR pair may span.
pub const PRODUCT_SIZE_RANGE: (usize, usize) = (100, 1000);
const NUM_RETURN: usize = 5;

/// Stretch length (bp) the sequence is cut into, and how many candidates
/// per strand each stretch keeps. Small enough stretches that every region
/// of the gene gets its own local best, not just the gene's global best.
const BIN: usize = 200;
const KEEP_PER_BIN: usize = 4;

/// Weight on |ΔTm| between the two primers; the dominant pair criterion.
const TM_DIFF_WEIGHT: f64 = 2.0;

/// A structure melting below this (°C) is harmless at annealing
/// temperatures and costs nothing; each degree above it costs
/// `STRUCTURE_WEIGHT` penalty points (a degree of Tm off the optimum costs 1).
const STRUCTURE_FREE_TM: f64 = 30.0;
const STRUCTURE_WEIGHT: f64 = 0.25;

/// How many Tm-ranked pairs get the heterodimer DP before the final
/// ranking. The DP is the costly step; the Tm ranking already puts the
/// strong contenders first.
const HETERODIMER_POOL: usize = 400;

fn structure_penalty(r: &DimerResult) -> f64 {
    r.tm.map_or(0.0, |tm| (tm - STRUCTURE_FREE_TM).max(0.0) * STRUCTURE_WEIGHT)
}

fn oligo_score(o: &ScoredCandidate) -> f64 {
    o.penalty + structure_penalty(&o.hairpin) + structure_penalty(&o.self_dimer)
}

#[derive(Debug, Clone, PartialEq)]
pub struct GeneralDesignResult {
    /// Best first; no two pairs share a primer.
    pub pairs: Vec<ScoredPair>,
    /// Why nothing was found, when `pairs` is empty.
    pub explain: String,
}

/// The best candidates of `strand` in every `BIN`-bp stretch of `sequence`.
fn pick_per_bin(backend: &dyn ThermoBackend, sequence: &str, candidates: &[Candidate], strand: Strand, constraints: &CandidateConstraints, thermo: ThermoParams) -> Vec<ScoredCandidate> {
    let bins = sequence.len().div_ceil(BIN);
    let mut by_bin: Vec<Vec<Candidate>> = vec![Vec::new(); bins];
    for c in candidates {
        by_bin[c.start / BIN].push(*c);
    }
    let filters = OligoFilters::default();
    let weights = PenaltyWeights::default();
    let mut picked: Vec<ScoredCandidate> = by_bin
        .par_iter()
        .flat_map_iter(|bin| pick_oligos(backend, sequence, bin, strand, constraints, &filters, thermo, &weights, KEEP_PER_BIN).oligos)
        .collect();
    picked.sort_by_key(|o| o.candidate.start);
    picked
}

pub fn design_best_pairs(backend: &dyn ThermoBackend, sequence: &str, thermo: ThermoParams) -> GeneralDesignResult {
    let sequence = sequence.to_uppercase().replace(' ', "");
    let constraints = CandidateConstraints {
        size: SizeRange { min: DEFAULT_PRIMER_SIZE.min_size as usize, opt: DEFAULT_PRIMER_SIZE.opt_size as usize, max: DEFAULT_PRIMER_SIZE.max_size as usize },
        tm: TmRange { min: DEFAULT_PRIMER_TM.min_tm, opt: DEFAULT_PRIMER_TM.opt_tm, max: DEFAULT_PRIMER_TM.max_tm },
        gc: GcRange { min: DEFAULT_PRIMER_GC.min_gc, max: DEFAULT_PRIMER_GC.max_gc },
    };
    let (min_product, max_product) = PRODUCT_SIZE_RANGE;
    if sequence.len() < min_product {
        return GeneralDesignResult { pairs: Vec::new(), explain: format!("sequence is {} bp, shorter than the {min_product} bp minimum product", sequence.len()) };
    }

    let candidates = scan_candidates(&sequence, &constraints);
    let left = pick_per_bin(backend, &sequence, &candidates, Strand::Forward, &constraints, thermo);
    let right = pick_per_bin(backend, &sequence, &candidates, Strand::Reverse, &constraints, thermo);
    if left.is_empty() || right.is_empty() {
        let side = if left.is_empty() { "forward" } else { "reverse" };
        return GeneralDesignResult { pairs: Vec::new(), explain: format!("no {side} primer passes the Tm, GC, poly-X, hairpin and self-dimer limits") };
    }

    // Every left/right combination in product-size range, ranked on the
    // cheap terms. `right` is sorted by start, so each left only scans the
    // rights that can close a product with it.
    let mut ranked: Vec<(f64, usize, usize, usize)> = Vec::new();
    for (li, l) in left.iter().enumerate() {
        let first = right.partition_point(|r| r.candidate.start < l.candidate.end);
        for (ri, r) in right.iter().enumerate().skip(first) {
            if r.candidate.start >= l.candidate.start + max_product {
                break;
            }
            let product = r.candidate.end - l.candidate.start;
            if product < min_product || product > max_product {
                continue;
            }
            let penalty = oligo_score(l) + oligo_score(r) + TM_DIFF_WEIGHT * (l.tm - r.tm).abs();
            ranked.push((penalty, li, ri, product));
        }
    }
    if ranked.is_empty() {
        return GeneralDesignResult { pairs: Vec::new(), explain: format!("no forward/reverse primers close enough for a {min_product}-{max_product} bp product") };
    }
    ranked.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    ranked.truncate(HETERODIMER_POOL);

    let mut scored: Vec<ScoredPair> = ranked
        .par_iter()
        .filter_map(|&(penalty, li, ri, product_size)| {
            let heterodimer = backend.calc_heterodimer(&left[li].sequence, &right[ri].sequence, thermo);
            if heterodimer.tm.is_some_and(|tm| tm > DEFAULT_MAX_PAIR_DIMER_TM) {
                return None;
            }
            let penalty = penalty + structure_penalty(&heterodimer);
            Some(ScoredPair { left: left[li].clone(), right: right[ri].clone(), product_size, heterodimer, penalty })
        })
        .collect();
    scored.sort_by(|a, b| a.penalty.partial_cmp(&b.penalty).unwrap());

    // Distinct alternatives: a pair reusing a primer already returned is
    // just a shifted copy of a better pair.
    let mut pairs: Vec<ScoredPair> = Vec::new();
    for p in scored {
        if pairs.len() >= NUM_RETURN {
            break;
        }
        if pairs.iter().any(|q| q.left.candidate == p.left.candidate || q.right.candidate == p.right.candidate) {
            continue;
        }
        pairs.push(p);
    }
    let explain = if pairs.is_empty() { "every close-enough pair forms a heterodimer above the limit".to_string() } else { String::new() };
    GeneralDesignResult { pairs, explain }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_native::NativeBackend;

    const TEMPLATE: &str = "GATCGGAAGAGCACACGTCTGAACTCCAGTCACATCACGATCTCGTATGCCGTCTTCTGCTTGAAAAAAAAAAAA\
                GGCCTATCAAGCAGTGGTATCAACGCAGAGTACATGGGTACGACCTTCTGGCCTAGAGATCCGATGCTGACTGCC\
                AACTTAGTGCCTAGCTTGCCGAATATCATGGTGCACTCTCAGTACAATCTGCTCTGATGCCGCATAGTTAAGCCA";

    #[test]
    fn finds_ranked_distinct_pairs_without_any_target() {
        let result = design_best_pairs(&NativeBackend, TEMPLATE, ThermoParams::default());
        assert!(!result.pairs.is_empty(), "{}", result.explain);
        for p in &result.pairs {
            assert!(p.right.candidate.start >= p.left.candidate.end, "primers must not overlap");
            assert_eq!(p.product_size, p.right.candidate.end - p.left.candidate.start);
            assert!((PRODUCT_SIZE_RANGE.0..=PRODUCT_SIZE_RANGE.1).contains(&p.product_size));
            assert!(p.heterodimer.tm.is_none_or(|tm| tm <= DEFAULT_MAX_PAIR_DIMER_TM));
            assert_eq!(p.right.sequence, thermo_core::reverse_complement(&TEMPLATE[p.right.candidate.start..p.right.candidate.end]));
        }
        for w in result.pairs.windows(2) {
            assert!(w[0].penalty <= w[1].penalty, "pairs must be ranked best first");
        }
        for (i, a) in result.pairs.iter().enumerate() {
            for b in &result.pairs[i + 1..] {
                assert!(a.left.candidate != b.left.candidate && a.right.candidate != b.right.candidate, "pairs must not share a primer");
            }
        }
    }

    #[test]
    fn best_pair_has_closely_matched_tm() {
        let result = design_best_pairs(&NativeBackend, TEMPLATE, ThermoParams::default());
        let best = &result.pairs[0];
        assert!((best.left.tm - best.right.tm).abs() < 2.0, "ΔTm {:.2}", (best.left.tm - best.right.tm).abs());
    }

    #[test]
    fn pairs_come_from_anywhere_in_a_long_sequence() {
        // A long template whose only primable stretch sits at the far end:
        // a global top-N pick would never reach it.
        let filler = "A".repeat(5000);
        let seq = format!("{filler}{TEMPLATE}");
        let result = design_best_pairs(&NativeBackend, &seq, ThermoParams::default());
        assert!(!result.pairs.is_empty(), "{}", result.explain);
        // A primer may start up to `max_poly_x` bases into the filler.
        let reach = filler.len() - crate::defaults::DEFAULT_MAX_POLY_X as usize;
        assert!(result.pairs.iter().all(|p| p.left.candidate.start >= reach));
    }

    #[test]
    fn too_short_sequence_explains_itself() {
        let result = design_best_pairs(&NativeBackend, "ACGTACGTACGTACGTACGTACGT", ThermoParams::default());
        assert!(result.pairs.is_empty());
        assert!(result.explain.contains("shorter than"), "{}", result.explain);
    }
}
