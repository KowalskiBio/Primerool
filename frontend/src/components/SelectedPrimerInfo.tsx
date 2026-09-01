import { useState } from 'react';
import type { SequenceData } from '../api/sequence';
import type { Selection, Selections } from '../utils/regionMapping';
import { getIdtToken, idtAnalyze, type IdtAnalyzeResponse } from '../api/idt';
import { ApiError } from '../api/client';
import type { IdtCredentials } from './IdtSettingsPanel';
import HairpinSvg from './HairpinSvg';
import DimerSvg from './DimerSvg';

interface Props {
  selections: Selections;
  data: SequenceData;
  ampTarget: number | null;
  ampDev: number | null;
  onFindProbesInAmplicon?: () => void;
  /** Absent (not just empty) hides the "Analyze with IDT" button entirely
   * — IDT credentials are optional, per the rewrite plan's locked-in
   * decision to match Oligool's storage shape exactly. */
  idtCredentials?: IdtCredentials;
}

/** Amplicon-length stat row — ported from Oligool's `FlankingPrimersPanel`
 * (`ampliconBp` block): a bordered emerald tile with an uppercase label on
 * the left and the bold mono "N bp" value on the right, instead of the
 * inline "**Amplicon**: N bp" text this replaces. `valueClassName`
 * overrides the default emerald value color for the same red/bold warning
 * states `geneLenColor` already computes below. */
function AmpliconStat({ label, value, valueClassName }: { label: string; value: number; valueClassName?: string }) {
  return (
    <div className="rounded-lg border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/60 dark:bg-emerald-900/10 px-4 py-3 flex items-center justify-between">
      <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">{label}</span>
      <span className={`text-base font-bold font-mono ${valueClassName ?? 'text-emerald-700 dark:text-emerald-300'}`} title="Amplicon size: forward primer + template between primers + reverse primer">
        {value.toLocaleString()} bp
      </span>
    </div>
  );
}

function OneLine({ label, sel }: { label: string; sel: Selection | null }) {
  if (!sel) return null;
  return (
    <div className="mb-2.5">
      <strong>{label}</strong> ({sel.source})
      <br />
      Primer (5'→3'): <span className="font-mono">{sel.primerSeq}</span>
      <br />
      Binding site (highlighted): <span className="font-mono">{sel.bindingSeq}</span>
      <br />
      Location: <span className="font-mono">{sel.region}</span> [{sel.start}, {sel.end})
      {sel.analysis === undefined && sel.source === 'manual' && <span className="text-xs text-slate-400 italic"> — recomputing Tm/GC…</span>}
      {sel.analysis && (
        <>
          <br />
          Length: {sel.analysis.length} nt | Tm: {sel.analysis.tm ?? '—'}°C | GC%: {sel.analysis.gc_percent ?? '—'}
          {sel.analysis.hairpin.structure_found && <> | Hairpin ΔG: {sel.analysis.hairpin.dg ?? '—'} kcal/mol</>}
          {sel.analysis.homodimer.structure_found && <> | Homodimer ΔG: {sel.analysis.homodimer.dg ?? '—'} kcal/mol</>}
        </>
      )}
    </div>
  );
}

