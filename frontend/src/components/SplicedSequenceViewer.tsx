import { useMemo, useRef } from 'react';
import type { SequenceData } from '../api/sequence';
import type { Selection, Selections } from '../utils/regionMapping';
import { genomicToSpliced } from '../utils/regionMapping';
import { describeGenePosition, useBaseHover } from './BaseHoverTooltip';
import { useMapPickMenu } from './useMapPickMenu';
import { useMapDragSelect } from './useMapDragSelect';

interface Span {
  start: number;
  end: number;
  className: string;
  /** Which pick this span renders, when it belongs to one - emitted as
   * `data-pick-key` so a right-click on it opens the pick's own menu
   * (BLAST / secondary structures). */
  pickKey?: keyof Selections;
}

interface Piece {
  kind: 'label' | 'text';
  text: string;
  className?: string;
  /** Index into `spliced_exons_seq` of a text piece's first character. */
  start?: number;
  pickKey?: keyof Selections;
}

function collectSplicedSpans(data: SequenceData, sel: Selections): Span[] {
  const spans: Span[] = [];
  const addDirect = (p: Selection | null, className: string, key: keyof Selections) => {
    if (p && p.region === 'spliced') spans.push({ start: p.start, end: p.end, className, pickKey: key });
  };
  addDirect(sel.juncLeft, 'seq-primer', 'juncLeft');
  addDirect(sel.juncRight, 'seq-primer', 'juncRight');
  // A junction pair's second primer may sit in the gene instead (e.g. in an
  // intron - see `mapPickMenu`'s junction rule); show whatever part of it
  // lies on exons.
  for (const [p, key] of [
    [sel.juncLeft, 'juncLeft'],
    [sel.juncRight, 'juncRight'],
  ] as const) {
    if (p && p.region !== 'spliced') for (const r of genomicToSpliced(p, data)) spans.push({ ...r, className: 'seq-primer', pickKey: key });
  }

  const addMapped = (p: Selection | null, className: string, key: keyof Selections) => {
    for (const r of genomicToSpliced(p, data)) spans.push({ ...r, className, pickKey: key });
  };
  addMapped(sel.geneForward, 'seq-primer', 'geneForward');
  addMapped(sel.geneReverse, 'seq-primer', 'geneReverse');
  addMapped(sel.geneProbe, 'seq-probe', 'geneProbe');
  addMapped(sel.wgaForward, 'seq-primer', 'wgaForward');
  addMapped(sel.wgaReverse, 'seq-primer', 'wgaReverse');
  addMapped(sel.armsRefPrimer, 'seq-primer', 'armsRefPrimer');
  addMapped(sel.armsAltPrimer, 'seq-primer', 'armsAltPrimer');
  addMapped(sel.armsCommon, 'seq-primer', 'armsCommon');

  return spans.sort((a, b) => a.start - b.start);
}

function sliceWithHighlights(spliced: string, a: number, b: number, spans: Span[]): Piece[] {
  const relevant = spans.filter((sp) => sp.end > a && sp.start < b).sort((x, y) => x.start - y.start);
  const pieces: Piece[] = [];
  let cur = a;
  for (const sp of relevant) {
    const s = Math.max(a, sp.start);
    const e = Math.min(b, sp.end);
    if (s > cur) pieces.push({ kind: 'text', text: spliced.substring(cur, s), start: cur });
    if (e > s) {
      pieces.push({ kind: 'text', text: spliced.substring(s, e), className: sp.className, start: s, pickKey: sp.pickKey });
      cur = e;
    }
  }
  if (cur < b) pieces.push({ kind: 'text', text: spliced.substring(cur, b), start: cur });
  return pieces;
}

interface Props {
  data: SequenceData;
  selections: Selections;
  /** Enables junction-primer picks from the right-click menu. */
  onSelect?: (key: keyof Selections, value: Selection | null) => void;
}

/** Here exons are already joined, so the only pick that fits is a junction
 * primer (general/ARMS/probe picks belong on the genomic map). */
