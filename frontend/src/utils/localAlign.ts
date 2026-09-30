import type { SequenceData } from '../api/sequence';
import { cleanDNA, reverseComplement } from './dna';

/**
 * Smith-Waterman local alignment for the "Align in sequence" search: finds
 * where a pasted primer/amplicon best binds within the loaded (plus-strand)
 * sequence, tolerating mismatches and indels - unlike "Find in sequence",
 * which is a literal substring search.
 *
 * Runs fully in the browser. The DP is O(subject x query) and a query is a
 * primer-scale string (15-60 nt), so even a ~100 kb sequence costs tens of
 * millions of cell updates at worst - a few ms of plain integer math.
 */
export interface SwAlignment {
  /** Best local alignment score under the scoring below. */
  score: number;
  /** 0-based start of the aligned window in `subject` (as given). */
  subjectStart: number;
  /** End of the aligned window, exclusive. */
  subjectEnd: number;
  /** 0-based span of `query` actually covered by the alignment [start, end,
   * exclusive) - a trimmed local alignment covers only these bases of what
   * the user pasted, so callers can say so. */
  queryStart: number;
  queryEnd: number;
  /** Columns where both rows carry a base (excludes gap columns). */
  alignedColumns: number;
  matches: number;
  identityPct: number;
  /** Traceback rows; equal length, '-' marking gaps. */
  alignedQuery: string;
  alignedSubject: string;
}

// Conventional oligo-friendly scoring: matches dominate, a few mismatches
// still beat a gapped alignment, and opening a gap costs more than extending
// one (affine), so indels stay compact.
const MATCH = 2;
const MISMATCH = -3;
const GAP_OPEN = 5; // charged in addition to GAP_EXTEND for the first cell of a gap
const GAP_EXTEND = 1;

// Traceback state per cell: which predecessor gave its H value. Encoded as
// bit flags so the three predecessor matrices stay implicit.
const T_STOP = 0;
const T_DIAG = 1;
const T_LEFT = 4; // gap in subject (query base unpaired) - entered via the gap arrays
const T_UP = 8; // gap in query (subject base unpaired)

export function smithWaterman(subject: string, query: string): SwAlignment | null {
  const s = subject.toUpperCase();
  const q = query.toUpperCase();
  const n = s.length;
  const m = q.length;
  if (n === 0 || m === 0) return null;

  const cols = m + 1;
  // H rows (local alignment score) plus affine-gap helper rows; only the
  // current/previous H rows are needed for scores, but full matrices keep
  // the traceback simple, and at primer scale the memory is trivial:
  // 4 x (n+1) x (m+1) floats - ~25 MB even for a 100kb subject x 60nt query
  // …which is too much for a gratuitously long paste, so keep the traceback
  // matrices as typed arrays and it's ~4 bytes/cell.
  const size = (n + 1) * cols;
  const H = new Float32Array(size);
  const E = new Float32Array(size); // best score opening/extending a LEFT gap here
  const F = new Float32Array(size); // best score opening/extending an UP gap here
  const T = new Uint8Array(size);

  let best = 0;
  let bestI = 0;
  let bestJ = 0;

  for (let i = 1; i <= n; i++) {
    const si = s.charCodeAt(i - 1);
    const row = i * cols;
    const prevRow = row - cols;
    for (let j = 1; j <= m; j++) {
      const idx = row + j;
      const diag = H[prevRow + j - 1] + (si === q.charCodeAt(j - 1) ? MATCH : MISMATCH);
      const openLeft = H[idx - 1] - (GAP_OPEN + GAP_EXTEND);
      const extendLeft = E[idx - 1] - GAP_EXTEND;
      const left = Math.max(openLeft, extendLeft);
      const openUp = H[prevRow + j] - (GAP_OPEN + GAP_EXTEND);
      const extendUp = F[prevRow + j] - GAP_EXTEND;
      const up = Math.max(openUp, extendUp);
      const score = Math.max(0, diag, left, up);

      H[idx] = score;
      E[idx] = left;
      F[idx] = up;
      if (score === 0) T[idx] = T_STOP;
      else if (score === diag) T[idx] = T_DIAG;
      else if (score === left) T[idx] = T_LEFT;
      else T[idx] = T_UP;

      if (score > best) {
        best = score;
        bestI = i;
        bestJ = j;
      }
    }
  }

  if (best <= 0) return null;

  // Traceback from the best cell until a 0 - records the aligned rows in
  // reverse, then flips them.
  let aq: string[] = [];
  let as: string[] = [];
  let matches = 0;
  let alignedColumns = 0;
  let i = bestI;
  let j = bestJ;
  let endSubject = i;
  while (i > 0 && j > 0 && H[i * cols + j] > 0) {
    const t = T[i * cols + j];
    if (t === T_DIAG) {
      const qb = q[j - 1];
      const sb = s[i - 1];
      aq.push(qb);
      as.push(sb);
      alignedColumns++;
      if (qb === sb) matches++;
      i--;
      j--;
    } else if (t === T_LEFT) {
      aq.push(q[j - 1]);
      as.push('-');
      j--;
    } else if (t === T_STOP) {
      break;
    } else {
      aq.push('-');
      as.push(s[i - 1]);
      i--;
    }
  }

  const alignedQuery = aq.reverse().join('');
  const alignedSubject = as.reverse().join('');
  return {
    score: best,
    subjectStart: i,
    subjectEnd: endSubject,
    queryStart: j,
    queryEnd: bestJ,
    alignedColumns,
    matches,
    identityPct: alignedColumns > 0 ? (matches / alignedColumns) * 100 : 0,
    alignedQuery,
    alignedSubject,
  };
}

