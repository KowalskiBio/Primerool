import { useEffect, useRef, useState } from 'react';
import type { SequenceData } from '../api/sequence';
import { analyzePrimer } from '../api/design';
import { mapPrimerToGenomic, selectionStrand, type Selection, type Selections } from '../utils/regionMapping';
import PrimerStructureModal from './PrimerStructureModal';
import Button from './ui/Button';

interface Props {
  data: SequenceData;
  selections: Selections;
  onSelect: (key: keyof Selections, value: Selection | null) => void;
}

type Key = keyof Selections;

const GROUPS: { id: string; title: string; keys: Key[] }[] = [
  { id: 'wga', title: 'WGA pair', keys: ['wgaForward', 'wgaReverse'] },
  { id: 'general', title: 'General pair', keys: ['geneForward', 'geneReverse'] },
  { id: 'junction', title: 'Junction pair', keys: ['juncLeft', 'juncRight'] },
  { id: 'arms', title: 'ARMS', keys: ['armsRefPrimer', 'armsAltPrimer', 'armsCommon'] },
  { id: 'probe', title: 'TaqMan probe', keys: ['geneProbe'] },
];

function roleLabel(key: Key, sel: Selection): string {
  const dir = selectionStrand(sel) === 'F' ? 'Forward' : 'Reverse';
  if (key === 'armsRefPrimer') return `${dir} twin · wild type${sel.arms ? ` (${sel.arms.wtBase})` : ''}`;
  if (key === 'armsAltPrimer') return `${dir} twin · mutant${sel.arms ? ` (${sel.arms.mutBase})` : ''}`;
  if (key === 'armsCommon') return `${dir} common`;
  if (key === 'geneProbe') return 'Probe';
  return dir;
}

/** Product length of the General pair: from the forward primer's 5' end
 * to the reverse primer's 5' end, in gene coordinates - so on a genomic
 * (intron-inclusive) view it counts any introns in between. A message
 * instead when the two don't face each other with the forward upstream. */
function generalAmplicon(selections: Selections, data: SequenceData): string | null {
  const f = selections.geneForward;
  const r = selections.geneReverse;
  if (!f || !r) return null;
  const size = r.end - f.start;
  if (size <= 0 || f.start >= r.start) return 'primers not in amplifying orientation';
  return `${size.toLocaleString('en-US')} bp amplicon${data.include_introns ? ' (genomic)' : ''}`;
}

function fmt(v: number | null | undefined, unit: string) {
  return v == null ? '–' : `${v}${unit}`;
}

/** Where a selection sits in the genomic map: region + region-local index
 * of its first base (junction picks are mapped back from spliced
 * coordinates). */
function mapAnchor(sel: Selection, data: SequenceData): { region: string; pos: number } | null {
  if (sel.region !== 'spliced') return { region: sel.region, pos: sel.start };
  const r = mapPrimerToGenomic(sel, data)[0];
  return r ? { region: 'gene', pos: r.start } : null;
}

/** Scrolls the sequence map to a selection and briefly outlines it. */
function showInMap(sel: Selection, data: SequenceData) {
  const anchor = mapAnchor(sel, data);
  if (!anchor) return;
  const spans = document.querySelectorAll<HTMLElement>(`#sequence-map span[data-region="${anchor.region}"][data-pos]`);
  for (const el of spans) {
    const pos = Number(el.dataset.pos);
    if (anchor.pos >= pos && anchor.pos < pos + (el.textContent ?? '').length) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.animate([{ outline: '2px solid var(--accent)', outlineOffset: '1px' }, { outline: '2px solid transparent', outlineOffset: '1px' }], { duration: 1600, easing: 'ease-out' });
      return;
    }
  }
}

function NameInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setDraft(value);
  }
  const commit = () => {
    const v = draft.trim();
    if (v && v !== value) onCommit(v);
    else setDraft(value);
  };
  return (
    <input
      aria-label="Primer name"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="h-7 w-24 rounded border border-transparent bg-transparent px-1.5 font-mono text-[13px] font-semibold text-ink hover:border-line focus:border-accent focus:outline-none"
    />
  );
}

