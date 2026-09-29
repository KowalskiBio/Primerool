import { useState } from 'react';
import { useSessionState } from '../session/sessionContext';
import type { SequenceData } from '../api/sequence';
import { designFlanking, designGeneral, designJunction, type DimerResult, type FlankingOligoResult, type GeneralPairResult, type GeneralPrimerRegion, type JunctionPairResult } from '../api/design';
import { ApiError } from '../api/client';
import type { Selection, Selections } from '../utils/regionMapping';
import ResultsTable from './ResultsTable';
import PrimerCard from './PrimerCard';
import ArmsDesignPanel from './ArmsDesignPanel';
import GeneralPrimerPreview from './GeneralPrimerPreview';
import { generalSelection } from '../utils/generalSelection';
import SegmentedControl from './ui/SegmentedControl';
import Field from './ui/Field';
import TextInput from './ui/TextInput';
import Select from './ui/Select';
import Button from './ui/Button';
import { fmt, yesNo } from '../utils/format';
import type { IdtCredentials } from '../utils/idtCredentials';

type PrimerMode = 'flanking' | 'junction' | 'general' | 'arms';

/** `design_general::PRODUCT_SIZE_RANGE` on the server. */
const GENERAL_PRODUCT_RANGE = '100–1000';

/** A primer sequence kept on one line, with its preview button. */
function PrimerCell({ sequence, onShow }: { sequence: string; onShow: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="whitespace-nowrap font-mono text-ink">{sequence}</span>
      <Button size="sm" onClick={onShow} title="See where this primer lands on the sequence map">
        Show
      </Button>
    </div>
  );
}

/** A structure's ΔG in kcal/mol, or "none" when nothing folds. */
function structureDg(r: DimerResult): string {
  return r.structure_found && r.dg !== null ? fmt(r.dg) : 'none';
}

interface Props {
  data: SequenceData;
  species: string;
  apiSource: 'ensembl' | 'ncbi';
  primerMode: PrimerMode;
  onPrimerModeChange: (mode: PrimerMode) => void;
  onSelect: (key: keyof Selections, value: Selection) => void;
  idtCredentials?: IdtCredentials;
  /** The sequence map's intron truncation, reused by the primer preview. */
  truncateIntrons: boolean;
}

