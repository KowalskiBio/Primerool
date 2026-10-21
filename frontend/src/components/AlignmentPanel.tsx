import { useMemo, useState } from 'react';
import { useSessionState } from '../session/sessionContext';
import { alignSequences, designConserved, type ConservedPair, type ConservedCandidate, type Coverage, type DesignConservedRequest } from '../api/align';
import type { SequenceData } from '../api/sequence';
import { getSequence } from '../api/sequence';
import type { Transcript } from '../api/gene';
import { ApiError } from '../api/client';
import { parseMultiFasta } from '../utils/fasta';
import AlignmentView from './AlignmentView';
import ConservedWindows from './ConservedWindows';
import HomologCollector from './HomologCollector';
import Badge from './ui/Badge';
import AlignmentPrimersPanel from './AlignmentPrimersPanel';
import { analyzeAlignment, parseAlignedFasta, type ConservedWindow } from '../utils/alignedFasta';
import { NO_ALIGN_PRIMERS, primerFromPick, type AlignPick, type AlignPrimer, type AlignPrimers } from '../utils/alignPrimers';
import { analyzePrimer } from '../api/design';
import { cleanDNA } from '../utils/dna';
import ResultsTable from './ResultsTable';
import PrimerSequence from './PrimerSequence';
import Button from './ui/Button';
import Checkbox from './ui/Checkbox';
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
interface Props {
  loadedSequence?: SequenceData | null;
  /** All transcripts of the loaded sequence's gene (from the step-2 search)
   * - enables "compare transcript variants…". Absent on custom pastes, as is
   * `loadedSequence`. */
  geneTranscripts?: Transcript[];
  /** Context needed to fetch a transcript's sequence (`/get_sequence`) for
   * variant comparison - gene name, species/source, and the view options the
   * loaded sequence was fetched with, so variants align in the same shape. */
  geneContext?: {
    geneName: string;
    species: string;
    apiSource: 'ensembl' | 'ncbi';
    includeIntrons: boolean;
    includeUtr: boolean;
    upstreamBp: number;
    downstreamBp: number;
  };
}

/** "18/20 sequences", flagged when some would fail at the primer's 3' end. */
function CoverageBadge({ coverage, label }: { coverage: Coverage; label?: string }) {
  const { matching_rows: ok, total_rows: total, three_prime_mismatch_rows: bad3 } = coverage;
  const tone = ok === total ? 'success' : bad3 > 0 ? 'danger' : 'warning';
  const title = `Matches ${ok} of ${total} aligned sequences exactly${bad3 ? `; ${bad3} have a mismatch in its 3'-terminal 5 bases and are unlikely to amplify` : ''}.`;
  return (
    <Badge tone={tone} title={title} className="whitespace-nowrap tabular-nums">
      {label ? `${label} ` : ''}
      {ok}/{total}
      {bad3 > 0 ? ` · ${bad3}×3′` : ''}
    </Badge>
  );
}

/** "Pseudomonas" from a species slug, name or BLAST organism - the
 * default taxon to collect homologs in. Empty for a taxonomy ID. */
function genusOf(species: string): string {
  const first = species.trim().split(/[\s_]+/)[0] ?? '';
  return /^[a-z]+$/i.test(first) ? first[0].toUpperCase() + first.slice(1).toLowerCase() : '';
}

