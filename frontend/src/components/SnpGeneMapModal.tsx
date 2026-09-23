import { useEffect, useState } from 'react';
import { searchGene, type Transcript } from '../api/gene';
import { getSequence, type SequenceData } from '../api/sequence';
import type { SnpBlock } from '../api/snpImport';
import type { VariantMarker } from './SequenceViewer';
import Modal from './ui/Modal';
import Checkbox from './ui/Checkbox';
import Select from './ui/Select';
import SequenceViewer from './SequenceViewer';
import { EMPTY_SELECTIONS } from '../utils/regionMapping';
import { localGenePos, SNP_WORKFLOW_SPECIES } from '../utils/variantMapping';

interface Props {
  /** The gene symbol to load, or `null` to keep the modal closed. */
  gene: string | null;
  /** Every block from the current batch belonging to `gene` - each becomes
   * one marker on the map (see `SequenceViewer`'s `variantMarkers`). */
  blocks: SnpBlock[];
  onClose: () => void;
}

function markersFor(data: SequenceData, blocks: SnpBlock[]): VariantMarker[] {
  return blocks
    .map((b): VariantMarker | null => {
      const local = localGenePos(data, b.position);
      if (local === null) return null;
      return { rsid: b.rsid, start: local, end: local + 1, alleles: b.alleles };
    })
    .filter((m): m is VariantMarker => m !== null);
}

/** Opens the same intron-aware sequence map the main gene-search workflow
 * uses (`SequenceViewer`), loaded fresh for one gene from a clicked SNP
 * batch result row - with every SNP the batch found for that gene (not
 * just the clicked one) marked on it. */
