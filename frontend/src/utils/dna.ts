/** Ports of the legacy app's small DNA string helpers (`normalizeDNA`,
 * `reverseComplement`, and the accession-ID regex heuristic reused at two
 * call sites — gene-name-vs-accession dispatch, and BLAST-identify input
 * validation). */

import { baseBits, complementBase } from './iupac';

export function cleanDNA(seq: string): string {
  return (seq || '').toUpperCase().replace(/[^ACGTN]/g, '');
}

/** Reverse complement, IUPAC-aware: ambiguity codes complement to their
 * partner (R↔Y, K↔M, B↔V, D↔H; S, W, N stay). */
export function reverseComplement(seq: string): string {
  return seq
    .toUpperCase()
    .split('')
    .reverse()
    .map((b) => (baseBits(b) ? complementBase(b) : 'N'))
    .join('');
}

/** e.g. `NR_132312.2`, `AL359314` — 1-4 letters, optional underscore, 5+
 * digits, optional version suffix. */
export function isAccessionId(input: string): boolean {
  return /[A-Za-z]{1,4}_?\d{5,}/.test(input);
}
