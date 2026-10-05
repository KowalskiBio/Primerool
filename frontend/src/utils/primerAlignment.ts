// Judging a primer's BLAST hit by *where* it mismatches, not just its
// overall identity: polymerase extends from the primer's 3' end, so a hit
// whose 3'-terminal bases mismatch is unlikely to prime even at high
// identity, while one with only 5'-end mismatches can still amplify.
//
// The rule is Primer-BLAST's default specificity check: a target with 2+
// mismatches within the primer's last 5 bases (3' end), or 6+ mismatches
// overall, is not expected to amplify.

import type { BlastHit, HitFlanks } from '../api/blast';

/** How many 3'-terminal bases the 3'-end mismatch count looks at. */
export const THREE_PRIME_WINDOW = 5;
/** Total mismatches from which a hit is ignored outright. */
const MAX_TOTAL_MISMATCHES = 6;

export type ColumnKind = 'match' | 'mismatch' | 'gap' | 'unaligned';

/** One alignment column. `qPos` is the 1-based primer position it belongs
 * to - for a base the target has but the primer lacks (a `-` in the
 * primer row), the primer position just before it. */
export interface AlignmentColumn {
  primer: string;
  target: string;
  kind: ColumnKind;
  qPos: number;
}

export type PrimingLevel = 'perfect' | 'risk' | 'weak' | 'unlikely';

export interface PrimerHitAssessment {
  columns: AlignmentColumn[];
  /** Mismatches, gaps and unaligned primer bases, over the whole primer. */
  mismatches: number;
  /** The same, within the last `THREE_PRIME_WINDOW` primer bases. */
  threePrimeMismatches: number;
  /** Whether the primer's very last (3'-terminal) base fails to match. */
  terminalMismatch: boolean;
  level: PrimingLevel;
  label: string;
  reason: string;
}

/** Lays `primer` (5'->3', as BLASTed) against `hit`'s best HSP. The
 * primer ends BLAST's local alignment left out are padded as `unaligned`
 * — they did not extend into the hit, so they count as mismatches —
 * unless `flanks` (from `/blast_hit_flanks`) supplies the subject bases
 * those positions actually oppose, in which case each becomes a real
 * `match`/`mismatch` column: the 5' bases arrive right-aligned to the
 * alignment edge, the 3' bases left-aligned, and positions past the end
 * of the hit's own sequence (or after a failed fetch) stay `unaligned`.
 * `null` when the hit carries no alignment (a direct-accession hit, or
 * one saved before alignments were returned). */
export function assessPrimerHit(primer: string, hit: BlastHit, flanks?: HitFlanks | null): PrimerHitAssessment | null {
  const { qseq, hseq } = hit;
  if (!qseq || !hseq || qseq.length !== hseq.length || hit.query_from < 1) return null;
  const seq = primer.toUpperCase();
  const len = seq.length;
  const columns: AlignmentColumn[] = [];

  // 5' flank: fetched bases are right-aligned against the alignment, so
  // position i has a base only from hit.query_from - five.length on.
  const five = flanks?.five ?? '';
  for (let i = 1; i < hit.query_from; i++) {
    const target = i >= hit.query_from - five.length ? (five[i - (hit.query_from - five.length)] ?? '').toUpperCase() : '';
    const q = seq[i - 1];
    columns.push({ primer: q, target, kind: target === '' ? 'unaligned' : q === target ? 'match' : 'mismatch', qPos: i });
  }
  let pos = hit.query_from - 1;
  for (let j = 0; j < qseq.length; j++) {
    const q = qseq[j].toUpperCase();
    const h = hseq[j].toUpperCase();
    if (q !== '-') pos++;
    const kind: ColumnKind = q === '-' || h === '-' ? 'gap' : q === h ? 'match' : 'mismatch';
    columns.push({ primer: q, target: h, kind, qPos: Math.max(pos, hit.query_from) });
  }
  // 3' flank: fetched bases are left-aligned against the alignment.
  const three = flanks?.three ?? '';
  for (let i = hit.query_to + 1; i <= len; i++) {
    const target = ((three[i - hit.query_to - 1] ?? '') as string).toUpperCase();
    const q = seq[i - 1];
    columns.push({ primer: q, target, kind: target === '' ? 'unaligned' : q === target ? 'match' : 'mismatch', qPos: i });
  }

  const bad = columns.filter((c) => c.kind !== 'match');
  const mismatches = bad.length;
  const threePrimeMismatches = bad.filter((c) => c.qPos > len - THREE_PRIME_WINDOW).length;
  const terminalMismatch = bad.some((c) => c.qPos === len && c.primer !== '-');

  let level: PrimingLevel;
  let label: string;
  let reason: string;
  if (mismatches >= MAX_TOTAL_MISMATCHES) {
    level = 'unlikely';
    label = 'Unlikely to prime';
    reason = `${mismatches} mismatches in total`;
  } else if (threePrimeMismatches >= 2) {
    level = 'unlikely';
    label = 'Unlikely to prime';
    reason = `${threePrimeMismatches} mismatches in the 3′-terminal ${THREE_PRIME_WINDOW} nt`;
  } else if (threePrimeMismatches === 1) {
    level = 'weak';
    label = 'Weak priming';
    reason = terminalMismatch ? 'the 3′-terminal base mismatches' : `1 mismatch in the 3′-terminal ${THREE_PRIME_WINDOW} nt`;
  } else if (mismatches === 0) {
    level = 'perfect';
    label = 'Perfect match';
    reason = 'every base matches';
  } else {
    level = 'risk';
    label = 'Can prime';
    reason = mismatches === 1 ? '1 mismatch, outside the 3′ end' : `${mismatches} mismatches, all outside the 3′ end`;
  }

  return { columns, mismatches, threePrimeMismatches, terminalMismatch, level, label, reason };
}
