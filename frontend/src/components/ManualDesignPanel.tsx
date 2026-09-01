import { useEffect, useRef, useState } from 'react';
import type { SequenceData } from '../api/sequence';
import { designFromSequence, designProbe, type BestPairResult, type DesignEngine, type FromSequencePrimerResult, type ProbeResult } from '../api/design';
import EngineSelect from './EngineSelect';
import { ApiError } from '../api/client';
import { cleanDNA, reverseComplement } from '../utils/dna';
import { rawTupleToInterval } from '../utils/coords';
import { fmt, yesNo } from '../utils/format';
import type { Selection, Selections } from '../utils/regionMapping';
import ResultsTable from './ResultsTable';

/** The two probe-parameter presets confirmed in the legacy source (see the
 * rewrite plan's Phase 6c section) — genuinely different fallback defaults
 * at two call sites that happen to share one input panel today. Both stay
 * distinct here rather than being unified into one constant. */
const PROBE_DEFAULTS_STANDALONE = { tmMin: 65, tmOpt: 70, tmMax: 75, lenMin: 18, lenOpt: 22, lenMax: 30, gcMin: 30, gcMax: 80 };
const PROBE_DEFAULTS_IN_AMPLICON = { tmMin: 55, tmOpt: 60, tmMax: 75, lenMin: 18, lenOpt: 22, lenMax: 35, gcMin: 20, gcMax: 80 };

export interface ProbeSearchRequest {
  probeRegion: string;
  offset: number;
  nonce: number;
}

interface Props {
  data: SequenceData;
  onSelect: (key: keyof Selections, value: Selection) => void;
  ampTarget: number;
  ampDev: number;
  onAmpTargetChange: (v: number) => void;
  onAmpDevChange: (v: number) => void;
  probeSearchRequest: ProbeSearchRequest | null;
}