export interface AlignmentHit {
  /** 0-based span in the hit region's LOCAL coordinates - the same space
   * `SearchMatch`/cells use, so it drops straight into the viewer's search
   * highlight pipeline. */
  start: number;
  end: number;
  region: 'up' | 'gene' | 'down';
  /** Which strand of the user's sequence matched the map's plus strand:
   * '+' aligns as given, '-' means only its reverse complement matches
   * (i.e. the entry is a reverse-strand binding site). */
  strand: '+' | '-';
  score: number;
  matches: number;
  alignedColumns: number;
  identityPct: number;
  /** 0-based span [start, end, exclusive) of the ORIENTED pasted query the
   * alignment actually covers; the caller maps it back to the original
   * paste's coordinates for a "only bases X-Y of your sequence bind here"
   * note (for strand '-', position k of the oriented query is position
   * `query.length - k` of the paste). */
  queryStart: number;
  queryEnd: number;
  /** Traceback rows in map orientation (alignedSubject is the map slice,
   * alignedQuery the user's sequence, '-'-padded), for the detail view. */
  alignedQuery: string;
  alignedSubject: string;
}

/** Finds the best binding site of `customer` (a pasted primer/amplicon)
 * anywhere in the loaded sequence, trying both its sense and reverse
 * complement against each raw region (never the intron-truncated view).
 * `null` when nothing aligns at all. */
export function findBestAlignment(data: SequenceData, customer: string): AlignmentHit | null {
  const query = cleanDNA(customer);
  if (query.length < 2) return null;

  const regions: Array<[AlignmentHit['region'], string]> = [
    ['up', data.upstream_seq || ''],
    ['gene', data.gene_seq || ''],
    ['down', data.downstream_seq || ''],
  ];

  let best: AlignmentHit | null = null;
  for (const [region, raw] of regions) {
    if (!raw) continue;
    for (const [strand, oriented] of [
      ['+', query],
      ['-', reverseComplement(query)],
    ] as const) {
      const hit = smithWaterman(raw, oriented);
      if (!hit) continue;
      // Tie on score goes to the better-identity cell: a true 20/20 revcomp
      // match beats a same-scoring 19/20 sense one at the same locus, which
      // is the usual "user pasted a reverse primer" check.
      if (best && (hit.score < best.score || (hit.score === best.score && hit.matches <= best.matches))) continue;
      best = {
        start: hit.subjectStart,
        end: hit.subjectEnd,
        region,
        strand,
        score: hit.score,
        matches: hit.matches,
        alignedColumns: hit.alignedColumns,
        identityPct: hit.identityPct,
        queryStart: hit.queryStart,
        queryEnd: hit.queryEnd,
        alignedQuery: hit.alignedQuery,
        alignedSubject: hit.alignedSubject,
      };
    }
  }
  return best;
}
