import { useEffect, useState, type ReactNode } from 'react';
import { analyzeStructure, type FullStructureAnalysis, type StructureCandidate } from '../api/structure';
import HairpinSvg from './HairpinSvg';
import DimerSvg from './DimerSvg';
import StriderStructure from './StriderStructure';

interface Props {
  /** The pair to analyze, or `null` to render nothing. Both sequences are
   * needed for a pair (not just whichever primer was clicked) since the
   * heterodimer check is between them. Without `reverse` it analyzes
   * `forward` alone (hairpin + self-dimer, no heterodimer) - e.g. a
   * stretch picked from the sequence map's right-click menu. */
  pair: { forward: string; reverse?: string } | null;
}

/** Strider-style figures, falling back to the older diagrams. */
function hairpin(sequence: string, structure: string) {
  return <StriderStructure sequence={sequence} structure={structure} title="Hairpin" fallback={<HairpinSvg sequence={sequence} structure={structure} />} />;
}
/** A self-dimer (`seq2` omitted) or the F × R heterodimer. */
function dimer(seq1: string, structure: string, seq2 = seq1) {
  return (
    <StriderStructure
      sequence={seq1 + seq2}
      nick={seq1.length}
      strandNames={seq2 === seq1 ? undefined : HETERODIMER_NAMES}
      structure={structure}
      title={seq2 === seq1 ? 'Self-dimer' : 'Heterodimer'}
      fallback={<DimerSvg seq1={seq1} seq2={seq2} structure={structure} />}
    />
  );
}
const HETERODIMER_NAMES = ['F', 'R'];

function fmtDg(v: number): string {
  return `${v.toFixed(2)} kcal/mol`;
}
function fmtTm(v: number): string {
  return `${v.toFixed(1)}°C`;
}
function fmtPct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}
function dgColor(dg: number): string {
  if (dg < -6) return 'text-danger';
  if (dg < -3) return 'text-warning';
  return 'text-success';
}

/** A wrapping grid of up to 5 subopt candidates for one category (a
 * primer's hairpin, its self-dimer, or the pair's heterodimer) - `diagram`
 * draws whichever kind this category is. Wraps onto new rows rather than
 * scrolling sideways, so every candidate is visible at once. */
function CandidateStrip({ candidates, diagram, wide = false }: { candidates: StructureCandidate[]; diagram: (structure: string) => ReactNode; wide?: boolean }) {
  if (candidates.length === 0) {
    return <div className="text-[13px] italic text-ink-faint">No structure found</div>;
  }
  return (
    // Dimers (`wide`) are long two-strand diagrams that shrink unreadably in
    // a hairpin-sized card, so they get roughly two per row instead of three.
    <div className={`grid gap-3 ${wide ? 'grid-cols-[repeat(auto-fill,minmax(min(30rem,100%),1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(min(20rem,100%),1fr))]'}`}>
      {candidates.map((c, i) => (
        <div key={i} className="min-w-0 rounded-md border border-line bg-base p-3">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-ink-muted">
            <span className="font-medium text-ink">#{i + 1}</span>
            <span className="text-accent" title="Boltzmann share within this model's own top-5 subopt ensemble">
              {fmtPct(c.population_fraction)}
            </span>
          </div>
          <div className="mb-1.5 flex gap-2 text-[11px] text-ink-muted">
            <span className={`font-mono font-medium tabular-nums ${dgColor(c.dg)}`}>{fmtDg(c.dg)}</span>
            <span className="font-mono font-medium tabular-nums text-ink">{fmtTm(c.tm)}</span>
          </div>
          {diagram(c.structure)}
        </div>
      ))}
    </div>
  );
}

function CategorySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 text-[12px] font-medium uppercase tracking-wider text-ink-faint">{title}</div>
      {children}
    </div>
  );
}

/** Up to 5 subopt candidates each for the forward primer's hairpin and
 * self-dimer, the reverse primer's hairpin and self-dimer, and the pair's
 * heterodimer (forward × reverse), all from Strider's own bulge-allowing
 * MFE model, drawn in Strider's figure style (`StriderStructure`; the older
 * `HairpinSvg`/`DimerSvg` diagrams are only the fallback). Renders bare (no Modal/
 * card wrapper) so it can sit inside either `PrimerStructureModal.tsx`
 * (a standalone popup for a primer-segment click) or
 * `AmpliconDetailModal.tsx` (embedded below that amplicon's sequence map). */
