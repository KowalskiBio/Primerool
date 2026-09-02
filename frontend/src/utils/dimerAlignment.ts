/** Shared duplex-alignment layout for rendering a bimolecular (self- or
 * hetero-) dimer from a dot-bracket structure: assigns every base a column
 * such that every actual base pair shares one column between strands (so a
 * "|"/":" bond always connects two bases in the same column, never a
 * diagonal), and any bulge/slip gets its own column with an empty slot on
 * the opposite strand — the standard nucleic-acid duplex-alignment
 * convention (matching primer3's own `thal()` ASCII output). This is a
 * proper gapped alignment, not the single-global-shift approach Oligool's
 * own dimer views (SVG and ASCII alike) use, which drops or misdraws any
 * bond outside whichever one offset that shift picked. */

export interface DimerPair {
  /** Index into `seq1` (0-based). */
  topIdx: number;
  /** Index into `seq2` (0-based). */
  botIdx: number;
}

/** Parses a dot-bracket over the concatenation `seq1 + seq2` into
 * inter-strand base pairs only (intra-strand folds within one strand are
 * a different, separate concern this alignment doesn't need). */
export function parseInterStrandPairs(structure: string, splitPoint: number): DimerPair[] {
  const stack: number[] = [];
  const pairs: DimerPair[] = [];
  for (let i = 0; i < structure.length; i++) {
    if (structure[i] === '(') {
      stack.push(i);
    } else if (structure[i] === ')') {
      const open = stack.pop();
      if (open === undefined) continue;
      const isInter = (open < splitPoint) !== (i < splitPoint);
      if (!isInter) continue;
      const topIdx = open < splitPoint ? open : i;
      const botIdx = (open < splitPoint ? i : open) - splitPoint;
      pairs.push({ topIdx, botIdx });
    }
  }
  return pairs;
}

/** Assigns every top/bottom-walk position a shared column index so that
 * every anchor (a base pair) lands both strands in the same column, and
 * any unpaired run between anchors gets exactly `max(topGapLen, botGapLen)`
 * columns — the standard "align two sequences given a set of non-crossing
 * anchors" merge, gap-filling whichever side has fewer unpaired bases in
 * that stretch. `anchors` must be sorted ascending and non-crossing (true
 * for any pseudoknot-free dot-bracket). */
function buildColumns(n1: number, n2: number, anchors: Array<[number, number]>): { topCol: number[]; botCol: number[]; totalCols: number } {
  const topCol = new Array(n1).fill(-1);
  const botCol = new Array(n2).fill(-1); // indexed by bottom-WALK position, not raw seq2 index
  let col = 0;
  let prevTop = -1;
  let prevBot = -1;
  for (const [ti, bi] of [...anchors, [n1, n2] as [number, number]]) {
    const topGapLen = ti - prevTop - 1;
    const botGapLen = bi - prevBot - 1;
    const gapCols = Math.max(topGapLen, botGapLen);
    for (let g = 0; g < topGapLen; g++) topCol[prevTop + 1 + g] = col + g;
    for (let g = 0; g < botGapLen; g++) botCol[prevBot + 1 + g] = col + g;
    col += gapCols;
    if (ti < n1) {
      topCol[ti] = col;
      botCol[bi] = col;
      col += 1;
    }
    prevTop = ti;
    prevBot = bi;
  }
  return { topCol, botCol, totalCols: col };
}

export interface DimerAlignment {
  /** Column index for each `seq1` base, in order. */
  topCol: number[];
  /** Column index for each `seq2` base, in order (not walk order). */
  botCol: number[];
  /** The base pairs used to build this alignment. */
  pairs: DimerPair[];
  totalCols: number;
}

/** Full alignment for a dimer (self or hetero) over `seq1`/`seq2` and a
 * dot-bracket `structure` defined over their concatenation. */
export function alignDimer(seq1: string, seq2: string, structure: string): DimerAlignment {
  const splitPoint = seq1.length;
  const pairs = parseInterStrandPairs(structure, splitPoint);

  // Bottom strand walked 3'->5' so the anchors below sort consistently
  // alongside the top strand's natural 5'->3' walk.
  const seq2IndexToWalk = (idx2: number) => seq2.length - 1 - idx2;
  const anchors: Array<[number, number]> = pairs.map(({ topIdx, botIdx }): [number, number] => [topIdx, seq2IndexToWalk(botIdx)]).sort((a, b) => a[0] - b[0]);

  const { topCol, botCol: botWalkCol, totalCols } = buildColumns(seq1.length, seq2.length, anchors);

  // Convert bottom-walk-indexed columns back to seq2-indexed columns.
  const botCol = new Array(seq2.length).fill(-1);
  for (let idx2 = 0; idx2 < seq2.length; idx2++) {
    botCol[idx2] = botWalkCol[seq2IndexToWalk(idx2)];
  }

  return { topCol, botCol, pairs, totalCols };
}
