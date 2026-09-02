//! MFE folding under the Mathews2004 parameter set — needed because
//! [`crate::thermo::hairpin_thermo`]/`dimer_thermo` must fold and score with
//! the *same* table, exactly like the fork's `hairpin_thermo`/`dimer_thermo`
//! do (`with param_context(paramset): fold_mfe(...)`, and `_dimer_mfe`'s own
//! `param_context(override)` around its candidate scan). [`crate::hairpin`]
//! and [`crate::dimer`] fold under the native SantaLucia table instead —
//! reusing them here would fold under one parameter set and score under
//! another, which is not merely a style choice: for short/symmetric
//! sequences the two tables' MFE structure can disagree (verified against
//! the real fork: `GGGGAAACCCC` folds to a 4bp stem under Mathews2004 but a
//! worse 3bp-stem-plus-dangling-base structure was picked when this module
//! didn't exist yet and native-table folding was used instead).
//!
//! Otherwise structurally identical DP to `hairpin.rs`/`dimer.rs` — same
//! recurrence, same trace bookkeeping, same tie-breaking — with every
//! per-cell energy call routed through [`crate::structure_thermo`]'s
//! Mathews2004-aware (native-table-falling-back) functions at
//! [`crate::mathews2004::Mode::Dg`] instead of the hardcoded native tables.

use crate::dimer::can_pair;
use crate::mathews2004::{params, Mode};
use crate::structure_thermo::{hairpin_exterior_dangle_bonus, hairpin_loop_energy, interior_bulge_energy, stack_energy, terminal_pair_penalty};

fn c(seq: &[u8], i: usize) -> char {
    seq[i] as char
}

/// `_inner_dangles`: dangles adjacent to the *inner* terminus of pair
/// `(i, n1+j_loc)`. Unlike [`crate::structure_thermo`]'s dangle handling
/// (only applied when the caller asks for `dangles=2`, and only once, to
/// the final reported structure's termini), this is applied
/// *unconditionally* at every DP cell — mirroring the fork's
/// `_dimer_mfe_candidates`, which always factors dangle stabilization into
/// *which* structure gets chosen, independent of what `dangles` the caller
/// later passes to `dimer_thermo` for scoring. Verified against the real
/// fork: a plain per-pair stack/terminal-penalty sum without this
/// undercounts a 6bp `AAAAACCCCC`/`GGGGGTTTTT` stack by 0.2 kcal/mol.
fn inner_dangles(seq: &[u8], n1: usize, i: usize, j_loc: usize) -> f64 {
    let p = params();
    let j_concat = n1 + j_loc;
    let mut total = 0.0;
    if j_concat >= n1 + 1 {
        let key = format!("{}{}{}", c(seq, j_concat), c(seq, i), c(seq, j_concat - 1));
        if let Some(d5) = p.dangle_5(Mode::Dg, &key) {
            if d5 < 0.0 {
                total += d5;
            }
        }
    }
    if i >= 1 && i + 1 < n1 {
        let key = format!("{}{}{}", c(seq, i - 1), c(seq, i), c(seq, i + 1));
        if let Some(d3) = p.dangle_3(Mode::Dg, &key) {
            if d3 < 0.0 {
                total += d3;
            }
        }
    }
    total
}

/// `_outer_dangles`: dangles adjacent to the *outer* terminus of pair
/// `(i, n1+j_loc)`. See [`inner_dangles`]'s docs.
fn outer_dangles(seq: &[u8], n1: usize, n: usize, i: usize, j_loc: usize) -> f64 {
    let p = params();
    let j_concat = n1 + j_loc;
    let mut total = 0.0;
    if i >= 1 {
        let key = format!("{}{}{}", c(seq, i), c(seq, j_concat), c(seq, i - 1));
        if let Some(d5) = p.dangle_5(Mode::Dg, &key) {
            if d5 < 0.0 {
                total += d5;
            }
        }
    }
    if j_concat + 1 < n {
        let key = format!("{}{}{}", c(seq, j_concat - 1), c(seq, j_concat), c(seq, j_concat + 1));
        if let Some(d3) = p.dangle_3(Mode::Dg, &key) {
            if d3 < 0.0 {
                total += d3;
            }
        }
    }
    total
}

const INF: f64 = f64::INFINITY;
const MAX_LOOP: usize = 4;
const MIN_HAIRPIN_LOOP: usize = 3;

