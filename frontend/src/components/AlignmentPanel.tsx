import { useState } from 'react';
import { alignSequences, designConserved, type ConservedPair, type ConservedCandidate } from '../api/align';
import { ApiError } from '../api/client';
import { parseMultiFasta } from '../utils/fasta';
import ResultsTable from './ResultsTable';
import Button from './ui/Button';
import Checkbox from './ui/Checkbox';
import EngineSelect from './EngineSelect';
import Field from './ui/Field';
import TextInput, { controlClasses } from './ui/TextInput';
import { fmt } from '../utils/format';

/** Card 7: MAFFT multi-sequence alignment + conserved-region primer design
 * (Phase 7). New feature, not present in the legacy Primerool app - the
 * plan's own "mirror Oligool" instruction for this phase only covers the
 * *backend* MAFFT-subprocess pattern and the raw-alignment-passthrough
 * contract; Oligool's own frontend alignment tooling (`anchorGrid.ts`/
 * `msa.ts`, a full per-column mismatch/insertion visual diff grid) is a
 * substantially larger, more specialized component than this phase's
 * remaining budget covers. This ships a plain, functional raw-alignment
 * view instead - real MAFFT output, real conserved-region design against
 * it, just without Oligool's anchor-grid visualization layer. */
export default function AlignmentPanel() {
  const [fastaText, setFastaText] = useState('');
  const [alignment, setAlignment] = useState<string | null>(null);
  const [aligning, setAligning] = useState(false);
  const [alignError, setAlignError] = useState<string | null>(null);

  const [colStart, setColStart] = useState(0);
  const [colEnd, setColEnd] = useState(0);
  const [useTarget, setUseTarget] = useState(false);
  const [targetStart, setTargetStart] = useState(0);
  const [targetEnd, setTargetEnd] = useState(0);
  const [backend, setBackend] = useState<'primer3' | 'strider'>('strider');
  const [designing, setDesigning] = useState(false);
  const [designError, setDesignError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ConservedCandidate[] | null>(null);
  const [pairs, setPairs] = useState<ConservedPair[] | null>(null);

  async function runAlign() {
    setAlignError(null);
    setAlignment(null);
    setCandidates(null);
    setPairs(null);
    const records = parseMultiFasta(fastaText);
    if (records.length < 2) {
      setAlignError('Paste at least two FASTA sequences to align.');
      return;
    }
    setAligning(true);
    try {
      const res = await alignSequences(records);
      setAlignment(res.alignment);
      // Default the conserved-region range to the full alignment length.
      const firstSeqLen = res.alignment
        .split(/\n(?=>)/)[0]
        ?.split('\n')
        .slice(1)
        .join('').length;
      if (firstSeqLen) {
        setColStart(0);
        setColEnd(firstSeqLen);
      }
    } catch (e) {
      setAlignError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setAligning(false);
    }
  }

  async function runDesign() {
    if (!alignment) return;
    setDesignError(null);
    setCandidates(null);
    setPairs(null);
    setDesigning(true);
    try {
      const res = await designConserved({
        alignment,
        col_start: colStart,
        col_end: colEnd,
        target_start: useTarget ? targetStart : undefined,
        target_end: useTarget ? targetEnd : undefined,
        backend,
      });
      if (res.mode === 'pairs') {
        setPairs(res.pairs);
      } else {
        setCandidates(res.candidates);
      }
    } catch (e) {
      setDesignError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setDesigning(false);
    }
  }

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-ink">Multi-Sequence Alignment</h3>
      <p className="mb-4 text-sm text-ink-muted">
        Paste two or more sequences in FASTA format (or one bare sequence per line). MAFFT aligns them; you can then design primers within a conserved column range.
      </p>

      <textarea
        rows={8}
        value={fastaText}
        onChange={(e) => setFastaText(e.target.value)}
        placeholder={'>seq1\nACGT…\n>seq2\nACGT…'}
        className={`${controlClasses} mb-3 resize-y p-3 font-mono`}
      />

      <Button variant="primary" disabled={aligning} onClick={() => void runAlign()}>
        {aligning ? 'Aligning…' : 'Align Sequences'}
      </Button>

      {alignError && <div role="alert" className="mt-4 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">{alignError}</div>}

      {alignment && (
        <>
          <h4 className="mb-2 mt-4 text-sm font-semibold text-ink">Aligned FASTA</h4>
          <pre className="sequence-viewer max-h-[300px] overflow-y-auto overflow-x-auto rounded-lg border border-line bg-base p-4 text-xs">
            {alignment}
          </pre>

          <div className="mt-4 rounded-md border border-line bg-surface-2 p-4">
            <h4 className="mb-3 text-sm font-semibold text-ink">Design Primers in Conserved Region</h4>
            <div className="mb-3 grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Conserved column start">
                <TextInput type="number" min={0} value={colStart} onChange={(e) => setColStart(parseInt(e.target.value, 10) || 0)} className="tabular-nums" />
              </Field>
              <Field label="Conserved column end">
                <TextInput type="number" min={0} value={colEnd} onChange={(e) => setColEnd(parseInt(e.target.value, 10) || 0)} className="tabular-nums" />
              </Field>
            </div>

            <Checkbox
              className="mb-3"
              label={<span className="text-sm">Design a pair flanking a specific target (otherwise: scan for individual candidates)</span>}
              checked={useTarget}
              onChange={(e) => setUseTarget(e.target.checked)}
            />

            {useTarget && (
              <div className="mb-3 grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="Target start (consensus-relative)">
                  <TextInput type="number" min={0} value={targetStart} onChange={(e) => setTargetStart(parseInt(e.target.value, 10) || 0)} className="tabular-nums" />
                </Field>
                <Field label="Target end (consensus-relative)">
                  <TextInput type="number" min={0} value={targetEnd} onChange={(e) => setTargetEnd(parseInt(e.target.value, 10) || 0)} className="tabular-nums" />
                </Field>
              </div>
            )}

            <div className="mb-3">
              <EngineSelect value={backend} onChange={setBackend} />
            </div>

            <Button variant="primary" disabled={designing} onClick={() => void runDesign()}>
              {designing ? 'Designing…' : 'Design Primers'}
            </Button>

            {designError && <div role="alert" className="mt-3 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">{designError}</div>}
          </div>

          {candidates && candidates.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Conserved-Region Candidates</h4>
              <ResultsTable
                rows={candidates}
                keyOf={(c, i) => `${i}-${c.sequence}`}
                columns={[
                  { header: "Sequence (5'→3')", render: (c) => c.sequence, className: 'font-mono text-ink' },
                  { header: 'Start', render: (c) => c.start },
                  { header: 'End', render: (c) => c.end },
                  { header: 'Tm', render: (c) => fmt(c.tm) },
                  { header: 'GC%', render: (c) => fmt(c.gc_percent) },
                  { header: 'Penalty', render: (c) => c.penalty.toFixed(2) },
                ]}
              />
            </div>
          )}

          {pairs && pairs.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Conserved-Region Pairs</h4>
              <ResultsTable
                rows={pairs}
                keyOf={(p, i) => `${i}-${p.left.sequence}`}
                columns={[
                  { header: 'Left', render: (p) => p.left.sequence, className: 'font-mono text-ink' },
                  { header: 'Right', render: (p) => p.right.sequence, className: 'font-mono text-ink' },
                  { header: 'Product', render: (p) => `${p.product_size} bp` },
                  { header: 'Left Tm', render: (p) => fmt(p.left.tm) },
                  { header: 'Right Tm', render: (p) => fmt(p.right.tm) },
                  { header: 'Penalty', render: (p) => p.penalty.toFixed(2) },
                ]}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
