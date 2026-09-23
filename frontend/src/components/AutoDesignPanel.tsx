import { useState } from 'react';
import type { SequenceData } from '../api/sequence';
import { designFlanking, designInternal, designJunction, type DesignEngine, type FlankingOligoResult, type InternalDesignPair, type JunctionPairResult } from '../api/design';
import EngineSelect from './EngineSelect';
import { ApiError } from '../api/client';
import type { Selection, Selections } from '../utils/regionMapping';
import { rawTupleToInterval } from '../utils/coords';
import ResultsTable from './ResultsTable';
import PrimerCard from './PrimerCard';
import ArmsDesignPanel from './ArmsDesignPanel';
import SegmentedControl from './ui/SegmentedControl';
import Field from './ui/Field';
import TextInput from './ui/TextInput';
import Select from './ui/Select';
import Button from './ui/Button';
import { fmt, yesNo } from '../utils/format';
import type { IdtCredentials } from './IdtSettingsPanel';

type PrimerMode = 'flanking' | 'junction' | 'general' | 'arms';

interface Props {
  data: SequenceData;
  species: string;
  apiSource: 'ensembl' | 'ncbi';
  primerMode: PrimerMode;
  onPrimerModeChange: (mode: PrimerMode) => void;
  onSelect: (key: keyof Selections, value: Selection) => void;
  idtCredentials?: IdtCredentials;
}

