import { useEffect, useState, type ReactNode } from 'react';
import type { PrimerAnalysis } from '../api/design';
import { analyzeStructure, type FullStructureAnalysis, type StructureVariant } from '../api/structure';
import { getIdtToken, idtAnalyze, type IdtAnalyzeResponse } from '../api/idt';
import type { IdtCredentials } from './IdtSettingsPanel';
import HairpinSvg from './HairpinSvg';
import DimerAscii from './DimerAscii';

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
  /** Absent (not just empty) hides the "IDT" button entirely — IDT credentials are optional. */
  idtCredentials?: IdtCredentials;
}

/** Same red/amber/emerald ΔG thresholds Oligool's provenance cards use. */
function dgColor(dg: number | null): string {
  if (dg == null) return 'text-zinc-400';
  if (dg < -6) return 'text-red-500';
  if (dg < -3) return 'text-amber-500';
  return 'text-emerald-500';
}

function fmtDg(v: number | null): string {
  return v == null ? '–' : `${v.toFixed(2)} kcal/mol`;
}

function fmtTm(v: number | null): string {
  return v == null ? '–' : `${v.toFixed(1)}°C`;
}

function fmtPct(v: number | null): string {
  return v == null ? '–' : `${(v * 100).toFixed(0)}%`;
}

/** One structural-model box: ΔG/Tm/% of (this model's own) ensemble, plus
 * the fold diagram when one was found. `diagram` is `null` when there's
 * nothing to draw (e.g. a no-bulge model with zero pairs). */
function VariantBox({ label, variant, diagram }: { label: string; variant: StructureVariant; diagram: ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[13px] text-zinc-500 dark:text-zinc-400">{label}</span>
        {variant.structure_found && variant.population_fraction != null && (
          <span className="text-[13px] text-blue-500 dark:text-blue-400" title="Share of this model's own top-5 subopt ensemble (Boltzmann-weighted)">
            {fmtPct(variant.population_fraction)} of ensemble
          </span>
        )}
      </div>
      <div className="flex gap-3 text-[13px] text-zinc-500 dark:text-zinc-400 mb-2">
        <span>
          Strider ΔG: <span className={`font-mono tabular-nums font-medium ${dgColor(variant.dg)}`}>{fmtDg(variant.dg)}</span>
        </span>
        <span>
          Strider Tm: <span className="font-mono tabular-nums font-medium text-zinc-600 dark:text-zinc-300">{fmtTm(variant.tm)}</span>
        </span>
      </div>
      {variant.structure_found ? diagram : <div className="text-[13px] text-zinc-400 italic">No structure found</div>}
    </div>
  );
}

/** One card per primer candidate, styled to match Oligool's Flanking
 * Primers Provenance cards exactly (zinc borders, teal accent, `text-[13px]`
 * stats grid) rather than this app's own `ResultsTable`/`Card` look —
 * requested verbatim, not adapted to Primerool's slate/green palette. */