export default function ManualDesignPanel({ data, onSelect, ampTarget, ampDev, onAmpTargetChange, onAmpDevChange, probeSearchRequest }: Props) {
  const [fwdRegionText, setFwdRegionText] = useState('');
  const [revRegionText, setRevRegionText] = useState('');
  const [probeRegionText, setProbeRegionText] = useState('');

  const [tmMin, setTmMin] = useState(57);
  const [tmOpt, setTmOpt] = useState(62);
  const [tmMax, setTmMax] = useState(67);
  const [lenMin, setLenMin] = useState(18);
  const [lenOpt, setLenOpt] = useState(20);
  const [lenMax, setLenMax] = useState(25);
  const [gcMin, setGcMin] = useState(40);
  const [gcMax, setGcMax] = useState(60);
  const [numReturn, setNumReturn] = useState(5);

  const [probeTmMin, setProbeTmMin] = useState(55);
  const [probeTmOpt, setProbeTmOpt] = useState(60);
  const [probeTmMax, setProbeTmMax] = useState(75);
  const [probeLenMin, setProbeLenMin] = useState(18);
  const [probeLenOpt, setProbeLenOpt] = useState(22);
  const [probeLenMax, setProbeLenMax] = useState(35);
  const [probeGcMin, setProbeGcMin] = useState(20);
  const [probeGcMax, setProbeGcMax] = useState(80);

  const [mvConc, setMvConc] = useState(50.0);
  const [dvConc, setDvConc] = useState(1.5);
  const [dntpConc, setDntpConc] = useState(0.2);
  const [dnaConc, setDnaConc] = useState(50.0);
  const [maxPolyX, setMaxPolyX] = useState(5);
  const [maxNs, setMaxNs] = useState(0);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [engine, setEngine] = useState<DesignEngine>('primer3');
  const [fromSeqResult, setFromSeqResult] = useState<{ forward: FromSequencePrimerResult[]; reverse: FromSequencePrimerResult[]; bestPairs: BestPairResult[]; offset: number } | null>(null);
  const [probeResult, setProbeResult] = useState<{ probes: ProbeResult[]; offset: number } | null>(null);
  // A ref, not state: this just remembers which request we've already
  // fired, it doesn't drive rendering — mutating it inside the effect
  // below is the sanctioned pattern (unlike calling setState there).
  const lastHandledProbeNonceRef = useRef(0);

  const advanced = { mv_conc: mvConc, dv_conc: dvConc, dntp_conc: dntpConc, dna_conc: dnaConc, max_poly_x: maxPolyX, max_ns: maxNs };

  function selectManualGene(which: 'forward' | 'reverse', interval: [number, number], primerSeq: string, source: 'recommended' | 'manual') {
    const [start, end] = interval;
    const binding = (data.gene_seq || '').substring(start, end);
    onSelect(which === 'forward' ? 'geneForward' : 'geneReverse', { region: 'gene', start, end, primerSeq, bindingSeq: binding, source });
  }

  /** Fallback for results with no coordinate metadata at all (the
   * independent-design path): searches gene -> spliced -> upstream ->
   * downstream, in that priority order, for the primer sequence or its
   * reverse-complement — ported directly from the legacy `findAndUsePrimer`. */
  function findAndUsePrimer(seq: string, type: 'forward' | 'reverse' | 'unknown', searchOffset = 0) {
    const cleanSeq = seq.replace(/[^A-Za-z]/g, '').toUpperCase();
    const rc = reverseComplement(cleanSeq);
    const gene = data.gene_seq || '';
    const spliced = data.spliced_exons_seq || '';
    const up = data.upstream_seq || '';
    const down = data.downstream_seq || '';

    if (type !== 'reverse') {
      const idx = gene.indexOf(cleanSeq, searchOffset);
      if (idx !== -1) return selectManualGene('forward', [idx, idx + cleanSeq.length], cleanSeq, 'manual');
    }
    if (type !== 'forward') {
      const idx = gene.indexOf(rc, searchOffset);
      if (idx !== -1) return selectManualGene('reverse', [idx, idx + rc.length], cleanSeq, 'manual');
    }
    if (type !== 'reverse') {
      const idx = spliced.indexOf(cleanSeq);
      if (idx !== -1) return onSelect('juncLeft', { region: 'spliced', start: idx, end: idx + cleanSeq.length, primerSeq: cleanSeq, bindingSeq: cleanSeq, source: 'manual' });
    }
    if (type !== 'forward') {
      const idx = spliced.indexOf(rc);
      if (idx !== -1) return onSelect('juncRight', { region: 'spliced', start: idx, end: idx + rc.length, primerSeq: cleanSeq, bindingSeq: cleanSeq, source: 'manual' });
    }
    if (type !== 'reverse') {
      const idx = up.indexOf(cleanSeq);
      if (idx !== -1) return onSelect('wgaForward', { region: 'up', start: idx, end: idx + cleanSeq.length, primerSeq: cleanSeq, bindingSeq: cleanSeq, source: 'manual' });
    }
    if (type !== 'forward') {
      const idx = up.indexOf(rc);
      if (idx !== -1) return onSelect('wgaReverse', { region: 'up', start: idx, end: idx + rc.length, primerSeq: cleanSeq, bindingSeq: cleanSeq, source: 'manual' });
    }
    if (type !== 'reverse') {
      const idx = down.indexOf(cleanSeq);
      if (idx !== -1) return onSelect('wgaForward', { region: 'down', start: idx, end: idx + cleanSeq.length, primerSeq: cleanSeq, bindingSeq: cleanSeq, source: 'manual' });
    }
    if (type !== 'forward') {
      const idx = down.indexOf(rc);
      if (idx !== -1) return onSelect('wgaReverse', { region: 'down', start: idx, end: idx + rc.length, primerSeq: cleanSeq, bindingSeq: cleanSeq, source: 'manual' });
    }
    setError(`Primer sequence ${cleanSeq} not found in any sequence block (Gene, Spliced, Flanks).`);
  }

  // The legacy app's `findAndUseProbe` substring-search fallback (for a
  // probe result with no coordinate metadata) is genuinely dead code here:
  // `/design_probe`'s response always includes `coords` (see `api/design.ts`'s
  // `ProbeResult` — declared required, not optional, because the real
  // route always sets it via `raw_tuple`), so the "Use" button below
  // always has real coordinates to work with. Not ported, per this
  // session's own "drop confirmed-dead code, don't preserve it defensively"
  // precedent (e.g. the legacy feature map's dead first `renderFeatureMap`).

  async function runDesignFromSequence() {
    setError(null);
    const fwdRegion = cleanDNA(fwdRegionText);
    let revRegion = cleanDNA(revRegionText);

    if (!fwdRegion || fwdRegion.length < 18) {
      setError('Please enter a forward primer region (at least 18 bp).');
      return;
    }

    const upstream = cleanDNA(data.upstream_seq || '');
    const gene = cleanDNA(data.gene_seq || '');
    const downstream = cleanDNA(data.downstream_seq || '');
    const fullTemplate = upstream + gene + downstream;
    const upstreamLen = upstream.length;

    let fwdPos = fullTemplate.indexOf(fwdRegion);
    if (fwdPos === -1) fwdPos = fullTemplate.indexOf(reverseComplement(fwdRegion));

    let revPos = -1;
    const userProvidedReverse = !!revRegion;
    let target = ampTarget;
    let dev = ampDev;

    if (!revRegion) {
      if (fwdPos === -1) {
        setError('Forward sequence not found in template. Please ensure you copied it from the map or provided a valid sub-sequence.');
        return;
      }
      const fwdEnd = fwdPos + fwdRegion.length;
      const searchStart = Math.max(fwdEnd, fwdPos + (target - dev));
      const searchEnd = fwdPos + (target + dev);
      if (searchEnd <= searchStart) {
        setError(`Target amplicon length (${target} bp) is too short. Try a larger target.`);
        return;
      }
      revPos = Math.max(0, searchStart - 30);
      const endPos = Math.min(fullTemplate.length, searchEnd + 10);
      revRegion = fullTemplate.substring(revPos, endPos);
      if (revRegion.length < 20) {
        setError('Calculated reverse search region is too short. Please provide a reverse region manually.');
        return;
      }
    } else {
      revPos = fullTemplate.indexOf(revRegion);
      if (revPos === -1) revPos = fullTemplate.indexOf(reverseComplement(revRegion));
    }

    if (userProvidedReverse && fwdPos !== -1 && revPos !== -1) {
      const actualLen = revPos + revRegion.length - fwdPos;
      if (actualLen < target - dev || actualLen > target + dev) {
        const proceed = window.confirm(`Warning: The distance between provided regions (${actualLen} bp) is outside your range (${target} ± ${dev} bp). Proceed anyway?`);
        if (!proceed) return;
        // @ts-expect-error -- deliberately widened below the request type's number requirement, matching the legacy app's own "ignore limits" escape hatch.
        target = null;
        // @ts-expect-error -- see above.
        dev = null;
      }
    }

    setLoading(true);
    try {
      const res = await designFromSequence({
        forward_region: fwdRegion,
        reverse_region: revRegion,
        fwd_pos: fwdPos,
        rev_pos: revPos,
        template_seq: fullTemplate,
        amplicon_target: target ?? undefined,
        amplicon_deviation: dev ?? undefined,
        conditions: { tm_min: tmMin, tm_opt: tmOpt, tm_max: tmMax, len_min: lenMin, len_opt: lenOpt, len_max: lenMax, gc_min: gcMin, gc_max: gcMax, num_return: numReturn, advanced },
        engine,
      });
      setFromSeqResult({ forward: res.forward_primers, reverse: res.reverse_primers, bestPairs: res.best_pairs, offset: -upstreamLen });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      setFromSeqResult(null);
    } finally {
      setLoading(false);
    }
  }

  async function runDesignProbeStandalone() {
    setError(null);
    const probeRegion = cleanDNA(probeRegionText);
    if (!probeRegion || probeRegion.length < 15) {
      setError('Please enter a probe region (at least 15 bp).');
      return;
    }
    setLoading(true);
    try {
      const res = await designProbe(probeRegion, {
        probe_tm_min: probeTmMin || PROBE_DEFAULTS_STANDALONE.tmMin,
        probe_tm_opt: probeTmOpt || PROBE_DEFAULTS_STANDALONE.tmOpt,
        probe_tm_max: probeTmMax || PROBE_DEFAULTS_STANDALONE.tmMax,
        probe_len_min: probeLenMin || PROBE_DEFAULTS_STANDALONE.lenMin,
        probe_len_opt: probeLenOpt || PROBE_DEFAULTS_STANDALONE.lenOpt,
        probe_len_max: probeLenMax || PROBE_DEFAULTS_STANDALONE.lenMax,
        probe_gc_min: probeGcMin || PROBE_DEFAULTS_STANDALONE.gcMin,
        probe_gc_max: probeGcMax || PROBE_DEFAULTS_STANDALONE.gcMax,
        advanced,
        num_return: numReturn,
      }, engine);
      const idx = (data.gene_seq || '').indexOf(probeRegion);
      setProbeResult({ probes: res.probes, offset: idx !== -1 ? idx : 0 });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      setProbeResult(null);
    } finally {
      setLoading(false);
    }
  }

  async function runFindProbesInAmplicon(probeRegion: string, offset: number) {
    setError(null);
    setProbeRegionText(probeRegion);
    setLoading(true);
    try {
      const res = await designProbe(probeRegion, {
        probe_tm_min: probeTmMin || PROBE_DEFAULTS_IN_AMPLICON.tmMin,
        probe_tm_opt: probeTmOpt || PROBE_DEFAULTS_IN_AMPLICON.tmOpt,
        probe_tm_max: probeTmMax || PROBE_DEFAULTS_IN_AMPLICON.tmMax,
        probe_len_min: probeLenMin || PROBE_DEFAULTS_IN_AMPLICON.lenMin,
        probe_len_opt: probeLenOpt || PROBE_DEFAULTS_IN_AMPLICON.lenOpt,
        probe_len_max: probeLenMax || PROBE_DEFAULTS_IN_AMPLICON.lenMax,
        probe_gc_min: probeGcMin || PROBE_DEFAULTS_IN_AMPLICON.gcMin,
        probe_gc_max: probeGcMax || PROBE_DEFAULTS_IN_AMPLICON.gcMax,
        advanced,
        num_return: 5,
      }, engine);
      setProbeResult({ probes: res.probes, offset });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      setProbeResult(null);
    } finally {
      setLoading(false);
    }
  }

  // Responds to Card 3's "Find Probes in this Amplicon" button (App.tsx
  // computes the amplicon region from `selections` and hands it down here
  // as a nonce-tagged request, since the two components are siblings, not
  // parent/child). Triggering an async fetch in response to a prop change
  // is exactly what `useEffect` is for — this isn't mirroring a prop into
  // state synchronously (the pattern the lint rule warns about).
  useEffect(() => {
    if (probeSearchRequest && probeSearchRequest.nonce !== lastHandledProbeNonceRef.current) {
      lastHandledProbeNonceRef.current = probeSearchRequest.nonce;
      void runFindProbesInAmplicon(probeSearchRequest.probeRegion, probeSearchRequest.offset);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeSearchRequest]);

  return (
    <div>
      <h3 className="text-md font-semibold text-slate-800 dark:text-slate-200 mb-2">Design Primers from Sequence</h3>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Paste a sequence region for each primer. Primer3 will find the best primer within each region.</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Forward Primer Region:</label>
          <textarea
            rows={3}
            value={fwdRegionText}
            onChange={(e) => setFwdRegionText(e.target.value)}
            placeholder="Paste sequence region for forward primer..."
            className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm font-mono text-sm p-3 border resize-y"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Reverse Primer Region:</label>
          <textarea
            rows={3}
            value={revRegionText}
            onChange={(e) => setRevRegionText(e.target.value)}
            placeholder="Paste sequence region for reverse primer..."
            className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm font-mono text-sm p-3 border resize-y"
          />
        </div>
      </div>

      <div className="mb-4">
        <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">TaqMan Probe Region (Optional):</label>
        <textarea
          rows={2}
          value={probeRegionText}
          onChange={(e) => setProbeRegionText(e.target.value)}
          placeholder="Paste sequence region for TaqMan probe..."
          className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm font-mono text-sm p-3 border resize-y"
        />

        <details className="mt-2 border border-slate-200 dark:border-slate-600 rounded-lg">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-blue-600 dark:text-blue-400 bg-slate-50 dark:bg-slate-700/50 rounded-lg">⚙️ Probe Conditions (Tm, Length, GC)</summary>
          <div className="px-3 py-2 space-y-2">
            <NumberTriple label="Probe Tm (°C)" min={probeTmMin} opt={probeTmOpt} max={probeTmMax} onMin={setProbeTmMin} onOpt={setProbeTmOpt} onMax={setProbeTmMax} step={0.5} />
            <NumberTriple label="Probe Length (bp)" min={probeLenMin} opt={probeLenOpt} max={probeLenMax} onMin={setProbeLenMin} onOpt={setProbeLenOpt} onMax={setProbeLenMax} step={1} />
            <NumberPair label="Probe GC (%)" min={probeGcMin} max={probeGcMax} onMin={setProbeGcMin} onMax={setProbeGcMax} />
          </div>
        </details>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">Desired Amplicon Length (bp)</label>
          <input type="number" step={10} min={50} max={2000} value={ampTarget} onChange={(e) => onAmpTargetChange(parseInt(e.target.value, 10) || 150)} className="w-full rounded-md border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">Length Deviation (± bp)</label>
          <input type="number" step={5} min={5} max={500} value={ampDev} onChange={(e) => onAmpDevChange(parseInt(e.target.value, 10) || 50)} className="w-full rounded-md border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border" />
        </div>
      </div>

      <details className="mb-4 border border-slate-200 dark:border-slate-600 rounded-lg">
        <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-700/50 rounded-lg">⚙️ Primer Conditions</summary>
        <div className="px-4 py-3 space-y-3">
          <NumberTriple label="Melting Temperature (Tm, °C)" min={tmMin} opt={tmOpt} max={tmMax} onMin={setTmMin} onOpt={setTmOpt} onMax={setTmMax} step={0.5} />
          <NumberTriple label="Primer Length (bp)" min={lenMin} opt={lenOpt} max={lenMax} onMin={setLenMin} onOpt={setLenOpt} onMax={setLenMax} step={1} />
          <NumberPair label="GC Content (%)" min={gcMin} max={gcMax} onMin={setGcMin} onMax={setGcMax} />
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">Max Options to Return</label>
              <input type="number" step={1} min={1} max={20} value={numReturn} onChange={(e) => setNumReturn(parseInt(e.target.value, 10) || 5)} className="w-24 rounded-md border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border" />
            </div>
            <EngineSelect value={engine} onChange={setEngine} />
          </div>

          <details className="mt-2 border-t border-slate-100 dark:border-slate-700 pt-2">
            <summary className="text-xs font-semibold text-green-600 cursor-pointer select-none py-1">Advanced Primer3 Options (Salts, Poly-X, etc)</summary>
            <div className="grid grid-cols-2 gap-3 mt-2">
              <LabeledNumber label="Na+/K+ conc (mM)" value={mvConc} onChange={setMvConc} step={1} />
              <LabeledNumber label="Mg2+ conc (mM)" value={dvConc} onChange={setDvConc} step={0.1} />
              <LabeledNumber label="dNTP conc (mM)" value={dntpConc} onChange={setDntpConc} step={0.05} />
              <LabeledNumber label="DNA conc (nM)" value={dnaConc} onChange={setDnaConc} step={5} />
              <LabeledNumber label="Max Poly-X" value={maxPolyX} onChange={setMaxPolyX} step={1} />
              <LabeledNumber label="Max Ns" value={maxNs} onChange={setMaxNs} step={1} />
            </div>
          </details>
        </div>
      </details>

      <div className="flex flex-wrap gap-2">
        <button disabled={loading} onClick={() => void runDesignFromSequence()} className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2 transition-colors shadow-sm w-full md:w-auto">
          Design Primers
        </button>
        <button disabled={loading} onClick={() => void runDesignProbeStandalone()} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2 transition-colors shadow-sm w-full md:w-auto">
          Design TaqMan Probe
        </button>
      </div>

      {error && <div className="error mt-4 p-3 text-sm text-red-800 dark:text-red-300 rounded-lg bg-red-50 dark:bg-red-950/40">{error}</div>}

      <div className="mt-4 space-y-6">
        {fromSeqResult && (
          <>
            {fromSeqResult.forward.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2 mt-4 ml-1">Forward Primers (from forward region)</h4>
                <ResultsTable
                  rows={fromSeqResult.forward}
                  keyOf={(p, i) => `fp-${i}-${p.sequence}`}
                  columns={primerAnalysisColumns((p) => {
                    if (p.coords) {
                      const [s, e] = rawTupleToInterval(p.coords, false);
                      selectManualGene('forward', [s + fromSeqResult.offset, e + fromSeqResult.offset], p.sequence, 'manual');
                    } else {
                      findAndUsePrimer(p.sequence, 'forward', fromSeqResult.offset);
                    }
                  })}
                />
              </div>
            )}
            {fromSeqResult.reverse.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2 mt-4 ml-1">Reverse Primers (from reverse region)</h4>
                <ResultsTable
                  rows={fromSeqResult.reverse}
                  keyOf={(p, i) => `rp-${i}-${p.sequence}`}
                  columns={primerAnalysisColumns((p) => {
                    if (p.coords) {
                      const [s, e] = rawTupleToInterval(p.coords, true);
                      selectManualGene('reverse', [s + fromSeqResult.offset, e + fromSeqResult.offset], p.sequence, 'manual');
                    } else {
                      findAndUsePrimer(p.sequence, 'reverse', fromSeqResult.offset);
                    }
                  })}
                />
              </div>
            )}
            {fromSeqResult.bestPairs.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2 mt-4 ml-1">Best Pair Combinations</h4>
                <ResultsTable
                  rows={fromSeqResult.bestPairs}
                  keyOf={(p, i) => `bp-${i}-${p.forward_seq}`}
                  columns={[
                    { header: '#', render: (_p, i) => i + 1 },
                    { header: 'Forward', render: (p) => p.forward_seq, className: 'font-mono text-slate-800 dark:text-slate-200' },
                    { header: 'Fwd Tm', render: (p) => fmt(p.forward_tm) },
                    { header: 'Reverse', render: (p) => p.reverse_seq, className: 'font-mono text-slate-800 dark:text-slate-200' },
                    { header: 'Rev Tm', render: (p) => fmt(p.reverse_tm) },
                    { header: 'Amplicon', render: (p) => (p.product_size !== undefined ? `${p.product_size} bp` : '-'), className: 'font-bold text-blue-700 dark:text-blue-400' },
                    { header: 'ΔTm', render: (p) => fmt(p.tm_diff) },
                    { header: 'HD ΔG', render: (p) => fmt(p.heterodimer.dg) },
                    {
                      header: 'Action',
                      render: (p) => (
                        <button
                          className="px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition"
                          onClick={() => {
                            if (p.forward_coords && p.reverse_coords) {
                              const [fs, fe] = rawTupleToInterval(p.forward_coords, false);
                              const [rs, re] = rawTupleToInterval(p.reverse_coords, true);
                              selectManualGene('forward', [fs + fromSeqResult.offset, fe + fromSeqResult.offset], p.forward_seq, 'manual');
                              selectManualGene('reverse', [rs + fromSeqResult.offset, re + fromSeqResult.offset], p.reverse_seq, 'manual');
                            } else {
                              findAndUsePrimer(p.forward_seq, 'forward', fromSeqResult.offset);
                              findAndUsePrimer(p.reverse_seq, 'reverse', fromSeqResult.offset);
                            }
                          }}
                        >
                          Use Both
                        </button>
                      ),
                    },
                  ]}
                />
              </div>
            )}
          </>
        )}

        {probeResult && probeResult.probes.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2 mt-4 ml-1">TaqMan Probes</h4>
            <ResultsTable
              accent="blue"
              rows={probeResult.probes}
              keyOf={(p, i) => `pr-${i}-${p.sequence}`}
              columns={[
                { header: '#', render: (_p, i) => i + 1 },
                { header: "Sequence (5'→3')", render: (p) => p.sequence, className: 'font-mono text-blue-800 dark:text-blue-300' },
                { header: 'Len', render: (p) => p.length },
                { header: 'Tm', render: (p) => fmt(p.tm) },
                { header: 'GC%', render: (p) => fmt(p.gc_percent) },
                { header: 'Hairpin', render: (p) => yesNo(p.hairpin.structure_found) },
                { header: 'Homol', render: (p) => yesNo(p.homodimer.structure_found) },
                {
                  header: 'Action',
                  render: (p) => (
                    <button
                      className="px-2 py-1 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700 transition"
                      onClick={() => {
                        const [s, e] = rawTupleToInterval(p.coords, false);
                        onSelect('geneProbe', { region: 'gene', start: probeResult.offset + s, end: probeResult.offset + e, primerSeq: p.sequence, bindingSeq: p.sequence, source: 'manual' });
                      }}
                    >
                      Use
                    </button>
                  ),
                },
              ]}
            />
          </div>
        )}

      </div>
    </div>
  );
}

