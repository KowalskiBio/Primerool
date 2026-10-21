/** One row of a multiple alignment: its name and gapped sequence. */
export interface AlignedRow {
  id: string;
  /** Upper-case bases and `-` gaps, all rows the same length. */
  seq: string;
}

/** Per-column facts the alignment view draws from. */
export interface AlignmentAnalysis {
  rows: AlignedRow[];
  length: number;
  /** Per column: the most common base (ignoring gaps), `''` if all gaps. */
  consensus: string[];
  /** Per column: every row has the same base (no gaps). */
  conserved: boolean[];
  /** Per column: at least one row has a gap. */
  gapped: boolean[];
  /** Per column: the share of rows carrying the consensus base (a gap
   * counts as not carrying it), 0-1. */
  identity: number[];
  /** Per row: bases (not gaps) before each column - its numbering. */
  residuesBefore: number[][];
  stats: { identical: number; mismatch: number; gapColumns: number };
}

/** Reads MAFFT's aligned FASTA, keeping gaps (unlike `parseMultiFasta`,
 * which cleans sequences down to bases). */
export function parseAlignedFasta(text: string): AlignedRow[] {
  const rows: AlignedRow[] = [];
  for (const block of text.split(/^>/m)) {
    if (!block.trim()) continue;
    const [header, ...lines] = block.split(/\r?\n/);
    const seq = lines.join('').replace(/\s/g, '').toUpperCase();
    if (seq) rows.push({ id: header.trim() || `seq${rows.length + 1}`, seq });
  }
  return rows;
}

export function analyzeAlignment(rows: AlignedRow[]): AlignmentAnalysis {
  const length = Math.max(0, ...rows.map((r) => r.seq.length));
  const consensus: string[] = [];
  const conserved: boolean[] = [];
  const gapped: boolean[] = [];
  const identity: number[] = [];
  const stats = { identical: 0, mismatch: 0, gapColumns: 0 };

  for (let c = 0; c < length; c++) {
    const counts = new Map<string, number>();
    let gaps = 0;
    for (const r of rows) {
      const b = r.seq[c] ?? '-';
      if (b === '-' || b === '.') gaps++;
      else counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    let best = '';
    let bestN = 0;
    for (const [b, n] of counts) if (n > bestN) [best, bestN] = [b, n];
    consensus.push(best);
    gapped.push(gaps > 0);
    identity.push(rows.length ? bestN / rows.length : 0);
    const allSame = gaps === 0 && counts.size === 1;
    conserved.push(allSame);
    if (gaps > 0) stats.gapColumns++;
    else if (allSame) stats.identical++;
    else stats.mismatch++;
  }

  const residuesBefore = rows.map((r) => {
    const out: number[] = new Array(length + 1);
    let n = 0;
    for (let c = 0; c <= length; c++) {
      out[c] = n;
      const b = r.seq[c];
      if (b && b !== '-' && b !== '.') n++;
    }
    return out;
  });

  return { rows, length, consensus, conserved, gapped, identity, residuesBefore, stats };
}

/** A run of alignment columns `[start, end)` conserved enough to put a
 * primer in. */
export interface ConservedWindow {
  start: number;
  end: number;
  /** The lowest column identity inside it, 0-1. */
  minIdentity: number;
}

/** Every maximal run of at least `minLength` columns whose identity is at
 * least `minIdentity`, in alignment order. */
export function findConservedWindows(identity: number[], minIdentity: number, minLength: number): ConservedWindow[] {
  const windows: ConservedWindow[] = [];
  let start = -1;
  let low = 1;
  for (let c = 0; c <= identity.length; c++) {
    const ok = c < identity.length && identity[c] >= minIdentity - 1e-9;
    if (ok) {
      if (start < 0) [start, low] = [c, 1];
      low = Math.min(low, identity[c]);
    } else if (start >= 0) {
      if (c - start >= minLength) windows.push({ start, end: c, minIdentity: low });
      start = -1;
    }
  }
  return windows;
}

/** Percent identity of two aligned rows over the columns where both have
 * a base (BLAST-style: gaps don't count against it), and how many such
 * columns there are - the overlap, which breaks ties. */
export function percentIdentity(a: AlignedRow, b: AlignedRow): { identity: number; overlap: number } {
  let same = 0;
  let overlap = 0;
  const n = Math.min(a.seq.length, b.seq.length);
  for (let c = 0; c < n; c++) {
    const x = a.seq[c];
    const y = b.seq[c];
    if (x === '-' || x === '.' || y === '-' || y === '.') continue;
    overlap++;
    if (x === y) same++;
  }
  return { identity: overlap ? (100 * same) / overlap : 0, overlap };
}
