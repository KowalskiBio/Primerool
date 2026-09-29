//! Strider's candidate scan/filter/score/rank engine — the single picking
//! engine behind every design mode.
//!
//! Scans every window of the allowed lengths, rejects the ones that break a
//! hard constraint (Ns, poly-X runs, GC, Tm, then hairpin/self-dimer
//! stability), ranks the survivors by distance from the optimum, and pairs
//! LEFT/RIGHT pools into amplicons. Filter thresholds default to Primer3's
//! own defaults (`defaults.rs`) so results stay recognisable to anyone used
//! to Primer3, but the penalty is a plain weighted distance-from-optimum, not
//! a reproduction of Primer3's internal formula.
//!
//! Two-phase scoring keeps large search windows fast: the cheap checks and
//! the penalty run over every window in parallel (`rayon`); the hairpin and
//! self-dimer DPs (~100µs each) only run walking down the penalty-ranked
//! list until enough candidates have passed.

use rayon::prelude::*;

use crate::backend::{DimerResult, ThermoBackend, ThermoParams};
use crate::defaults::{DEFAULT_MAX_HAIRPIN_TM, DEFAULT_MAX_NS_ACCEPTED, DEFAULT_MAX_PAIR_DIMER_TM, DEFAULT_MAX_POLY_X, DEFAULT_MAX_SELF_DIMER_TM};

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

/// Hard per-oligo rejections beyond size/Tm/GC. Defaults are Primer3's
/// (`PRIMER_MAX_POLY_X`, `PRIMER_MAX_NS_ACCEPTED`, `PRIMER_MAX_HAIRPIN_TH`,
/// `PRIMER_MAX_SELF_ANY_TH`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OligoFilters {
    pub max_poly_x: usize,
    pub max_ns: usize,
    /// °C; a hairpin melting above this rejects the oligo.
    pub max_hairpin_tm: f64,
    /// °C; a self-dimer melting above this rejects the oligo.
    pub max_self_dimer_tm: f64,
}

impl Default for OligoFilters {
    fn default() -> Self {
        Self {
            max_poly_x: DEFAULT_MAX_POLY_X as usize,
            max_ns: DEFAULT_MAX_NS_ACCEPTED as usize,
            max_hairpin_tm: DEFAULT_MAX_HAIRPIN_TM,
            max_self_dimer_tm: DEFAULT_MAX_SELF_DIMER_TM,
        }
    }
}

/// Which strand an oligo anneals as. `Forward` covers LEFT primers and
/// probes (the oligo reads as the template); `Reverse` covers RIGHT primers
/// (the oligo is the reverse complement of its template window).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strand {
    Forward,
    Reverse,
}

/// A candidate oligo: a half-open `[start, end)` range into the forward
/// strand of the template it was scanned from, whatever its `Strand`.
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

    /// The oligo's own 5'→3' sequence — the template window for `Forward`,
    /// its reverse complement for `Reverse`.
    pub fn oligo(&self, template: &str, strand: Strand) -> String {
        let window = &template[self.start..self.end];
        match strand {
            Strand::Forward => window.to_string(),
            Strand::Reverse => thermo_core::reverse_complement(window),
        }
    }
}

/// Exhaustive sliding-window enumeration of every `[start, start+len)`
/// window with `len` in `[constraints.size.min, constraints.size.max]`.
/// Pure, no thermodynamics; callers narrow the result to a search region
/// (`in_region`) or to one side of a target before picking.
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

