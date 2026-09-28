//! Structure-resolved ΔG/ΔH for a *given* fold — port of the fork's
//! `strider/thermo/structure_thermo.py`. Walks a fixed base-pair list and
//! sums per-element energies from [`crate::mathews2004`], exactly mirroring
//! `strider/thermo/ensemble.py`'s `_stack_energy`/`_hairpin_loop_energy`/
//! `_interior_bulge_energy`/`_terminal_pair_penalty` (DNA-only; the RNA
//! branches of those functions are not ported — Primerool never folds RNA).
//!
//! Called twice per structure, once against the ΔG₃₇ section and once
//! against the ΔH section of the same [`crate::mathews2004::Mathews2004Params`]
//! (selected via [`crate::mathews2004::Mode`]), so that
//! `ΔS = (ΔH − ΔG₃₇) / T_REF` is internally consistent — see
//! `crate::thermo::hairpin_thermo`/`dimer_thermo`.

use crate::mathews2004::{params, Mode};

fn c(seq: &[u8], i: usize) -> char {
    seq[i] as char
}

fn key2(seq: &[u8], i: usize, j: usize) -> String {
    format!("{}{}", c(seq, i), c(seq, j))
}

/// `_stack_energy`: stacking energy for closing pair `(i,j)` on inner pair
/// `(i+1,j-1)`. Default -1.5 on a miss (matches `_stack_energy`'s own
/// default, distinct from the 0.0 default used at the bulge call site).
pub(crate) fn stack_energy(mode: Mode, seq: &[u8], i: usize, j: usize) -> f64 {
    let key = format!("{}{}{}{}", c(seq, i), c(seq, i + 1), c(seq, j - 1), c(seq, j));
    params().stack(mode, &key).unwrap_or(-1.5)
}

/// `_hairpin_loop_energy`. `loop_size = j - i - 1` must be >= 3 (the DP
/// that produces any structure walked here already enforces this).
pub(crate) fn hairpin_loop_energy(mode: Mode, seq: &[u8], i: usize, j: usize) -> f64 {
    let p = params();
    let loop_size = j - i - 1;
    let size_idx = loop_size - 1;

    let mut dg = if size_idx < p.hairpin_size_len(mode) {
        p.hairpin_size(mode, size_idx)
    } else {
        p.hairpin_size_last(mode) + p.log_loop_penalty(mode) * (loop_size as f64 / 30.0).ln()
    };

    if loop_size == 3 {
        let key: String = (i..=j).map(|k| c(seq, k)).collect();
        dg += p.terminal_penalty(mode, &key2(seq, j, i));
        dg += p.hairpin_triloop(mode, &key);
        dg += p.terminal_penalty(mode, &key2(seq, i, j));
        return dg;
    }

    if loop_size == 4 {
        let key: String = (i..=j).map(|k| c(seq, k)).collect();
        dg += p.hairpin_tetraloop(mode, &key);
    }

    let mm_key = format!("{}{}{}{}", c(seq, j - 1), c(seq, j), c(seq, i), c(seq, i + 1));
    dg += p.hairpin_mismatch(mode, &mm_key);
    dg += p.terminal_penalty(mode, &key2(seq, i, j));
    dg
}