export default function AlignmentPanel({ loadedSequence, geneTranscripts, geneContext }: Props) {
  const [fastaText, setFastaText] = useSessionState('align.fastaText', '');
  // When set, the currently loaded sequence (flanks + gene) is prepended to
  // the alignment input as '>loaded query' - e.g. to compare the NCBI-sourced
  // sequence the rest of the app is working against with Ensembl's take on
  // the same transcript pasted below.
  const [includeQuery, setIncludeQuery] = useSessionState('align.includeQuery', false);
  // When set, every OTHER transcript variant of the same gene is fetched via
  // `/get_sequence` (same view options as the loaded sequence) and added to
  // the alignment as its own record, so variants can be compared straight
  // from the search result - no manual per-transcript FASTA extraction.
  const [includeVariants, setIncludeVariants] = useSessionState('align.includeVariants', false);
  const [alignment, setAlignment] = useSessionState<string | null>('align.alignment', null);
  const [aligning, setAligning] = useState(false);
  const [alignError, setAlignError] = useState<string | null>(null);

  const [colStart, setColStart] = useSessionState('align.colStart', 0);
  const [colEnd, setColEnd] = useSessionState('align.colEnd', 0);
  const [useTarget, setUseTarget] = useSessionState('align.useTarget', false);
  const [targetStart, setTargetStart] = useSessionState('align.targetStart', 0);
  const [targetEnd, setTargetEnd] = useSessionState('align.targetEnd', 0);
  const [designing, setDesigning] = useState(false);
  const [designError, setDesignError] = useState<string | null>(null);
  const [candidates, setCandidates] = useSessionState<ConservedCandidate[] | null>('align.candidates', null);
  const [pairs, setPairs] = useSessionState<ConservedPair[] | null>('align.pairs', null);
  // Rows taken out of the alignment view, and the F/R primers picked off it.
  const [hiddenRows, setHiddenRows] = useSessionState<string[]>('align.hiddenRows', []);
  const [primers, setPrimers] = useSessionState<AlignPrimers>('align.primers', NO_ALIGN_PRIMERS);
  const alignedRows = useMemo(() => (alignment ? parseAlignedFasta(alignment) : []), [alignment]);
  const visibleRows = useMemo(() => alignedRows.filter((r) => !hiddenRows.includes(r.id)), [alignedRows, hiddenRows]);

  function setPrimer(side: 'F' | 'R', primer: AlignPrimer | null) {
    setPrimers((prev) => ({ ...prev, [side]: primer }));
  }

  /** Makes a selection the forward or reverse primer (keeping a name the
   * user gave the one it replaces), then fills in its Strider analysis. */
  function pickPrimer(side: 'F' | 'R', pick: AlignPick) {
    const row = alignedRows.find((r) => r.id === pick.rowId);
    if (!row) return;
    const primer = primerFromPick(row, pick, side, primers[side]?.name ?? (side === 'F' ? 'Cons-F' : 'Cons-R'));
    setPrimer(side, primer);
    analyzePrimer({ sequence: primer.sequence }).then(
      (analysis) => setPrimers((prev) => (prev[side]?.sequence === primer.sequence ? { ...prev, [side]: { ...prev[side]!, analysis } } : prev)),
      () => setPrimers((prev) => (prev[side]?.sequence === primer.sequence ? { ...prev, [side]: { ...prev[side]!, analysis: null } } : prev)),
    );
  }

  async function runAlign() {
    setAlignError(null);
    setAlignment(null);
    setCandidates(null);
    setPairs(null);
    setPrimers(NO_ALIGN_PRIMERS);
    setHiddenRows([]);
    const records = parseMultiFasta(fastaText);
    const extraRecords: { id: string; seq: string }[] = [];
    if (includeQuery && loadedSequence) {
      const querySeq = cleanDNA((loadedSequence.upstream_seq || '') + (loadedSequence.gene_seq || '') + (loadedSequence.downstream_seq || ''));
      if (querySeq) extraRecords.push({ id: 'loaded query', seq: querySeq });
    }

    const variants =
      includeVariants && geneTranscripts && geneContext && loadedSequence
        ? geneTranscripts.filter((t) => t.id !== loadedSequence.transcript_id)
        : [];
    if (variants.length > 0) {
      setAligning(true);
      try {
        const fetched = await Promise.all(
          variants.map((t) =>
            getSequence({
              gene_name: geneContext!.geneName,
              transcript_id: t.id,
              upstream_bp: geneContext!.upstreamBp,
              downstream_bp: geneContext!.downstreamBp,
              include_introns: geneContext!.includeIntrons,
              include_utr: geneContext!.includeUtr,
              orient_plus: true,
              species: geneContext!.species,
              api_source: geneContext!.apiSource,
            }),
          ),
        );
        for (const [i, data] of fetched.entries()) {
          const seq = cleanDNA((data.upstream_seq || '') + (data.gene_seq || '') + (data.downstream_seq || ''));
          if (seq) extraRecords.push({ id: variants[i].name, seq });
        }
      } catch (e) {
        setAligning(false);
        setAlignError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
        return;
      }
      setAligning(false);
    }

    const all = [...extraRecords, ...records];
    if (all.length < 2) {
      setAlignError('Paste at least two sequences to align (FASTA, GenBank, or one bare sequence per line).');
      return;
    }
    setAligning(true);
    try {
      const res = await alignSequences(all);
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

  const analysis = useMemo(() => (alignment ? analyzeAlignment(alignedRows) : null), [alignment, alignedRows]);

  /** Runs the design with the column fields' settings, or over one
   * conserved window, or as a pair across two of them. */
  async function runDesign(region?: { window: ConservedWindow } | { left: ConservedWindow; right: ConservedWindow }) {
    if (!alignment) return;
    setDesignError(null);
    setCandidates(null);
    setPairs(null);
    setDesigning(true);
    let req: DesignConservedRequest;
    if (region && 'window' in region) {
      setColStart(region.window.start);
      setColEnd(region.window.end);
      setUseTarget(false);
      req = { alignment, col_start: region.window.start, col_end: region.window.end };
    } else if (region) {
      req = {
        alignment,
        col_start: region.left.start,
        col_end: region.right.end,
        left_cols: [region.left.start, region.left.end],
        right_cols: [region.right.start, region.right.end],
        product_size_min: 60,
        product_size_max: Math.max(1000, region.right.end - region.left.start),
      };
    } else {
      req = {
        alignment,
        col_start: colStart,
        col_end: colEnd,
        target_start: useTarget ? targetStart : undefined,
        target_end: useTarget ? targetEnd : undefined,
      };
    }
    try {
      const res = await designConserved(req);
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
        Collect a gene&rsquo;s homologs across species, or paste two or more sequences - FASTA, GenBank (a whole record or just its numbered sequence lines), or one bare sequence per line. MAFFT aligns them; then pick primers straight off the alignment (drag across a row, right-click) or a conserved window to design primers in. Each primer shows how many of the aligned sequences it matches.
      </p>

      <HomologCollector
        defaultGene={geneContext?.geneName}
        defaultTaxon={geneContext ? genusOf(geneContext.species) : undefined}
        onAdd={(fasta) => setFastaText((fastaText.trim() ? `${fastaText.trim()}\n` : '') + fasta)}
      />

      <textarea
        rows={8}
        value={fastaText}
        onChange={(e) => setFastaText(e.target.value)}
        placeholder={'>seq1\nACGT…\n>seq2\nACGT…'}
        className={`${controlClasses} mb-3 resize-y p-3 font-mono`}
      />

      {loadedSequence && (
        <div className="mb-3 flex flex-col gap-1.5">
          <Checkbox
            label={
              <span className="text-sm">
                Include the loaded sequence as the first entry (<span className="font-mono">&gt;loaded query</span>)
              </span>
            }
            checked={includeQuery}
            onChange={(e) => setIncludeQuery(e.target.checked)}
          />
          {geneTranscripts && geneTranscripts.length > 1 && (
            <Checkbox
              label={
                <span className="text-sm">
                  Also include the {geneTranscripts.length - 1} other transcript variant{geneTranscripts.length - 1 === 1 ? '' : 's'} of{' '}
                  <span className="font-medium">{geneContext?.geneName ?? 'this gene'}</span> (each fetched with the same view options)
                </span>
              }
              checked={includeVariants}
              onChange={(e) => setIncludeVariants(e.target.checked)}
            />
          )}
        </div>
      )}

      <Button variant="primary" disabled={aligning} onClick={() => void runAlign()}>
        {aligning ? 'Aligning…' : 'Align Sequences'}
      </Button>

      {alignError && <div role="alert" className="mt-4 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">{alignError}</div>}

      {alignment && (
        <>
          {analysis && analysis.rows.length >= 2 && (
            <ConservedWindows analysis={analysis} designing={designing} onDesignIn={(w) => void runDesign({ window: w })} onDesignPair={(left, right) => void runDesign({ left, right })} />
          )}

          <h4 className="mb-2 mt-4 text-sm font-semibold text-ink">Alignment</h4>
          <AlignmentView
            alignment={alignment}
            rows={alignedRows}
            hiddenRows={hiddenRows}
            onHiddenRowsChange={setHiddenRows}
            primers={primers}
            designRange={{ colStart, colEnd }}
            onPickPrimer={pickPrimer}
            onSetDesignRange={(start, end) => {
              setColStart(start);
              setColEnd(end);
            }}
          />
          <AlignmentPrimersPanel rows={visibleRows} primers={primers} onChange={setPrimer} />
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-medium text-ink-muted hover:text-ink">Aligned FASTA</summary>
            <pre className="sequence-viewer mt-2 max-h-[300px] overflow-auto rounded-lg border border-line bg-base p-4 text-xs">{alignment}</pre>
          </details>

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
                  { header: "Sequence (5'→3')", render: (c) => <PrimerSequence sequence={c.sequence} />, className: 'font-mono text-ink' },
                  { header: 'Covers', render: (c) => <CoverageBadge coverage={c.coverage} /> },
                  { header: 'Columns', render: (c) => `${c.col_start + 1}-${c.col_end}` },
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
                  { header: 'Left', render: (p) => <PrimerSequence sequence={p.left.sequence} label="Forward primer" />, className: 'font-mono text-ink' },
                  { header: 'Right', render: (p) => <PrimerSequence sequence={p.right.sequence} label="Reverse primer" />, className: 'font-mono text-ink' },
                  {
                    header: 'Covers',
                    render: (p) => (
                      <span className="flex flex-col items-start gap-1">
                        <CoverageBadge coverage={p.left.coverage} label="F" />
                        <CoverageBadge coverage={p.right.coverage} label="R" />
                      </span>
                    ),
                  },
                  { header: 'Columns', render: (p) => `${p.left.col_start + 1}-${p.right.col_end}` },
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
