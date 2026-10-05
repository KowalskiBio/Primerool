import type { BlastHit } from '../api/blast';
import { THREE_PRIME_WINDOW, type AlignmentColumn, type PrimerHitAssessment } from '../utils/primerAlignment';

const KIND_CLASS: Record<AlignmentColumn['kind'], string> = {
  match: 'text-ink',
  mismatch: 'bg-danger-subtle font-semibold text-danger',
  gap: 'bg-danger-subtle font-semibold text-danger',
  unaligned: 'text-ink-faint',
};

/** A primer's BLAST hit as three aligned rows - primer 5'->3', match line,
 * target - with mismatches, gaps and the primer ends BLAST left unaligned
 * marked, and the 3'-terminal window (where a mismatch stops extension)
 * underlined. */
export default function PrimerHitAlignment({ hit, assessment }: { hit: BlastHit; assessment: PrimerHitAssessment }) {
  const len = Math.max(...assessment.columns.map((c) => c.qPos));
  const inWindow = (c: AlignmentColumn) => c.qPos > len - THREE_PRIME_WINDOW;
  const minus = hit.hit_from > hit.hit_to;

  const row = (pick: (c: AlignmentColumn) => string) =>
    assessment.columns.map((c, i) => (
      <span key={i} className={`${KIND_CLASS[c.kind]} ${inWindow(c) ? 'underline decoration-accent decoration-2 underline-offset-4' : ''}`}>
        {pick(c)}
      </span>
    ));

  return (
    <div className="overflow-x-auto">
      <div className="inline-grid grid-cols-[auto_auto] gap-x-3 whitespace-pre font-mono text-xs leading-5">
        <span className="text-ink-faint">Primer 5′</span>
        <span>
          {row((c) => c.primer)}
          <span className="text-ink-faint"> 3′</span>
        </span>
        <span />
        <span className="text-ink-faint">{assessment.columns.map((c) => (c.kind === 'match' ? '|' : c.kind === 'unaligned' ? ' ' : '×')).join('')}</span>
        <span className="text-ink-faint">Target</span>
        <span>
          {row((c) => c.target || '·')}
          <span className="text-ink-faint">
            {' '}
            {hit.hit_from.toLocaleString()}–{hit.hit_to.toLocaleString()} ({minus ? 'minus' : 'plus'} strand)
          </span>
        </span>
      </div>
    </div>
  );
}