/// Mathews2004-scored counterpart of [`crate::hairpin::hairpin_mfe`]. Returns
/// `(dg37, pairs)` (the pure closed-structure ΔG, dangle-free — callers
/// re-derive the dangle-inclusive ΔG/ΔH themselves via
/// `structure_thermo::sum_hairpin_elements`), `pairs` outermost-first.
///
/// `dangles`: must match whatever the caller will use for scoring. It only
/// affects *which* outer boundary wins here — see
/// [`crate::structure_thermo::hairpin_exterior_dangle_bonus`]'s docs — a
/// structure's internal stacking/loop energies never depend on it.
/// The DP fill shared by [`hairpin_mfe_mathews`] (single best) and
/// [`hairpin_mfe_candidates_mathews`] (every closing pair, ranked) — same
/// recurrence either way, only what's read back out of `inner`/`trace`
/// differs.
fn hairpin_mfe_fill(seq: &[u8]) -> Option<(usize, Vec<f64>, Vec<Option<(usize, usize)>>)> {
    let n = seq.len();
    if n < MIN_HAIRPIN_LOOP + 2 {
        return None;
    }

    let idx = |i: usize, j: usize| i * n + j;
    let mut inner = vec![INF; n * n];
    let mut trace: Vec<Option<(usize, usize)>> = vec![None; n * n];

    for i in (0..n).rev() {
        for j in (i + MIN_HAIRPIN_LOOP + 1)..n {
            if !can_pair(seq[i], seq[j]) {
                continue;
            }

            // Unlike `hairpin::hairpin_mfe`'s native-table `hairpin_loop_energy`
            // (which excludes the terminal penalty, added separately by the
            // caller), this Mathews2004-aware `hairpin_loop_energy` already
            // bakes the terminal penalty in internally — faithfully mirroring
            // Python's `_hairpin_loop_energy` — so it must NOT be added again
            // here (that was a real double-counting bug, caught by the
            // `mathews2004_parity` golden-fixture test).
            let stop_val = hairpin_loop_energy(Mode::Dg, seq, i, j);

            let mut best_continue = INF;
            let mut best_next: Option<(usize, usize)> = None;
            for nl in 0..=MAX_LOOP {
                for nr in 0..=(MAX_LOOP - nl) {
                    let ip = i + 1 + nl;
                    if j < 1 + nr {
                        continue;
                    }
                    let jp = j - 1 - nr;
                    if ip >= jp || jp - ip - 1 < MIN_HAIRPIN_LOOP {
                        continue;
                    }
                    if !can_pair(seq[ip], seq[jp]) {
                        continue;
                    }
                    let inner_next = inner[idx(ip, jp)];
                    if inner_next == INF {
                        continue;
                    }
                    let e = if nl == 0 && nr == 0 { stack_energy(Mode::Dg, seq, i, j) } else { interior_bulge_energy(Mode::Dg, seq, i, j, ip, jp, nl, nr) };
                    let cand = e + inner_next;
                    if cand < best_continue {
                        best_continue = cand;
                        best_next = Some((ip, jp));
                    }
                }
            }

            if best_next.is_none() || stop_val <= best_continue {
                inner[idx(i, j)] = stop_val;
                trace[idx(i, j)] = None;
            } else {
                inner[idx(i, j)] = best_continue;
                trace[idx(i, j)] = best_next;
            }
        }
    }

    Some((n, inner, trace))
}

fn hairpin_traceback(n: usize, trace: &[Option<(usize, usize)>], i: usize, j: usize) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    let (mut ci, mut cj) = (i, j);
    loop {
        pairs.push((ci, cj));
        match trace[ci * n + cj] {
            None => break,
            Some((ip, jp)) => {
                ci = ip;
                cj = jp;
            }
        }
    }
    pairs
}

pub fn hairpin_mfe_mathews(seq: &[u8], dangles: u8) -> Option<(f64, Vec<(usize, usize)>)> {
    let (n, inner, trace) = hairpin_mfe_fill(seq)?;
    let idx = |i: usize, j: usize| i * n + j;

    // Ranked by val + dangle bonus (when dangles=2) so a shorter stem that
    // leaves a more favorable dangling flank can beat a longer one that
    // engulfs those bases — mirroring `fold_mfe`'s exterior-loop placement,
    // which is dangle-aware even though internal stacking never is. The
    // *reported* energy is still the pure `val` (dangle-free); the actual
    // dangle-inclusive ΔG/ΔH is re-derived by the caller.
    let mut best_outer: Option<(usize, usize, f64, f64)> = None;
    for i in 0..n {
        for j in (i + MIN_HAIRPIN_LOOP + 1)..n {
            let val = inner[idx(i, j)];
            if !val.is_finite() {
                continue;
            }
            let ranked = if dangles == 2 { val + hairpin_exterior_dangle_bonus(Mode::Dg, seq, i, j) } else { val };
            if best_outer.map(|(_, _, _, b)| ranked < b).unwrap_or(true) {
                best_outer = Some((i, j, val, ranked));
            }
        }
    }

    best_outer.map(|(i, j, dg, _)| (dg, hairpin_traceback(n, &trace, i, j)))
}