function primerAnalysisColumns(onUse: (p: FromSequencePrimerResult) => void) {
  return [
    { header: '#', render: (_p: FromSequencePrimerResult, i: number) => i + 1 },
    { header: "Sequence (5'→3')", render: (p: FromSequencePrimerResult) => p.sequence, className: 'font-mono text-slate-800 dark:text-slate-200' },
    { header: 'Len', render: (p: FromSequencePrimerResult) => p.length },
    { header: 'Tm', render: (p: FromSequencePrimerResult) => fmt(p.tm) },
    { header: 'GC%', render: (p: FromSequencePrimerResult) => fmt(p.gc_percent) },
    { header: 'Hairpin', render: (p: FromSequencePrimerResult) => yesNo(p.hairpin.structure_found) },
    { header: 'HP ΔG', render: (p: FromSequencePrimerResult) => fmt(p.hairpin.dg) },
    { header: 'Homol', render: (p: FromSequencePrimerResult) => yesNo(p.homodimer.structure_found) },
    { header: 'HD ΔG', render: (p: FromSequencePrimerResult) => fmt(p.homodimer.dg) },
    {
      header: 'Action',
      render: (p: FromSequencePrimerResult) => (
        <button className="px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition" onClick={() => onUse(p)}>
          Use
        </button>
      ),
    },
  ];
}

