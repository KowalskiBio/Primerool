import { useState } from 'react';
import type { AlignedRow } from '../utils/alignedFasta';
import { ampliconSizes, primerMatches, THREE_PRIME_WINDOW, type AlignPrimer, type AlignPrimers } from '../utils/alignPrimers';
import { NameInput } from './PrimerSetsPanel';
import PrimerStructureModal from './PrimerStructureModal';
import Button from './ui/Button';

interface Props {
  /** The rows in view - conservation and product sizes are judged on these. */
  rows: AlignedRow[];
  primers: AlignPrimers;
  onChange: (side: 'F' | 'R', primer: AlignPrimer | null) => void;
}

function fmt(v: number | null | undefined, unit: string) {
  return v == null ? '–' : `${v}${unit}`;
}

function ampliconLabel(rows: AlignedRow[], f: AlignPrimer | null, r: AlignPrimer | null): string | null {
  if (!f || !r) return null;
  const res = ampliconSizes(rows, f, r);
  if ('error' in res) return res.error;
  if (res.sizes.length === 0) return null;
  const lo = Math.min(...res.sizes);
  const hi = Math.max(...res.sizes);
  return lo === hi ? `${lo.toLocaleString('en-US')} bp amplicon` : `${lo.toLocaleString('en-US')}–${hi.toLocaleString('en-US')} bp amplicon (varies by sequence)`;
}

/** How well the primer's site is conserved across the rows shown: exact
 * matches, then each mismatching sequence - 3'-end mismatches first, as
 * those are the ones that stop extension. */
function Conservation({ rows, primer }: { rows: AlignedRow[]; primer: AlignPrimer }) {
  const matches = primerMatches(rows, primer);
  if (matches.length === 0) return <span className="text-ink-faint">source sequence hidden - show it under Rows to check conservation</span>;
  const exact = matches.filter((m) => m.mismatches === 0).length;
  const off = matches.filter((m) => m.mismatches > 0).sort((x, y) => y.threePrime - x.threePrime || y.mismatches - x.mismatches);
  return (
    <span>
      <span className={exact === matches.length ? 'text-success' : 'text-ink'}>
        Matches {exact} of {matches.length} sequence{matches.length === 1 ? '' : 's'} exactly
      </span>
      {off.map((m) => (
        <span key={m.id} className="ml-2 inline-block" title={`${m.mismatches} differing base${m.mismatches === 1 ? '' : 's'}, ${m.threePrime} within the 3′-most ${THREE_PRIME_WINDOW}`}>
          · <span className="font-mono">{m.id}</span>{' '}
          <span className={m.threePrime > 0 ? 'text-danger' : 'text-warning'}>
            {m.mismatches} mm{m.threePrime > 0 ? `, ${m.threePrime} at 3′` : ''}
          </span>
        </span>
      ))}
    </span>
  );
}

/** The forward/reverse primers picked off the alignment, in the "My
 * primers" layout: Strider's numbers per primer, plus how well each site
 * is conserved across the sequences shown and the pair's product size in
 * each of them. */
export default function AlignmentPrimersPanel({ rows, primers, onChange }: Props) {
  const [structurePair, setStructurePair] = useState<{ label: string; forward: string; reverse?: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const list = [primers.F, primers.R].filter((p): p is AlignPrimer => p !== null);
  const amplicon = ampliconLabel(rows, primers.F, primers.R);

  function copy(p: AlignPrimer) {
    void navigator.clipboard?.writeText(p.sequence).then(() => {
      setCopied(p.side);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <div className="mt-4">
      <h4 className="mb-2 text-sm font-semibold text-ink">Alignment primers</h4>
      {list.length === 0 ? (
        <p className="rounded-md border border-dashed border-line px-3 py-3 text-sm text-ink-muted">
          No primers yet - drag across a sequence row in the alignment above, right-click the selection and choose forward (F) or reverse (R) primer.
        </p>
      ) : (
        <section className="min-w-0 rounded-md border border-line bg-surface p-3" aria-label="Alignment primer pair">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-ink">
              {primers.F && primers.R ? 'Primer pair' : primers.F ? 'Forward primer' : 'Reverse primer'}
              {amplicon && <span className="ml-2 font-normal text-ink-muted">· {amplicon}</span>}
            </span>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                onClick={() =>
                  setStructurePair(
                    primers.F && primers.R
                      ? { label: `${primers.F.name} × ${primers.R.name}`, forward: primers.F.sequence, reverse: primers.R.sequence }
                      : { label: list[0].name, forward: list[0].sequence },
                  )
                }
              >
                Structures
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onChange('F', null);
                  onChange('R', null);
                }}
              >
                Remove
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            {list.map((p) => {
              const a = p.analysis;
              return (
                <div key={p.side} className="rounded border border-line bg-base px-2 py-1.5">
                  <div className="flex flex-wrap items-center gap-x-2">
                    <NameInput value={p.name} onCommit={(name) => onChange(p.side, { ...p, name })} />
                    <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: p.side === 'F' ? 'var(--aln-fwd)' : 'var(--aln-rev)' }} />
                    <span className="text-[11px] uppercase tracking-wider text-ink-faint">{p.side === 'F' ? 'Forward' : 'Reverse'}</span>
                    <span className="text-[11px] text-ink-faint">
                      from <span className="font-mono">{p.rowId}</span> · columns {(p.colStart + 1).toLocaleString('en-US')}–{p.colEnd.toLocaleString('en-US')}
                    </span>
                    <span className="ml-auto flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => copy(p)}>
                        {copied === p.side ? 'Copied' : 'Copy'}
                      </Button>
                      <Button size="sm" variant="ghost" aria-label={`Remove ${p.name}`} onClick={() => onChange(p.side, null)}>
                        ✕
                      </Button>
                    </span>
                  </div>
                  <div className="break-all px-1.5 font-mono text-[13px] text-ink">
                    <span className="text-ink-faint">5&apos;-</span>
                    {p.sequence}
                    <span className="text-ink-faint">-3&apos;</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 px-1.5 text-[12px] text-ink-muted">
                    <span>{p.sequence.length} bp</span>
                    {a === undefined ? (
                      <span className="italic text-ink-faint">Strider…</span>
                    ) : a === null ? (
                      <span className="text-ink-faint">analysis unavailable</span>
                    ) : (
                      <>
                        <span>
                          Tm <span className="font-mono text-ink">{fmt(a.tm, '°C')}</span>
                        </span>
                        <span>
                          GC <span className="font-mono text-ink">{fmt(a.gc_percent, '%')}</span>
                        </span>
                        <span>
                          Hairpin <span className="font-mono text-ink">{a.hairpin.structure_found ? fmt(a.hairpin.tm, '°C') : 'none'}</span>
                        </span>
                        <span>
                          Self-dimer <span className="font-mono text-ink">{fmt(a.homodimer.dg, ' kcal/mol')}</span>
                        </span>
                      </>
                    )}
                  </div>
                  <div className="mt-0.5 px-1.5 text-[12px] text-ink-muted">
                    <Conservation rows={rows} primer={p} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
      <PrimerStructureModal pair={structurePair} onClose={() => setStructurePair(null)} />
    </div>
  );
}