export default function SnpGeneMapModal({ gene, blocks, onClose }: Props) {
  const [data, setData] = useState<SequenceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [apiSourceUsed, setApiSourceUsed] = useState<'ncbi' | 'ensembl' | null>(null);
  // Which gene `data`/`error` actually belong to - lets render tell "still
  // loading this gene" apart from "showing a previous gene's stale result"
  // without a separate loading flag set synchronously inside the effect
  // (see `PrimerCard.tsx`'s `structureFor` for the same pattern).
  const [resultFor, setResultFor] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [truncateIntrons, setTruncateIntrons] = useState(true);

  useEffect(() => {
    if (!gene) return;
    let cancelled = false;

    async function load() {
      // NCBI first (matches this app's default gene source), falling back
      // to Ensembl on any failure - a batch-imported gene symbol should
      // resolve against whichever source actually has it, without making
      // the user pick.
      for (const apiSource of ['ncbi', 'ensembl'] as const) {
        try {
          const found = await searchGene({ gene_name: gene!, species: SNP_WORKFLOW_SPECIES, api_source: apiSource });
          const canonical = found.transcripts.find((t) => t.is_canonical) || found.transcripts[0];
          if (!canonical) continue;
          const canonicalSeq = await getSequence({
            gene_name: gene!,
            transcript_id: canonical.id,
            species: SNP_WORKFLOW_SPECIES,
            api_source: apiSource,
            upstream_bp: 200,
            downstream_bp: 200,
            include_introns: true,
            include_utr: false,
          });
          if (cancelled) return;

          let best = canonicalSeq;
          let bestCoverage = markersFor(canonicalSeq, blocks).length;
          // The canonical transcript doesn't cover every batch SNP - a
          // gene's RefSeq/Ensembl-flagged "canonical" pick can span only
          // part of its full genomic locus (e.g. OPRM1's canonical
          // transcript covers ~122kb of its ~236kb gene), so a batch SNP
          // genuinely inside the gene can still fall outside it. Every
          // other transcript this gene has is tried, in order, until one
          // covers every batch SNP or the list runs out - whichever covers
          // the most wins. A candidate that fails to load (some very large
          // transcripts do, from this backend) is just skipped, not
          // treated as an error.
          if (bestCoverage < blocks.length) {
            const others = found.transcripts.filter((t) => t.id !== canonical.id);
            for (const t of others) {
              if (bestCoverage >= blocks.length) break;
              try {
                const seq = await getSequence({
                  gene_name: gene!,
                  transcript_id: t.id,
                  species: SNP_WORKFLOW_SPECIES,
                  api_source: apiSource,
                  upstream_bp: 200,
                  downstream_bp: 200,
                  include_introns: true,
                  include_utr: false,
                });
                if (cancelled) return;
                const coverage = markersFor(seq, blocks).length;
                if (coverage > bestCoverage) {
                  best = seq;
                  bestCoverage = coverage;
                }
              } catch {
                // try the next candidate
              }
            }
          }

          if (!cancelled) {
            setData(best);
            setTranscripts(found.transcripts);
            setApiSourceUsed(apiSource);
            setError(null);
            setResultFor(gene);
          }
          return;
        } catch {
          // try the next source
        }
      }
      if (!cancelled) {
        setData(null);
        setTranscripts([]);
        setApiSourceUsed(null);
        setError(`Couldn't load "${gene}" from either NCBI or Ensembl.`);
        setResultFor(gene);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [gene, blocks]);

  const loading = gene !== null && resultFor !== gene;
  const shownData = gene !== null && resultFor === gene ? data : null;
  const shownError = gene !== null && resultFor === gene ? error : null;

  async function switchTranscript(transcriptId: string) {
    if (!gene || !apiSourceUsed || transcriptId === shownData?.transcript_id) return;
    setSwitching(true);
    try {
      const seq = await getSequence({
        gene_name: gene,
        transcript_id: transcriptId,
        species: SNP_WORKFLOW_SPECIES,
        api_source: apiSourceUsed,
        upstream_bp: 200,
        downstream_bp: 200,
        include_introns: true,
        include_utr: false,
      });
      setData(seq);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitching(false);
    }
  }

  const markers = shownData ? markersFor(shownData, blocks) : [];
  const markedRsids = new Set(markers.map((m) => m.rsid));
  const offMapCount = shownData ? blocks.length - markers.length : 0;

  /** Jumps the sequence map to a marker rendered by `SequenceViewer` -
   * found by the `data-variant-rsid` attribute it sets on that marker's
   * span (see `SequenceViewer.tsx`), the same way `SequenceViewer`'s own
   * "Find in sequence" jumps to a match. Queried from the document rather
   * than a ref into `SequenceViewer` (which exposes no imperative API)
   * since the marker is a real DOM node under this same modal regardless
   * of the component tree between here and there. */
  function scrollToVariant(rsid: string) {
    const el = document.querySelector(`[data-variant-rsid="${CSS.escape(rsid)}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  return (
    <Modal open={gene !== null} onClose={onClose} title={gene ? `${gene} - sequence map (${blocks.length} SNP${blocks.length === 1 ? '' : 's'})` : ''}>
      {loading && <p className="text-sm text-ink-muted">Loading {gene}'s sequence…</p>}
      {shownError && (
        <div role="alert" className="rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">
          {shownError}
        </div>
      )}
      {shownData && (
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Checkbox label="Truncate introns (show length only)" checked={truncateIntrons} onChange={(e) => setTruncateIntrons(e.target.checked)} />
              {transcripts.length > 1 && (
                <label className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
                  Transcript:
                  <Select size="sm" value={shownData.transcript_id} disabled={switching} onChange={(e) => void switchTranscript(e.target.value)}>
                    {transcripts.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.id}){t.is_canonical ? ' - canonical' : ''}
                      </option>
                    ))}
                  </Select>
                  {switching && <span>loading…</span>}
                </label>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
              <span aria-hidden="true" className="inline-block h-2.5 w-4 rounded-sm" style={{ outline: '2px dashed var(--warning)', outlineOffset: 1 }} />
              <span>marks this batch's SNPs:</span>
              {blocks.map((b, i) => (
                <span key={b.rsid}>
                  {markedRsids.has(b.rsid) ? (
                    <button
                      type="button"
                      onClick={() => scrollToVariant(b.rsid)}
                      title={`Jump to ${b.rsid}`}
                      className="font-medium text-warning underline decoration-dotted hover:decoration-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    >
                      {b.rsid}
                    </button>
                  ) : (
                    <span title={`Outside ${shownData.transcript_name}'s exon span - this SNP may still be in the gene, just under a different transcript. Try the Transcript picker.`} className="text-ink-faint line-through">
                      {b.rsid}
                    </span>
                  )}
                  {i < blocks.length - 1 && ', '}
                </span>
              ))}
              {offMapCount > 0 && ` (${offMapCount} outside ${shownData.transcript_name}'s span - try another transcript above)`}
            </div>
          </div>
          <SequenceViewer data={shownData} selections={EMPTY_SELECTIONS} truncateIntrons={truncateIntrons} variantMarkers={markers} />
        </div>
      )}
    </Modal>
  );
}
