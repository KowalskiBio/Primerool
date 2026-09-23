import { useEffect, useState, type ReactNode } from 'react';
import type { PrimerAnalysis } from '../api/design';
import { analyzeStructure, type FullStructureAnalysis, type StructureVariant } from '../api/structure';
import { getIdtToken, idtAnalyze, type IdtAnalyzeResponse } from '../api/idt';
import type { IdtCredentials } from './IdtSettingsPanel';
import HairpinSvg from './HairpinSvg';
import DimerAscii from './DimerAscii';
import Button from './ui/Button';

interface Props {
  index: number;
  primer: PrimerAnalysis;
  /** Optional badge next to the sequence (e.g. a primer name). */
  name?: string;
  /** Optional badge after the sequence (e.g. a relative-position label). */
  positionLabel?: string;
  /** Highlights the card and switches the Use button to its "Used" state. */
  selected?: boolean;
  onUse?: () => void;
  /** Extra content rendered below the stats grid (e.g. binding site, product sizes). */
  extra?: ReactNode;
  /** Absent (not just empty) hides the "IDT" button entirely - IDT credentials are optional. */
  idtCredentials?: IdtCredentials;
}

/** ΔG severity: strong structure = danger, borderline = warning, benign = success. */
function dgColor(dg: number | null): string {
  if (dg == null) return 'text-ink-faint';
  if (dg < -6) return 'text-danger';
  if (dg < -3) return 'text-warning';
  return 'text-success';
}

function fmtDg(v: number | null): string {
  return v == null ? '-' : `${v.toFixed(2)} kcal/mol`;
}

function fmtTm(v: number | null): string {
  return v == null ? '-' : `${v.toFixed(1)}°C`;
}

function fmtPct(v: number | null): string {
  return v == null ? '-' : `${(v * 100).toFixed(0)}%`;
}

/** One structural-model box: ΔG/Tm/% of (this model's own) ensemble, plus
 * the fold diagram when one was found. `diagram` is `null` when there's
 * nothing to draw (e.g. a no-bulge model with zero pairs). Exported for
 * `PrimerStructureModal.tsx`, which reuses this exact box (and the dual
 * with-bulge/no-bulge layout below) outside the primer-design cards. */
export function VariantBox({ label, variant, diagram }: { label: string; variant: StructureVariant; diagram: ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-base p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] text-ink-muted">{label}</span>
        {variant.structure_found && variant.population_fraction != null && (
          <span className="text-[13px] text-accent" title="Share of this model's own top-5 subopt ensemble (Boltzmann-weighted)">
            {fmtPct(variant.population_fraction)} of ensemble
          </span>
        )}
      </div>
      <div className="mb-2 flex gap-3 text-[13px] text-ink-muted">
        <span>
          Strider ΔG: <span className={`font-mono font-medium tabular-nums ${dgColor(variant.dg)}`}>{fmtDg(variant.dg)}</span>
        </span>
        <span>
          Strider Tm: <span className="font-mono font-medium tabular-nums text-ink">{fmtTm(variant.tm)}</span>
        </span>
      </div>
      {variant.structure_found ? diagram : <div className="text-[13px] italic text-ink-faint">No structure found</div>}
    </div>
  );
}

