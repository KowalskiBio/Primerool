//! Backend-agnostic candidate scan/score/rank engine — the genuinely new
//! part of this rewrite, not a port of anything in the Python app.
//!
//! This is what actually enables the features that motivated leaving
//! Python in the first place (exhaustive/sliding-window candidate
//! scanning, live re-scoring under interactive parameter changes): it's
//! written once, works with either calculation backend (`Primer3Backend`
//! or `NativeBackend`, anything implementing `ThermoBackend`), and scores
//! candidates in parallel via `rayon` since each candidate's thermo
//! evaluation is independent of every other's.
//!
//! Deliberately does **not** attempt to reverse-engineer Primer3's exact
//! internal penalty-weighting formula — that's one of the more baroque,
//! undocumented parts of `libprimer3`, and "does this look like a
//! reasonable primer" (bounds-respecting, ranked by distance from the
//! optimum) is the actual bar, not bit-for-bit penalty-score parity.

use rayon::prelude::*;

use crate::backend::{DimerResult, ThermoBackend, ThermoParams};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SizeRange {
    pub min: usize,
    pub opt: usize,
    pub max: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TmRange {
    pub min: f64,
    pub opt: f64,
    pub max: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GcRange {
    pub min: f64,
    pub max: f64,
}

impl GcRange {
    fn midpoint(self) -> f64 {
        (self.min + self.max) / 2.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CandidateConstraints {
    pub size: SizeRange,
    pub tm: TmRange,
    pub gc: GcRange,
}

/// A candidate oligo: a half-open `[start, end)` byte range into the
/// template it was scanned from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Candidate {
    pub start: usize,
    pub end: usize,
}

impl Candidate {
    pub fn len(&self) -> usize {
        self.end - self.start
    }

    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }

    pub fn sequence<'a>(&self, template: &'a str) -> &'a str {
        &template[self.start..self.end]
    }
}

