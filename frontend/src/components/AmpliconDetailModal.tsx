import { useEffect, useState } from 'react';
import type { PlacedAmplicon } from './SnpAmpliconMap';
import type { SequenceData } from '../api/sequence';
import { EMPTY_SELECTIONS, type Selection, type Selections } from '../utils/regionMapping';
import { localGenePos } from '../utils/variantMapping';
import { useGeneSequence } from '../utils/useGeneSequence';
import Modal from './ui/Modal';
import Checkbox from './ui/Checkbox';
import Select from './ui/Select';
import SequenceViewer, { type VariantMarker } from './SequenceViewer';
import PrimerStructurePanel from './PrimerStructurePanel';
import { fmt } from '../utils/format';

interface Props {
  /** The amplicon to open, or `null` to keep the modal closed. */
  amplicon: PlacedAmplicon | null;
  /** Fired once a drag in the sequence map below commits a new forward or
   * reverse primer - `SequenceViewer` has already clamped, re-sliced, and
   * re-analyzed it (the exact same interactive editing the main gene
   * workflow's sequence map uses), so this just reports the result.
   * `groupRsids` are every rsID sharing this amplicon's primer pair (a
   * merged group's members all get the same update - see
   * `PlacedAmplicon.variants`). `side: 'start'` is the forward primer's
   * edge, `'end'` the reverse's, matching `SnpAmpliconMap`'s own
   * `onEdgeDrag` convention. */
  onPrimerEdit: (groupRsids: string[], side: 'start' | 'end', newAmpEdge: number, sequence: string, tm: number | null) => void;
  onClose: () => void;
}

/** Maps a primer's own PLUS-STRAND genomic span (`gStart <= gEnd`, both
 * inclusive) onto a `gene`-region `Selection` within `data.gene_seq` -
 * strand-aware, so it's correct even when the gene transcript is on the
 * minus strand (where `gene_seq` is already reverse-complemented relative
 * to the plus strand, and local coordinate order runs opposite to genomic
 * order - `localGenePos` handles that reversal, `min`/`max` here just
 * keeps `start <= end` regardless of which endpoint that puts first).
 * `bindingSeq` is always read directly from `gene_seq` (ground truth for
 * whatever's actually there); `primerSeq` is the primer's own known real
 * sequence - their relationship (equal on a plus-strand gene, reverse
 * complements of each other on a minus-strand one) is exactly what
 * `SequenceViewer`'s existing `isReverseStrand` drag logic already
 * expects, so no special-casing is needed beyond building this correctly.
 * Returns `null` if either endpoint falls outside `data`'s exon span. */
function buildPrimerSelection(data: SequenceData, gStart: number, gEnd: number, primerSeq: string): Selection | null {
  const a = localGenePos(data, gStart);
  const b = localGenePos(data, gEnd);
  if (a === null || b === null) return null;
  const start = Math.min(a, b);
  const end = Math.max(a, b) + 1;
  return { region: 'gene', start, end, primerSeq, bindingSeq: data.gene_seq.substring(start, end), source: 'manual' };
}

/** The inverse of `localGenePos`: a 0-based local `gene_seq` position back
 * to a plus-strand genomic one. Needed because after a drag,
 * `SequenceViewer` reports the new span in `data`'s own local coordinates
 * - and `data.gene_seq` is the *gene's* sequence, not the amplicon's own
 * window, so it can't be converted via `amplicon.intervalStart` the way
 * the old (pre-whole-gene) version of this modal did. */
function genomicFromLocal(data: SequenceData, local: number): number {
  return data.strand === '-' ? data.gene_end_genomic - local : data.gene_start_genomic + local;
}