export default function AutoDesignPanel({ data, species, apiSource, primerMode, onPrimerModeChange, onSelect, idtCredentials }: Props) {
  const [junctionPos, setJunctionPos] = useState('');
  const [overlapMin, setOverlapMin] = useState(6);
  const [overlapMax, setOverlapMax] = useState(12);
  const [ampliconMin, setAmpliconMin] = useState(80);
  const [ampliconMax, setAmpliconMax] = useState(220);
  const [targetStart, setTargetStart] = useState(0);
  const [targetEnd, setTargetEnd] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<DesignEngine>('strider');
  const [flankWindow, setFlankWindow] = useState('');
  const [flankingResult, setFlankingResult] = useState<{ forward: FlankingOligoResult[]; reverse: FlankingOligoResult[]; pairDg: number | null; pairFound: boolean } | null>(null);
  const [junctionPairs, setJunctionPairs] = useState<JunctionPairResult[] | null>(null);
  const [generalPairs, setGeneralPairs] = useState<InternalDesignPair[] | null>(null);
  const [usedWgaFwdSeq, setUsedWgaFwdSeq] = useState<string | null>(null);
  const [usedWgaRevSeq, setUsedWgaRevSeq] = useState<string | null>(null);

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
      const window = flankWindow.trim() ? parseInt(flankWindow, 10) : undefined;
      const res = await designFlanking(data.upstream_seq, data.downstream_seq, engine, window);
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
        engine,
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
      <SegmentedControl
        className="mb-6"
        ariaLabel="Primer design mode"
        value={primerMode}
        onChange={onPrimerModeChange}
        options={[
          { value: 'general', label: 'General', title: 'Primers anywhere in the gene' },
          { value: 'flanking', label: 'WGA', title: 'Primers in flanking regions' },
          { value: 'junction', label: 'Junction', title: 'Exon-exon junction primers' },
          { value: 'arms', label: 'SNP/indel', title: 'ARMS-PCR allele-specific primers' },
        ]}
      />

      {primerMode === 'arms' && <ArmsDesignPanel data={data} species={species} apiSource={apiSource} onSelect={onSelect} idtCredentials={idtCredentials} />}

      {primerMode === 'general' && (
        <div className="mb-6 rounded-md border border-line bg-surface-2 p-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Target start (bp, 0-based into gene sequence)">
              <TextInput type="number" min={0} value={targetStart} onChange={(e) => setTargetStart(parseInt(e.target.value, 10) || 0)} className="tabular-nums" />
            </Field>
            <Field label="Target end (bp, exclusive)">
              <TextInput type="number" min={0} value={targetEnd} onChange={(e) => setTargetEnd(parseInt(e.target.value, 10) || 0)} className="tabular-nums" />
            </Field>
          </div>
        </div>
      )}

      {primerMode === 'junction' && (
        <div className="mb-6 rounded-md border border-line bg-surface-2 p-4">
          <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Choose junction">
              <Select value={junctionPos} onChange={(e) => setJunctionPos(e.target.value)}>
                <option value="">Select a junction…</option>
                {(data.junctions || []).map((j) => (
                  <option key={j.index} value={j.pos}>
                    {j.label || `junction @ ${j.pos}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Junction overlap min (bp)">
              <TextInput type="number" min={1} value={overlapMin} onChange={(e) => setOverlapMin(parseInt(e.target.value, 10) || 1)} className="tabular-nums" />
            </Field>
            <Field label="Junction overlap max (bp)">
              <TextInput type="number" min={1} value={overlapMax} onChange={(e) => setOverlapMax(parseInt(e.target.value, 10) || 1)} className="tabular-nums" />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Amplicon min (bp)">
              <TextInput type="number" min={1} value={ampliconMin} onChange={(e) => setAmpliconMin(parseInt(e.target.value, 10) || 1)} className="tabular-nums" />
            </Field>
            <Field label="Amplicon max (bp)">
              <TextInput type="number" min={1} value={ampliconMax} onChange={(e) => setAmpliconMax(parseInt(e.target.value, 10) || 1)} className="tabular-nums" />
            </Field>
          </div>
        </div>
      )}

      {primerMode === 'flanking' && (
        <div className="mb-6 rounded-md border border-line bg-surface-2 p-4">
          <Field label="Primer search window (bp from target; blank = full flank)" hint="Restricts each primer's search to the last/first N bases of its flank (the bases nearest the target), so the primer-to-target distance never exceeds N. Leave blank to search the whole provided flank.">
            <TextInput
              type="number"
              min={1}
              placeholder="e.g. 130 for 2x150bp sequencing…"
              value={flankWindow}
              onChange={(e) => setFlankWindow(e.target.value)}
              className="max-w-xs tabular-nums"
            />
          </Field>
        </div>
      )}

      {(primerMode === 'flanking' || primerMode === 'junction') && (
        <div className="mb-4">
          <EngineSelect value={engine} onChange={setEngine} />
        </div>
      )}

      {primerMode !== 'arms' && (
        <Button variant="primary" className="mb-4" disabled={loading} onClick={() => void (primerMode === 'flanking' ? runFlanking() : primerMode === 'junction' ? runJunction() : runGeneral())}>
          {loading ? 'Designing…' : 'Design Primers'}
        </Button>
      )}

      {primerMode !== 'arms' && error && (
        <div role="alert" className="mb-4 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">
          {error}
        </div>
      )}

      {primerMode === 'flanking' && flankingResult && (
        <div className="mt-6 space-y-4">
          <h3 className="mb-2 text-sm font-semibold text-ink">Flanking Primers (WGA)</h3>
          <div className="mb-4 rounded-md border border-line bg-surface-2 p-2 text-sm text-ink-muted">
            Reverse (RIGHT) primers: the red highlight shows the <strong className="font-medium text-ink">binding site on the downstream template</strong>. The primer sequence is expected to be the reverse-complement of that binding site.
          </div>

          <h4 className="mb-2 ml-1 mt-4 text-sm font-semibold text-ink">Forward primers (upstream flank)</h4>
          <div className="space-y-2">
            {flankingResult.forward.map((p, i) => (
              <PrimerCard
                key={`f-${i}-${p.sequence}`}
                index={i}
                primer={p}
                idtCredentials={idtCredentials}
                selected={usedWgaFwdSeq === p.sequence}
                onUse={() => {
                  setUsedWgaFwdSeq(p.sequence);
                  selectWGA('forward', 'up', p.interval, p.sequence);
                }}
                extra={
                  <div className="mt-2 break-words border-t border-line pt-2 font-mono text-[13px] text-ink-muted">
                    Binding site: {data.upstream_seq.substring(p.interval[0], p.interval[1])}
                  </div>
                }
              />
            ))}
          </div>

          <h4 className="mb-2 ml-1 mt-4 text-sm font-semibold text-ink">Reverse primers (downstream flank)</h4>
          <div className="space-y-2">
            {flankingResult.reverse.map((p, i) => (
              <PrimerCard
                key={`r-${i}-${p.sequence}`}
                index={i}
                primer={p}
                idtCredentials={idtCredentials}
                selected={usedWgaRevSeq === p.sequence}
                onUse={() => {
                  setUsedWgaRevSeq(p.sequence);
                  selectWGA('reverse', 'down', p.interval, p.sequence);
                }}
                extra={
                  <div className="mt-2 break-words border-t border-line pt-2 font-mono text-[13px] text-ink-muted">
                    Binding site: {(data.downstream_seq || '').substring(p.interval[0], p.interval[1])}
                  </div>
                }
              />
            ))}
          </div>

          {flankingResult.pairDg !== null && (
            <p className="text-sm text-ink-muted">
              <strong className="font-medium text-ink">Best-pair heterodimer (Forward #1 vs Reverse #1):</strong> {yesNo(flankingResult.pairFound)} · <strong className="font-medium text-ink">ΔG:</strong> {fmt(flankingResult.pairDg)}
            </p>
          )}
        </div>
      )}

      {primerMode === 'general' && generalPairs && (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold text-ink">General Primer Pairs</h3>
          <ResultsTable
            rows={generalPairs}
            keyOf={(p, i) => `g-${i}-${p.left.sequence}`}
            columns={[
              { header: '#', render: (_p, i) => i + 1 },
              { header: "Left (5'→3')", render: (p) => p.left.sequence, className: 'font-mono text-ink' },
              { header: "Right (5'→3')", render: (p) => p.right.sequence, className: 'font-mono text-ink' },
              { header: 'Product', render: (p) => p.product_size },
              { header: 'Left Tm', render: (p) => fmt(p.left.tm) },
              { header: 'Right Tm', render: (p) => fmt(p.right.tm) },
              { header: 'Left GC%', render: (p) => fmt(p.left.gc) },
              { header: 'Right GC%', render: (p) => fmt(p.right.gc) },
              {
                header: 'Highlight',
                render: (p) => (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => selectGeneral('forward', rawTupleToInterval(p.left.position, false), p.left.sequence)}>
                      Use L
                    </Button>
                    <Button size="sm" onClick={() => selectGeneral('reverse', rawTupleToInterval(p.right.position, true), p.right.sequence)}>
                      Use R
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}

      {primerMode === 'junction' && junctionPairs && (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold text-ink">Exon-Exon Junction Primer Pairs</h3>
          <div className="mb-4 rounded-md border border-line bg-surface-2 p-2 text-sm text-ink-muted">
            Highlights appear in the <strong className="font-medium text-ink">spliced exon-only template</strong> shown above when Junction mode is selected.
          </div>
          <ResultsTable
            rows={junctionPairs}
            keyOf={(p, i) => `p-${i}-${p.left.sequence}`}
            columns={[
              { header: '#', render: (_p, i) => i + 1 },
              { header: "Left (5'→3')", render: (p) => p.left.sequence, className: 'font-mono text-ink' },
              { header: "Right (5'→3')", render: (p) => p.right.sequence, className: 'font-mono text-ink' },
              { header: 'Product', render: (p) => p.product_size },
              { header: 'Left Tm', render: (p) => fmt(p.left.tm) },
              { header: 'Right Tm', render: (p) => fmt(p.right.tm) },
              {
                header: 'Highlight',
                render: (p) => (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => selectJunction('left', p.left.interval, p.left.sequence)}>
                      Use L
                    </Button>
                    <Button size="sm" onClick={() => selectJunction('right', p.right.interval, p.right.sequence)}>
                      Use R
                    </Button>
                  </div>
                ),
              },
              { header: 'Left binding', render: (p) => (data.spliced_exons_seq || '').substring(p.left.interval[0], p.left.interval[1]), className: 'font-mono text-xs break-all text-ink-muted' },
              { header: 'Right binding', render: (p) => (data.spliced_exons_seq || '').substring(p.right.interval[0], p.right.interval[1]), className: 'font-mono text-xs break-all text-ink-muted' },
            ]}
          />
        </div>
      )}
    </div>
  );
}