/** One card per primer candidate, on the app's shared token palette. */
export default function PrimerCard({ index, primer, name, positionLabel, selected = false, onUse, extra, idtCredentials }: Props) {
  const [copied, setCopied] = useState(false);
  const [structure, setStructure] = useState<FullStructureAnalysis | null>(null);
  /** Which primer's sequence `structure` was actually fetched for - lets
   * the render below tell "still loading this primer's analysis" apart
   * from "showing a previous selection's stale result" without a separate
   * loading flag set synchronously inside the effect (flagged by
   * react-hooks/set-state-in-effect: only its promise callbacks setState). */
  const [structureFor, setStructureFor] = useState<string | null>(null);
  const [idtLoading, setIdtLoading] = useState(false);
  const [idtError, setIdtError] = useState<string | null>(null);
  const [idtResult, setIdtResult] = useState<IdtAnalyzeResponse | null>(null);

  const copy = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard
      .writeText(primer.sequence)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  // Fires the rich, dual-model (bulge-allowing vs. no-bulge) structural
  // breakdown only for the one primer the user has selected - mirrors
  // Oligool's own analyzeStriderIndividual-on-"Use" pattern, not a bulk
  // per-candidate fetch.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    analyzeStructure({ sequence: primer.sequence })
      .then((res) => {
        if (cancelled) return;
        setStructure(res);
        setStructureFor(primer.sequence);
      })
      .catch(() => {
        if (cancelled) return;
        setStructure(null);
        setStructureFor(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, primer.sequence]);

  async function analyzeWithIdt() {
    if (!idtCredentials) return;
    setIdtError(null);
    setIdtLoading(true);
    try {
      const token = await getIdtToken({
        client_id: idtCredentials.clientId,
        client_secret: idtCredentials.clientSecret,
        username: idtCredentials.username,
        password: idtCredentials.password,
        idt_region: idtCredentials.region,
      });
      const result = await idtAnalyze({ p1_seq: primer.sequence, p2_seq: primer.sequence, token: token.access_token, idt_region: idtCredentials.region });
      setIdtResult(result);
    } catch (e) {
      setIdtError(e instanceof Error ? e.message : String(e));
    } finally {
      setIdtLoading(false);
    }
  }

  return (
    <div
      className={`rounded-md border p-3 text-[13px] transition-colors ${
        selected ? 'border-accent/50 bg-accent-subtle' : 'border-line bg-surface'
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] uppercase tracking-wider text-ink-faint">#{index + 1}</span>
          {name && <span className="text-[13px] uppercase tracking-wider text-accent">{name}</span>}
          <span className="break-all font-mono text-ink">{primer.sequence}</span>
          {positionLabel && <span className="whitespace-nowrap font-mono text-[13px] text-ink-faint">{positionLabel}</span>}
        </div>
        <div className="flex flex-shrink-0 gap-1.5">
          <Button size="sm" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
          {idtCredentials && (
            <Button
              size="sm"
              onClick={() => void analyzeWithIdt()}
              disabled={idtLoading}
              title="Analyze this primer's hairpin/self-dimer with the real IDT OligoAnalyzer API"
              className={idtResult ? 'text-accent' : ''}
            >
              {idtLoading ? '…' : idtResult ? 'IDT ↻' : 'IDT'}
            </Button>
          )}
          {onUse && (
            <Button size="sm" variant={selected ? 'secondary' : 'primary'} onClick={onUse}>
              {selected ? 'Used' : 'Use'}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-5 gap-1 text-[13px] text-ink-muted">
        <div>
          <span>Len</span>
          <br />
          <span className="font-mono font-medium tabular-nums text-ink">{primer.length} bp</span>
        </div>
        <div>
          <span>Tm</span>
          <br />
          <span className="font-mono font-medium tabular-nums text-ink">{primer.tm != null ? primer.tm : '-'}°C</span>
        </div>
        <div>
          <span>GC</span>
          <br />
          <span className="font-mono font-medium tabular-nums text-ink">{primer.gc_percent != null ? primer.gc_percent : '-'}%</span>
        </div>
        <div>
          <span>Hairpin</span>
          <br />
          <span className={`font-mono font-medium tabular-nums ${primer.hairpin.structure_found ? 'text-warning' : 'text-success'}`}>
            {primer.hairpin.structure_found ? (primer.hairpin.tm != null ? `${primer.hairpin.tm}°C` : primer.hairpin.dg != null ? `${primer.hairpin.dg} kcal/mol` : 'Yes') : 'None'}
          </span>
        </div>
        <div>
          <span>Self-dimer</span>
          <br />
          <span className={`font-mono font-medium tabular-nums whitespace-nowrap ${dgColor(primer.homodimer.dg)}`}>{primer.homodimer.dg != null ? `${primer.homodimer.dg} kcal/mol` : 'OK'}</span>
        </div>
      </div>

      {extra}

      {idtError && <div role="alert" className="mt-2 text-[13px] text-danger">{idtError}</div>}
      {idtResult && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 border-t border-line pt-2 text-[13px] text-ink-muted">
          <span>
            IDT Hairpin ΔG: <span className="font-mono font-medium tabular-nums text-accent">{fmtDg(idtResult.m1.idt.hairpin_delta_g)}</span>
          </span>
          <span>
            IDT Self-dimer ΔG: <span className="font-mono font-medium tabular-nums text-accent">{fmtDg(idtResult.m1.idt.self_dimer_delta_g)}</span>
          </span>
        </div>
      )}

      {/* Dual-model structural analysis: mirrors Oligool's expand-on-select
       * section, plus an explicit no-bulge ("pure sliding window", the
       * model simpler checkers like IDT's OligoAnalyzer use) counterpart
       * alongside Strider's own bulge-allowing MFE - see
       * `engine::structure_variant`'s module docs. Fetched fresh via
       * Strider on selection, independent of which engine designed this
       * candidate in the first place. */}
      {selected && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="mb-2 text-[13px] font-medium uppercase tracking-wider text-ink-faint">Structural Analysis</div>
          {structureFor !== primer.sequence && <div className="text-[13px] italic text-ink-faint">Analyzing…</div>}
          {structure && structureFor === primer.sequence && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <VariantBox
                label="Hairpin - with bulges (Strider MFE)"
                variant={structure.hairpin.with_bulge}
                diagram={structure.hairpin.with_bulge.structure && <HairpinSvg sequence={primer.sequence} structure={structure.hairpin.with_bulge.structure} />}
              />
              <VariantBox
                label="Hairpin - no bulge (pure sliding)"
                variant={structure.hairpin.no_bulge}
                diagram={structure.hairpin.no_bulge.structure && <HairpinSvg sequence={primer.sequence} structure={structure.hairpin.no_bulge.structure} />}
              />
              <VariantBox
                label="Self-dimer - with bulges (Strider MFE)"
                variant={structure.homodimer.with_bulge}
                diagram={structure.homodimer.with_bulge.structure && <DimerAscii seq1={primer.sequence} seq2={primer.sequence} structure={structure.homodimer.with_bulge.structure} />}
              />
              <VariantBox
                label="Self-dimer - no bulge (pure sliding)"
                variant={structure.homodimer.no_bulge}
                diagram={structure.homodimer.no_bulge.structure && <DimerAscii seq1={primer.sequence} seq2={primer.sequence} structure={structure.homodimer.no_bulge.structure} />}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
