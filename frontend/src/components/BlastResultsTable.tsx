import { Fragment } from 'react';
import type { BlastHit } from '../api/blast';
import { assessPrimerHit, THREE_PRIME_WINDOW, type PrimingLevel } from '../utils/primerAlignment';
import PrimerHitAlignment from './PrimerHitAlignment';
import Badge from './ui/Badge';
import Button from './ui/Button';

const LEVEL_TONE: Record<PrimingLevel, 'accent' | 'danger' | 'warning' | 'success'> = {
  perfect: 'accent',
  risk: 'danger',
  weak: 'warning',
  unlikely: 'success',
};

const LEVEL_LABEL: Record<PrimingLevel, string> = {
  perfect: 'perfect',
  risk: 'can prime',
  weak: 'weak',
  unlikely: 'unlikely',
};

interface Props {
  hits: BlastHit[];
  /** Absent hides the "Action" column - e.g. BLASTing a stretch picked from
   * the sequence map, where there's no gene to load from a hit. */
  onUse?: (hit: BlastHit) => void;
  /** The primer (5'->3') these hits are for: switches on primer mode -
   * every hit, each judged by where it mismatches (see
   * `utils/primerAlignment.ts`) with its alignment shown beneath it. */
  primer?: string;
}

export default function BlastResultsTable({ hits, onUse, primer }: Props) {
  const top = primer ? hits : hits.slice(0, 10);
  const columnCount = 8 + (primer ? 1 : 0) + (onUse ? 1 : 0);
  const assessments = top.map((hit) => (primer ? assessPrimerHit(primer, hit) : null));
  const levelCounts = (Object.keys(LEVEL_TONE) as PrimingLevel[])
    .map((level) => ({ level, count: assessments.filter((a) => a?.level === level).length }))
    .filter((c) => c.count > 0);

  return (
    <div className="overflow-x-auto">
      {primer && (
        <p className="mb-3 text-xs text-ink-muted">
          Polymerase extends from the primer&rsquo;s 3′ end, so a hit mismatched there is unlikely to amplify even at high identity, while 5′-end mismatches are tolerated. A hit with 2+ mismatches in the 3′-terminal {THREE_PRIME_WINDOW} nt
          (<span className="underline decoration-accent decoration-2 underline-offset-4">underlined</span>) or 6+ in total is not expected to prime (Primer-BLAST&rsquo;s default rule). Primer ends BLAST left unaligned (<span className="text-ink-faint">·</span>) count as mismatches.
        </p>
      )}
      {primer && levelCounts.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
          {top.length} hit{top.length === 1 ? '' : 's'}:
          {levelCounts.map(({ level, count }) => (
            <Badge key={level} tone={LEVEL_TONE[level]}>
              {count} {LEVEL_LABEL[level]}
            </Badge>
          ))}
        </div>
      )}
      <table className="w-full text-left text-sm text-ink-muted">
        <thead className="text-xs uppercase text-ink-muted bg-surface-2">
          <tr>
            <th className="border-b border-line px-4 py-3 font-medium">#</th>
            {primer && <th className="border-b border-line px-4 py-3 font-medium">Priming</th>}
            <th className="border-b border-line px-4 py-3 font-medium">Organism</th>
            <th className="border-b border-line px-4 py-3 font-medium">Gene</th>
            <th className="border-b border-line px-4 py-3 font-medium">Description</th>
            <th className="border-b border-line px-4 py-3 font-medium">Accession</th>
            <th className="border-b border-line px-4 py-3 font-medium">Query Cover</th>
            <th className="border-b border-line px-4 py-3 font-medium">Identity</th>
            <th className="border-b border-line px-4 py-3 font-medium">E-value</th>
            {onUse && <th className="border-b border-line px-4 py-3 font-medium">Action</th>}
          </tr>
        </thead>
        <tbody>
          {top.map((hit, i) => {
            const assessment = assessments[i];
            return (
              <Fragment key={`${hit.accession}-${i}`}>
                <tr className={`bg-surface text-xs hover:bg-surface-2 ${primer ? '' : 'border-b border-line last:border-0'}`}>
                  <td className="px-4 py-3 tabular-nums">{i + 1}</td>
                  {primer && (
                    <td className="min-w-[10rem] px-4 py-3">
                      {assessment ? (
                        <Badge tone={LEVEL_TONE[assessment.level]} title={assessment.reason} className="whitespace-nowrap">
                          {assessment.label}
                        </Badge>
                      ) : (
                        <span className="text-ink-faint" title="No alignment returned for this hit - re-run BLAST to get one">
                          -
                        </span>
                      )}
                      {assessment && <div className="mt-1 text-[11px] text-ink-faint">{assessment.reason}</div>}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <em>{hit.organism}</em>
                  </td>
                  <td className="px-4 py-3">
                    <strong className="font-medium text-ink">{hit.gene_symbol || <span className="text-ink-faint">-</span>}</strong>
                  </td>
                  <td className="px-4 py-3">
                    <div className="min-w-[200px]" title={hit.title}>
                      {hit.title}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono">
                    <a href={`https://www.ncbi.nlm.nih.gov/nuccore/${hit.accession}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      {hit.accession}
                    </a>
                  </td>
                  <td className="px-4 py-3 tabular-nums">{hit.query_cover ?? '-'}%</td>
                  <td className="px-4 py-3 tabular-nums">{hit.identity_pct}%</td>
                  <td className="px-4 py-3 tabular-nums">{hit.evalue !== null ? hit.evalue.toExponential(1) : '-'}</td>
                  {onUse && (
                    <td className="px-4 py-3">
                      <Button size="sm" onClick={() => onUse(hit)}>
                        Use
                      </Button>
                    </td>
                  )}
                </tr>
                {primer && (
                  <tr className="border-b border-line bg-surface last:border-0">
                    <td />
                    <td colSpan={columnCount - 1} className="px-4 pb-3">
                      {assessment ? <PrimerHitAlignment hit={hit} assessment={assessment} /> : <span className="text-xs text-ink-faint">No alignment available for this hit.</span>}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