/** Every primer set made on this sequence - WGA, general and junction
 * pairs, the ARMS set and the probe - side by side, each with its Strider
 * numbers. Names are editable; "Show" jumps the map to the set, and
 * "Structures" opens the pair's hairpins/dimers/heterodimer. Sets persist
 * per sequence (see `utils/primerSetStore.ts`). */
export default function PrimerSetsPanel({ data, selections, onSelect }: Props) {
  const [structurePair, setStructurePair] = useState<{ label: string; forward: string; reverse?: string } | null>(null);
  const inFlight = useRef(new Set<string>());

  // Picks from the design panels arrive without a Strider analysis - fill
  // it in once, so every row shows the same engine's numbers.
  useEffect(() => {
    for (const g of GROUPS) {
      for (const key of g.keys) {
        const sel = selections[key];
        if (!sel || sel.analysis !== undefined || sel.source !== 'recommended') continue;
        const tag = `${key}:${sel.primerSeq}`;
        if (inFlight.current.has(tag)) continue;
        inFlight.current.add(tag);
        analyzePrimer({ sequence: sel.primerSeq, engine: 'strider' }).then(
          (analysis) => onSelect(key, { ...sel, analysis }),
          () => onSelect(key, { ...sel, analysis: null }),
        );
      }
    }
  }, [selections, onSelect]);

  const groups = GROUPS.map((g) => ({ ...g, rows: g.keys.flatMap((k) => (selections[k] ? [{ key: k, sel: selections[k]! }] : [])) })).filter((g) => g.rows.length > 0);

  return (
    <div className="mt-6">
      <h3 className="mb-2 text-sm font-semibold text-ink">My primers</h3>
      {groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-line px-3 py-3 text-sm text-ink-muted">
          No primers yet - select bases in the map above and right-click to make a WGA, general, junction or ARMS primer (or pick one from the design panels below).
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {groups.map((g) => {
            const twins = selections.armsRefPrimer;
            const amplicon = g.id === 'general' ? generalAmplicon(selections, data) : null;
            const title = g.id === 'arms' && twins ? `ARMS (${selectionStrand(twins) === 'F' ? '2 F + 1 R' : '1 F + 2 R'})` : g.title;
            const fwd = g.rows.find((r) => selectionStrand(r.sel) === 'F' && r.key !== 'armsAltPrimer')?.sel;
            const rev = g.rows.find((r) => selectionStrand(r.sel) === 'R' && r.key !== 'armsAltPrimer')?.sel;
            return (
              <section key={g.id} className="min-w-0 rounded-md border border-line bg-surface p-3" aria-label={title}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-ink">
                    {title}
                    {amplicon && <span className="ml-2 font-normal text-ink-muted">· {amplicon}</span>}
                  </span>
                  <div className="flex gap-1.5">
                    <Button size="sm" onClick={() => showInMap(g.rows[0].sel, data)}>
                      Show
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        setStructurePair(
                          fwd && rev
                            ? { label: `${title}: ${fwd.name ?? 'F'} × ${rev.name ?? 'R'}`, forward: fwd.primerSeq, reverse: rev.primerSeq }
                            : { label: `${title}: ${g.rows[0].sel.name ?? ''}`, forward: g.rows[0].sel.primerSeq },
                        )
                      }
                    >
                      Structures
                    </Button>
                    <Button size="sm" onClick={() => g.keys.forEach((k) => selections[k] && onSelect(k, null))}>
                      Remove
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  {g.rows.map(({ key, sel }) => {
                    const a = sel.analysis;
                    return (
                      <div key={key} className="rounded border border-line bg-base px-2 py-1.5">
                        <div className="flex flex-wrap items-center gap-x-2">
                          <NameInput value={sel.name ?? ''} onCommit={(name) => onSelect(key, { ...sel, name })} />
                          <span className="text-[11px] uppercase tracking-wider text-ink-faint">{roleLabel(key, sel)}</span>
                        </div>
                        <div className="break-all px-1.5 font-mono text-[13px] text-ink">
                          <span className="text-ink-faint">5&apos;-</span>
                          {sel.primerSeq}
                          <span className="text-ink-faint">-3&apos;</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-4 px-1.5 text-[12px] text-ink-muted">
                          <span>{sel.primerSeq.length} bp</span>
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
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <PrimerStructureModal pair={structurePair} onClose={() => setStructurePair(null)} />
    </div>
  );
}
