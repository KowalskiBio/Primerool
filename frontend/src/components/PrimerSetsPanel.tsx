import { useEffect, useRef, useState } from 'react';
import type { SequenceData } from '../api/sequence';
import { analyzePrimer } from '../api/design';
import { getCachedIdtToken, idtTm, type IdtTmResult } from '../api/idt';
import type { IdtCredentials } from '../utils/idtCredentials';
import { mapPrimerToGenomic, selectionStrand, type ProbeEditKey, type Selection, type Selections } from '../utils/regionMapping';
import { reverseComplement } from '../utils/dna';
import PrimerStructureModal from './PrimerStructureModal';
import Button from './ui/Button';

interface Props {
  data: SequenceData;
  selections: Selections;
  onSelect: (key: keyof Selections, value: Selection | null) => void;
  /** Which allele probe is currently unlocked for drag/resize on the
   * sequence map (null: both static). The two probes overlap almost
   * completely there, so editing is offered one at a time - when the
   * alleles' Tms disagree, one probe can be lengthened/shortened
   * independently of its twin. */
  probeEditKey: ProbeEditKey | null;
  onProbeEditKeyChange: (key: ProbeEditKey | null) => void;
  /** Complete IDT credentials, or undefined (the "IDT" button is then
   * disabled). */
  idtCredentials?: IdtCredentials;
}

type Key = keyof Selections;

const GROUPS: { id: string; title: string; keys: Key[] }[] = [
  { id: 'wga', title: 'WGA pair', keys: ['wgaForward', 'wgaReverse'] },
  { id: 'general', title: 'General pair', keys: ['geneForward', 'geneReverse'] },
  { id: 'junction', title: 'Junction pair', keys: ['juncLeft', 'juncRight'] },
  { id: 'arms', title: 'ARMS', keys: ['armsRefPrimer', 'armsAltPrimer', 'armsCommon'] },
  { id: 'probe', title: 'TaqMan probe', keys: ['geneProbe', 'geneProbeAlt'] },
];

function roleLabel(key: Key, sel: Selection): string {
  const dir = selectionStrand(sel) === 'F' ? 'Forward' : 'Reverse';
  if (key === 'armsRefPrimer') return `${dir} twin · wild type${sel.arms ? ` (${sel.arms.wtBase})` : ''}`;
  if (key === 'armsAltPrimer') return `${dir} twin · mutant${sel.arms ? ` (${sel.arms.mutBase})` : ''}`;
  if (key === 'armsCommon') return `${dir} common`;
  if (key === 'geneProbe') return `${dir} probe · wild type${sel.allele ? ` (${sel.allele.wtBase})` : ''}`;
  if (key === 'geneProbeAlt') return `${dir} probe · mutant${sel.allele ? ` (${sel.allele.mutBase})` : ''}`;
  if ((key === 'juncLeft' || key === 'juncRight') && sel.region !== 'spliced') return `${dir} · in the gene (partner crosses the junction)`;
  return dir;
}

/** A selection's span in one continuous coordinate space: gene-local for
 * flank/gene picks (upstream negative, downstream past `gene_len`), or the
 * spliced transcript for junction picks. */
function span(sel: Selection, data: SequenceData, forceGenomic = false): { space: 'genomic' | 'spliced'; start: number; end: number } {
  if (sel.region === 'spliced') {
    if (!forceGenomic) return { space: 'spliced', start: sel.start, end: sel.end };
    const r = mapPrimerToGenomic(sel, data);
    return { space: 'genomic', start: Math.min(...r.map((x) => x.start)), end: Math.max(...r.map((x) => x.end)) };
  }
  const shift = sel.region === 'up' ? -data.upstream_len : sel.region === 'down' ? data.gene_len : 0;
  return { space: 'genomic', start: sel.start + shift, end: sel.end + shift };
}

/** Product length of a primer set: from the forward primer's 5' end to
 * the reverse primer's 5' end. Genomic picks count any introns in between
 * on an intron-inclusive view (marked "genomic"); junction picks measure
 * the spliced product ("cDNA"). A note instead when the primers don't
 * face each other, or can't be compared (one spliced, one genomic). */
