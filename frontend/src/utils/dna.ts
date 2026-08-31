/** Ports of the legacy app's small DNA string helpers (`normalizeDNA`,
 * `reverseComplement`, and the accession-ID regex heuristic reused at two
 * call sites — gene-name-vs-accession dispatch, and BLAST-identify input
 * validation). */

export function cleanDNA(seq: string): string {
  return (seq || '').toUpperCase().replace(/[^ACGTN]/g, '');
}

const RC_MAP: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G', N: 'N' };

export function reverseComplement(seq: string): string {
  return seq
    .toUpperCase()
    .split('')
    .reverse()
    .map((b) => RC_MAP[b] || 'N')
    .join('');
}

/** e.g. `NR_132312.2`, `AL359314` — 1-4 letters, optional underscore, 5+
 * digits, optional version suffix. */
export function isAccessionId(input: string): boolean {
  return /[A-Za-z]{1,4}_?\d{5,}/.test(input);
}
