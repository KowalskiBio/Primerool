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

/** The SNP-flanking-report workflow only ever deals in GRCh38 human
 * variants (see `SNP_flanking_sequences_GRCh38.docx`), so unlike the main
 * gene-search workflow there's no species/source picker upstream to read
 * this from - it's fixed here instead. */
const SPECIES = 'homo_sapiens';

/** A gene's "canonical" transcript (per whichever source has it) can cover
 * only part of the gene's full genomic locus - a large gene like OPRM1
 * has isoforms differing by tens of kb at either end, and its
 * RefSeq-flagged canonical pick is a short one. A batch SNP that's
 * genuinely inside the gene can still land outside that one transcript's
 * exon span. Rather than surface that as a dead end, up to this many
 * *other* transcripts from the same search result are tried in order
 * (their natural list order already tends to put the well-characterized
 * RefSeq/Ensembl transcripts before predicted ones) until one covers every
 * batch SNP, or attempts run out - whichever covers the most wins. */
const MAX_AUTO_TRANSCRIPT_ATTEMPTS = 6;

interface Props {
  /** The gene symbol to load, or `null` to keep the modal closed. */
  gene: string | null;
  /** Every block from the current batch belonging to `gene` - each becomes
   * one marker on the map (see `SequenceViewer`'s `variantMarkers`). */
  blocks: SnpBlock[];
  onClose: () => void;
}

/** Maps a 1-based genomic position onto a 0-based offset into
 * `data.gene_seq` - only meaningful when `data.include_introns` is true
 * (only then is `gene_seq` the linear genomic template `gene_start_genomic`/
 * `gene_end_genomic` describe). Same formula `ArmsDesignPanel.tsx` uses for
 * variant-search hits. */
function localGenePos(data: SequenceData, genomicPos: number): number | null {
  const local = data.strand === '-' ? data.gene_end_genomic - genomicPos : genomicPos - data.gene_start_genomic;
  if (local < 0 || local >= data.gene_seq.length) return null;
  return local;
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
          const found = await searchGene({ gene_name: gene!, species: SPECIES, api_source: apiSource });
          const canonical = found.transcripts.find((t) => t.is_canonical) || found.transcripts[0];
          if (!canonical) continue;
          const canonicalSeq = await getSequence({
            gene_name: gene!,
            transcript_id: canonical.id,
            species: SPECIES,
            api_source: apiSource,
            upstream_bp: 200,
            downstream_bp: 200,
            include_introns: true,
            include_utr: false,
          });
          if (cancelled) return;

          let best = canonicalSeq;
          let bestCoverage = markersFor(canonicalSeq, blocks).length;
          // The canonical transcript doesn't cover every batch SNP - try a
          // handful of this gene's other transcripts for one that does
          // (see `MAX_AUTO_TRANSCRIPT_ATTEMPTS`'s doc). A candidate that
          // fails to load (some very large transcripts do, from this
          // backend) is just skipped, not treated as an error.
          if (bestCoverage < blocks.length) {
            const others = found.transcripts.filter((t) => t.id !== canonical.id).slice(0, MAX_AUTO_TRANSCRIPT_ATTEMPTS);
            for (const t of others) {
              if (bestCoverage >= blocks.length) break;
              try {
                const seq = await getSequence({
                  gene_name: gene!,
                  transcript_id: t.id,
                  species: SPECIES,
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
        species: SPECIES,
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