/// Every closing pair `(i,j)` that folds at all, ranked the same way
/// [`crate::dimer::dimer_mfe_candidates_dna`]/[`dimer_mfe_candidates_mathews`]
/// rank theirs: closed-state energy ascending, then base-pair count
/// descending. Needed for the same reason that one is: a subopt/ensemble
/// view over more than just the single MFE structure.
pub fn hairpin_mfe_candidates_mathews(seq: &[u8], dangles: u8) -> Vec<(f64, Vec<(usize, usize)>)> {
    let Some((n, inner, trace)) = hairpin_mfe_fill(seq) else {
        return Vec::new();
    };
    let idx = |i: usize, j: usize| i * n + j;

    let mut candidates: Vec<(f64, f64, usize, usize)> = Vec::new();
    for i in 0..n {
        for j in (i + MIN_HAIRPIN_LOOP + 1)..n {
            let val = inner[idx(i, j)];
            if !val.is_finite() {
                continue;
            }
            let ranked = if dangles == 2 { val + hairpin_exterior_dangle_bonus(Mode::Dg, seq, i, j) } else { val };
            candidates.push((ranked, val, i, j));
        }
    }
    candidates.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then_with(|| {
        let len_a = hairpin_traceback(n, &trace, a.2, a.3).len();
        let len_b = hairpin_traceback(n, &trace, b.2, b.3).len();
        len_b.cmp(&len_a)
    }));
    candidates.into_iter().map(|(_, dg, i, j)| (dg, hairpin_traceback(n, &trace, i, j))).collect()
}

/// Mathews2004-scored counterpart of
/// [`crate::dimer::dimer_mfe_candidates_dna`]. Same ranked-candidate-list
/// contract: every antiparallel helix start state, sorted by closed-state
/// energy ascending then base-pair count descending.
pub fn dimer_mfe_candidates_mathews(seq1: &[u8], seq2: &[u8]) -> Vec<(f64, Vec<(usize, usize)>)> {
    let n1 = seq1.len();
    let n2 = seq2.len();
    if n1 == 0 || n2 == 0 {
        return Vec::new();
    }
    let n = n1 + n2;
    let concat: Vec<u8> = seq1.iter().chain(seq2.iter()).copied().collect();
    let seq = concat.as_slice();

    let cp = |i: usize, j_loc: usize| can_pair(seq1[i], seq2[j_loc]);
    let idx = |i: usize, j_loc: usize| i * n2 + j_loc;

    let mut inner = vec![INF; n1 * n2];
    let mut trace: Vec<Option<(usize, usize)>> = vec![None; n1 * n2];

    for i in (0..n1).rev() {
        for j_loc in 0..n2 {
            if !cp(i, j_loc) {
                continue;
            }
            let j_concat = n1 + j_loc;

            let stop_val = terminal_pair_penalty(Mode::Dg, seq, i, j_concat) + inner_dangles(seq, n1, i, j_loc);

            let mut best_continue = INF;
            let mut best_next: Option<(usize, usize)> = None;
            for nl in 0..=MAX_LOOP {
                for nr in 0..=(MAX_LOOP - nl) {
                    let ip = i + 1 + nl;
                    if j_loc < 1 + nr {
                        continue;
                    }
                    let jp_loc = j_loc - 1 - nr;
                    if ip >= n1 || !cp(ip, jp_loc) {
                        continue;
                    }
                    let inner_next = inner[idx(ip, jp_loc)];
                    if inner_next == INF {
                        continue;
                    }
                    let e = if nl == 0 && nr == 0 {
                        stack_energy(Mode::Dg, seq, i, j_concat)
                    } else {
                        interior_bulge_energy(Mode::Dg, seq, i, j_concat, ip, n1 + jp_loc, nl, nr)
                    };
                    let cand = e + inner_next;
                    if cand < best_continue {
                        best_continue = cand;
                        best_next = Some((ip, jp_loc));
                    }
                }
            }

            if best_next.is_none() || stop_val <= best_continue {
                inner[idx(i, j_loc)] = stop_val;
            } else {
                inner[idx(i, j_loc)] = best_continue;
                trace[idx(i, j_loc)] = best_next;
            }
        }
    }

    let mut candidates: Vec<(f64, Vec<(usize, usize)>)> = Vec::new();
    for i in 0..n1 {
        for j_loc in 0..n2 {
            if !cp(i, j_loc) {
                continue;
            }
            let j_concat = n1 + j_loc;
            let outer_val = terminal_pair_penalty(Mode::Dg, seq, i, j_concat) + outer_dangles(seq, n1, n, i, j_loc) + inner[idx(i, j_loc)];
            if !outer_val.is_finite() {
                continue;
            }
            let mut pairs: Vec<(usize, usize)> = Vec::new();
            let (mut ci, mut cj_loc) = (i, j_loc);
            loop {
                pairs.push((ci, n1 + cj_loc));
                match trace[idx(ci, cj_loc)] {
                    None => break,
                    Some((ip, jp)) => {
                        ci = ip;
                        cj_loc = jp;
                    }
                }
            }
            candidates.push((outer_val, pairs));
        }
    }

    candidates.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(b.1.len().cmp(&a.1.len())));
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hairpin_mfe_mathews_finds_full_stem_not_native_tables_choice() {
        // Regression: native-table folding (`hairpin::hairpin_mfe`) picks a
        // worse 3bp-stem structure for this sequence; Mathews2004 folding
        // must pick the objectively better full 4bp GGGG/CCCC stem.
        let (_, pairs) = hairpin_mfe_mathews(b"GGGGAAACCCC", 2).expect("should fold");
        assert_eq!(pairs.len(), 4, "pairs={pairs:?}");
        assert_eq!(pairs[0], (0, 10));
    }
}