function NumberTriple({
  label,
  min,
  opt,
  max,
  onMin,
  onOpt,
  onMax,
  step,
}: {
  label: string;
  min: number;
  opt: number;
  max: number;
  onMin: (v: number) => void;
  onOpt: (v: number) => void;
  onMax: (v: number) => void;
  step: number;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">{label}</label>
      <div className="grid grid-cols-3 gap-2">
        <LabeledNumber label="Min" value={min} onChange={onMin} step={step} small />
        <LabeledNumber label="Optimal" value={opt} onChange={onOpt} step={step} small />
        <LabeledNumber label="Max" value={max} onChange={onMax} step={step} small />
      </div>
    </div>
  );
}

function NumberPair({ label, min, max, onMin, onMax }: { label: string; min: number; max: number; onMin: (v: number) => void; onMax: (v: number) => void }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">{label}</label>
      <div className="grid grid-cols-2 gap-2">
        <LabeledNumber label="Min" value={min} onChange={onMin} step={1} small />
        <LabeledNumber label="Max" value={max} onChange={onMax} step={1} small />
      </div>
    </div>
  );
}

function LabeledNumber({ label, value, onChange, step, small }: { label: string; value: number; onChange: (v: number) => void; step: number; small?: boolean }) {
  return (
    <div>
      <label className="block text-xs text-slate-500 dark:text-slate-400">{label}</label>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className={`w-full rounded-md border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm border ${small ? 'text-xs px-2 py-1' : 'text-sm px-2 py-1.5'}`}
      />
    </div>
  );
}
