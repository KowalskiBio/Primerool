import { useState } from 'react';
import type { SequenceData } from '../api/sequence';
import { designFlanking, designInternal, designJunction, type FlankingOligoResult, type InternalDesignPair, type JunctionPairResult } from '../api/design';
import { ApiError } from '../api/client';
import type { Selection, Selections } from '../utils/regionMapping';
import { rawTupleToInterval } from '../utils/coords';
import ResultsTable from './ResultsTable';
import ArmsDesignPanel from './ArmsDesignPanel';
import { fmt, yesNo } from '../utils/format';

type PrimerMode = 'flanking' | 'junction' | 'general' | 'arms';

interface Props {
  data: SequenceData;
  species: string;
  apiSource: 'ensembl' | 'ncbi';
  primerMode: PrimerMode;
  onPrimerModeChange: (mode: PrimerMode) => void;
  onSelect: (key: keyof Selections, value: Selection) => void;
}

export default function AutoDesignPanel({ data, species, apiSource, primerMode, onPrimerModeChange, onSelect }: Props) {
  const [junctionPos, setJunctionPos] = useState('');
  const [overlapMin, setOverlapMin] = useState(6);
  const [overlapMax, setOverlapMax] = useState(12);
  const [ampliconMin, setAmpliconMin] = useState(80);
  const [ampliconMax, setAmpliconMax] = useState(220);
  const [targetStart, setTargetStart] = useState(0);
  const [targetEnd, setTargetEnd] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flankingResult, setFlankingResult] = useState<{ forward: FlankingOligoResult[]; reverse: FlankingOligoResult[]; pairDg: number | null; pairFound: boolean } | null>(null);
  const [junctionPairs, setJunctionPairs] = useState<JunctionPairResult[] | null>(null);
  const [generalPairs, setGeneralPairs] = useState<InternalDesignPair[] | null>(null);

  function selectWGA(which: 'forward' | 'reverse', region: 'up' | 'down', interval: [number, number], primerSeq: string, source: 'recommended' | 'manual' = 'recommended') {
    const [start, end] = interval;
    const binding = (region === 'up' ? data.upstream_seq : data.downstream_seq || '').substring(start, end);
    onSelect(which === 'forward' ? 'wgaForward' : 'wgaReverse', { region, start, end, primerSeq, bindingSeq: binding, source });
  }

  function selectJunction(which: 'left' | 'right', interval: [number, number], primerSeq: string, source: 'recommended' | 'manual' = 'recommended') {
    const [start, end] = interval;
    const spliced = data.spliced_exons_seq || '';
    onSelect(which === 'left' ? 'juncLeft' : 'juncRight', { region: 'spliced', start, end, primerSeq, bindingSeq: spliced.substring(start, end), source });
  }

  function selectGeneral(which: 'forward' | 'reverse', interval: [number, number], primerSeq: string, source: 'recommended' | 'manual' = 'recommended') {
    const [start, end] = interval;
    onSelect(which === 'forward' ? 'geneForward' : 'geneReverse', { region: 'gene', start, end, primerSeq, bindingSeq: (data.gene_seq || '').substring(start, end), source });
  }

  async function runFlanking() {
    setError(null);
    setLoading(true);
    setJunctionPairs(null);
    setGeneralPairs(null);
    try {
      const res = await designFlanking(data.upstream_seq, data.downstream_seq);
      const fwd = res.primers.forward.primers;
      const rev = res.primers.reverse.primers;
      if (!fwd.length || !rev.length) {
        setError('No primers returned. Try larger flanks.');
        setFlankingResult(null);
        return;
      }
      setFlankingResult({ forward: fwd, reverse: rev, pairDg: res.primers.pair_metrics?.heterodimer.dg ?? null, pairFound: res.primers.pair_metrics?.heterodimer.structure_found ?? false });
      if (fwd[0]) selectWGA('forward', 'up', fwd[0].interval, fwd[0].sequence);
      if (rev[0]) selectWGA('reverse', 'down', rev[0].interval, rev[0].sequence);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      setFlankingResult(null);
    } finally {
      setLoading(false);
    }
  }

  async function runJunction() {
    setError(null);
    if (!junctionPos) {
      setError('Select a junction first.');
      return;
    }
    const spliced = data.spliced_exons_seq || data.spliced_seq || '';
    if (!spliced) {
      setError('No exon-only spliced template available for junction primer design.');
      return;
    }
    setLoading(true);
    setFlankingResult(null);
    setGeneralPairs(null);
    try {
      const res = await designJunction({
        sequence: spliced,
        junction_pos: parseInt(junctionPos, 10),
        junction_overlap_min: overlapMin,
        junction_overlap_max: overlapMax,
        amplicon_min: ampliconMin,
        amplicon_max: ampliconMax,
      });
      const pairs = res.primers.pairs;
      if (!pairs.length) {
        setError('No internal primer pairs returned.');
        setJunctionPairs(null);
        return;
      }
      setJunctionPairs(pairs);
      const first = pairs[0];
      if (first.left.interval) selectJunction('left', first.left.interval, first.left.sequence);
      if (first.right.interval) selectJunction('right', first.right.interval, first.right.sequence);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      setJunctionPairs(null);
    } finally {
      setLoading(false);
    }
  }

  async function runGeneral() {
    setError(null);
    if (targetEnd <= targetStart) {
      setError('Target end must be after target start.');
      return;
    }
    setLoading(true);
    setFlankingResult(null);
    setJunctionPairs(null);
    try {
      const res = await designInternal(data.gene_seq, targetStart, targetEnd);
      const pairs = res.primers;
      if (!pairs.length) {
        setError('No primers found. Try different positions.');
        setGeneralPairs(null);
        return;
      }
      setGeneralPairs(pairs);
      const first = pairs[0];
      selectGeneral('forward', rawTupleToInterval(first.left.position, false), first.left.sequence);
      selectGeneral('reverse', rawTupleToInterval(first.right.position, true), first.right.sequence);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      setGeneralPairs(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-4 mb-6">
        <label className="flex items-center gap-2 cursor-pointer bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
          <input type="radio" name="primerMode" checked={primerMode === 'general'} onChange={() => onPrimerModeChange('general')} className="accent-green-600 w-4 h-4" />
          <span className="font-medium text-slate-700 dark:text-slate-200">General (primers anywhere in the gene)</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
          <input type="radio" name="primerMode" checked={primerMode === 'flanking'} onChange={() => onPrimerModeChange('flanking')} className="accent-green-600 w-4 h-4" />
          <span className="font-medium text-slate-700 dark:text-slate-200">WGA (primers in flanking regions)</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
          <input type="radio" name="primerMode" checked={primerMode === 'junction'} onChange={() => onPrimerModeChange('junction')} className="accent-green-600 w-4 h-4" />
          <span className="font-medium text-slate-700 dark:text-slate-200">Intron/Exon junction (exon–exon junction primers)</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
          <input type="radio" name="primerMode" checked={primerMode === 'arms'} onChange={() => onPrimerModeChange('arms')} className="accent-green-600 w-4 h-4" />
          <span className="font-medium text-slate-700 dark:text-slate-200">SNP/indel (ARMS-PCR allele-specific primers)</span>
        </label>
      </div>

      {primerMode === 'arms' && <ArmsDesignPanel data={data} species={species} apiSource={apiSource} onSelect={onSelect} />}

      {primerMode === 'general' && (
        <div className="bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-700 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Target start (bp, 0-based into gene sequence):</label>
              <input type="number" min={0} value={targetStart} onChange={(e) => setTargetStart(parseInt(e.target.value, 10) || 0)} className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-3 py-2 border" />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Target end (bp, exclusive):</label>
              <input type="number" min={0} value={targetEnd} onChange={(e) => setTargetEnd(parseInt(e.target.value, 10) || 0)} className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-3 py-2 border" />
            </div>
          </div>
        </div>
      )}

      {primerMode === 'junction' && (
        <div className="bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-700 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Choose junction:</label>
              <select
                value={junctionPos}
                onChange={(e) => setJunctionPos(e.target.value)}
                className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-3 py-2 border"
              >
                <option value="">-- Select a junction --</option>
                {(data.junctions || []).map((j) => (
                  <option key={j.index} value={j.pos}>
                    {j.label || `junction @ ${j.pos}`}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Junction overlap min (bp):</label>
              <input type="number" min={1} value={overlapMin} onChange={(e) => setOverlapMin(parseInt(e.target.value, 10) || 1)} className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-3 py-2 border" />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Junction overlap max (bp):</label>
              <input type="number" min={1} value={overlapMax} onChange={(e) => setOverlapMax(parseInt(e.target.value, 10) || 1)} className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-3 py-2 border" />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Amplicon min (bp):</label>
              <input type="number" min={1} value={ampliconMin} onChange={(e) => setAmpliconMin(parseInt(e.target.value, 10) || 1)} className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-3 py-2 border" />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Amplicon max (bp):</label>
              <input type="number" min={1} value={ampliconMax} onChange={(e) => setAmpliconMax(parseInt(e.target.value, 10) || 1)} className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-3 py-2 border" />
            </div>
          </div>
        </div>
      )}

      {primerMode !== 'arms' && (
        <button
          disabled={loading}
          onClick={() => void (primerMode === 'flanking' ? runFlanking() : primerMode === 'junction' ? runJunction() : runGeneral())}
          className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2 transition-colors shadow-sm mb-4"
        >
          {loading ? 'Designing…' : 'Design Primers'}
        </button>
      )}

      {primerMode !== 'arms' && error && <div className="p-4 mb-4 text-sm text-red-800 dark:text-red-300 rounded-lg bg-red-50 dark:bg-red-950/40">{error}</div>}

      {primerMode === 'flanking' && flankingResult && (
        <div className="mt-6 space-y-4">
          <h3 className="text-md font-semibold text-slate-800 dark:text-slate-200 mb-2">Flanking Primers (WGA)</h3>
          <div className="text-sm text-slate-500 dark:text-slate-400 mb-4 bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 p-2 rounded border border-slate-100 dark:border-slate-700">
            Reverse (RIGHT) primers: the red highlight shows the <strong>binding site on the downstream template</strong>. The primer sequence is expected to be the reverse-complement of that binding site.
          </div>

          <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2 mt-4 ml-1">Forward primers (upstream flank)</h4>
          <ResultsTable
            rows={flankingResult.forward}
            keyOf={(p, i) => `f-${i}-${p.sequence}`}
            columns={[
              { header: '#', render: (_p, i) => i + 1 },
              { header: "Sequence (5'→3')", render: (p) => p.sequence, className: 'font-mono text-slate-800 dark:text-slate-200' },
              { header: 'Len', render: (p) => p.length },
              { header: 'Tm', render: (p) => fmt(p.tm) },
              { header: 'GC%', render: (p) => fmt(p.gc_percent) },
              { header: 'Hairpin', render: (p) => yesNo(p.hairpin.structure_found) },
              { header: 'HP Tm', render: (p) => fmt(p.hairpin.tm) },
              { header: 'HP ΔG', render: (p) => fmt(p.hairpin.dg) },
              { header: 'Homol', render: (p) => yesNo(p.homodimer.structure_found) },
              { header: 'HD Tm', render: (p) => fmt(p.homodimer.tm) },
              { header: 'HD ΔG', render: (p) => fmt(p.homodimer.dg) },
              {
                header: 'Action',
                render: (p) => (
                  <button className="px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition" onClick={() => selectWGA('forward', 'up', p.interval, p.sequence)}>
                    Use
                  </button>
                ),
              },
              { header: 'Binding site', render: (p) => data.upstream_seq.substring(p.interval[0], p.interval[1]), className: 'font-mono text-xs text-slate-500 dark:text-slate-400 break-all' },
            ]}
          />

          <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2 mt-4 ml-1">Reverse primers (downstream flank)</h4>
          <ResultsTable
            rows={flankingResult.reverse}
            keyOf={(p, i) => `r-${i}-${p.sequence}`}
            columns={[
              { header: '#', render: (_p, i) => i + 1 },
              { header: "Sequence (5'→3')", render: (p) => p.sequence, className: 'font-mono text-slate-800 dark:text-slate-200' },
              { header: 'Len', render: (p) => p.length },
              { header: 'Tm', render: (p) => fmt(p.tm) },
              { header: 'GC%', render: (p) => fmt(p.gc_percent) },
              { header: 'Hairpin', render: (p) => yesNo(p.hairpin.structure_found) },
              { header: 'HP Tm', render: (p) => fmt(p.hairpin.tm) },
              { header: 'HP ΔG', render: (p) => fmt(p.hairpin.dg) },
              { header: 'Homol', render: (p) => yesNo(p.homodimer.structure_found) },
              { header: 'HD Tm', render: (p) => fmt(p.homodimer.tm) },
              { header: 'HD ΔG', render: (p) => fmt(p.homodimer.dg) },
              {
                header: 'Action',
                render: (p) => (
                  <button className="px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition" onClick={() => selectWGA('reverse', 'down', p.interval, p.sequence)}>
                    Use
                  </button>
                ),
              },
              { header: 'Binding site', render: (p) => (data.downstream_seq || '').substring(p.interval[0], p.interval[1]), className: 'font-mono text-xs text-slate-500 dark:text-slate-400 break-all' },
            ]}
          />

          {flankingResult.pairDg !== null && (
            <p className="text-slate-700 dark:text-slate-300">
              <strong>Best-pair heterodimer (Forward #1 vs Reverse #1):</strong> {yesNo(flankingResult.pairFound)} | <strong>ΔG:</strong> {fmt(flankingResult.pairDg)}
            </p>
          )}
        </div>
      )}

      {primerMode === 'general' && generalPairs && (
        <div className="mt-6">
          <h3 className="text-md font-semibold text-slate-800 dark:text-slate-200 mb-2">General Primer Pairs</h3>
          <ResultsTable
            rows={generalPairs}
            keyOf={(p, i) => `g-${i}-${p.left.sequence}`}
            columns={[
              { header: '#', render: (_p, i) => i + 1 },
              { header: "Left (5'→3')", render: (p) => p.left.sequence, className: 'font-mono text-slate-800 dark:text-slate-200' },
              { header: "Right (5'→3')", render: (p) => p.right.sequence, className: 'font-mono text-slate-800 dark:text-slate-200' },
              { header: 'Product', render: (p) => p.product_size },
              { header: 'Left Tm', render: (p) => fmt(p.left.tm) },
              { header: 'Right Tm', render: (p) => fmt(p.right.tm) },
              { header: 'Left GC%', render: (p) => fmt(p.left.gc) },
              { header: 'Right GC%', render: (p) => fmt(p.right.gc) },
              {
                header: 'Highlight',
                render: (p) => (
                  <div className="flex gap-2">
                    <button className="px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition" onClick={() => selectGeneral('forward', rawTupleToInterval(p.left.position, false), p.left.sequence)}>
                      Use L
                    </button>
                    <button className="px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition" onClick={() => selectGeneral('reverse', rawTupleToInterval(p.right.position, true), p.right.sequence)}>
                      Use R
                    </button>
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}

      {primerMode === 'junction' && junctionPairs && (
        <div className="mt-6">
          <h3 className="text-md font-semibold text-slate-800 dark:text-slate-200 mb-2">Exon–Exon Junction Primer Pairs</h3>
          <div className="text-sm text-slate-500 dark:text-slate-400 mb-4 bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 p-2 rounded border border-slate-100 dark:border-slate-700">
            Highlights appear in the <strong>spliced exon-only template</strong> shown above when Junction mode is selected.
          </div>
          <ResultsTable
            rows={junctionPairs}
            keyOf={(p, i) => `p-${i}-${p.left.sequence}`}
            columns={[
              { header: '#', render: (_p, i) => i + 1 },
              { header: "Left (5'→3')", render: (p) => p.left.sequence, className: 'font-mono text-slate-800 dark:text-slate-200' },
              { header: "Right (5'→3')", render: (p) => p.right.sequence, className: 'font-mono text-slate-800 dark:text-slate-200' },
              { header: 'Product', render: (p) => p.product_size },
              { header: 'Left Tm', render: (p) => fmt(p.left.tm) },
              { header: 'Right Tm', render: (p) => fmt(p.right.tm) },
              {
                header: 'Highlight',
                render: (p) => (
                  <div className="flex gap-2">
                    <button className="px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition" onClick={() => selectJunction('left', p.left.interval, p.left.sequence)}>
                      Use L
                    </button>
                    <button className="px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition" onClick={() => selectJunction('right', p.right.interval, p.right.sequence)}>
                      Use R
                    </button>
                  </div>
                ),
              },
              { header: 'Left binding', render: (p) => (data.spliced_exons_seq || '').substring(p.left.interval[0], p.left.interval[1]), className: 'font-mono text-xs text-slate-500 dark:text-slate-400 break-all' },
              { header: 'Right binding', render: (p) => (data.spliced_exons_seq || '').substring(p.right.interval[0], p.right.interval[1]), className: 'font-mono text-xs text-slate-500 dark:text-slate-400 break-all' },
            ]}
          />
        </div>
      )}
    </div>
  );
}