function ampliconLabel(fwd: Selection | undefined, rev: Selection | undefined, data: SequenceData): string | null {
  if (!fwd || !rev) return null;
  // One junction primer on the spliced transcript and its partner in the
  // gene (an intron): only an unspliced template carries both, so measure
  // the pair there.
  const mixed = (fwd.region === 'spliced') !== (rev.region === 'spliced');
  const f = span(fwd, data, mixed);
  const r = span(rev, data, mixed);
  if (!Number.isFinite(f.start) || !Number.isFinite(r.end)) return null;
  const size = r.end - f.start;
  // The forward (+ strand) pick must sit upstream of the reverse (- strand)
  // one. When it doesn't, the usual cause is roles assigned by a paper's
  // "sense/anti-sense" names on a minus-strand gene: the map is plus-strand
  // genomic, so that paper's "sense" primer is this map's reverse one.
  if (size <= 0 || f.start >= r.start) return 'primers not in amplifying orientation (F/R roles may be swapped)';
  const kind = mixed ? ' (unspliced template)' : f.space === 'spliced' ? ' (cDNA)' : data.include_introns ? ' (genomic)' : '';
  return `${size.toLocaleString('en-US')} bp amplicon${kind}`;
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

/** IDT's Tm, in blue beside Strider's. */
function IdtTm({ result }: { result: IdtTmResult | 'loading' }) {
  const base = 'ml-1.5 font-mono text-blue-600 dark:text-blue-400';
  if (result === 'loading') return <span className={`${base} italic`}>IDT…</span>;
  if (result.tm == null) {
    return (
      <span className={base} title={result.error}>
        IDT failed
      </span>
    );
  }
  return (
    <span className={base} title="IDT OligoAnalyzer Tm (same conditions as Strider)">
      IDT {result.tm.toFixed(1)}°C
    </span>
  );
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
 * numbers. Names are editable; "Show" jumps the map to the set,
 * "Structures" opens the pair's hairpins/dimers/heterodimer, and "IDT" adds
 * IDT OligoAnalyzer's Tm (same conditions) beside Strider's. Sets persist
 * per sequence (see `utils/primerSetStore.ts`). */
export default function PrimerSetsPanel({ data, selections, onSelect, probeEditKey, onProbeEditKeyChange, idtCredentials }: Props) {
  const [structurePair, setStructurePair] = useState<{ label: string; forward: string; reverse?: string } | null>(null);
  const inFlight = useRef(new Set<string>());
  // IDT Tm per primer sequence, for this page view only (not persisted).
  const [idtTms, setIdtTms] = useState<Record<string, IdtTmResult | 'loading'>>({});

  async function fetchIdtTms(seqs: string[]) {
    if (!idtCredentials) return;
    const unique = [...new Set(seqs)];
    const put = (value: (seq: string, i: number) => IdtTmResult | 'loading') =>
      setIdtTms((prev) => ({ ...prev, ...Object.fromEntries(unique.map((seq, i) => [seq, value(seq, i)])) }));
    put(() => 'loading');
    try {
      const token = await getCachedIdtToken({
        client_id: idtCredentials.clientId,
        client_secret: idtCredentials.clientSecret,
        username: idtCredentials.username,
        password: idtCredentials.password,
        idt_region: idtCredentials.region,
      });
      const { results } = await idtTm({ sequences: unique, token, idt_region: idtCredentials.region });
      put((_, i) => results[i] ?? { tm: null, error: 'No result' });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      put(() => ({ tm: null, error }));
    }
  }

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
        analyzePrimer({ sequence: sel.primerSeq }).then(
          (analysis) => onSelect(key, { ...sel, analysis }),
          () => onSelect(key, { ...sel, analysis: null }),
        );
      }
    }
  }, [selections, onSelect]);

  const groups = GROUPS.map((g) => ({ ...g, rows: g.keys.flatMap((k) => (selections[k] ? [{ key: k, sel: selections[k]! }] : [])) })).filter((g) => g.rows.length > 0);

  /** Reads this probe off the opposite template strand: the oligo becomes
   * its own reverse complement, binding the same spot from the other side.
   * Allele bases are stored in template sense, so they carry over
   * untouched; the nearest-neighbor Tm does change under this (an oligo's
   * stacks are not its revcomp's), so Strider re-analyzes the flipped
   * sequence like any edited pick. */
  function flipProbeStrand(key: Key, sel: Selection) {
    const next: Selection = { ...sel, strand: selectionStrand(sel) === 'F' ? 'R' : 'F', primerSeq: reverseComplement(sel.primerSeq), analysis: undefined };
    onSelect(key, next);
    analyzePrimer({ sequence: next.primerSeq }).then(
      (analysis) => onSelect(key, { ...next, analysis }),
      () => onSelect(key, { ...next, analysis: null }),
    );
  }

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
            const title = g.id === 'arms' && twins ? `ARMS (${selectionStrand(twins) === 'F' ? '2 F + 1 R' : '1 F + 2 R'})` : g.id === 'probe' && selections.geneProbeAlt ? 'Allele-detection probes' : g.title;
            // The ARMS mutant twin sits exactly where the wild-type twin
            // does, so one twin + the common primer gives the trio's
            // amplicon (identical for both alleles).
            const fwd = g.rows.find((r) => selectionStrand(r.sel) === 'F' && r.key !== 'armsAltPrimer')?.sel;
            const rev = g.rows.find((r) => selectionStrand(r.sel) === 'R' && r.key !== 'armsAltPrimer')?.sel;
            const amplicon = g.id === 'probe' ? null : ampliconLabel(fwd, rev, data);
            return (
              <section key={g.id} className="min-w-0 rounded-md border border-line bg-surface p-3" aria-label={title}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-ink">
                    {title}
                    {amplicon && <span className="ml-2 font-normal text-ink-muted">· {amplicon}</span>}
                  </span>
                  <div className="flex gap-1.5">
                    {/* Pick which of the two overlapping allele probes is
                        unlocked for dragging on the sequence map - the only
                        way to resize one twin independently of the other
                        (e.g. when a mismatch drops one allele's Tm). */}
                    {g.id === 'probe' &&
                      g.rows.map(({ key, sel }) => {
                        const active = probeEditKey === key;
                        const wt = key === 'geneProbe';
                        const fwd = selectionStrand(sel) === 'F';
                        const label = wt ? `WT${sel.allele ? ` (${sel.allele.wtBase})` : ''}` : `MUT${sel.allele ? ` (${sel.allele.mutBase})` : ''}`;
                        return (
                          <span key={key} className="inline-flex items-center gap-0.5">
                            <button
                              type="button"
                              aria-pressed={active}
                              title={active ? 'Lock this probe again (it keeps its current span)' : 'Unlock this probe on the sequence map: drag it to move, or pull an end to lengthen or shorten it'}
                              onClick={() => onProbeEditKeyChange(active ? null : (key as ProbeEditKey))}
                              className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                                active
                                  ? wt
                                    ? 'border-transparent bg-green-600 text-white hover:bg-green-700'
                                    : 'border-transparent bg-blue-600 text-white hover:bg-blue-700'
                                  : 'border-line-strong bg-surface text-ink hover:bg-surface-2'
                              }`}
                            >
                              <span aria-hidden="true" className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: active ? 'currentColor' : wt ? 'var(--seq-probe-wt-ink)' : 'var(--seq-probe-ink)' }} />
                              {label}
                            </button>
                            {/* Strand of THIS probe - independent of its
                                twin, so the pair can read one allele off
                                the + strand and the other off the -. */}
                            <button
                              type="button"
                              aria-label={`This probe reads on the ${fwd ? 'plus' : 'minus'} strand - switch it to the ${fwd ? 'minus' : 'plus'} strand`}
                              title={`Reads the ${fwd ? '+' : '−'} strand; switch to ${fwd ? '−' : '+'} (the oligo becomes its reverse complement - the SNP stays put, then you can move/resize as usual)`}
                              onClick={() => flipProbeStrand(key, sel)}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line-strong bg-surface font-mono text-xs font-semibold text-ink transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                            >
                              {fwd ? '+' : '−'}
                            </button>
                          </span>
                        );
                      })}
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
                    <Button
                      size="sm"
                      disabled={!idtCredentials || g.rows.some((r) => idtTms[r.sel.primerSeq] === 'loading')}
                      title={idtCredentials ? "Tm from IDT OligoAnalyzer, under the same conditions as Strider's" : 'Add your IDT account in Settings (,) to use this'}
                      onClick={() => fetchIdtTms(g.rows.map((r) => r.sel.primerSeq))}
                    >
                      IDT
                    </Button>
                    <Button size="sm" onClick={() => g.keys.forEach((k) => selections[k] && onSelect(k, null))}>
                      Remove
                    </Button>
                  </div>
                </div>
                {g.id === 'probe' && probeEditKey && selections[probeEditKey] && (
                  <p className="mb-2 text-[11px] text-ink-faint">
                    The{' '}
                    <span className="font-semibold" style={{ color: probeEditKey === 'geneProbe' ? 'var(--seq-probe-wt-ink)' : 'var(--seq-probe-ink)' }}>
                      {probeEditKey === 'geneProbe' ? 'wild-type' : 'mutant'} probe
                    </span>{' '}
                    is unlocked on the sequence map: drag it to move, or pull an end to lengthen or shorten it - only this probe changes, and it keeps
                    its allele base at the SNP. Click the {probeEditKey === 'geneProbe' ? 'WT' : 'MUT'} button again when you're done.
                  </p>
                )}
                <div className="space-y-2">
                  {g.rows.map(({ key, sel }) => {
                    const a = sel.analysis;
                    const idt = idtTms[sel.primerSeq];
                    return (
                      <div key={key} className="rounded border border-line bg-base px-2 py-1.5">
                        <div className="flex flex-wrap items-center gap-x-2">
                          <NameInput value={sel.name ?? ''} onCommit={(name) => onSelect(key, { ...sel, name })} />
                          {g.id === 'probe' && (
                            <span
                              aria-hidden="true"
                              title={key === 'geneProbe' ? 'Shown green on the sequence map' : 'Shown blue on the sequence map'}
                              className="h-2.5 w-2.5 rounded-[2px]"
                              style={{ backgroundColor: key === 'geneProbe' ? 'var(--seq-probe-wt-ink)' : 'var(--seq-probe-ink)' }}
                            />
                          )}
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
                                {idt && <IdtTm result={idt} />}
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
