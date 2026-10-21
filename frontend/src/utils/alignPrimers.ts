import type { PrimerAnalysis } from '../api/design';
import type { AlignedRow } from './alignedFasta';
import { reverseComplement } from './dna';

/** A stretch of one alignment row the user dragged across: gapped columns
 * `[colStart, colEnd)`. */
export interface AlignPick {
  rowId: string;
  colStart: number;
  colEnd: number;
}

/** A primer picked straight off the alignment: the bases of one row over
 * a column range, read 5'→3' (a reverse primer is their reverse
 * complement). */
export interface AlignPrimer extends AlignPick {
  side: 'F' | 'R';
  sequence: string;
  name: string;
  /** Strider's numbers: `undefined` while loading, `null` on failure. */
  analysis?: PrimerAnalysis | null;
}

export interface AlignPrimers {
  F: AlignPrimer | null;
  R: AlignPrimer | null;
}

export const NO_ALIGN_PRIMERS: AlignPrimers = { F: null, R: null };

/** The 3'-most bases a mismatch there is called out for. */
export const THREE_PRIME_WINDOW = 5;

const isGap = (b: string | undefined) => !b || b === '-' || b === '.';

/** A row's bases over columns `[from, to)`, gaps dropped. */
export function rowBases(row: AlignedRow, from: number, to: number): string {
  return row.seq.slice(from, to).replace(/[-.]/g, '');
}

export function primerFromPick(row: AlignedRow, pick: Omit<AlignPick, 'rowId'>, side: 'F' | 'R', name: string): AlignPrimer {
  const bases = rowBases(row, pick.colStart, pick.colEnd);
  return { side, rowId: row.id, colStart: pick.colStart, colEnd: pick.colEnd, sequence: side === 'F' ? bases : reverseComplement(bases), name };
}

/** How one row matches a primer's binding stretch (the source row's
 * bases over the primer's columns): differing columns - a base against a
 * gap counts - and how many of them sit in the primer's 3'-most
 * `THREE_PRIME_WINDOW` bases (its right end for F, left end for R). */
export interface RowMatch {
  id: string;
  mismatches: number;
  threePrime: number;
}

export function primerMatches(rows: AlignedRow[], p: AlignPrimer): RowMatch[] {
  const src = rows.find((r) => r.id === p.rowId);
  if (!src) return [];
  // Distance of each column from the primer's 3' end, in source bases.
  const n = rowBases(src, p.colStart, p.colEnd).length;
  const dist: number[] = [];
  let k = 0;
  for (let c = p.colStart; c < p.colEnd; c++) {
    const idx = Math.min(k, n - 1);
    dist.push(p.side === 'F' ? n - 1 - idx : idx);
    if (!isGap(src.seq[c])) k++;
  }
  return rows.map((r) => {
    let mismatches = 0;
    let threePrime = 0;
    for (let c = p.colStart; c < p.colEnd; c++) {
      const a = src.seq[c];
      const b = r.seq[c];
      if (isGap(a) && isGap(b)) continue;
      if (isGap(a) || isGap(b) || a !== b) {
        mismatches++;
        if (dist[c - p.colStart] < THREE_PRIME_WINDOW) threePrime++;
      }
    }
    return { id: r.id, mismatches, threePrime };
  });
}

/** The pair's product per row - forward primer's first column through
 * the reverse primer's last, counted in that row's own bases - or a note
 * when the two don't face each other. Rows lacking either site are left
 * out. */
export function ampliconSizes(rows: AlignedRow[], f: AlignPrimer, r: AlignPrimer): { sizes: number[] } | { error: string } {
  if (f.colStart >= r.colStart || f.colEnd > r.colEnd) return { error: 'primers not in amplifying orientation (the forward primer must sit left of the reverse one)' };
  const sizes: number[] = [];
  for (const row of rows) {
    if (!rowBases(row, f.colStart, f.colEnd) || !rowBases(row, r.colStart, r.colEnd)) continue;
    sizes.push(rowBases(row, f.colStart, r.colEnd).length);
  }
  return { sizes };
}