/// `_interior_bulge_energy`. Outer pair `(i,j)`, inner pair `(ip,jp)`;
/// `nl`/`nr` unpaired bases on the left/right. DNA-only (Primerool has no
/// RNA path).
pub(crate) fn interior_bulge_energy(mode: Mode, seq: &[u8], i: usize, j: usize, ip: usize, jp: usize, nl: usize, nr: usize) -> f64 {
    let p = params();
    let tp_outer = p.terminal_penalty(mode, &key2(seq, i, j));
    let tp_inner = p.terminal_penalty(mode, &key2(seq, ip, jp));

    if nl == 0 || nr == 0 {
        let n = nl + nr;
        let mut dg = if n <= 30 { p.bulge_size(mode, n - 1) } else { p.bulge_size_last(mode) + p.log_loop_penalty(mode) * (n as f64 / 30.0).ln() };
        if n == 1 {
            let key = format!("{}{}{}{}", c(seq, i), c(seq, ip), c(seq, jp), c(seq, j));
            // Same "stack" table as `stack_energy`, but this call site's
            // Python default is 0.0, not -1.5 — see `Mathews2004Params::stack`'s docs.
            dg += p.stack(mode, &key).unwrap_or(0.0);
            return dg + tp_outer - tp_inner;
        } else {
            return dg + 2.0 * tp_outer;
        }
    }

    if nl == 1 && nr == 1 {
        let key = format!("{}{}{}{}{}{}", c(seq, i), c(seq, i + 1), c(seq, ip), c(seq, jp), c(seq, j - 1), c(seq, j));
        if let Some(val) = p.interior_1_1(mode, &key) {
            return tp_outer + val - tp_inner;
        }
    }
    if nl == 1 && nr == 2 {
        let key = format!("{}{}{}{}{}{}{}", c(seq, i), c(seq, i + 1), c(seq, ip), c(seq, jp), c(seq, jp + 1), c(seq, j - 1), c(seq, j));
        if let Some(val) = p.interior_1_2(mode, &key) {
            return tp_outer + val - tp_inner;
        }
    }
    if nl == 2 && nr == 1 {
        let key = format!("{}{}{}{}{}{}{}", c(seq, jp), c(seq, j - 1), c(seq, j), c(seq, i), c(seq, i + 1), c(seq, i + 2), c(seq, ip));
        if let Some(val) = p.interior_1_2(mode, &key) {
            return tp_outer + val - tp_inner;
        }
    }
    if nl == 2 && nr == 2 {
        let key = format!(
            "{}{}{}{}{}{}{}{}",
            c(seq, i),
            c(seq, i + 1),
            c(seq, i + 2),
            c(seq, ip),
            c(seq, jp),
            c(seq, jp + 1),
            c(seq, j - 1),
            c(seq, j)
        );
        if let Some(val) = p.interior_2_2(mode, &key) {
            return tp_outer + val - tp_inner;
        }
    }

    let n = nl + nr;
    let mut dg = if n <= 30 { p.interior_size(mode, n - 1) } else { p.interior_size_last(mode) + p.log_loop_penalty(mode) * (n as f64 / 30.0).ln() };
    let asym = (nl as f64 - nr as f64).abs();
    let ninio_number = nl.min(nr).min(4) - 1;
    dg += p.asymmetry_ninio(mode, 4).min(asym * p.asymmetry_ninio(mode, ninio_number));

    let (outer_key, inner_key) = if (nl == 1 && nr > 2) || (nl > 2 && nr == 1) {
        (format!("A{}{}A", c(seq, j), c(seq, i)), format!("A{}{}A", c(seq, ip), c(seq, jp)))
    } else {
        (key4(seq, j - 1, j, i, i + 1), key4(seq, ip - 1, ip, jp, jp + 1))
    };
    dg += p.interior_mismatch(mode, &outer_key);
    dg += p.interior_mismatch(mode, &inner_key);

    dg + tp_outer - tp_inner
}

fn key4(seq: &[u8], a: usize, b: usize, c_: usize, d: usize) -> String {
    format!("{}{}{}{}", c(seq, a), c(seq, b), c(seq, c_), c(seq, d))
}

/// `_terminal_pair_penalty`.
pub(crate) fn terminal_pair_penalty(mode: Mode, seq: &[u8], i: usize, j: usize) -> f64 {
    params().terminal_penalty(mode, &key2(seq, i, j))
}

/// Best single negative exterior dangle for a stem's outermost pair `(io,jo)`
/// (`dangles=2` convention — one dangle total, the more favorable of the 5'
/// tail at `io-1` or the 3' tail at `jo+1`, matching ViennaRNA's `d2` outer-
/// loop behavior for a single exterior stem). Shared by [`sum_hairpin_elements`]
/// (applied once, to the final reported ΔG/ΔH) and
/// [`crate::mathews2004_fold::hairpin_mfe_mathews`] (applied only to *rank*
/// candidate outer boundaries — without it, folding under `dangles=2` can
/// pick a longer stem that engulfs bases which would have dangled more
/// favorably left unpaired; verified against the real fork on `GGGGAAACCCC`-
/// and `AATACATTTTTATGATT`-shaped sequences).
pub(crate) fn hairpin_exterior_dangle_bonus(mode: Mode, seq: &[u8], io: usize, jo: usize) -> f64 {
    let p = params();
    let mut best = 0.0f64;
    if io >= 1 {
        let key = format!("{}{}{}", c(seq, io), c(seq, jo), c(seq, io - 1));
        if let Some(d5) = p.dangle_5(mode, &key) {
            if d5 < best {
                best = d5;
            }
        }
    }
    if jo + 1 < seq.len() {
        let key = format!("{}{}{}", c(seq, jo - 1), c(seq, jo), c(seq, jo + 1));
        if let Some(d3) = p.dangle_3(mode, &key) {
            if d3 < best {
                best = d3;
            }
        }
    }
    best
}