const EXON_MAP_PICKS = ['junction'] as const;

export default function SplicedSequenceViewer({ data, selections, onSelect }: Props) {
  const pieces = useMemo(() => {
    const spliced = data.spliced_exons_seq || '';
    const spans = collectSplicedSpans(data, selections);
    const jPos = (data.junctions || [])
      .map((j) => j.pos)
      .filter((x) => Number.isFinite(x))
      .sort((a, b) => a - b);

    const out: Piece[] = [];
    let last = 0;
    let exonNum = 1;
    for (const jp of jPos) {
      const a = last;
      const b = Math.min(jp, spliced.length);
      out.push({ kind: 'label', text: `Exon ${exonNum} (${b - a} bp)` });
      out.push(...sliceWithHighlights(spliced, a, b, spans));
      exonNum++;
      last = b;
    }
    if (last < spliced.length) {
      out.push({ kind: 'label', text: `Exon ${exonNum} (${spliced.length - last} bp)` });
      out.push(...sliceWithHighlights(spliced, last, spliced.length, spans));
    }
    return out;
  }, [data, selections]);

  // Exon spans in `gene_seq` coordinates, in transcript order, so a hovered
  // spliced index can be traced back to its gene position. Only when
  // `gene_seq` includes the introns (the exon annotations are then in its
  // coordinates) and the exons add up to exactly the spliced sequence -
  // otherwise just the transcript position is shown.
  const exonSpans = useMemo(() => {
    if (!data.include_introns) return null;
    const exons = (data.annotations || [])
      .filter((a) => a.type === 'exon')
      .map((a) => [a.start, a.end] as const)
      .sort((x, y) => x[0] - y[0]);
    const total = exons.reduce((n, [s, e]) => n + (e - s), 0);
    return total === (data.spliced_exons_seq || '').length ? exons : null;
  }, [data]);

  const pickMenu = useMapPickMenu({ data, selections, onSelect, pickKinds: EXON_MAP_PICKS });
  const containerRef = useRef<HTMLDivElement>(null);
  const dragSelect = useMapDragSelect({ containerRef });

  const { handlers: hoverHandlers, tooltip } = useBaseHover(({ pos, base }) => {
    const transcriptLine = `transcript position ${(pos + 1).toLocaleString('en-US')}`;
    if (!exonSpans) return [`${base.toUpperCase()} · ${transcriptLine}`];
    let offset = pos;
    for (let k = 0; k < exonSpans.length; k++) {
      const [s, e] = exonSpans[k];
      if (offset < e - s) return describeGenePosition(data, s + offset, base, `exon ${k + 1} · ${transcriptLine}`);
      offset -= e - s;
    }
    return null;
  }, !pickMenu.busy && !dragSelect.active);

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-ink">Spliced exon-only map (for exon-exon junction primers)</h3>
      <div className="mb-3 rounded-md border border-line bg-surface-2 p-2 text-sm text-ink-muted">
        Junction positions in the sequence map refer to these sequences. Horizontal bars indicate exon boundaries.
      </div>
      <div
        ref={containerRef}
        className="sequence-viewer max-h-[520px] overflow-y-auto rounded-lg border border-line bg-base p-4 text-sm"
        {...hoverHandlers}
        onMouseDown={dragSelect.onMouseDown}
        onContextMenu={pickMenu.onContextMenu}
      >
        {pieces.map((p, i) =>
          p.kind === 'label' ? (
            <span key={i} className="exon-label">
              {p.text}
            </span>
          ) : (
            <span key={i} className={p.className} data-region="spliced" data-pos={p.start} data-pick-key={p.pickKey}>
              {p.text}
            </span>
          ),
        )}
        {/* After the pieces, never before: the first exon label's
            `:first-child` style drops its top border/margin, so anything
            rendered ahead of it (a tooltip on hover) would shift the whole
            map down under the pointer, hide the tooltip, and shift it back. */}
        {tooltip}
        {dragSelect.overlay}
      </div>
      {pickMenu.overlay}
    </div>
  );
}
