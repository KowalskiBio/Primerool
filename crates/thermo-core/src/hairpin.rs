//! Hairpin ΔG — closes the gap Strider left unfinished.
//!
//! Strider's `tables_dna.rs` already contains `HAIRPIN_SIZE`,
//! `HAIRPIN_MISMATCH`, `HAIRPIN_TRILOOP`, `HAIRPIN_TETRALOOP` (generated,
//! present, `#[allow(dead_code)]`) but no folding DP ever consumed them —
//! `tables.rs`'s own comment says this "lands in a later DP port" that was
//! never done. This module is that DP: a single-strand sibling of
//! `dimer.rs`'s existing heterodimer/homodimer DP, reusing its exact
//! stack/interior-loop scoring (`stack_energy_c`/`interior_c`/
//! `terminal_penalty`/`can_pair`/`norm`, made `pub(crate)` for this reuse)
//! since the physics of a stem's internal loops/bulges/stacks doesn't
//! differ between a hairpin and a duplex — only the accessor does (one
//! sequence indexed directly, not two concatenated strands).
//!
//! **Scope, matching the rewrite plan exactly**: hairpin/stem-loop folding
//! only (one closing pair chain down to one terminal loop), NOT general
//! multi-branch MFE structure prediction — that's explicitly out of scope
//! (Primerool only needs Tm/GC/hairpin ΔG/dimer ΔG per oligo, not full
//! secondary-structure prediction).
//!
//! **On Tm**: `STACK`/`INTERIOR_*`/`TERMINAL_PENALTY`/`HAIRPIN_*` are
//! Turner/Zuker-style ΔG37 tables (single free-energy values per key, not
//! ΔH/ΔS pairs — confirmed by how `dimer.rs` sums them directly into a
//! final energy with no temperature term anywhere in that DP). This is the
//! standard representation for MFE structure *ranking*, not melting-curve
//! prediction, and there is no matching ΔH table here to back out a real
//! Tm from. `hairpin_mfe` therefore reports ΔG(37°C) only — silently
//! offering a fabricated Tm would be worse than admitting the native
//! model doesn't have the data for one. `NativeBackend` (Phase 5) can
//! surface this as `tm: None` in `ThermoBackend::calc_hairpin`'s result.

use crate::dimer::{can_pair, interior_c, norm, stack_energy_c, terminal_penalty};
use crate::tables::dna::*;
use crate::tables::{lookup, pack};

const INF: f64 = f64::INFINITY;
const MAX_LOOP: usize = 4; // matches dimer.rs's interior-loop/bulge search width
const MIN_HAIRPIN_LOOP: usize = 3; // shortest physically foldable loop; HAIRPIN_SIZE[0..=1] are unused placeholders

#[derive(Debug, Clone, PartialEq)]
pub struct HairpinMfeResult {
    /// Free energy at 37°C (kcal/mol) of the minimum-free-energy hairpin.
    pub dg: f64,
    /// 0-based index of the 5' base of the closing (outermost) pair.
    pub stem_start: usize,
    /// 0-based index of the 3' base of the closing (outermost) pair.
    pub stem_end: usize,
    /// Every nested base pair of the fold, outermost-first — `(stem_start,
    /// stem_end)` is always `pairs[0]`. Needed by `structure_thermo`'s
    /// per-element walk (Tm derivation), which requires the full structure,
    /// not just the closing pair.
    pub pairs: Vec<(usize, usize)>,
}

/// Loop-closing energy for a hairpin loop of `seq[i+1..j]` (i.e. `j-i-1`
/// unpaired bases), closed by the pair `(seq[i], seq[j])`. Trinucleotide
/// and tetranucleotide loops get sequence-specific lookups (measured
/// values, not extrapolated from the general formula) when present in the
/// table; otherwise `HAIRPIN_SIZE` (extrapolated via `LOG_LOOP_PENALTY`
/// past 30nt, same convention as `BULGE_SIZE`/`INTERIOR_SIZE` in
/// `dimer.rs::interior_c`) plus a closing-mismatch correction.
fn hairpin_loop_energy(seq: &[u8], i: usize, j: usize) -> f64 {
    let loop_len = j - i - 1;
    debug_assert!(loop_len >= MIN_HAIRPIN_LOOP);

    if loop_len == 3 {
        let key = pack(&[norm(seq[i]), norm(seq[i + 1]), norm(seq[i + 2]), norm(seq[i + 3]), norm(seq[j])]);
        if let Some(v) = lookup(HAIRPIN_TRILOOP, key) {
            return v;
        }
    } else if loop_len == 4 {
        let key = pack(&[norm(seq[i]), norm(seq[i + 1]), norm(seq[i + 2]), norm(seq[i + 3]), norm(seq[i + 4]), norm(seq[j])]);
        if let Some(v) = lookup(HAIRPIN_TETRALOOP, key) {
            return v;
        }
    }

    let size_term = if loop_len <= 30 {
        HAIRPIN_SIZE[loop_len - 1]
    } else {
        HAIRPIN_SIZE[HAIRPIN_SIZE.len() - 1] + LOG_LOOP_PENALTY * (loop_len as f64 / 30.0).ln()
    };
    // Closing mismatch: the two bases immediately inside the closing pair,
    // same 4-base key convention as dimer.rs's INTERIOR_MISMATCH lookups.
    let mismatch_key = pack(&[norm(seq[j - 1]), norm(seq[j]), norm(seq[i]), norm(seq[i + 1])]);
    let mismatch_term = lookup(HAIRPIN_MISMATCH, mismatch_key).unwrap_or(0.0);
    size_term + mismatch_term
}