export default function SelectedPrimerInfo({ selections, data, ampTarget, ampDev, onFindProbesInAmplicon, idtCredentials }: Props) {
  const { wgaForward, wgaReverse, juncLeft, juncRight, geneForward, geneReverse, geneProbe } = selections;
  const [idtLoading, setIdtLoading] = useState(false);
  const [idtError, setIdtError] = useState<string | null>(null);
  const [idtResult, setIdtResult] = useState<IdtAnalyzeResponse | null>(null);

  const hasAny = wgaForward || wgaReverse || juncLeft || juncRight || geneForward || geneReverse || geneProbe;
  if (!hasAny) return null;

  const wgaLen = wgaForward && wgaReverse ? data.gene_len + wgaReverse.end - wgaForward.start + (data.upstream_len || 0) : null;
  const juncLen = juncLeft && juncRight ? juncRight.end - juncLeft.start : null;

  let geneLen: number | null = null;
  let geneLenColor = 'text-emerald-700 dark:text-emerald-300';
  let geneWarning: string | null = null;
  let splicedLen: number | null = null;
  let probeOutsideAmplicon = false;

  if (geneForward && geneReverse) {
    geneLen = geneReverse.end - geneForward.start;
    if (ampTarget && ampDev !== null && Math.abs(geneLen - ampTarget) > ampDev) {
      geneLenColor = 'text-red-600 dark:text-red-400 font-bold';
      geneWarning = 'Outside desired range';
    }
    if (geneLen < 50) {
      geneLenColor = 'text-red-600 dark:text-red-400 font-bold';
      geneWarning = 'Amplicon is too short';
    }
    if (data.include_introns) {
      let sum = 0;
      for (const ex of (data.annotations || []).filter((a) => a.type === 'exon')) {
        const s = Math.max(geneForward.start, ex.start);
        const e = Math.min(geneReverse.end, ex.end);
        if (e > s) sum += e - s;
      }
      if (sum > 0 && sum !== geneLen) splicedLen = sum;
    }
    if (geneProbe && geneProbe.region === 'gene') {
      if (geneProbe.start < geneForward.start || geneProbe.end > geneReverse.end) probeOutsideAmplicon = true;
    }
  }

  // Whichever forward/reverse pair is currently selected — gene-mode takes
  // priority (the more common manual-design flow), falling back to WGA.
  const idtPair = geneForward && geneReverse ? { p1: geneForward.primerSeq, p2: geneReverse.primerSeq } : wgaForward && wgaReverse ? { p1: wgaForward.primerSeq, p2: wgaReverse.primerSeq } : null;

  async function analyzeWithIdt() {
    if (!idtCredentials || !idtPair) return;
    setIdtError(null);
    setIdtResult(null);
    setIdtLoading(true);
    try {
      const token = await getIdtToken({
        client_id: idtCredentials.clientId,
        client_secret: idtCredentials.clientSecret,
        username: idtCredentials.username,
        password: idtCredentials.password,
        idt_region: idtCredentials.region,
      });
      // `engine: 'native'` here specifically to populate `native_hairpin`/
      // `native_self_dimer_subopt`/`native_hetero_dimer_subopt` — the
      // dot-bracket structure data the diagrams below need, which primer3
      // has no equivalent of (see `crates/server/src/routes/idt.rs`'s
      // module docs). Doesn't affect IDT's own numbers, only the "local"
      // comparison column.
      const result = await idtAnalyze({ p1_seq: idtPair.p1, p2_seq: idtPair.p2, token: token.access_token, idt_region: idtCredentials.region, engine: 'native' });
      setIdtResult(result);
    } catch (e) {
      setIdtError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setIdtLoading(false);
    }
  }

  return (
    <div className="mt-4 p-4 bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-700 dark:text-slate-300">
      <OneLine label="WGA Forward selected" sel={wgaForward} />
      <OneLine label="WGA Reverse selected" sel={wgaReverse} />
      <OneLine label="Junction Left selected" sel={juncLeft} />
      <OneLine label="Junction Right selected" sel={juncRight} />
      <OneLine label="Forward primer" sel={geneForward} />
      <OneLine label="Reverse primer" sel={geneReverse} />
      <OneLine label="TaqMan Probe selected" sel={geneProbe} />

      {wgaLen !== null && (
        <div className="mt-2.5 pt-2.5 border-t border-slate-200 dark:border-slate-700">
          <AmpliconStat label="Amplicon Length (WGA)" value={wgaLen} />
        </div>
      )}
      {juncLen !== null && (
        <div className="mt-2.5 pt-2.5 border-t border-slate-200 dark:border-slate-700">
          <AmpliconStat label="Amplicon Length (Junction)" value={juncLen} />
        </div>
      )}
      {geneLen !== null && (
        <div className="mt-2.5 pt-2.5 border-t border-slate-200 dark:border-slate-700 space-y-2">
          <AmpliconStat label={`Amplicon Length${data.include_introns ? ' (DNA/Genomic)' : ''}`} value={geneLen} valueClassName={geneLenColor} />
          {geneWarning && <p className="text-xs text-red-500">⚠ {geneWarning}</p>}
          {splicedLen !== null && <AmpliconStat label="Amplicon Length (mRNA/Spliced)" value={splicedLen} />}
          <div>
            <button onClick={onFindProbesInAmplicon} className="px-3 py-1 text-xs font-medium text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded hover:bg-blue-100 dark:hover:bg-blue-900/40 transition">
              Find Probes in this Amplicon
            </button>
          </div>
          {probeOutsideAmplicon && (
            <div className="p-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded text-xs text-red-700 dark:text-red-300">
              <strong>⚠ Warning:</strong> TaqMan probe is located outside the primer amplicon. Biologically, the probe must be between the forward and reverse primers.
            </div>
          )}
        </div>
      )}

      {idtCredentials && idtPair && (
        <div className="mt-2.5 pt-2.5 border-t border-slate-200 dark:border-slate-700">
          <button
            disabled={idtLoading}
            onClick={() => void analyzeWithIdt()}
            className="px-3 py-1 text-xs font-medium text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded transition"
          >
            {idtLoading ? 'Analyzing with IDT…' : 'Analyze with IDT'}
          </button>

          {idtError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{idtError}</p>}

          {idtResult && (
            <div className="mt-2 text-xs space-y-3">
              <div>
                <p>
                  <strong>Forward</strong> — IDT hairpin ΔG: {fmtDg(idtResult.m1.idt.hairpin_delta_g)} | IDT self-dimer ΔG: {fmtDg(idtResult.m1.idt.self_dimer_delta_g)} | local Tm:{' '}
                  {fmtNum(idtResult.m1.local.tm)}°C
                </p>
                {idtResult.m1.native_hairpin && (
                  <div className="mt-1">
                    <p className="text-slate-500 dark:text-slate-400">Native hairpin — Tm: {fmtNum(idtResult.m1.native_hairpin.tm)}°C | ΔG: {idtResult.m1.native_hairpin.dg37.toFixed(2)} kcal/mol</p>
                    <HairpinSvg sequence={idtPair.p1} structure={idtResult.m1.native_hairpin.structure} />
                  </div>
                )}
                {idtResult.m1.native_self_dimer_subopt[0] && (
                  <div className="mt-1">
                    <p className="text-slate-500 dark:text-slate-400">
                      Native self-dimer — Tm: {fmtNum(idtResult.m1.native_self_dimer_subopt[0].tm)}°C | ΔG: {idtResult.m1.native_self_dimer_subopt[0].dg37.toFixed(2)} kcal/mol
                    </p>
                    <DimerSvg seq1={idtPair.p1} seq2={idtPair.p1} structure={idtResult.m1.native_self_dimer_subopt[0].structure} />
                  </div>
                )}
              </div>

              <div>
                <p>
                  <strong>Reverse</strong> — IDT hairpin ΔG: {fmtDg(idtResult.m2.idt.hairpin_delta_g)} | IDT self-dimer ΔG: {fmtDg(idtResult.m2.idt.self_dimer_delta_g)} | local Tm:{' '}
                  {fmtNum(idtResult.m2.local.tm)}°C
                </p>
                {idtResult.m2.native_hairpin && (
                  <div className="mt-1">
                    <p className="text-slate-500 dark:text-slate-400">Native hairpin — Tm: {fmtNum(idtResult.m2.native_hairpin.tm)}°C | ΔG: {idtResult.m2.native_hairpin.dg37.toFixed(2)} kcal/mol</p>
                    <HairpinSvg sequence={idtPair.p2} structure={idtResult.m2.native_hairpin.structure} />
                  </div>
                )}
                {idtResult.m2.native_self_dimer_subopt[0] && (
                  <div className="mt-1">
                    <p className="text-slate-500 dark:text-slate-400">
                      Native self-dimer — Tm: {fmtNum(idtResult.m2.native_self_dimer_subopt[0].tm)}°C | ΔG: {idtResult.m2.native_self_dimer_subopt[0].dg37.toFixed(2)} kcal/mol
                    </p>
                    <DimerSvg seq1={idtPair.p2} seq2={idtPair.p2} structure={idtResult.m2.native_self_dimer_subopt[0].structure} />
                  </div>
                )}
              </div>

              <div>
                <p>
                  <strong>Pair</strong> — IDT heterodimer ΔG: {fmtDg(idtResult.pairwise.idt.hetero_dimer_delta_g)} | local heterodimer Tm: {fmtNum(idtResult.pairwise.local.heterodimer.tm)}°C
                </p>
                {idtResult.pairwise.native_hetero_dimer_subopt[0] && (
                  <div className="mt-1">
                    <p className="text-slate-500 dark:text-slate-400">
                      Native heterodimer — Tm: {fmtNum(idtResult.pairwise.native_hetero_dimer_subopt[0].tm)}°C | ΔG: {idtResult.pairwise.native_hetero_dimer_subopt[0].dg37.toFixed(2)} kcal/mol
                    </p>
                    <DimerSvg seq1={idtPair.p1} seq2={idtPair.p2} structure={idtResult.pairwise.native_hetero_dimer_subopt[0].structure} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function fmtDg(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)} kcal/mol`;
}

function fmtNum(v: number | null): string {
  return v === null ? '—' : v.toFixed(1);
}
