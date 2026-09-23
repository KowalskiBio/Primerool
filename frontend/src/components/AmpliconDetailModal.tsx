import { useState } from 'react';
import type { PlacedAmplicon } from './SnpAmpliconMap';
import type { SequenceData } from '../api/sequence';
import { EMPTY_SELECTIONS, type Selection, type Selections } from '../utils/regionMapping';
import Modal from './ui/Modal';
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

/** A flat, structure-free `SequenceData` wrapping one amplicon's own
 * reference window - `gene_seq` is the whole window, with no
 * upstream/downstream flank and no exon/intron annotations, so
 * `SequenceViewer` falls into its existing "custom pasted sequence"
 * rendering path (see `geneBlockSegments`'s no-annotations branch)
 * instead of needing a real gene-structure fetch. */
function buildSequenceData(amplicon: PlacedAmplicon): SequenceData {
  return {
    gene_name: amplicon.gene,
    transcript_id: 'custom',
    transcript_name: amplicon.rsid,
    chrom: amplicon.chrom,
    strand: '+',
    gene_start_genomic: amplicon.intervalStart,
    gene_end_genomic: amplicon.intervalStart + amplicon.refSeq.length - 1,
    upstream_len: 0,
    gene_len: amplicon.refSeq.length,
    downstream_len: 0,
    utr5_len: 0,
    upstream_seq: '',
    gene_seq: amplicon.refSeq,
    downstream_seq: '',
    spliced_seq: amplicon.refSeq,
    spliced_exons_seq: amplicon.refSeq,
    junctions: [],
    annotations: [],
    include_introns: false,
    include_utr: false,
  };
}

/** The current forward/reverse primers, expressed as `gene`-region
 * `Selection`s local to `buildSequenceData`'s `gene_seq` - draggable via
 * `SequenceViewer`'s existing `geneForward`/`geneReverse` editing, the
 * same mechanism the main gene workflow's manual-design panels use. */
function buildSelections(amplicon: PlacedAmplicon): Selections {
  const fwdStart = amplicon.ampStart - amplicon.intervalStart;
  const fwdEnd = fwdStart + amplicon.fwd.sequence.length;
  const revEnd = amplicon.ampEnd - amplicon.intervalStart + 1;
  const revStart = revEnd - amplicon.rev.sequence.length;
  return {
    ...EMPTY_SELECTIONS,
    geneForward: { region: 'gene', start: fwdStart, end: fwdEnd, primerSeq: amplicon.fwd.sequence, bindingSeq: amplicon.refSeq.substring(fwdStart, fwdEnd), source: 'manual' },
    geneReverse: { region: 'gene', start: revStart, end: revEnd, primerSeq: amplicon.rev.sequence, bindingSeq: amplicon.refSeq.substring(revStart, revEnd), source: 'manual' },
  };
}

/** Full per-amplicon detail view, opened by clicking (not dragging) an
 * amplicon bar's body on the map: an editable sequence map (drag either
 * primer's highlighted span to reposition/resize it, exactly like the
 * main Primerool pipeline's own sequence-map primer editing) with the
 * SNP(s) marked, both primers' sequence/Tm/length, and their secondary
 * structures below (`PrimerStructurePanel` - the same hairpin/self-dimer/
 * heterodimer breakdown a primer-segment click opens standalone). */
export default function AmpliconDetailModal({ amplicon, onPrimerEdit, onClose }: Props) {
  const [selections, setSelections] = useState<Selections>(EMPTY_SELECTIONS);
  const [selectionsFor, setSelectionsFor] = useState<string | null>(null);

  const key = amplicon ? `${amplicon.rsid}:${amplicon.ampStart}:${amplicon.ampEnd}:${amplicon.fwd.sequence}:${amplicon.rev.sequence}` : null;

  // Render-time reset (React's documented "derive state from props"
  // pattern, not an effect) whenever a different amplicon opens, or the
  // parent's data changes after a commit below re-renders this with fresh
  // props - see `SequenceViewer.tsx`'s own `prevData`/`prevSearchKey` for
  // the same shape.
  if (amplicon && key !== selectionsFor) {
    setSelections(buildSelections(amplicon));
    setSelectionsFor(key);
  }

  function handleSelect(selKey: keyof Selections, value: Selection) {
    setSelections((prev) => ({ ...prev, [selKey]: value }));
    if (!amplicon || value.analysis === undefined) return; // still awaiting SequenceViewer's own recompute
    const groupRsids = amplicon.variants.map((v) => v.rsid);
    if (selKey === 'geneForward') {
      onPrimerEdit(groupRsids, 'start', amplicon.intervalStart + value.start, value.primerSeq, value.analysis?.tm ?? null);
    } else if (selKey === 'geneReverse') {
      onPrimerEdit(groupRsids, 'end', amplicon.intervalStart + value.end - 1, value.primerSeq, value.analysis?.tm ?? null);
    }
  }

  const data = amplicon ? buildSequenceData(amplicon) : null;
  const variantMarkers: VariantMarker[] = amplicon ? amplicon.variants.map((v) => ({ rsid: v.rsid, start: v.position - amplicon.intervalStart, end: v.position - amplicon.intervalStart + 1, alleles: v.alleles })) : [];

  return (
    <Modal open={amplicon !== null} onClose={onClose} title={amplicon ? `${amplicon.rsid} - amplicon detail` : ''}>
      {data && amplicon && (
        <div>
          <p className="mb-3 text-xs text-ink-muted">
            Drag the highlighted forward/reverse primer spans below to reposition or resize them - the same interactive editing the main gene workflow's sequence map uses. Each drag is
            re-analyzed automatically and written back to the results table once released.
          </p>
          <SequenceViewer data={data} selections={selections} truncateIntrons={false} onSelect={handleSelect} variantMarkers={variantMarkers} />

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