/** Full per-amplicon detail view, opened by clicking (not dragging) an
 * amplicon bar's body on the map: the *whole gene's* sequence map (same
 * fetch-and-best-transcript logic as `SnpGeneMapModal.tsx`, via the
 * shared `useGeneSequence` hook) scrolled to this amplicon on open, so
 * scrolling up/down shows where it sits in the gene's real exon/intron
 * structure - not just the amplicon's own short window in isolation. Both
 * primers are draggable `geneForward`/`geneReverse` selections (exactly
 * like the main Primerool pipeline's own sequence-map primer editing,
 * resize-capable and auto-re-analyzed - distinct from the amplicon map's
 * own edge-drag, which preserves primer length instead). Below the map:
 * both primers' sequence/Tm/length, amplicon length, and their secondary
 * structures (`PrimerStructurePanel` - the same breakdown a primer-segment
 * click opens standalone). */
export default function AmpliconDetailModal({ amplicon, onPrimerEdit, onClose }: Props) {
  const [truncateIntrons, setTruncateIntrons] = useState(true);
  const [liveSelections, setLiveSelections] = useState<Selections>(EMPTY_SELECTIONS);
  const [liveFor, setLiveFor] = useState<string | null>(null);

  // Frozen at whatever this amplicon's bounds were the moment it was
  // opened (keyed by its own rsID, not the live `amplicon` object) - NOT
  // recomputed from `amplicon.ampStart`/`ampEnd` on every render. Those
  // shift every time a primer drag below commits, and `useGeneSequence`
  // refetches whenever `requiredPositions` changes - without freezing this,
  // every drag would re-run the whole gene/transcript search and reload
  // the sequence map out from under the user, instead of only the
  // secondary structures and amplicon length actually needing to update.
  const openKey = amplicon ? (amplicon.variants[0]?.rsid ?? null) : null;
  const [requiredPositions, setRequiredPositions] = useState<number[]>([]);
  const [requiredPositionsFor, setRequiredPositionsFor] = useState<string | null>(null);
  if (openKey !== requiredPositionsFor) {
    setRequiredPositions(amplicon ? [amplicon.ampStart, amplicon.ampEnd, ...amplicon.variants.map((v) => v.position)] : []);
    setRequiredPositionsFor(openKey);
  }

  const { data, error, transcripts, switching, switchTranscript, loading } = useGeneSequence(amplicon?.gene ?? null, requiredPositions);

  const fwdSel = data && amplicon ? buildPrimerSelection(data, amplicon.ampStart, amplicon.ampStart + amplicon.fwd.sequence.length - 1, amplicon.fwd.sequence) : null;
  const revSel = data && amplicon ? buildPrimerSelection(data, amplicon.ampEnd - amplicon.rev.sequence.length + 1, amplicon.ampEnd, amplicon.rev.sequence) : null;
  const baseSelections: Selections = { ...EMPTY_SELECTIONS, geneForward: fwdSel, geneReverse: revSel };

  // Render-time reset (React's documented "derive state from props"
  // pattern, not an effect) whenever a different amplicon/transcript loads,
  // or the parent's data changes after a commit below re-renders this with
  // fresh props - see `SequenceViewer.tsx`'s own `prevData`/`prevSearchKey`
  // for the same shape.
  const liveKey = data && amplicon ? `${data.transcript_id}:${amplicon.rsid}:${amplicon.ampStart}:${amplicon.ampEnd}:${amplicon.fwd.sequence}:${amplicon.rev.sequence}` : null;
  if (liveKey !== liveFor) {
    setLiveSelections(baseSelections);
    setLiveFor(liveKey);
  }

  // Scrolls to this amplicon's first variant once its gene loads (or a
  // different transcript is picked) - keyed on stable ids, not the
  // `amplicon`/`data` object references themselves, so an unrelated
  // re-render elsewhere in the app can't yank the user's own scroll
  // position back here mid-browse.
  useEffect(() => {
    if (!data || !amplicon) return;
    const rsid = amplicon.variants[0]?.rsid;
    if (!rsid) return;
    const el = document.querySelector(`[data-variant-rsid="${CSS.escape(rsid)}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.transcript_id, amplicon?.rsid]);

  function handleSelect(key: keyof Selections, value: Selection) {
    setLiveSelections((prev) => ({ ...prev, [key]: value }));
    if (!amplicon || !data || value.analysis === undefined) return; // still awaiting SequenceViewer's own recompute
    const groupRsids = amplicon.variants.map((v) => v.rsid);
    // Both endpoints go through `genomicFromLocal` and are then min/max'd,
    // not assumed start<end, because local order runs opposite to genomic
    // order on a minus-strand gene (see `buildPrimerSelection`'s doc).
    // `ampStart`/`ampEnd` are always plus-strand genomic positions
    // regardless of which strand the gene transcript itself is on.
    const gA = genomicFromLocal(data, value.start);
    const gB = genomicFromLocal(data, value.end - 1);
    const gSpanStart = Math.min(gA, gB);
    const gSpanEnd = Math.max(gA, gB);
    if (key === 'geneForward') {
      onPrimerEdit(groupRsids, 'start', gSpanStart, value.primerSeq, value.analysis?.tm ?? null);
    } else if (key === 'geneReverse') {
      onPrimerEdit(groupRsids, 'end', gSpanEnd, value.primerSeq, value.analysis?.tm ?? null);
    }
  }

  const variantMarkers: VariantMarker[] = data
    ? (amplicon?.variants
        .map((v): VariantMarker | null => {
          const local = localGenePos(data, v.position);
          if (local === null) return null;
          return { rsid: v.rsid, start: local, end: local + 1, alleles: v.alleles };
        })
        .filter((m): m is VariantMarker => m !== null) ?? [])
    : [];

  return (
    <Modal open={amplicon !== null} onClose={onClose} title={amplicon ? `${amplicon.rsid} - amplicon detail (${amplicon.gene})` : ''}>
      {loading && <p className="text-sm text-ink-muted">Loading {amplicon?.gene}'s sequence…</p>}
      {error && (
        <div role="alert" className="mb-3 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">
          {error}
        </div>
      )}
      {data && amplicon && (
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-ink-muted">
              Drag the highlighted primer spans to reposition or resize them (same interactive editing as the main gene workflow) - each drag is re-analyzed automatically and written back to the
              results table. Scroll to see where this amplicon sits in the gene.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Checkbox label="Truncate introns" checked={truncateIntrons} onChange={(e) => setTruncateIntrons(e.target.checked)} />
              {transcripts.length > 1 && (
                <label className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
                  Transcript:
                  <Select size="sm" value={data.transcript_id} disabled={switching} onChange={(e) => void switchTranscript(e.target.value)}>
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
          </div>

          <SequenceViewer data={data} selections={liveSelections} truncateIntrons={truncateIntrons} onSelect={handleSelect} variantMarkers={variantMarkers} />

          <div className="mt-5 grid grid-cols-1 gap-3 border-t border-line pt-4 sm:grid-cols-3">
            <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted">
              <div className="mb-1 font-medium uppercase tracking-wider text-ink-faint">Forward</div>
              <div className="break-all font-mono text-ink">{amplicon.fwd.sequence}</div>
              <div className="mt-1">
                {amplicon.fwd.sequence.length} bp &middot; {fmt(amplicon.fwd.tm)}&deg;C
              </div>
            </div>
            <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted">
              <div className="mb-1 font-medium uppercase tracking-wider text-ink-faint">Reverse</div>
              <div className="break-all font-mono text-ink">{amplicon.rev.sequence}</div>
              <div className="mt-1">
                {amplicon.rev.sequence.length} bp &middot; {fmt(amplicon.rev.tm)}&deg;C
              </div>
            </div>
            <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted">
              <div className="mb-1 font-medium uppercase tracking-wider text-ink-faint">Amplicon</div>
              <div className="font-mono text-ink">{amplicon.productSize} bp</div>
              <div className="mt-1 font-mono tabular-nums">
                {amplicon.chrom}:{amplicon.ampStart.toLocaleString()}-{amplicon.ampEnd.toLocaleString()}
              </div>
            </div>
          </div>

          <div className="mt-5 border-t border-line pt-4">
            <PrimerStructurePanel pair={{ forward: amplicon.fwd.sequence, reverse: amplicon.rev.sequence }} />
          </div>
        </div>
      )}
    </Modal>
  );
}
