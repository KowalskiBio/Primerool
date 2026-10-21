/** IUPAC nucleotide ambiguity codes as 4-bit base sets (A=1, C=2, G=4,
 * T=8) - mirrors `crates/engine/src/iupac.rs`. */

const BITS: Record<string, number> = { A: 1, C: 2, G: 4, T: 8, U: 8, M: 3, R: 5, W: 9, S: 6, Y: 10, K: 12, V: 7, H: 11, D: 13, B: 14, N: 15 };
const CODES = '-ACMGRSVTWYHKDBN';

/** The bases a character stands for; 0 for a gap or anything unknown. */
export function baseBits(b: string | undefined): number {
  return (b && BITS[b.toUpperCase()]) || 0;
}

/** The IUPAC character for a set of bases (`-` for the empty set). */
export function iupacCode(bits: number): string {
  return CODES[bits & 15];
}

function popcount(x: number): number {
  let n = 0;
  for (let v = x; v; v >>= 1) n += v & 1;
  return n;
}

/** Complement of one IUPAC character; anything else unchanged. */
export function complementBase(b: string): string {
  const x = baseBits(b);
  if (!x) return b;
  return iupacCode(((x & 1) << 3) | ((x & 8) >> 3) | ((x & 2) << 1) | ((x & 4) >> 1));
}

/** How many plain-ACGT sequences a degenerate one stands for. */
export function degeneracy(seq: string): number {
  let n = 1;
  for (const b of seq) n *= Math.max(1, popcount(baseBits(b)));
  return n;
}

export function isDegenerate(seq: string): boolean {
  for (const b of seq) if (popcount(baseBits(b)) > 1) return true;
  return false;
}

/** Whether a base (itself possibly a code) is one the code accepts. */
export function fitsCode(base: string | undefined, code: string | undefined): boolean {
  const b = baseBits(base);
  return b !== 0 && (b & ~baseBits(code)) === 0;
}