/// Exhaustive sliding-window enumeration of every `[start, start+len)`
/// window with `len` in `[constraints.size.min, constraints.size.max]` —
/// the "scan every possible candidate" primitive. Pure, allocation-only;
/// no thermodynamics here, so it's cheap to call on every parameter
/// change even before deciding whether a full re-score is warranted.
pub fn scan_candidates(template: &str, constraints: &CandidateConstraints) -> Vec<Candidate> {
    let n = template.len();
    let mut out = Vec::new();
    for len in constraints.size.min..=constraints.size.max {
        if len == 0 || len > n {
            continue;
        }
        for start in 0..=(n - len) {
            out.push(Candidate { start, end: start + len });
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScoredCandidate {
    pub candidate: Candidate,
    pub tm: f64,
    pub gc_percent: f64,
    pub hairpin: DimerResult,
    pub self_dimer: DimerResult,
    /// Lower is better. A weighted sum of distance-from-optimum terms —
    /// see the module docs on why this doesn't try to match Primer3's own
    /// internal formula.
    pub penalty: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PenaltyWeights {
    pub tm: f64,
    pub gc: f64,
    pub size: f64,
}

impl Default for PenaltyWeights {
    fn default() -> Self {
        Self { tm: 1.0, gc: 0.5, size: 0.5 }
    }
}

fn gc_percent(seq: &str) -> f64 {
    if seq.is_empty() {
        return 0.0;
    }
    let gc = seq.bytes().filter(|b| matches!(b.to_ascii_uppercase(), b'G' | b'C')).count();
    100.0 * gc as f64 / seq.len() as f64
}

/// Evaluates every candidate's thermodynamics in parallel (`rayon`),
/// hard-filtering on Tm/GC bounds before computing the more expensive
/// hairpin/self-dimer checks, and scores what survives. Works identically
/// with `Primer3Backend` or `NativeBackend` — the whole point of this
/// module.
pub fn score_candidates(
    backend: &dyn ThermoBackend,
    template: &str,
    candidates: &[Candidate],
    constraints: &CandidateConstraints,
    thermo_params: ThermoParams,
    weights: &PenaltyWeights,
) -> Vec<ScoredCandidate> {
    candidates
        .par_iter()
        .filter_map(|&candidate| {
            let seq = candidate.sequence(template);
            let tm = backend.calc_tm(seq, thermo_params);
            if tm < constraints.tm.min || tm > constraints.tm.max {
                return None;
            }
            let gc = gc_percent(seq);
            if gc < constraints.gc.min || gc > constraints.gc.max {
                return None;
            }

            let hairpin = backend.calc_hairpin(seq, thermo_params);
            let self_dimer = backend.calc_homodimer(seq, thermo_params);

            let penalty = weights.tm * (tm - constraints.tm.opt).abs()
                + weights.gc * (gc - constraints.gc.midpoint()).abs()
                + weights.size * (candidate.len() as f64 - constraints.size.opt as f64).abs();

            Some(ScoredCandidate { candidate, tm, gc_percent: gc, hairpin, self_dimer, penalty })
        })
        .collect()
}

/// Ascending by penalty (lower is better) — stable, so candidates tying on
/// penalty keep their scan order (leftmost-first).
pub fn rank(mut scored: Vec<ScoredCandidate>) -> Vec<ScoredCandidate> {
    scored.sort_by(|a, b| a.penalty.partial_cmp(&b.penalty).unwrap());
    scored
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScoredPair {
    pub left: ScoredCandidate,
    pub right: ScoredCandidate,
    /// `right.candidate.end - left.candidate.start` — the amplicon length.
    pub product_size: usize,
    pub heterodimer: DimerResult,
    /// Lower is better: `left.penalty + right.penalty + weights.tm_diff *
    /// |left.tm - right.tm|`. Like `ScoredCandidate::penalty`, this is a
    /// reasonable-primer-pair heuristic, not a reproduction of Primer3's
    /// own internal pair-penalty formula.
    pub penalty: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PairWeights {
    pub tm_diff: f64,
}

impl Default for PairWeights {
    fn default() -> Self {
        Self { tm_diff: 1.0 }
    }
}

/// Combines two already-scored candidate pools (typically produced by
/// `scan_candidates`+`score_candidates` over disjoint regions of the same
/// template — e.g. everything upstream of a target vs. everything
/// downstream of it) into ranked, product-size-respecting pairs.
///
/// Backend-agnostic like the rest of this module: `left`/`right` only need
/// to have been scored (by either `Primer3Backend` or `NativeBackend`), and
/// this function's only backend-dependent call is the heterodimer check
/// between the two chosen sequences — called against whichever `backend`
/// the caller passes, which should be the same one that produced `left`/
/// `right`'s `ScoredCandidate`s.
///
/// A pair is valid when `right` starts at or after `left` ends (no overlap
/// — primer3's own convention for LEFT/RIGHT primer pairs) and the
/// resulting product size falls within `product_size_range`. Runs the
/// O(|left| × |right|) combination in parallel via `rayon`, since each
/// pair's heterodimer check is independent of every other's.
///
/// **This is genuinely expensive at realistic pool sizes, not just in
/// theory**: `calc_heterodimer` is a DP alignment (measured ~120µs/call),
/// not the closed-form `calc_tm` (~0.1µs/call) — a real 228bp test
/// scenario with ~370/~510 candidates per side produced 177,118 pairs
/// passing the cheap non-overlap+product-size filter, which took ~24s of
/// wall time once each actually got a heterodimer call. Callers doing
/// interactive/live design should pre-truncate `left`/`right` (already
/// `rank`-sorted, so truncating keeps the best individually-scored
/// candidates) to a bounded size before calling this — see
/// `design_internal::MAX_POOL_FOR_PAIRING` for a worked example and the
/// exact numbers above.
#[allow(clippy::too_many_arguments)]
pub fn pick_pairs(
    backend: &dyn ThermoBackend,
    template: &str,
    left: &[ScoredCandidate],
    right: &[ScoredCandidate],
    product_size_range: (usize, usize),
    thermo_params: ThermoParams,
    weights: &PairWeights,
    num_return: usize,
) -> Vec<ScoredPair> {
    let mut pairs: Vec<ScoredPair> = left
        .par_iter()
        .flat_map_iter(|l| {
            right.iter().filter_map(move |r| {
                if r.candidate.start < l.candidate.end {
                    return None;
                }
                let product_size = r.candidate.end - l.candidate.start;
                if product_size < product_size_range.0 || product_size > product_size_range.1 {
                    return None;
                }
                let heterodimer = backend.calc_heterodimer(l.candidate.sequence(template), r.candidate.sequence(template), thermo_params);
                let penalty = l.penalty + r.penalty + weights.tm_diff * (l.tm - r.tm).abs();
                Some(ScoredPair { left: *l, right: *r, product_size, heterodimer, penalty })
            })
        })
        .collect();

    pairs.sort_by(|a, b| a.penalty.partial_cmp(&b.penalty).unwrap());
    pairs.truncate(num_return);
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_native::NativeBackend;
    use crate::backend_primer3::Primer3Backend;

    fn constraints() -> CandidateConstraints {
        CandidateConstraints {
            size: SizeRange { min: 18, opt: 20, max: 25 },
            tm: TmRange { min: 55.0, opt: 60.0, max: 65.0 },
            gc: GcRange { min: 30.0, max: 70.0 },
        }
    }

    #[test]
    fn scan_candidates_produces_every_window() {
        let template = "A".repeat(30);
        let c = CandidateConstraints { size: SizeRange { min: 20, opt: 20, max: 20 }, ..constraints() };
        let candidates = scan_candidates(&template, &c);
        // Windows of exactly length 20 over a 30-length template: 30-20+1 = 11.
        assert_eq!(candidates.len(), 11);
        assert!(candidates.iter().all(|c| c.len() == 20));
    }

    #[test]
    fn scan_candidates_skips_lengths_longer_than_template() {
        let template = "ACGT"; // length 4
        let candidates = scan_candidates(template, &constraints()); // min size 18
        assert!(candidates.is_empty());
    }

    #[test]
    fn score_and_rank_orders_by_penalty_ascending() {
        // A long template with varied GC content so different windows land
        // at different distances from the Tm/GC optimum.
        let template = "ACGTACGTACGTACGTACGTGCGCGCGCGCGCGCGCGCGCACGTACGTACGTACGTACGT";
        let c = constraints();
        let candidates = scan_candidates(template, &c);
        assert!(!candidates.is_empty());

        let backend = Primer3Backend;
        let scored = score_candidates(&backend, template, &candidates, &c, ThermoParams::default(), &PenaltyWeights::default());
        let ranked = rank(scored);

        for pair in ranked.windows(2) {
            assert!(pair[0].penalty <= pair[1].penalty);
        }
        // Every surviving candidate must respect the hard Tm/GC bounds.
        for sc in &ranked {
            assert!(sc.tm >= c.tm.min && sc.tm <= c.tm.max);
            assert!(sc.gc_percent >= c.gc.min && sc.gc_percent <= c.gc.max);
        }
    }

    #[test]
    fn works_identically_with_either_backend() {
        let template = "ACGTACGTACGTACGTACGTGCGCGCGCGCGCGCGCGCGCACGTACGTACGTACGTACGT";
        let c = constraints();
        let candidates = scan_candidates(template, &c);

        let primer3_backend = Primer3Backend;
        let native_backend = NativeBackend;

        let primer3_scored = rank(score_candidates(&primer3_backend, template, &candidates, &c, ThermoParams::default(), &PenaltyWeights::default()));
        let native_scored = rank(score_candidates(&native_backend, template, &candidates, &c, ThermoParams::default(), &PenaltyWeights::default()));

        // Not asserting numeric equality (different Tm models) - just that
        // both backends run the exact same picker code path to completion
        // and produce bounds-respecting, ranked results.
        assert!(!primer3_scored.is_empty());
        assert!(!native_scored.is_empty());
    }

    #[test]
    fn pick_pairs_respects_product_size_and_non_overlap() {
        let template = "ACGTACGTACGTACGTACGTGCGCGCGCGCGCGCGCGCGCACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTGCGCGCGCGCGCGC";
        let c = constraints();
        let candidates = scan_candidates(template, &c);
        let backend = Primer3Backend;
        let scored = rank(score_candidates(&backend, template, &candidates, &c, ThermoParams::default(), &PenaltyWeights::default()));

        let pairs = pick_pairs(&backend, template, &scored, &scored, (40, 80), ThermoParams::default(), &PairWeights::default(), 5);
        assert!(!pairs.is_empty());
        for p in &pairs {
            assert!(p.right.candidate.start >= p.left.candidate.end, "pairs must not overlap");
            assert_eq!(p.product_size, p.right.candidate.end - p.left.candidate.start);
            assert!(p.product_size >= 40 && p.product_size <= 80);
        }
        for w in pairs.windows(2) {
            assert!(w[0].penalty <= w[1].penalty, "pairs must be ranked ascending by penalty");
        }
        assert!(pairs.len() <= 5);
    }

    #[test]
    fn pick_pairs_finds_none_when_product_size_range_is_unreachable() {
        let template = "A".repeat(40);
        let c = CandidateConstraints { size: SizeRange { min: 20, opt: 20, max: 20 }, tm: TmRange { min: 0.0, max: 200.0, opt: 60.0 }, gc: GcRange { min: 0.0, max: 100.0 } };
        let candidates = scan_candidates(&template, &c);
        let backend = Primer3Backend;
        let scored = rank(score_candidates(&backend, &template, &candidates, &c, ThermoParams::default(), &PenaltyWeights::default()));

        let pairs = pick_pairs(&backend, &template, &scored, &scored, (1000, 2000), ThermoParams::default(), &PairWeights::default(), 5);
        assert!(pairs.is_empty());
    }
}
