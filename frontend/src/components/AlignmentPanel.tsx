import { useMemo, useRef, useState } from 'react';
import { useSessionState } from '../session/sessionContext';
import { alignSequences, designConserved, type ConservedPairOligo, type ConservedPair, type ConservedCandidate, type Coverage, type DesignConservedRequest } from '../api/align';
import type { SequenceData } from '../api/sequence';
import { fetchNucleotide, getSequence } from '../api/sequence';
import type { Transcript } from '../api/gene';
import { ApiError } from '../api/client';
import { parseMultiFasta } from '../utils/fasta';
import AlignmentView from './AlignmentView';
import ConservedWindows from './ConservedWindows';
import HomologCollector from './HomologCollector';
import Badge from './ui/Badge';
import AlignmentPrimersPanel from './AlignmentPrimersPanel';
import { analyzeAlignment, parseAlignedFasta, percentIdentity, type ConservedWindow } from '../utils/alignedFasta';
import { NO_ALIGN_PRIMERS, degenerateSite, primerFromPick, type AlignPick, type AlignPrimer, type AlignPrimers } from '../utils/alignPrimers';
import { analyzePrimer } from '../api/design';
import { cleanDNA, reverseComplement } from '../utils/dna';
import ResultsTable from './ResultsTable';
import PrimerSequence from './PrimerSequence';
import Button from './ui/Button';
import Checkbox from './ui/Checkbox';
import Field from './ui/Field';
import TextInput, { controlClasses } from './ui/TextInput';
import Select from './ui/Select';
import SegmentedControl from './ui/SegmentedControl';

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
  /** A pasted sequence's best BLAST hit (no `geneContext` then): the gene
   * and organism its homologs are collected for. */
  homologHint?: { gene: string | null; organism: string };
}

/** The alignment's reference (query row): any record being aligned, or a
 * new one by NCBI accession or pasted sequence. */