/// `_sum_elements`: per-element energy of a single hairpin, `pairs`
/// outermost-first (as produced by `hairpin::hairpin_mfe`'s traceback).
/// `dangles`: 0 (default) or 2 (dangling-end stacking at the closing pair —
/// Oligool's strider call always uses 2 for hairpins).
pub fn sum_hairpin_elements(mode: Mode, seq: &[u8], pairs: &[(usize, usize)], dangles: u8) -> f64 {
    let mut total = 0.0;
    for w in pairs.windows(2) {
        let (i, j) = w[0];
        let (ip, jp) = w[1];
        let nl = ip - i - 1;
        let nr = j - jp - 1;
        total += if nl == 0 && nr == 0 { stack_energy(mode, seq, i, j) } else { interior_bulge_energy(mode, seq, i, j, ip, jp, nl, nr) };
    }
    let (il, jl) = *pairs.last().expect("hairpin must have at least one pair");
    total += hairpin_loop_energy(mode, seq, il, jl);

    if dangles == 2 {
        let (io, jo) = pairs[0];
        total += hairpin_exterior_dangle_bonus(mode, seq, io, jo);
    }
    total
}

/// Parse a dot-bracket string into outermost-first pairs for a single
/// unbranched hairpin; `None` for multiloops/pseudoknots/unpaired input.
/// Port of `structure_thermo.parse_hairpin_pairs`.
pub fn parse_hairpin_pairs(structure: &str) -> Option<Vec<(usize, usize)>> {
    let mut stack = Vec::new();
    let mut pairs = Vec::new();
    for (k, ch) in structure.chars().enumerate() {
        match ch {
            '(' => stack.push(k),
            ')' => {
                let open = stack.pop()?;
                pairs.push((open, k));
            }
            '.' => {}
            _ => return None,
        }
    }
    if !stack.is_empty() || pairs.is_empty() {
        return None;
    }
    pairs.sort();
    for a in 1..pairs.len() {
        if !(pairs[a].0 > pairs[a - 1].0 && pairs[a].1 < pairs[a - 1].1) {
            return None;
        }
    }
    Some(pairs)
}

/// `structure_free_energy`/`structure_enthalpy`: ΔG or ΔH (kcal/mol) of a
/// folded hairpin, selected by `mode`.
pub fn structure_energy_hairpin(mode: Mode, seq: &[u8], pairs: &[(usize, usize)], dangles: u8) -> f64 {
    sum_hairpin_elements(mode, seq, pairs, dangles)
}

// ─── dimer (bimolecular) ────────────────────────────────────────────────────

/// Parse dimer pairs from a dot-bracket string over the concatenated
/// `seq1+seq2` (or an explicit pairs list), keeping only inter-strand pairs
/// (`i < n1 <= j`) and validating a single nested helix. Port of
/// `structure_thermo.parse_dimer_pairs`.
pub fn parse_dimer_pairs_dotbracket(structure: &str, n1: usize) -> Result<Vec<(usize, usize)>, &'static str> {
    let mut stack = Vec::new();
    let mut raw = Vec::new();
    for (k, ch) in structure.chars().enumerate() {
        match ch {
            '(' => stack.push(k),
            ')' => {
                let open = stack.pop().ok_or("unbalanced dot-bracket structure")?;
                raw.push((open, k));
            }
            '.' => {}
            _ => return Err("invalid character in dot-bracket structure"),
        }
    }
    if !stack.is_empty() {
        return Err("unbalanced dot-bracket structure");
    }
    validate_dimer_pairs(raw.into_iter().filter(|&(i, j)| i < n1 && j >= n1).collect(), n1)
}