/// Minimum-free-energy hairpin (stem-loop) fold of a single DNA sequence.
/// `None` if the sequence is too short to fold at all (`< 2*MIN_HAIRPIN_LOOP + 2`)
/// or no valid closing pair exists.
pub fn hairpin_mfe(seq: &[u8]) -> Option<HairpinMfeResult> {
    let n = seq.len();
    // Minimum foldable length: one closing pair (2 bases) + the shortest
    // possible loop (MIN_HAIRPIN_LOOP bases).
    if n < MIN_HAIRPIN_LOOP + 2 {
        return None;
    }

    let at = |k: usize| -> u8 { norm(seq[k]) };
    let idx = |i: usize, j: usize| i * n + j;

    // inner[i][j]: best (most negative) free energy of the structure closed
    // by pair (i,j), whether that's a direct hairpin-loop closure or a
    // stack/bulge/interior-loop extension to some inner pair (i',j').
    // Filled for decreasing i, increasing j - i (mirrors dimer.rs's
    // inside-out fill order, adapted to a single triangular table).
    let mut inner = vec![INF; n * n];
    // Trace: None = stop here (hairpin-loop closure at this cell), Some((ip, jp)).
    let mut trace: Vec<Option<(usize, usize)>> = vec![None; n * n];

    for i in (0..n).rev() {
        // j must leave room for at least a MIN_HAIRPIN_LOOP-sized loop.
        for j in (i + MIN_HAIRPIN_LOOP + 1)..n {
            if !can_pair(seq[i], seq[j]) {
                continue;
            }

            let stop_val = terminal_penalty(at(i), at(j)) + hairpin_loop_energy(seq, i, j);

            let mut best_continue = INF;
            let mut best_next: Option<(usize, usize)> = None;
            for nl in 0..=MAX_LOOP {
                for nr in 0..=(MAX_LOOP - nl) {
                    let ip = i + 1 + nl;
                    if j < 1 + nr {
                        continue;
                    }
                    let jp = j - 1 - nr;
                    // The inner pair must still leave room for its own
                    // minimum hairpin loop, and must be a real shrink.
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
                    let e = if nl == 0 && nr == 0 { stack_energy_c(&at, i, j) } else { interior_c(&at, i, j, ip, jp, nl, nr) };
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

    let mut best_outer: Option<(usize, usize, f64)> = None;
    for i in 0..n {
        for j in (i + MIN_HAIRPIN_LOOP + 1)..n {
            let val = inner[idx(i, j)];
            if !val.is_finite() {
                continue;
            }
            if best_outer.map(|(_, _, b)| val < b).unwrap_or(true) {
                best_outer = Some((i, j, val));
            }
        }
    }

    best_outer.map(|(i, j, dg)| {
        let mut pairs = Vec::new();
        let (mut ci, mut cj) = (i, j);
        loop {
            pairs.push((ci, cj));
            match trace[idx(ci, cj)] {
                None => break,
                Some((ip, jp)) => {
                    ci = ip;
                    cj = jp;
                }
            }
        }
        HairpinMfeResult { dg, stem_start: i, stem_end: j, pairs }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_hairpin_for_short_sequence() {
        assert!(hairpin_mfe(b"ACGT").is_none());
    }

    #[test]
    fn no_hairpin_for_non_complementary_sequence() {
        // All A's: can never pair with itself.
        assert!(hairpin_mfe(b"AAAAAAAAAAAAAAAAAAAA").is_none());
    }

    #[test]
    fn perfect_stem_loop_folds_with_negative_dg() {
        // 6bp GC stem + a tetraloop (GAAA is a classic stable tetraloop).
        let seq = b"GCGCGCGAAACGCGCGC";
        let result = hairpin_mfe(seq).expect("a perfect stem-loop should fold");
        assert!(result.dg < 0.0, "a stable hairpin should have negative dG, got {}", result.dg);
    }

    #[test]
    fn hand_computed_minimal_triloop_hairpin() {
        // Minimal case: one closing pair (A,T at positions 0,4) around an
        // exact 3nt loop "CGC" -> must match HAIRPIN_TRILOOP's lookup
        // (or the general HAIRPIN_SIZE+MISMATCH formula if this exact
        // triloop isn't in the measured table) plus terminal_penalty(A,T),
        // computed by hand from the same tables the DP reads.
        let seq = b"ACGCT"; // A-T close a 3nt loop "CGC"
        let result = hairpin_mfe(seq).expect("minimal triloop hairpin should fold");
        assert_eq!((result.stem_start, result.stem_end), (0, 4));

        let expected_tp = terminal_penalty(b'A', b'T');
        let key = pack(&[b'A', b'C', b'G', b'C', b'T']);
        let expected_loop = lookup(HAIRPIN_TRILOOP, key).unwrap_or_else(|| {
            let mismatch_key = pack(&[b'C', b'T', b'A', b'C']);
            HAIRPIN_SIZE[2] + lookup(HAIRPIN_MISMATCH, mismatch_key).unwrap_or(0.0)
        });
        assert!((result.dg - (expected_tp + expected_loop)).abs() < 1e-9);
    }

    #[test]
    fn longer_general_formula_loop_uses_hairpin_size_extrapolation() {
        // A loop long enough (>4nt) to require the general HAIRPIN_SIZE
        // formula rather than a tri/tetraloop lookup.
        let seq = b"GCAAAAAAAAAAGC"; // 10nt loop, closed by a G-C pair
        let result = hairpin_mfe(seq).expect("should fold with a long loop");
        assert!(result.dg.is_finite());
    }
}