export default function PrimerCard({ index, primer, name, positionLabel, selected = false, onUse, extra, idtCredentials }: Props) {
  const [copied, setCopied] = useState(false);
  const [structure, setStructure] = useState<FullStructureAnalysis | null>(null);
  /** Which primer's sequence `structure` was actually fetched for — lets
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
  // breakdown only for the one primer the user has selected — mirrors
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
      className={`rounded-lg border p-3 text-[13px] transition-all ${
        selected ? 'border-teal-600/60 dark:border-teal-300/40 bg-teal-700/5 dark:bg-teal-300/10' : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900'
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-zinc-500 dark:text-zinc-400 text-[13px] uppercase tracking-wider">#{index + 1}</span>
          {name && <span className="text-amber-600 dark:text-amber-400 text-[13px] uppercase tracking-wider">{name}</span>}
          <span className="font-mono text-zinc-700 dark:text-zinc-200 break-all">{primer.sequence}</span>
          {positionLabel && <span className="font-mono text-[13px] text-zinc-400 dark:text-zinc-500 whitespace-nowrap">{positionLabel}</span>}
        </div>
        <div className="flex gap-1 flex-shrink-0">
          <button
            onClick={copy}
            className="text-[13px] px-2 py-0.5 rounded-md border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all font-medium"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          {idtCredentials && (
            <button
              onClick={() => void analyzeWithIdt()}
              disabled={idtLoading}
              title="Analyze this primer's hairpin/self-dimer with the real IDT OligoAnalyzer API"
              className={`text-[13px] px-2 py-0.5 rounded-md border font-medium transition-all ${
                idtResult ? 'bg-purple-600 border-purple-600 text-white' : 'border-purple-600/40 text-purple-700 dark:text-purple-300 hover:bg-purple-700/10 dark:hover:bg-purple-300/10 disabled:opacity-40'
              }`}
            >
              {idtLoading ? '...' : idtResult ? 'IDT ↻' : 'IDT'}
            </button>
          )}
          {onUse && (
            <button
              onClick={onUse}
              className={`text-[13px] px-2 py-0.5 rounded-md border font-medium transition-all ${
                selected ? 'bg-teal-600 border-teal-600 text-white' : 'border-teal-600/40 text-teal-700 dark:text-teal-300 hover:bg-teal-700/10 dark:hover:bg-teal-300/10'
              }`}
            >
              {selected ? 'Used' : 'Use'}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-5 gap-1 text-[13px] text-zinc-500 dark:text-zinc-400">
        <div>
          <span className="text-zinc-600 dark:text-zinc-300">Len</span>
          <br />
          <span className="font-mono tabular-nums font-medium">{primer.length} bp</span>
        </div>
        <div>
          <span className="text-zinc-600 dark:text-zinc-300">Tm</span>
          <br />
          <span className="font-mono tabular-nums font-medium">{primer.tm != null ? primer.tm : '–'}°C</span>
        </div>
        <div>
          <span className="text-zinc-600 dark:text-zinc-300">GC</span>
          <br />
          <span className="font-mono tabular-nums font-medium">{primer.gc_percent != null ? primer.gc_percent : '–'}%</span>
        </div>
        <div>
          <span className="text-zinc-600 dark:text-zinc-300">Hairpin</span>
          <br />
          <span className={`font-mono tabular-nums font-medium ${primer.hairpin.structure_found ? 'text-amber-500' : 'text-emerald-500'}`}>
            {primer.hairpin.structure_found ? (primer.hairpin.tm != null ? `${primer.hairpin.tm}°C` : primer.hairpin.dg != null ? `${primer.hairpin.dg} kcal/mol` : 'Yes') : 'None'}
          </span>
        </div>
        <div>
          <span className="text-zinc-600 dark:text-zinc-300">Self-dimer</span>
          <br />
          <span className={`font-mono tabular-nums font-medium whitespace-nowrap ${dgColor(primer.homodimer.dg)}`}>{primer.homodimer.dg != null ? `${primer.homodimer.dg} kcal/mol` : 'OK'}</span>
        </div>
      </div>

      {extra}

      {idtError && <div className="mt-2 text-[13px] text-red-600 dark:text-red-400">{idtError}</div>}
      {idtResult && (
        <div className="mt-2 pt-2 border-t border-zinc-100 dark:border-zinc-800 flex flex-wrap gap-x-4 gap-y-0.5 text-[13px] text-zinc-500 dark:text-zinc-400">
          <span>
            IDT Hairpin ΔG: <span className="font-mono tabular-nums font-medium text-purple-600 dark:text-purple-400">{fmtDg(idtResult.m1.idt.hairpin_delta_g)}</span>
          </span>
          <span>
            IDT Self-dimer ΔG: <span className="font-mono tabular-nums font-medium text-purple-600 dark:text-purple-400">{fmtDg(idtResult.m1.idt.self_dimer_delta_g)}</span>
          </span>
        </div>
      )}

      {/* Dual-model structural analysis: mirrors Oligool's expand-on-select
       * section, plus an explicit no-bulge ("pure sliding window", the
       * model simpler checkers like IDT's OligoAnalyzer use) counterpart
       * alongside Strider's own bulge-allowing MFE — see
       * `engine::structure_variant`'s module docs. Fetched fresh via
       * Strider on selection, independent of which engine designed this
       * candidate in the first place. */}
      {selected && (
        <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-800">
          <div className="text-[13px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2">Structural Analysis</div>
          {structureFor !== primer.sequence && <div className="text-[13px] text-zinc-400 italic">Analyzing…</div>}
          {structure && structureFor === primer.sequence && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <VariantBox
                label="Hairpin — with bulges (Strider MFE)"
                variant={structure.hairpin.with_bulge}
                diagram={structure.hairpin.with_bulge.structure && <HairpinSvg sequence={primer.sequence} structure={structure.hairpin.with_bulge.structure} />}
              />
              <VariantBox
                label="Hairpin — no bulge (pure sliding)"
                variant={structure.hairpin.no_bulge}
                diagram={structure.hairpin.no_bulge.structure && <HairpinSvg sequence={primer.sequence} structure={structure.hairpin.no_bulge.structure} />}
              />
              <VariantBox
                label="Self-dimer — with bulges (Strider MFE)"
                variant={structure.homodimer.with_bulge}
                diagram={structure.homodimer.with_bulge.structure && <DimerAscii seq1={primer.sequence} seq2={primer.sequence} structure={structure.homodimer.with_bulge.structure} />}
              />
              <VariantBox
                label="Self-dimer — no bulge (pure sliding)"
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