pub fn validate_dimer_pairs(mut pairs: Vec<(usize, usize)>, _n1: usize) -> Result<Vec<(usize, usize)>, &'static str> {
    if pairs.len() < 2 {
        return Err("dimer helix must contain at least two inter-strand base pairs");
    }
    pairs.sort();
    for a in 1..pairs.len() {
        let (prev_i, prev_j) = pairs[a - 1];
        let (i, j) = pairs[a];
        if !(prev_i < i && j < prev_j) {
            return Err("dimer structure must be a single nested helix");
        }
    }
    Ok(pairs)
}

fn to_dotbracket(n: usize, pairs: &[(usize, usize)]) -> String {
    let mut s = vec!['.'; n];
    for &(i, j) in pairs {
        s[i] = '(';
        s[j] = ')';
    }
    s.into_iter().collect()
}

/// `_sum_dimer_elements`: per-element ΔG/ΔH of a single nested bimolecular
/// duplex. `pairs` outermost-first, every pair satisfying `i < seq1_len <= j`
/// on the concatenated `seq`. `dangles`: 0 (no exterior dangling ends,
/// Oligool's default for dimers) or 2 (both flanks of both termini).
pub fn sum_dimer_elements(mode: Mode, seq: &[u8], seq1_len: usize, pairs: &[(usize, usize)], dangles: u8) -> f64 {
    let mut paired = std::collections::HashSet::new();
    for &(i, j) in pairs {
        paired.insert(i);
        paired.insert(j);
    }

    let mut total = 0.0;
    for w in pairs.windows(2) {
        let (i, j) = w[0];
        let (ip, jp) = w[1];
        let nl = ip - i - 1;
        let nr = j - jp - 1;
        total += if nl == 0 && nr == 0 { stack_energy(mode, seq, i, j) } else { interior_bulge_energy(mode, seq, i, j, ip, jp, nl, nr) };
    }

    let (i_out, j_out) = pairs[0];
    total += terminal_pair_penalty(mode, seq, i_out, j_out);
    let (i_in, j_in) = *pairs.last().unwrap();
    total += terminal_pair_penalty(mode, seq, i_in, j_in);

    if dangles != 2 {
        return total;
    }

    let p = params();
    let n = seq.len();
    if i_out >= 1 && !paired.contains(&(i_out - 1)) {
        let key = format!("{}{}{}", c(seq, i_out), c(seq, j_out), c(seq, i_out - 1));
        if let Some(d5) = p.dangle_5(mode, &key) {
            if d5 < 0.0 {
                total += d5;
            }
        }
    }
    if j_out + 1 < n && !paired.contains(&(j_out + 1)) {
        let key = format!("{}{}{}", c(seq, j_out - 1), c(seq, j_out), c(seq, j_out + 1));
        if let Some(d3) = p.dangle_3(mode, &key) {
            if d3 < 0.0 {
                total += d3;
            }
        }
    }
    if j_in >= seq1_len + 1 && !paired.contains(&(j_in - 1)) {
        let key = format!("{}{}{}", c(seq, j_in), c(seq, i_in), c(seq, j_in - 1));
        if let Some(d5) = p.dangle_5(mode, &key) {
            if d5 < 0.0 {
                total += d5;
            }
        }
    }
    if i_in + 1 < seq1_len && !paired.contains(&(i_in + 1)) {
        let key = format!("{}{}{}", c(seq, i_in - 1), c(seq, i_in), c(seq, i_in + 1));
        if let Some(d3) = p.dangle_3(mode, &key) {
            if d3 < 0.0 {
                total += d3;
            }
        }
    }
    total
}

pub fn structure_energy_dimer(mode: Mode, seq: &[u8], seq1_len: usize, pairs: &[(usize, usize)], dangles: u8) -> f64 {
    sum_dimer_elements(mode, seq, seq1_len, pairs, dangles)
}

pub fn dotbracket(n: usize, pairs: &[(usize, usize)]) -> String {
    to_dotbracket(n, pairs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hairpin_pairs_rejects_multiloop() {
        // Two independent stems side by side inside one loop — a multiloop.
        assert!(parse_hairpin_pairs("((..))((..))").is_none());
    }

    #[test]
    fn parse_hairpin_pairs_accepts_nested_stem() {
        let pairs = parse_hairpin_pairs("((...))").unwrap();
        assert_eq!(pairs, vec![(0, 6), (1, 5)]);
    }

    #[test]
    fn dotbracket_roundtrip() {
        let pairs = vec![(0, 6), (1, 5)];
        assert_eq!(dotbracket(7, &pairs), "((...))");
    }
}
