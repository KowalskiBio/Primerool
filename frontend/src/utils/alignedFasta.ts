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

  return { rows, length, consensus, conserved, gapped, residuesBefore, stats };
}
