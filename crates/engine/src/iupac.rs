//! IUPAC nucleotide ambiguity codes for degenerate primers: each code as a
//! 4-bit set of the bases it stands for (A=1, C=2, G=4, T=8), so unions,
//! complements and "does this base fit" are bit operations.

/// The bases a character stands for; 0 for a gap or anything unknown.
pub fn bits(b: u8) -> u8 {
    match b.to_ascii_uppercase() {
        b'A' => 1,
        b'C' => 2,
        b'G' => 4,
        b'T' | b'U' => 8,
        b'M' => 3,
        b'R' => 5,
        b'W' => 9,
        b'S' => 6,
        b'Y' => 10,
        b'K' => 12,
        b'V' => 7,
        b'H' => 11,
        b'D' => 13,
        b'B' => 14,
        b'N' => 15,
        _ => 0,
    }
}

const CODES: [u8; 16] = [b'-', b'A', b'C', b'M', b'G', b'R', b'S', b'V', b'T', b'W', b'Y', b'H', b'K', b'D', b'B', b'N'];

/// The IUPAC character for a set of bases (`-` for the empty set).
pub fn code(bits: u8) -> u8 {
    CODES[(bits & 15) as usize]
}

/// Complement of one IUPAC character (A↔T, C↔G, R↔Y, K↔M, B↔V, D↔H; S, W
/// and N are their own). Anything else is returned unchanged.
pub fn complement(b: u8) -> u8 {
    let x = bits(b);
    if x == 0 {
        return b;
    }
    code(((x & 1) << 3) | ((x & 8) >> 3) | ((x & 2) << 1) | ((x & 4) >> 1))
}

pub fn reverse_complement(seq: &str) -> String {
    seq.bytes().rev().map(|b| complement(b) as char).collect()
}

/// How many plain-ACGT sequences a degenerate one stands for (saturating).
pub fn degeneracy(seq: &str) -> u64 {
    seq.bytes().map(|b| (bits(b).count_ones() as u64).max(1)).fold(1u64, |acc, n| acc.saturating_mul(n))
}

/// Whether any position stands for more than one base.
pub fn is_degenerate(seq: &str) -> bool {
    seq.bytes().any(|b| bits(b).count_ones() > 1)
}

/// Every plain-ACGT sequence a degenerate one stands for, or `None` when
/// there are more than `cap`.
pub fn expand(seq: &str, cap: usize) -> Option<Vec<String>> {
    if degeneracy(seq) > cap as u64 {
        return None;
    }
    let mut out = vec![String::with_capacity(seq.len())];
    for b in seq.bytes() {
        let x = bits(b);
        if x.count_ones() <= 1 {
            let c = if x == 0 { b.to_ascii_uppercase() } else { code(x) };
            out.iter_mut().for_each(|s| s.push(c as char));
            continue;
        }
        out = out
            .into_iter()
            .flat_map(|s| {
                [1u8, 2, 4, 8].into_iter().filter(move |&bit| x & bit != 0).map(move |bit| {
                    let mut v = s.clone();
                    v.push(code(bit) as char);
                    v
                })
            })
            .collect();
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complements_every_code() {
        assert_eq!(reverse_complement("ACGTRYKMBVDHSWN"), "NWSDHBVKMRYACGT");
    }

    #[test]
    fn counts_and_expands_variants() {
        let seq = "GGACTACNVGGGTWTCTAAT";
        assert_eq!(degeneracy(seq), 24);
        let v = expand(seq, 64).unwrap();
        assert_eq!(v.len(), 24);
        assert!(v.contains(&"GGACTACAAGGGTATCTAAT".to_string()));
        assert!(v.iter().all(|s| !is_degenerate(s)));
        assert!(expand(seq, 10).is_none());
    }

    #[test]
    fn unions_back_to_codes() {
        assert_eq!(code(bits(b'A') | bits(b'G')), b'R');
        assert_eq!(code(bits(b'R') | bits(b'C')), b'V');
    }
}