export default function AutoDesignPanel({ data, species, apiSource, primerMode, onPrimerModeChange, onSelect, idtCredentials, truncateIntrons }: Props) {
  const [junctionPos, setJunctionPos] = useSessionState('auto.junctionPos', '');
  const [overlapMin, setOverlapMin] = useSessionState('auto.overlapMin', 6);
  const [overlapMax, setOverlapMax] = useSessionState('auto.overlapMax', 12);
  const [ampliconMin, setAmpliconMin] = useSessionState('auto.ampliconMin', 80);
  const [ampliconMax, setAmpliconMax] = useSessionState('auto.ampliconMax', 220);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flankWindow, setFlankWindow] = useSessionState('auto.flankWindow', '');
  const [flankingResult, setFlankingResult] = useSessionState<{ forward: FlankingOligoResult[]; reverse: FlankingOligoResult[]; pairDg: number | null; pairFound: boolean } | null>('auto.flankingResult', null);
  const [junctionPairs, setJunctionPairs] = useSessionState<JunctionPairResult[] | null>('auto.junctionPairs', null);
  // New key: sessions saved before whole-gene design hold target-based
  // pairs in the old shape under `auto.generalPairs`.
  const [generalPairs, setGeneralPairs] = useSessionState<GeneralPairResult[] | null>('auto.generalBestPairs', null);
  const [generalRegion, setGeneralRegion] = useSessionState<GeneralPrimerRegion>('auto.generalRegion', 'any');
  const [preview, setPreview] = useState<{ pair: GeneralPairResult; side: 'left' | 'right' } | null>(null);
  // Exon vs intron only means something on the genomic sequence; a
  // spliced one is all exon, so the choice is hidden and ignored there.
  const exonIntervals = (data.annotations || []).filter((a) => a.type === 'exon').map((a): [number, number] => [a.start, a.end]);
  const canChooseRegion = data.include_introns && exonIntervals.length > 0;
  const effectiveRegion: GeneralPrimerRegion = canChooseRegion ? generalRegion : 'any';
  const [usedWgaFwdSeq, setUsedWgaFwdSeq] = useSessionState<string | null>('auto.usedWgaFwdSeq', null);
  const [usedWgaRevSeq, setUsedWgaRevSeq] = useSessionState<string | null>('auto.usedWgaRevSeq', null);

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

  function selectGeneral(which: 'forward' | 'reverse', interval: [number, number], primerSeq: string) {
    onSelect(which === 'forward' ? 'geneForward' : 'geneReverse', generalSelection(data, which === 'forward' ? 'left' : 'right', interval, primerSeq));
  }

  async function runFlanking() {
    setError(null);
    setLoading(true);
    setJunctionPairs(null);
    setGeneralPairs(null);
    try {
      const window = flankWindow.trim() ? parseInt(flankWindow, 10) : undefined;
      const res = await designFlanking(data.upstream_seq, data.downstream_seq, window);
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
    setLoading(true);
    setFlankingResult(null);
    setJunctionPairs(null);
    try {
      const res = await designGeneral(data.gene_seq, effectiveRegion, effectiveRegion === 'any' ? [] : exonIntervals);
      const pairs = res.primers;
      if (!pairs.length) {
        setError('No primer pairs found in this gene.');
        setGeneralPairs(null);
        return;
      }
      setGeneralPairs(pairs);
      const first = pairs[0];
      selectGeneral('forward', first.left.interval, first.left.sequence);
      selectGeneral('reverse', first.right.interval, first.right.sequence);
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
          { value: 'general', label: 'General', title: 'The best primer pair anywhere in the gene' },
          { value: 'flanking', label: 'WGA', title: 'Primers in flanking regions' },
          { value: 'junction', label: 'Junction', title: 'Exon-exon junction primers' },
          { value: 'arms', label: 'SNP/indel', title: 'ARMS-PCR allele-specific primers' },
        ]}
      />

      {primerMode === 'arms' && <ArmsDesignPanel data={data} species={species} apiSource={apiSource} onSelect={onSelect} idtCredentials={idtCredentials} />}

      {primerMode === 'general' && (
        <div className="mb-6 rounded-md border border-line bg-surface-2 p-3 text-sm text-ink-muted">
          {canChooseRegion && (
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <span className="font-medium text-ink">Primers in</span>
              <SegmentedControl
                size="sm"
                ariaLabel="Where the primers may sit"
                value={generalRegion}
                onChange={setGeneralRegion}
                options={[
                  { value: 'exon', label: 'Exons', title: 'Both primers inside exons - they also match the transcript' },
                  { value: 'intron', label: 'Introns', title: 'Both primers inside introns - genomic DNA only' },
                  { value: 'any', label: "Don't care", title: 'Anywhere in the gene' },
                ]}
              />
            </div>
          )}
          Searches the {effectiveRegion === 'exon' ? 'exons' : effectiveRegion === 'intron' ? 'introns' : 'whole gene'} for the best pairs: both primers at the same Tm, with as little hairpin, self-dimer and heterodimer structure as possible, for a {GENERAL_PRODUCT_RANGE} bp amplicon. The best pair is highlighted on the map.
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

          {/* Forward and reverse side by side (Oligool's layout), so a pair
              can be compared at a glance; stacked on narrow screens. */}
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="min-w-0">
              <h4 className="mb-2 ml-1 text-sm font-semibold text-ink">Forward primers (upstream flank)</h4>
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
            </div>
            <div className="min-w-0">
              <h4 className="mb-2 ml-1 text-sm font-semibold text-ink">Reverse primers (downstream flank)</h4>
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
            </div>
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
              { header: '#', render: (_p, i) => i + 1, width: '2.5rem' },
              { header: "Left (5'→3')", render: (p) => <PrimerCell sequence={p.left.sequence} onShow={() => setPreview({ pair: p, side: 'left' })} />, width: '15rem' },
              { header: "Right (5'→3')", render: (p) => <PrimerCell sequence={p.right.sequence} onShow={() => setPreview({ pair: p, side: 'right' })} />, width: '15rem' },
              { header: 'Amplicon', render: (p) => `${p.product_size} bp`, width: '5.5rem' },
              { header: 'Position', render: (p) => `${p.left.interval[0]}–${p.right.interval[1]}`, width: '7.5rem', className: 'whitespace-nowrap tabular-nums' },
              { header: 'Tm L / R', render: (p) => `${fmt(p.left.tm)} / ${fmt(p.right.tm)}`, width: '5rem' },
              { header: 'GC% L / R', render: (p) => `${fmt(p.left.gc_percent)} / ${fmt(p.right.gc_percent)}`, width: '5rem' },
              { header: 'Hairpin ΔG (L / R)', render: (p) => `${structureDg(p.left.hairpin)} / ${structureDg(p.right.hairpin)}` },
              { header: 'Self-dimer ΔG (L / R)', render: (p) => `${structureDg(p.left.homodimer)} / ${structureDg(p.right.homodimer)}` },
              { header: 'Heterodimer ΔG', render: (p) => structureDg(p.pair_metrics.heterodimer) },
              {
                header: 'Highlight',
                width: '8.5rem',
                render: (p) => (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => selectGeneral('forward', p.left.interval, p.left.sequence)}>
                      Use L
                    </Button>
                    <Button size="sm" onClick={() => selectGeneral('reverse', p.right.interval, p.right.sequence)}>
                      Use R
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}

      <GeneralPrimerPreview data={data} preview={preview} truncateIntrons={truncateIntrons} onClose={() => setPreview(null)} />

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