/// Candidates lying entirely inside `[start, end)`.
pub fn in_region(candidates: &[Candidate], start: usize, end: usize) -> Vec<Candidate> {
    candidates.iter().copied().filter(|c| c.start >= start && c.end <= end).collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScoredCandidate {
    pub candidate: Candidate,
    pub strand: Strand,
    /// 5'→3' oligo sequence (reverse-complemented for `Strand::Reverse`).
    pub sequence: String,
    pub tm: f64,
    pub gc_percent: f64,
    pub hairpin: DimerResult,
    pub self_dimer: DimerResult,
    /// Lower is better: weighted distance from the Tm/GC/size optimum.
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

fn longest_run(seq: &str) -> usize {
    let bytes = seq.as_bytes();
    let mut best = 0;
    let mut run = 0;
    for (i, b) in bytes.iter().enumerate() {
        run = if i > 0 && bytes[i - 1] == *b { run + 1 } else { 1 };
        best = best.max(run);
    }
    best
}

/// Per-reason rejection tally, rendered in Primer3's `*_EXPLAIN` style so
/// "no primers found" messages say *why*.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PickStats {
    pub considered: usize,
    pub too_many_ns: usize,
    pub gc_failed: usize,
    pub low_tm: usize,
    pub high_tm: usize,
    pub poly_x: usize,
    pub hairpin: usize,
    pub self_dimer: usize,
    pub ok: usize,
}

impl PickStats {
    pub fn explain(&self) -> String {
        let mut parts = vec![format!("considered {}", self.considered)];
        for (count, label) in [
            (self.too_many_ns, "too many Ns"),
            (self.gc_failed, "GC content failed"),
            (self.low_tm, "low tm"),
            (self.high_tm, "high tm"),
            (self.poly_x, "long poly-x seq"),
            (self.hairpin, "high hairpin stability"),
            (self.self_dimer, "high self-dimer stability"),
        ] {
            if count > 0 {
                parts.push(format!("{label} {count}"));
            }
        }
        parts.push(format!("ok {}", self.ok));
        parts.join(", ")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PickResult {
    /// Ranked ascending by penalty, at most the requested `keep`.
    pub oligos: Vec<ScoredCandidate>,
    pub stats: PickStats,
}

impl PickResult {
    pub fn explain(&self) -> String {
        self.stats.explain()
    }
}

enum Cheap {
    Pass(ScoredCandidate),
    Ns,
    Gc,
    LowTm,
    HighTm,
    PolyX,
}

/// How many ranked survivors of the cheap pass get their structure DPs run
/// per parallel batch while walking down the list.
const STRUCTURE_BATCH: usize = 64;

/// Filters, scores and ranks `candidates` (all read as `strand`), keeping
/// the best `keep` that pass every check. The single entry point every
/// design mode picks through.
#[allow(clippy::too_many_arguments)]
pub fn pick_oligos(
    backend: &dyn ThermoBackend,
    template: &str,
    candidates: &[Candidate],
    strand: Strand,
    constraints: &CandidateConstraints,
    filters: &OligoFilters,
    thermo_params: ThermoParams,
    weights: &PenaltyWeights,
    keep: usize,
) -> PickResult {
    let cheap: Vec<Cheap> = candidates
        .par_iter()
        .map(|&candidate| {
            let seq = candidate.oligo(template, strand);
            if seq.bytes().filter(|b| !matches!(b, b'A' | b'C' | b'G' | b'T')).count() > filters.max_ns {
                return Cheap::Ns;
            }
            let gc = gc_percent(&seq);
            if gc < constraints.gc.min || gc > constraints.gc.max {
                return Cheap::Gc;
            }
            let tm = backend.calc_tm(&seq, thermo_params);
            if tm < constraints.tm.min {
                return Cheap::LowTm;
            }
            if tm > constraints.tm.max {
                return Cheap::HighTm;
            }
            if longest_run(&seq) > filters.max_poly_x {
                return Cheap::PolyX;
            }
            let penalty = weights.tm * (tm - constraints.tm.opt).abs()
                + weights.gc * (gc - constraints.gc.midpoint()).abs()
                + weights.size * (candidate.len() as f64 - constraints.size.opt as f64).abs();
            let unscored = DimerResult { structure_found: false, tm: None, dg: None, structure: None };
            Cheap::Pass(ScoredCandidate { candidate, strand, sequence: seq, tm, gc_percent: gc, hairpin: unscored.clone(), self_dimer: unscored, penalty })
        })
        .collect();

    let mut stats = PickStats { considered: candidates.len(), ..PickStats::default() };
    let mut ranked = Vec::new();
    for c in cheap {
        match c {
            Cheap::Pass(sc) => ranked.push(sc),
            Cheap::Ns => stats.too_many_ns += 1,
            Cheap::Gc => stats.gc_failed += 1,
            Cheap::LowTm => stats.low_tm += 1,
            Cheap::HighTm => stats.high_tm += 1,
            Cheap::PolyX => stats.poly_x += 1,
        }
    }
    // Stable, so penalty ties keep scan order.
    ranked.sort_by(|a, b| a.penalty.partial_cmp(&b.penalty).unwrap());

    let exceeds = |r: &DimerResult, max: f64| r.tm.is_some_and(|tm| tm > max);
    let mut oligos = Vec::new();
    for batch in ranked.chunks_mut(STRUCTURE_BATCH) {
        if oligos.len() >= keep {
            break;
        }
        batch.par_iter_mut().for_each(|sc| {
            sc.hairpin = backend.calc_hairpin(&sc.sequence, thermo_params);
            sc.self_dimer = backend.calc_homodimer(&sc.sequence, thermo_params);
        });
        for sc in batch.iter() {
            if exceeds(&sc.hairpin, filters.max_hairpin_tm) {
                stats.hairpin += 1;
            } else if exceeds(&sc.self_dimer, filters.max_self_dimer_tm) {
                stats.self_dimer += 1;
            } else if oligos.len() < keep {
                oligos.push(sc.clone());
            }
        }
    }
    stats.ok = oligos.len();
    PickResult { oligos, stats }
}

/// One-sided pick over `[region.0, region.1)` of `template` with the default
/// filters and weights — the common case for every design mode that picks
/// a single primer side or a probe.
#[allow(clippy::too_many_arguments)]
pub fn pick_in_region(
    backend: &dyn ThermoBackend,
    template: &str,
    region: (usize, usize),
    strand: Strand,
    constraints: &CandidateConstraints,
    filters: &OligoFilters,
    thermo_params: ThermoParams,
    keep: usize,
) -> PickResult {
    let candidates = in_region(&scan_candidates(template, constraints), region.0, region.1);
    pick_oligos(backend, template, &candidates, strand, constraints, filters, thermo_params, &PenaltyWeights::default(), keep)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScoredPair {
    pub left: ScoredCandidate,
    pub right: ScoredCandidate,
    /// `right.candidate.end - left.candidate.start` — the amplicon length.
    pub product_size: usize,
    pub heterodimer: DimerResult,
    /// Lower is better: `left.penalty + right.penalty + weights.tm_diff *
    /// |left.tm - right.tm|`.
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PairStats {
    pub considered: usize,
    pub overlapping: usize,
    pub product_size: usize,
    pub heterodimer: usize,
    pub ok: usize,
}

impl PairStats {
    pub fn explain(&self) -> String {
        let mut parts = vec![format!("considered {}", self.considered)];
        for (count, label) in [(self.overlapping, "overlapping primers"), (self.product_size, "unacceptable product size"), (self.heterodimer, "high any compl")] {
            if count > 0 {
                parts.push(format!("{label} {count}"));
            }
        }
        parts.push(format!("ok {}", self.ok));
        parts.join(", ")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PairPickResult {
    pub pairs: Vec<ScoredPair>,
    pub stats: PairStats,
}

impl PairPickResult {
    pub fn explain(&self) -> String {
        self.stats.explain()
    }
}

/// Combines a LEFT pool and a RIGHT pool (each already `pick_oligos`-ranked)
/// into amplicons. A pair is valid when the RIGHT primer's window starts at
/// or after the LEFT's ends, the product size is inside
/// `product_size_range`, and the primers' heterodimer melts at or below
/// `DEFAULT_MAX_PAIR_DIMER_TM`.
///
/// Like `pick_oligos`, two-phase: every combination is size-checked and
/// ranked by pair penalty first (cheap), and the heterodimer DP (~120µs)
/// only runs walking down that ranking until `num_return` pairs pass.
pub fn pick_pairs(
    backend: &dyn ThermoBackend,
    left: &[ScoredCandidate],
    right: &[ScoredCandidate],
    product_size_range: (usize, usize),
    thermo_params: ThermoParams,
    weights: &PairWeights,
    num_return: usize,
) -> PairPickResult {
    let mut stats = PairStats { considered: left.len() * right.len(), ..PairStats::default() };
    // (penalty, left index, right index, product size)
    let mut ranked: Vec<(f64, usize, usize, usize)> = Vec::new();
    for (li, l) in left.iter().enumerate() {
        for (ri, r) in right.iter().enumerate() {
            if r.candidate.start < l.candidate.end {
                stats.overlapping += 1;
                continue;
            }
            let product_size = r.candidate.end - l.candidate.start;
            if product_size < product_size_range.0 || product_size > product_size_range.1 {
                stats.product_size += 1;
                continue;
            }
            ranked.push((l.penalty + r.penalty + weights.tm_diff * (l.tm - r.tm).abs(), li, ri, product_size));
        }
    }
    ranked.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

    let mut pairs = Vec::new();
    for batch in ranked.chunks(STRUCTURE_BATCH) {
        if pairs.len() >= num_return {
            break;
        }
        let dimers: Vec<DimerResult> = batch.par_iter().map(|&(_, li, ri, _)| backend.calc_heterodimer(&left[li].sequence, &right[ri].sequence, thermo_params)).collect();
        for (&(penalty, li, ri, product_size), heterodimer) in batch.iter().zip(dimers) {
            if heterodimer.tm.is_some_and(|tm| tm > DEFAULT_MAX_PAIR_DIMER_TM) {
                stats.heterodimer += 1;
            } else if pairs.len() < num_return {
                pairs.push(ScoredPair { left: left[li].clone(), right: right[ri].clone(), product_size, heterodimer, penalty });
            }
        }
    }
    stats.ok = pairs.len();
    PairPickResult { pairs, stats }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_native::NativeBackend;

    const TEMPLATE: &str = "GATCGGAAGAGCACACGTCTGAACTCCAGTCACATCACGATCTCGTATGCCGTCTTCTGCTTGAAAAAAAAAAAA\
                            GGCCTATCAAGCAGTGGTATCAACGCAGAGTACATGGGTACGACCTTCTGGCCTAGAGATCCGATGCTGACTGCC\
                            AACTTAGTGCCTAGCTTGCCGAATATCATGGTGCACTCTCAGTACAATCTGCTCTGATGCCGCATAGTTAAGCCA";

    fn constraints() -> CandidateConstraints {
        CandidateConstraints {
            size: SizeRange { min: 18, opt: 20, max: 25 },
            tm: TmRange { min: 55.0, opt: 60.0, max: 68.0 },
            gc: GcRange { min: 30.0, max: 70.0 },
        }
    }

    fn pick(strand: Strand, keep: usize) -> PickResult {
        let c = constraints();
        let candidates = scan_candidates(TEMPLATE, &c);
        pick_oligos(&NativeBackend, TEMPLATE, &candidates, strand, &c, &OligoFilters::default(), ThermoParams::default(), &PenaltyWeights::default(), keep)
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
        assert!(scan_candidates("ACGT", &constraints()).is_empty());
    }

    #[test]
    fn in_region_keeps_only_fully_contained_windows() {
        let c = CandidateConstraints { size: SizeRange { min: 20, opt: 20, max: 20 }, ..constraints() };
        let candidates = scan_candidates(&"A".repeat(50), &c);
        let inside = in_region(&candidates, 10, 35);
        assert_eq!(inside.len(), 6);
        assert!(inside.iter().all(|c| c.start >= 10 && c.end <= 35));
    }

    #[test]
    fn longest_run_counts_homopolymers() {
        assert_eq!(longest_run("ACGT"), 1);
        assert_eq!(longest_run("ACGGGGT"), 4);
        assert_eq!(longest_run("AAAAAAAAAA"), 10);
    }

    #[test]
    fn pick_oligos_ranks_and_respects_every_filter() {
        let result = pick(Strand::Forward, 20);
        assert!(!result.oligos.is_empty(), "{}", result.explain());
        let c = constraints();
        let f = OligoFilters::default();
        for sc in &result.oligos {
            assert!(sc.tm >= c.tm.min && sc.tm <= c.tm.max);
            assert!(sc.gc_percent >= c.gc.min && sc.gc_percent <= c.gc.max);
            assert!(longest_run(&sc.sequence) <= f.max_poly_x);
            assert!(sc.hairpin.tm.is_none_or(|tm| tm <= f.max_hairpin_tm));
            assert!(sc.self_dimer.tm.is_none_or(|tm| tm <= f.max_self_dimer_tm));
            assert_eq!(sc.sequence, &TEMPLATE[sc.candidate.start..sc.candidate.end]);
        }
        for w in result.oligos.windows(2) {
            assert!(w[0].penalty <= w[1].penalty);
        }
        // The poly-A run in the template must have been rejected somewhere.
        assert!(result.stats.poly_x > 0, "{}", result.explain());
    }

    #[test]
    fn reverse_strand_oligos_are_reverse_complemented() {
        let result = pick(Strand::Reverse, 5);
        assert!(!result.oligos.is_empty());
        for sc in &result.oligos {
            assert_eq!(sc.sequence, thermo_core::reverse_complement(&TEMPLATE[sc.candidate.start..sc.candidate.end]));
        }
    }

    #[test]
    fn keep_caps_the_result_and_explain_reports_it() {
        let result = pick(Strand::Forward, 3);
        assert_eq!(result.oligos.len(), 3);
        assert_eq!(result.stats.ok, 3);
        assert!(result.explain().starts_with("considered "));
        assert!(result.explain().ends_with("ok 3"));
    }

    #[test]
    fn impossible_tm_window_explains_itself() {
        let c = CandidateConstraints { tm: TmRange { min: 90.0, opt: 95.0, max: 99.0 }, ..constraints() };
        let candidates = scan_candidates(TEMPLATE, &c);
        let result = pick_oligos(&NativeBackend, TEMPLATE, &candidates, Strand::Forward, &c, &OligoFilters::default(), ThermoParams::default(), &PenaltyWeights::default(), 5);
        assert!(result.oligos.is_empty());
        assert!(result.explain().contains("low tm"), "{}", result.explain());
    }

    #[test]
    fn pick_pairs_respects_product_size_and_non_overlap() {
        let left = pick(Strand::Forward, 40).oligos;
        let right = pick(Strand::Reverse, 40).oligos;
        let result = pick_pairs(&NativeBackend, &left, &right, (60, 180), ThermoParams::default(), &PairWeights::default(), 5);
        assert!(!result.pairs.is_empty(), "{}", result.explain());
        for p in &result.pairs {
            assert!(p.right.candidate.start >= p.left.candidate.end, "pairs must not overlap");
            assert_eq!(p.product_size, p.right.candidate.end - p.left.candidate.start);
            assert!((60..=180).contains(&p.product_size));
        }
        for w in result.pairs.windows(2) {
            assert!(w[0].penalty <= w[1].penalty, "pairs must be ranked ascending by penalty");
        }
        assert!(result.pairs.len() <= 5);
    }

    #[test]
    fn pick_pairs_finds_none_when_product_size_range_is_unreachable() {
        let left = pick(Strand::Forward, 20).oligos;
        let right = pick(Strand::Reverse, 20).oligos;
        let result = pick_pairs(&NativeBackend, &left, &right, (1000, 2000), ThermoParams::default(), &PairWeights::default(), 5);
        assert!(result.pairs.is_empty());
        assert!(result.explain().contains("unacceptable product size"));
    }
}
