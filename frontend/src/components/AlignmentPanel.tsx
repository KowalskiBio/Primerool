import { useState } from 'react';
import { alignSequences, designConserved, type ConservedPair, type ConservedCandidate } from '../api/align';
import { ApiError } from '../api/client';
import { parseMultiFasta } from '../utils/fasta';
import ResultsTable from './ResultsTable';
import { fmt } from '../utils/format';

/** Card 7: MAFFT multi-sequence alignment + conserved-region primer design
 * (Phase 7). New feature, not present in the legacy Primerool app — the
 * plan's own "mirror Oligool" instruction for this phase only covers the
 * *backend* MAFFT-subprocess pattern and the raw-alignment-passthrough
 * contract; Oligool's own frontend alignment tooling (`anchorGrid.ts`/
 * `msa.ts`, a full per-column mismatch/insertion visual diff grid) is a
 * substantially larger, more specialized component than this phase's
 * remaining budget covers. This ships a plain, functional raw-alignment
 * view instead — real MAFFT output, real conserved-region design against
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
  const [backend, setBackend] = useState<'primer3' | 'native'>('primer3');
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
      <h3 className="text-md font-semibold text-slate-800 dark:text-slate-200 mb-2">Multi-Sequence Alignment</h3>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
        Paste two or more sequences in FASTA format (or one bare sequence per line). MAFFT aligns them; you can then design primers within a conserved column range.
      </p>

      <textarea
        rows={8}
        value={fastaText}
        onChange={(e) => setFastaText(e.target.value)}
        placeholder={'>seq1\nACGT...\n>seq2\nACGT...'}
        className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm font-mono text-sm p-3 border resize-y mb-3"
      />

      <button disabled={aligning} onClick={() => void runAlign()} className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2 transition-colors shadow-sm">
        {aligning ? 'Aligning…' : 'Align Sequences'}
      </button>

      {alignError && <div className="mt-4 p-3 text-sm text-red-800 dark:text-red-300 rounded-lg bg-red-50 dark:bg-red-950/40">{alignError}</div>}

      {alignment && (
        <>
          <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2 mt-4">Aligned FASTA</h4>
          <pre className="sequence-viewer bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg p-4 text-xs overflow-y-auto overflow-x-auto max-h-[300px] text-slate-800 dark:text-slate-200">
            {alignment}
          </pre>

          <div className="mt-4 bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
            <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">Design Primers in Conserved Region</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">Conserved column start</label>
                <input type="number" min={0} value={colStart} onChange={(e) => setColStart(parseInt(e.target.value, 10) || 0)} className="w-full rounded-md border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">Conserved column end</label>
                <input type="number" min={0} value={colEnd} onChange={(e) => setColEnd(parseInt(e.target.value, 10) || 0)} className="w-full rounded-md border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border" />
              </div>
            </div>

            <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-700 dark:text-slate-300 mb-3">
              <input type="checkbox" checked={useTarget} onChange={(e) => setUseTarget(e.target.checked)} className="accent-green-600 rounded w-4 h-4" />
              Design a pair flanking a specific target (otherwise: scan for individual candidates)
            </label>

            {useTarget && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">Target start (consensus-relative)</label>
                  <input type="number" min={0} value={targetStart} onChange={(e) => setTargetStart(parseInt(e.target.value, 10) || 0)} className="w-full rounded-md border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">Target end (consensus-relative)</label>
                  <input type="number" min={0} value={targetEnd} onChange={(e) => setTargetEnd(parseInt(e.target.value, 10) || 0)} className="w-full rounded-md border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border" />
                </div>
              </div>
            )}

            <div className="mb-3">
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">Calculation engine</label>
              <select value={backend} onChange={(e) => setBackend(e.target.value as 'primer3' | 'native')} className="rounded-md border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border">
                <option value="primer3">Primer3 (FFI)</option>
                <option value="native">Native (Strider-derived)</option>
              </select>
            </div>

            <button disabled={designing} onClick={() => void runDesign()} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2 transition-colors shadow-sm">
              {designing ? 'Designing…' : 'Design Primers'}
            </button>

            {designError && <div className="mt-3 p-3 text-sm text-red-800 dark:text-red-300 rounded-lg bg-red-50 dark:bg-red-950/40">{designError}</div>}
          </div>

          {candidates && candidates.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Conserved-Region Candidates</h4>
              <ResultsTable
                rows={candidates}
                keyOf={(c, i) => `${i}-${c.sequence}`}
                columns={[
                  { header: "Sequence (5'→3')", render: (c) => c.sequence, className: 'font-mono text-slate-800 dark:text-slate-200' },
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
                  { header: 'Left', render: (p) => p.left.sequence, className: 'font-mono text-slate-800 dark:text-slate-200' },
                  { header: 'Right', render: (p) => p.right.sequence, className: 'font-mono text-slate-800 dark:text-slate-200' },
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