function ReferencePicker({
  options,
  value,
  loadedName,
  externalRef,
  strand,
  onStrandChange,
  aligned,
  input,
  onInputChange,
  busy,
  error,
  onChoose,
  onUseNew,
  onDropExternal,
}: {
  options: string[];
  value: string | null;
  loadedName: string | null;
  externalRef: ExternalReference | null;
  strand: Strand;
  onStrandChange: (s: Strand) => void;
  aligned: boolean;
  input: string;
  onInputChange: (v: string) => void;
  busy: boolean;
  error: string | null;
  onChoose: (id: string) => void;
  onUseNew: () => void;
  onDropExternal: () => void;
}) {
  return (
    <div className="mb-3 rounded-md border border-line bg-surface-2 p-3">
      <h4 className="mb-1 text-sm font-semibold text-ink">Reference</h4>
      <p className="mb-2 text-sm text-ink-muted">
        The reference is the first row: the other sequences follow by percent identity to it, and their bases are marked red where they differ from it.{' '}
        {aligned
          ? `Swapping it to another aligned sequence is instant${strand === '-' ? ' (on the − strand it re-aligns)' : ''}; a new one or a strand change is aligned in.`
          : 'It applies when you align.'}{' '}
        On the − strand it is aligned as its reverse complement, for homologs that read the other way.
      </p>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <Field label="Swap to" htmlFor="aln-reference" className="min-w-56 max-w-md flex-1">
          <Select id="aln-reference" value={value ?? ''} onChange={(e) => onChoose(e.target.value)} disabled={busy || options.length === 0}>
            {options.length === 0 && <option value="">Nothing to align yet</option>}
            {options.map((id) => (
              <option key={id} value={id}>
                {id === loadedName ? `${id} - your sequence` : id}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Strand" className="shrink-0">
          <SegmentedControl
            ariaLabel="Reference strand"
            options={STRAND_OPTIONS}
            value={strand}
            onChange={(s) => {
              if (!busy && value) onStrandChange(s);
            }}
            className="h-9"
          />
        </Field>
        <Field label="Or a new one: NCBI accession (optionally :start-end) or a sequence" htmlFor="aln-new-reference" className="min-w-64 flex-[2]">
          <TextInput
            id="aln-new-reference"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onUseNew();
            }}
            placeholder="e.g. CP151816.1:5733700-5735400, or ACGT…"
            spellCheck={false}
            className="font-mono"
          />
        </Field>
        <Button disabled={busy} onClick={onUseNew}>
          {busy ? 'Working…' : 'Use as reference'}
        </Button>
      </div>
      {externalRef && (
        <p className="mt-2 text-xs text-ink-muted">
          Added reference <span className="font-mono text-ink">{externalRef.id}</span> ({externalRef.seq.length.toLocaleString('en-US')} bp{externalRef.title ? ` - ${externalRef.title}` : ''}).{' '}
          <button type="button" className="text-accent hover:underline" disabled={busy} onClick={onDropExternal}>
            Remove it
          </button>
        </p>
      )}
      {error && <div role="alert" className="mt-2 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2 text-sm font-medium text-danger">{error}</div>}
    </div>
  );
}

/** The reference as given (+) or reverse-complemented (−) for aligning. */
type Strand = '+' | '-';
const STRAND_OPTIONS = [
  { value: '+', label: '+', title: 'Align the reference as it is' },
  { value: '-', label: '−', title: 'Align the reverse complement of the reference' },
] as const;

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

/** An NCBI nucleotide accession, optionally with a range:
 * `CP151816.1`, `NC_000017.11:43044295-43125483`. */
const ACCESSION_INPUT = /^[A-Za-z]{1,6}_?\d{4,}(\.\d+)?(:\s*[\d,]+\s*-\s*[\d,]+)?$/;

/** A reference that isn't the loaded sequence or one of the input's
 * records: fetched from NCBI or pasted, aligned as a record of its own. */
interface ExternalReference {
  id: string;
  seq: string;
  title?: string;
}

/** "Pseudomonas" from a species slug, name or BLAST organism - the
 * default taxon to collect homologs in. Empty for a taxonomy ID. */
function genusOf(species: string): string {
  const first = species.trim().split(/[\s_]+/)[0] ?? '';
  return /^[a-z]+$/i.test(first) ? first[0].toUpperCase() + first.slice(1).toLowerCase() : '';
}

export default function AlignmentPanel({ loadedSequence, geneTranscripts, geneContext, homologHint }: Props) {
  const [fastaText, setFastaText] = useSessionState('align.fastaText', '');
  // The loaded sequence (flanks + gene) is always aligned. The reference -
  // the query row: first, never hidden, what identity and mismatches are
  // measured against - is the loaded sequence unless swapped for another
  // record (`referenceChoice`), which may be one fetched or pasted just for
  // that (`externalRef`). Record names are kept with the alignment, to find
  // the rows again in MAFFT's output.
  const loadedName = loadedSequence ? `${geneContext?.geneName || loadedSequence.gene_name || 'loaded sequence'} (loaded)` : null;
  const [queryId, setQueryId] = useSessionState<string | null>('align.queryId', null);
  const [referenceChoice, setReferenceChoice] = useSessionState<string | null>('align.reference', null);
  const [referenceStrand, setReferenceStrand] = useSessionState<Strand>('align.referenceStrand', '+');
  const [externalRef, setExternalRef] = useSessionState<ExternalReference | null>('align.externalRef', null);
  const [newRefInput, setNewRefInput] = useSessionState('align.newRefInput', '');
  const [fetchingRef, setFetchingRef] = useState(false);
  const [refError, setRefError] = useState<string | null>(null);
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
  // Designed primers may carry IUPAC codes covering every sequence.
  const [degenerate, setDegenerate] = useSessionState('align.degenerate', false);
  const [hiddenRows, setHiddenRows] = useSessionState<string[]>('align.hiddenRows', []);
  const [primers, setPrimers] = useSessionState<AlignPrimers>('align.primers', NO_ALIGN_PRIMERS);
  // The designed candidate/pair clicked in the results, highlighted on the map.
  const [picked, setPicked] = useState<{ key: string; ranges: { colStart: number; colEnd: number }[] } | null>(null);
  function togglePicked(key: string, ranges: { colStart: number; colEnd: number }[]) {
    setPicked((prev) => (prev?.key === key ? null : { key, ranges }));
  }
  // The query first, then the rest by percent identity to it, most similar
  // first (larger overlap breaks ties). Without a query: MAFFT's order.
  const { alignedRows, identities } = useMemo(() => {
    const rows = alignment ? parseAlignedFasta(alignment) : [];
    const query = rows.find((r) => r.id === queryId);
    if (!query) return { alignedRows: rows, identities: undefined };
    const scored = rows.filter((r) => r !== query).map((r) => ({ r, ...percentIdentity(query, r) }));
    scored.sort((x, y) => y.identity - x.identity || y.overlap - x.overlap);
    return { alignedRows: [query, ...scored.map((s) => s.r)], identities: new Map(scored.map((s) => [s.r.id, s.identity])) };
  }, [alignment, queryId]);
  const visibleRows = useMemo(() => alignedRows.filter((r) => r.id === queryId || !hiddenRows.includes(r.id)), [alignedRows, hiddenRows, queryId]);

  function setPrimer(side: 'F' | 'R', primer: AlignPrimer | null) {
    setPrimers((prev) => ({ ...prev, [side]: primer }));
  }

  /** Makes a selection the forward or reverse primer (keeping a name the
   * user gave the one it replaces), then fills in its Strider analysis. */
  function pickPrimer(side: 'F' | 'R', pick: AlignPick, degenerate: boolean) {
    const row = alignedRows.find((r) => r.id === pick.rowId);
    if (!row) return;
    const site = degenerate ? degenerateSite(visibleRows, pick.colStart, pick.colEnd) : undefined;
    const primer = primerFromPick(row, pick, side, primers[side]?.name ?? (side === 'F' ? 'Cons-F' : 'Cons-R'), site);
    setPrimer(side, primer);
    analyzePrimer({ sequence: primer.sequence }).then(
      (analysis) => setPrimers((prev) => (prev[side]?.sequence === primer.sequence ? { ...prev, [side]: { ...prev[side]!, analysis } } : prev)),
      () => setPrimers((prev) => (prev[side]?.sequence === primer.sequence ? { ...prev, [side]: { ...prev[side]!, analysis: null } } : prev)),
    );
  }

  /** Aligns the input. `override` stands in for the reference state when
   * it has just been set, ahead of React. */
  async function runAlign(override?: { externalRef?: ExternalReference | null; reference?: string | null; strand?: Strand }) {
    const external = override && 'externalRef' in override ? (override.externalRef ?? null) : externalRef;
    const reference = override && 'reference' in override ? (override.reference ?? null) : referenceChoice;
    const strand = override?.strand ?? referenceStrand;
    setAlignError(null);
    setAlignment(null);
    setCandidates(null);
    setPairs(null);
    setPrimers(NO_ALIGN_PRIMERS);
    setPicked(null);
    setHiddenRows([]);
    const records = parseMultiFasta(fastaText);
    const extraRecords: { id: string; seq: string }[] = [];
    if (loadedSequence && loadedName) {
      const loadedSeq = cleanDNA((loadedSequence.upstream_seq || '') + (loadedSequence.gene_seq || '') + (loadedSequence.downstream_seq || ''));
      if (loadedSeq) extraRecords.push({ id: loadedName, seq: loadedSeq });
    }
    if (external) extraRecords.push({ id: external.id, seq: external.seq });

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

    let all = [...extraRecords, ...records];
    // The chosen reference while it's still among the records, else the
    // loaded sequence; without either, MAFFT's order and no query. On the
    // − strand it goes in reverse-complemented.
    const ids = new Set(all.map((r) => r.id));
    const query = reference && ids.has(reference) ? reference : loadedName && ids.has(loadedName) ? loadedName : null;
    setQueryId(query);
    if (query && strand === '-') all = all.map((r) => (r.id === query ? { ...r, seq: reverseComplement(r.seq) } : r));
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
    setPicked(null);
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
    if (degenerate) req = { ...req, degenerate: true, max_degeneracy: MAX_DESIGN_DEGENERACY };
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

  // What can be the reference: the aligned rows once there's an alignment
  // (swapping among them is instant), else the records about to be aligned.
  const referenceOptions = alignment
    ? alignedRows.map((r) => r.id)
    : [...(loadedName ? [loadedName] : []), ...(externalRef ? [externalRef.id] : []), ...parseMultiFasta(fastaText).map((r) => r.id)];
  const currentReference = alignment ? queryId : referenceChoice && referenceOptions.includes(referenceChoice) ? referenceChoice : loadedName;

  function chooseReference(id: string) {
    setRefError(null);
    setReferenceChoice(id === loadedName ? null : id);
    // A − strand reference was aligned flipped: the old one goes back to
    // +, the new one flips, so that's a re-align.
    if (alignment && referenceStrand === '-') {
      void runAlign({ reference: id === loadedName ? null : id });
      return;
    }
    if (alignment && alignedRows.some((r) => r.id === id)) {
      setQueryId(id);
      setHiddenRows((prev) => prev.filter((h) => h !== id));
    }
  }

  /** The new-reference box's accession (fetched from NCBI) or sequence
   * (FASTA or bare) becomes the reference, re-aligning if aligned. */
  async function applyNewReference() {
    setRefError(null);
    const text = newRefInput.trim();
    if (!text) {
      setRefError('Enter an NCBI accession (optionally with a range) or paste a sequence.');
      return;
    }
    let ref: ExternalReference;
    if (ACCESSION_INPUT.test(text)) {
      setFetchingRef(true);
      try {
        const res = await fetchNucleotide(text);
        ref = { id: `${res.id.replace(/\s+/g, '')} (reference)`, seq: cleanDNA(res.sequence), title: res.title };
      } catch (e) {
        setRefError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
        return;
      } finally {
        setFetchingRef(false);
      }
    } else {
      const first = parseMultiFasta(text)[0];
      if (!first || first.seq.length < 20) {
        setRefError('That is neither an NCBI accession nor a DNA sequence of at least 20 bp.');
        return;
      }
      const name = /^seq\d+$/.test(first.id) ? 'pasted' : first.id.split(/\s+/)[0];
      ref = { id: `${name} (reference)`, seq: first.seq };
    }
    setExternalRef(ref);
    setReferenceChoice(ref.id);
    setNewRefInput('');
    if (alignment) await runAlign({ externalRef: ref, reference: ref.id });
  }

  function chooseStrand(strand: Strand) {
    if (strand === referenceStrand) return;
    setReferenceStrand(strand);
    if (alignment) void runAlign({ strand });
  }

  /** After homologs are added: brings the Align button on screen and
   * rings it for a moment - the next step. */
  const alignButtonRef = useRef<HTMLDivElement>(null);
  const [alignNudge, setAlignNudge] = useState(false);
  function showAlignButton() {
    alignButtonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setAlignNudge(true);
    setTimeout(() => setAlignNudge(false), 2000);
  }

  /** Drops the fetched/pasted reference; the loaded sequence takes over. */
  async function dropExternalReference() {
    setExternalRef(null);
    setReferenceChoice(null);
    if (alignment) await runAlign({ externalRef: null, reference: null });
  }

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-ink">Multi-Sequence Alignment</h3>
      <p className="mb-4 text-sm text-ink-muted">
        Collect a gene&rsquo;s homologs across species, or paste two or more sequences - FASTA, GenBank (a whole record or just its numbered sequence lines), or one bare sequence per line. MAFFT aligns them; then pick primers straight off the alignment (drag across a row, right-click) or a conserved window to design primers in. Each primer shows how many of the aligned sequences it matches.
      </p>

      <HomologCollector
        defaultGene={geneContext?.geneName ?? homologHint?.gene ?? undefined}
        defaultTaxon={geneContext ? genusOf(geneContext.species) : homologHint ? genusOf(homologHint.organism) : undefined}
        existing={parseMultiFasta(fastaText)}
        onAdd={(fasta) => {
          setFastaText((fastaText.trim() ? `${fastaText.trim()}\n` : '') + fasta);
          showAlignButton();
        }}
      />

      <textarea
        rows={8}
        value={fastaText}
        onChange={(e) => setFastaText(e.target.value)}
        placeholder={'>seq1\nACGT…\n>seq2\nACGT…'}
        className={`${controlClasses} mb-3 resize-y p-3 font-mono`}
      />

      <ReferencePicker
        options={referenceOptions}
        value={currentReference}
        loadedName={loadedName}
        externalRef={externalRef}
        strand={referenceStrand}
        onStrandChange={chooseStrand}
        aligned={alignment !== null}
        input={newRefInput}
        onInputChange={setNewRefInput}
        busy={fetchingRef || aligning}
        error={refError}
        onChoose={chooseReference}
        onUseNew={() => void applyNewReference()}
        onDropExternal={() => void dropExternalReference()}
      />

      {loadedSequence && (
        <div className="mb-3 flex flex-col gap-1.5">
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

      <div ref={alignButtonRef} className={`inline-block rounded-md transition-shadow duration-500 ${alignNudge ? 'ring-4 ring-accent/40' : ''}`}>
        <Button variant="primary" disabled={aligning || fetchingRef} onClick={() => void runAlign()}>
          {aligning ? 'Aligning…' : 'Align Sequences'}
        </Button>
      </div>

      {alignError && <div role="alert" className="mt-4 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">{alignError}</div>}

      {alignment && (
        <>
          <DegenerateToggle checked={degenerate} onChange={setDegenerate} className="mt-4" />
          {analysis && analysis.rows.length >= 2 && (
            <ConservedWindows analysis={analysis} designing={designing} onDesignIn={(w) => void runDesign({ window: w })} onDesignPair={(left, right) => void runDesign({ left, right })} />
          )}

          <h4 className="mb-2 mt-4 text-sm font-semibold text-ink">Alignment</h4>
          <AlignmentView
            alignment={alignment}
            rows={alignedRows}
            queryId={queryId}
            identities={identities}
            hiddenRows={hiddenRows}
            onHiddenRowsChange={setHiddenRows}
            primers={primers}
            designRange={{ colStart, colEnd }}
            onPickPrimer={pickPrimer}
            onSetDesignRange={(start, end) => {
              setColStart(start);
              setColEnd(end);
            }}
            highlight={picked?.ranges}
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

            <DegenerateToggle checked={degenerate} onChange={setDegenerate} className="mb-3" />

            <Button variant="primary" disabled={designing} onClick={() => void runDesign()}>
              {designing ? 'Designing…' : 'Design Primers'}
            </Button>

            {designError && <div role="alert" className="mt-3 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">{designError}</div>}
          </div>

          {candidates && candidates.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Conserved-Region Candidates</h4>
              <p className="mb-2 text-xs text-ink-muted">Click a row to highlight it on the alignment map.</p>
              <ResultsTable
                rows={candidates}
                keyOf={(c, i) => `c${i}-${c.sequence}`}
                selectedKey={picked?.key}
                onRowClick={(c, i) => togglePicked(`c${i}-${c.sequence}`, [{ colStart: c.col_start, colEnd: c.col_end }])}
                columns={[
                  { header: "Sequence (5'→3')", render: (c) => <DesignedSeq oligo={c} />, className: 'font-mono text-ink' },
                  { header: 'Covers', render: (c) => <CoverageBadge coverage={c.coverage} /> },
                  { header: 'Columns', render: (c) => `${c.col_start + 1}-${c.col_end}` },
                  { header: 'Tm', render: (c) => tmLabel(c) },
                  { header: 'GC%', render: (c) => spread(c.gc_percent, c.degeneracy > 1 ? c.gc_min : null, c.gc_max) },
                  { header: 'Penalty', render: (c) => c.penalty.toFixed(2) },
                ]}
              />
            </div>
          )}

          {pairs && pairs.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Conserved-Region Pairs</h4>
              <p className="mb-2 text-xs text-ink-muted">Click a row to highlight its primers on the alignment map.</p>
              <ResultsTable
                rows={pairs}
                keyOf={(p, i) => `p${i}-${p.left.sequence}`}
                selectedKey={picked?.key}
                onRowClick={(p, i) =>
                  togglePicked(`p${i}-${p.left.sequence}`, [
                    { colStart: p.left.col_start, colEnd: p.left.col_end },
                    { colStart: p.right.col_start, colEnd: p.right.col_end },
                  ])
                }
                columns={[
                  { header: 'Left', render: (p) => <DesignedSeq oligo={p.left} label="Forward primer" />, className: 'font-mono text-ink' },
                  { header: 'Right', render: (p) => <DesignedSeq oligo={p.right} label="Reverse primer" />, className: 'font-mono text-ink' },
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
                  { header: 'Left Tm', render: (p) => tmLabel(p.left) },
                  { header: 'Right Tm', render: (p) => tmLabel(p.right) },
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

/** Most variants a designed degenerate primer may have. */
const MAX_DESIGN_DEGENERACY = 64;

function DegenerateToggle({ checked, onChange, className = '' }: { checked: boolean; onChange: (v: boolean) => void; className?: string }) {
  // Its own block, so it never runs onto the line of a button before it.
  return (
    <div className={className}>
      <Checkbox
        label={
          <span className="text-sm">
            Degenerate primers (IUPAC codes covering every sequence; up to {MAX_DESIGN_DEGENERACY}-fold, the 3′-most 5 bases kept exact)
          </span>
        }
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </div>
  );
}

/** A value to one decimal, or a degenerate oligo's spread over its
 * variants (`lo`/`hi`, when given and different). */
function spread(value: number, lo: number | null, hi: number | null): string {
  const a = lo?.toFixed(1);
  const b = hi?.toFixed(1);
  return a != null && b != null && a !== b ? `${a}–${b}` : (a ?? value.toFixed(1));
}

/** A designed oligo's Tm: a degenerate one's spread over its variants. */
function tmLabel(o: ConservedPairOligo): string {
  return spread(o.tm, o.degeneracy > 1 ? o.tm_min : null, o.tm_max);
}

/** A designed oligo, with its degeneracy when it has one. */
function DesignedSeq({ oligo, label }: { oligo: ConservedPairOligo; label?: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <PrimerSequence sequence={oligo.sequence} label={label} />
      {oligo.degeneracy > 1 && (
        <span className="font-sans text-[11px] font-medium text-accent" title={`Consensus: ${oligo.consensus_sequence}`}>
          {oligo.degeneracy}-fold
        </span>
      )}
    </span>
  );
}
