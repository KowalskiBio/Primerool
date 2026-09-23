import { useEffect, useState, type ReactNode } from 'react';
import { analyzeStructure, type FullStructureAnalysis, type StructureCandidate } from '../api/structure';
import HairpinSvg from './HairpinSvg';
import DimerSvg from './DimerSvg';

interface Props {
  /** The pair to analyze, or `null` to render nothing. Both sequences are
   * always needed (not just whichever primer was clicked) since the
   * heterodimer check is between them. */
  pair: { forward: string; reverse: string } | null;
}

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

/** One horizontally-scrollable strip of up to 5 subopt candidates for one
 * category (a primer's hairpin, its self-dimer, or the pair's
 * heterodimer) - `diagram` draws whichever kind this category is. */
function CandidateStrip({ candidates, diagram }: { candidates: StructureCandidate[]; diagram: (structure: string) => ReactNode }) {
  if (candidates.length === 0) {
    return <div className="text-[13px] italic text-ink-faint">No structure found</div>;
  }
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {candidates.map((c, i) => (
        <div key={i} className="w-60 shrink-0 rounded-md border border-line bg-base p-2">
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
 * MFE model. The diagrams are this app's own SVG renderings (`HairpinSvg`/
 * `DimerSvg`), not Oligool's ASCII dimer view. Renders bare (no Modal/
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

  const pairKey = pair ? `${pair.forward}:${pair.reverse}` : null;

  useEffect(() => {
    if (!pair) return;
    let cancelled = false;
    Promise.all([analyzeStructure({ sequence: pair.forward, partner_sequence: pair.reverse }), analyzeStructure({ sequence: pair.reverse, partner_sequence: pair.forward })])
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
      {shownFwd && shownRev && (
        <div>
          <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <p className="mb-2 break-all font-mono text-xs text-ink">
                Forward: {pair.forward} <span className="text-ink-faint">({pair.forward.length} bp)</span>
              </p>
              <CategorySection title="Hairpin (Strider MFE)">
                <CandidateStrip candidates={shownFwd.hairpin.with_bulge.candidates} diagram={(s) => <HairpinSvg sequence={pair.forward} structure={s} />} />
              </CategorySection>
              <CategorySection title="Self-dimer (Strider MFE)">
                <CandidateStrip candidates={shownFwd.homodimer.with_bulge.candidates} diagram={(s) => <DimerSvg seq1={pair.forward} seq2={pair.forward} structure={s} />} />
              </CategorySection>
            </div>
            <div>
              <p className="mb-2 break-all font-mono text-xs text-ink">
                Reverse: {pair.reverse} <span className="text-ink-faint">({pair.reverse.length} bp)</span>
              </p>
              <CategorySection title="Hairpin (Strider MFE)">
                <CandidateStrip candidates={shownRev.hairpin.with_bulge.candidates} diagram={(s) => <HairpinSvg sequence={pair.reverse} structure={s} />} />
              </CategorySection>
              <CategorySection title="Self-dimer (Strider MFE)">
                <CandidateStrip candidates={shownRev.homodimer.with_bulge.candidates} diagram={(s) => <DimerSvg seq1={pair.reverse} seq2={pair.reverse} structure={s} />} />
              </CategorySection>
            </div>
          </div>
          <CategorySection title="Heterodimer - forward × reverse (Strider MFE)">
            <CandidateStrip candidates={shownFwd.heterodimer?.with_bulge.candidates ?? []} diagram={(s) => <DimerSvg seq1={pair.forward} seq2={pair.reverse} structure={s} />} />
          </CategorySection>
        </div>
      )}
    </div>
  );
}