export default function PrimerStructurePanel({ pair }: Props) {
  const [fwdAnalysis, setFwdAnalysis] = useState<FullStructureAnalysis | null>(null);
  const [revAnalysis, setRevAnalysis] = useState<FullStructureAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which pair (by its two sequences) the results above actually belong
  // to - see `SnpGeneMapModal.tsx`'s `resultFor` for the same pattern.
  const [resultFor, setResultFor] = useState<string | null>(null);

  const pairKey = pair ? `${pair.forward}:${pair.reverse ?? ''}` : null;

  useEffect(() => {
    if (!pair) return;
    let cancelled = false;
    const reverse = pair.reverse;
    Promise.all([
      analyzeStructure({ sequence: pair.forward, partner_sequence: reverse }),
      reverse ? analyzeStructure({ sequence: reverse, partner_sequence: pair.forward }) : Promise.resolve(null),
    ])
      .then(([fwd, rev]) => {
        if (cancelled) return;
        setFwdAnalysis(fwd);
        setRevAnalysis(rev);
        setError(null);
        setResultFor(pairKey);
      })
      .catch((e) => {
        if (cancelled) return;
        setFwdAnalysis(null);
        setRevAnalysis(null);
        setError(e instanceof Error ? e.message : String(e));
        setResultFor(pairKey);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKey]);

  if (!pair) return null;

  const loading = resultFor !== pairKey;
  const shownFwd = resultFor === pairKey ? fwdAnalysis : null;
  const shownRev = resultFor === pairKey ? revAnalysis : null;
  const shownError = resultFor === pairKey ? error : null;

  return (
    <div>
      {loading && <p className="text-sm text-ink-muted">Analyzing…</p>}
      {shownError && (
        <div role="alert" className="rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">
          {shownError}
        </div>
      )}
      {shownFwd && (
        <div>
          {/* Forward, reverse, then the heterodimer, each at full width -
              side-by-side columns left each candidate grid too narrow and
              forced horizontal scrolling. A single sequence shows just its
              own block. */}
          <div className={pair.reverse ? 'mb-5 border-b border-line pb-5' : ''}>
            <p className="mb-2 break-all font-mono text-xs text-ink">
              {pair.reverse ? 'Forward' : 'Selection'}: {pair.forward} <span className="text-ink-faint">({pair.forward.length} bp)</span>
            </p>
            <CategorySection title="Hairpin (Strider MFE)">
              <CandidateStrip candidates={shownFwd.hairpin.with_bulge.candidates} diagram={(s) => hairpin(pair.forward, s)} />
            </CategorySection>
            <CategorySection title="Self-dimer (Strider MFE)">
              <CandidateStrip candidates={shownFwd.homodimer.with_bulge.candidates} diagram={(s) => dimer(pair.forward, s)} wide />
            </CategorySection>
          </div>
          {pair.reverse && shownRev && (
            <>
              <div className="mb-5 border-b border-line pb-5">
                <p className="mb-2 break-all font-mono text-xs text-ink">
                  Reverse: {pair.reverse} <span className="text-ink-faint">({pair.reverse.length} bp)</span>
                </p>
                <CategorySection title="Hairpin (Strider MFE)">
                  <CandidateStrip candidates={shownRev.hairpin.with_bulge.candidates} diagram={(s) => hairpin(pair.reverse!, s)} />
                </CategorySection>
                <CategorySection title="Self-dimer (Strider MFE)">
                  <CandidateStrip candidates={shownRev.homodimer.with_bulge.candidates} diagram={(s) => dimer(pair.reverse!, s)} wide />
                </CategorySection>
              </div>
              <CategorySection title="Heterodimer - forward × reverse (Strider MFE)">
                <CandidateStrip candidates={shownFwd.heterodimer?.with_bulge.candidates ?? []} diagram={(s) => dimer(pair.forward, s, pair.reverse!)} wide />
              </CategorySection>
            </>
          )}
        </div>
      )}
    </div>
  );
}
