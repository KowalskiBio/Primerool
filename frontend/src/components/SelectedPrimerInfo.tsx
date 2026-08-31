import { useState } from 'react';
import type { SequenceData } from '../api/sequence';
import type { Selection, Selections } from '../utils/regionMapping';
import { getIdtToken, idtAnalyze, type IdtAnalyzeResponse } from '../api/idt';
import { ApiError } from '../api/client';
import type { IdtCredentials } from './IdtSettingsPanel';

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
  let geneLenColor = 'text-slate-900 dark:text-slate-100';
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
      const result = await idtAnalyze({ p1_seq: idtPair.p1, p2_seq: idtPair.p2, token: token.access_token, idt_region: idtCredentials.region });
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
          <strong>Amplicon (WGA)</strong>: <span className="font-mono">{wgaLen} bp</span>
        </div>
      )}
      {juncLen !== null && (
        <div className="mt-2.5 pt-2.5 border-t border-slate-200 dark:border-slate-700">
          <strong>Amplicon (Junction)</strong>: <span className="font-mono">{juncLen} bp</span>
        </div>
      )}
      {geneLen !== null && (
        <div className="mt-2.5 pt-2.5 border-t border-slate-200 dark:border-slate-700">
          <strong>Amplicon{data.include_introns ? ' (DNA/Genomic)' : ''}</strong>: <span className={`font-mono ${geneLenColor}`}>{geneLen} bp</span>
          {geneWarning && (
            <>
              <br />
              <span className="text-xs text-red-500">⚠ {geneWarning}</span>
            </>
          )}
          {splicedLen !== null && (
            <>
              <br />
              <strong>Amplicon (mRNA/Spliced)</strong>: <span className="font-mono text-slate-900 dark:text-slate-100">{splicedLen} bp</span>
            </>
          )}
          <div className="mt-2">
            <button onClick={onFindProbesInAmplicon} className="px-3 py-1 text-xs font-medium text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded hover:bg-blue-100 dark:hover:bg-blue-900/40 transition">
              Find Probes in this Amplicon
            </button>
          </div>
          {probeOutsideAmplicon && (
            <div className="mt-2 p-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded text-xs text-red-700 dark:text-red-300">
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
            <div className="mt-2 text-xs space-y-1">
              <p>
                <strong>Forward</strong> — IDT hairpin ΔG: {fmtDg(idtResult.m1.idt.hairpin_delta_g)} | IDT self-dimer ΔG: {fmtDg(idtResult.m1.idt.self_dimer_delta_g)} | local Tm:{' '}
                {fmtNum(idtResult.m1.local.tm)}°C
              </p>
              <p>
                <strong>Reverse</strong> — IDT hairpin ΔG: {fmtDg(idtResult.m2.idt.hairpin_delta_g)} | IDT self-dimer ΔG: {fmtDg(idtResult.m2.idt.self_dimer_delta_g)} | local Tm:{' '}
                {fmtNum(idtResult.m2.local.tm)}°C
              </p>
              <p>
                <strong>Pair</strong> — IDT heterodimer ΔG: {fmtDg(idtResult.pairwise.idt.hetero_dimer_delta_g)} | local heterodimer Tm: {fmtNum(idtResult.pairwise.local.heterodimer.tm)}°C
              </p>
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
