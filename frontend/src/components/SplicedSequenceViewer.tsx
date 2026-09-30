import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { SequenceData } from '../api/sequence';
import type { ProbeEditKey, Selection, Selections } from '../utils/regionMapping';
import { genomicToSpliced, selectionStrand } from '../utils/regionMapping';
import { reverseComplement } from '../utils/dna';
import { armsMutantTwin, withAlleleBase, type PickKind } from '../utils/mapPickMenu';
import type { MapPick } from '../utils/mapSelection';
import { computeDraggedInterval, type DragGeometry } from '../utils/dragInterval';
import { baseAtPoint, describeGenePosition, useBaseHover } from './BaseHoverTooltip';
import { useMapPickMenu } from './useMapPickMenu';
import { useMapDragSelect } from './useMapDragSelect';
import Button from './ui/Button';

interface Span {
  start: number;
  end: number;
  className: string;
  /** Which pick this span renders, when it belongs to one - emitted as
   * `data-pick-key` so a right-click on it opens the pick's own menu
   * (BLAST / secondary structures), and a drag on it moves the pick. */
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
  // Allele probes: the wild-type one paints the span they share, the
  // mutant twin shows only where it sticks out - same rule as the
  // sequence map, so the two maps never tell different stories.
  const wtProbeRanges = sel.geneProbe ? genomicToSpliced(sel.geneProbe, data) : [];
  for (const r of wtProbeRanges) spans.push({ ...r, className: 'seq-probe-wt', pickKey: 'geneProbe' });
  if (sel.geneProbeAlt) {
    const clip = wtProbeRanges.length > 0 ? { start: Math.min(...wtProbeRanges.map((r) => r.start)), end: Math.max(...wtProbeRanges.map((r) => r.end)) } : null;
    for (const r of genomicToSpliced(sel.geneProbeAlt, data)) {
      if (!clip) {
        spans.push({ ...r, className: 'seq-probe', pickKey: 'geneProbeAlt' });
        continue;
      }
      for (const [a, b] of [
        [r.start, Math.min(r.end, clip.start)],
        [Math.max(r.start, clip.end), r.end],
      ] as const) {
        if (b > a) spans.push({ start: a, end: b, className: 'seq-probe', pickKey: 'geneProbeAlt' });
      }
    }
  }
  addMapped(sel.wgaForward, 'seq-primer', 'wgaForward');
  addMapped(sel.wgaReverse, 'seq-primer', 'wgaReverse');
  addMapped(sel.armsRefPrimer, 'seq-primer', 'armsRefPrimer');
  addMapped(sel.armsAltPrimer, 'seq-primer', 'armsAltPrimer');
  addMapped(sel.armsCommon, 'seq-primer', 'armsCommon');

  return spans.sort((a, b) => a.start - b.start);
}

/** Cuts `[a, b)` of the spliced sequence into plain and highlighted pieces.
 * Overlapping spans (an ARMS mutant twin sits exactly on its wild-type
 * twin) are drawn once - the first span wins, as on the genomic map. */
function sliceWithHighlights(spliced: string, a: number, b: number, spans: Span[]): Piece[] {
  const relevant = spans.filter((sp) => sp.end > a && sp.start < b).sort((x, y) => x.start - y.start);
  const pieces: Piece[] = [];
  let cur = a;
  for (const sp of relevant) {
    const s = Math.max(cur, sp.start);
    const e = Math.min(b, sp.end);
    if (e <= s) continue;
    if (s > cur) pieces.push({ kind: 'text', text: spliced.substring(cur, s), start: cur });
    pieces.push({ kind: 'text', text: spliced.substring(s, e), className: sp.className, start: s, pickKey: sp.pickKey });
    cur = e;
  }
  if (cur < b) pieces.push({ kind: 'text', text: spliced.substring(cur, b), start: cur });
  return pieces;
}

/** One exon's stretch of `gene_seq` and of `spliced_exons_seq`. */
interface ExonSlot {
  gStart: number;
  gEnd: number;
  sStart: number;
  sEnd: number;
}

/** A pick the Exon map can drag: its span here and how far it may go,
 * and how to turn a new span back into the pick's own coordinates. */
interface Draggable {
  start: number;
  end: number;
  lo: number;
  hi: number;
  mustCover?: number;
  /** An ARMS twin's 3' end is locked on its SNP: only its 5' end drags. */
  onlyEdge?: 'left' | 'right';
  place: (start: number, end: number) => Pick<Selection, 'region' | 'start' | 'end' | 'primerSeq' | 'bindingSeq'>;
}

interface DragSession extends DragGeometry {
  key: keyof Selections;
}

/** Picks the Exon map lets you drag. The ARMS mutant twin and the mutant
 * allele probe aren't listed: they follow their wild-type partner. */
const DRAGGABLE_KEYS: (keyof Selections)[] = ['juncLeft', 'juncRight', 'geneForward', 'geneReverse', 'geneProbe', 'armsRefPrimer', 'armsCommon'];

interface Props {
  data: SequenceData;
  selections: Selections;
  /** Enables picks from the right-click menu and dragging picks. */
  onSelect?: (key: keyof Selections, value: Selection | null) => void;
  /** The one allele probe currently unlocked for dragging (picked in "My
   * primers" for the genomic map; the same lock applies here so the two
   * maps never disagree). Default null: both static. */
  probeEditable?: ProbeEditKey | null;
  /** Shows a "Hide exon map" button beside the heading, so the map can be
   * closed where it is instead of from the toggle above the sequence map. */
  onHide?: () => void;
}

/** A selection within one exon stands for the same gene stretch, so every
 * gene pick fits; one across a junction only makes a junction primer. WGA
 * primers belong in the flanks, which this map doesn't show. */
const EXON_MAP_PICKS: readonly PickKind[] = ['general', 'junction', 'arms', 'probe'];

export default function SplicedSequenceViewer({ data, selections, onSelect, probeEditable = null, onHide }: Props) {
  const interactive = Boolean(onSelect);
  const spliced = data.spliced_exons_seq || '';

  // Each exon's span in `gene_seq` and in the spliced sequence, in
  // transcript order - only when the exon annotations tile the spliced
  // sequence exactly (not in CDS-only mode, where they're CDS blocks), since
  // otherwise a spliced position can't be traced back to the gene.
  const exons = useMemo<ExonSlot[] | null>(() => {
    const ann = (data.annotations || [])
      .filter((a) => a.type === 'exon')
      .map((a) => [a.start, a.end] as const)
      .sort((x, y) => x[0] - y[0]);
    const slots: ExonSlot[] = [];
    let off = 0;
    for (const [s, e] of ann) {
      slots.push({ gStart: s, gEnd: e, sStart: off, sEnd: off + (e - s) });
      off += e - s;
    }
    return slots.length > 0 && off === spliced.length ? slots : null;
  }, [data, spliced.length]);

  /** The exon holding all of spliced `[start, end)`, if one does. */
  const exonOfSpliced = (start: number, end: number) => exons?.find((x) => start >= x.sStart && end <= x.sEnd) ?? null;
  /** The exon holding all of gene `[start, end)`, if one does. */
  const exonOfGene = (start: number, end: number) => exons?.find((x) => start >= x.gStart && end <= x.gEnd) ?? null;

  const draggables = useMemo(() => {
    const out = new Map<keyof Selections, Draggable>();
    if (!interactive) return out;
    for (const key of DRAGGABLE_KEYS) {
      const sel = selections[key];
      if (!sel) continue;
      // Allele probes drag one at a time, picked in "My primers" - an
      // unpicked grab would catch whichever twin renders on top.
      if ((key === 'geneProbe' || key === 'geneProbeAlt') && probeEditable !== key) continue;
      const reverse = selectionStrand(sel) === 'R';
      const primerOf = (slice: string) => (reverse ? reverseComplement(slice) : slice);
      const onlyEdge = sel.arms ? (reverse ? 'right' : 'left') : undefined;
      if (sel.region === 'spliced') {
        // A junction primer lives on the spliced transcript itself.
        out.set(key, {
          start: sel.start,
          end: sel.end,
          lo: 0,
          hi: spliced.length,
          onlyEdge,
          place: (start, end) => {
            const slice = spliced.substring(start, end).toUpperCase();
            return { region: 'spliced', start, end, bindingSeq: slice, primerSeq: primerOf(slice) };
          },
        });
      } else if (sel.region === 'gene') {
        // A gene pick drags within its own exon, so it stays one gene
        // stretch; one reaching into an intron isn't all shown here.
        const ex = exonOfGene(sel.start, sel.end);
        if (!ex) continue;
        const toSpliced = (g: number) => ex.sStart + (g - ex.gStart);
        const snp = sel.allele?.snpPos;
        out.set(key, {
          start: toSpliced(sel.start),
          end: toSpliced(sel.end),
          lo: ex.sStart,
          hi: ex.sEnd,
          mustCover: snp !== undefined && snp >= ex.gStart && snp < ex.gEnd ? toSpliced(snp) : undefined,
          onlyEdge,
          place: (start, end) => {
            const gStart = ex.gStart + (start - ex.sStart);
            const gEnd = ex.gStart + (end - ex.sStart);
            const slice = (data.gene_seq || '').substring(gStart, gEnd).toUpperCase();
            return { region: 'gene', start: gStart, end: gEnd, bindingSeq: slice, primerSeq: primerOf(slice) };
          },
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive, selections, data, spliced, exons, probeEditable]);

  const [drag, setDrag] = useState<DragSession | null>(null);
  const [deltaChars, setDeltaChars] = useState(0);
  // Read at mouseup instead of `deltaChars`, so the commit (which calls
  // `onSelect` and fires an analysis) never runs inside a state updater -
  // same reasoning as `SequenceViewer`'s drag.
  const deltaCharsRef = useRef(0);

  const liveDrag = drag ? { key: drag.key, ...computeDraggedInterval(drag, deltaChars, draggables.get(drag.key)!.lo, draggables.get(drag.key)!.hi) } : null;

  const pieces = useMemo(() => {
    let spans = collectSplicedSpans(data, selections);
    // Mid-drag, the dragged pick (and the ARMS mutant twin riding on it) is
    // drawn at its live span instead.
    if (liveDrag) {
      const riders = new Set<keyof Selections>([liveDrag.key, ...(liveDrag.key === 'armsRefPrimer' ? (['armsAltPrimer'] as const) : [])]);
      spans = spans.filter((sp) => !sp.pickKey || !riders.has(sp.pickKey));
      spans.push({ start: liveDrag.start, end: liveDrag.end, className: liveDrag.key === 'geneProbe' ? 'seq-probe-wt' : 'seq-primer', pickKey: liveDrag.key });
      spans.sort((a, b) => a.start - b.start);
    }
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
  }, [data, selections, spliced, liveDrag?.key, liveDrag?.start, liveDrag?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  // A selection within one exon is the same stretch of the gene - hand the
  // menu gene coordinates so it offers general/ARMS/probe picks too.
  function translatePick(pick: MapPick): MapPick {
    if (pick.kind !== 'contiguous' || pick.region !== 'spliced') return pick;
    const ex = exonOfSpliced(pick.start, pick.end);
    if (!ex) return pick;
    return { kind: 'contiguous', region: 'gene', start: ex.gStart + (pick.start - ex.sStart), end: ex.gStart + (pick.end - ex.sStart) };
  }

  const pickMenu = useMapPickMenu({ data, selections, onSelect, pickKinds: EXON_MAP_PICKS, translatePick });
  const commitSelection = pickMenu.commitSelection;
  const containerRef = useRef<HTMLDivElement>(null);
  const dragSelect = useMapDragSelect({ containerRef });

  function commitDrag(session: DragSession, finalDelta: number) {
    if (finalDelta === 0) return; // a click with no drag - leave the pick alone
    const sel = selections[session.key];
    const d = draggables.get(session.key);
    if (!sel || !d) return;
    const { start, end } = computeDraggedInterval(session, finalDelta, d.lo, d.hi);
    if (start === d.start && end === d.end) return;
    const next: Selection = { ...sel, ...d.place(start, end), source: 'manual', analysis: undefined };
    // The mutant probe is edited independently of its wild-type partner,
    // but `place()` rebuilt its sequence from bare template - re-stamp the
    // allele base at the SNP.
    commitSelection(session.key, session.key === 'geneProbeAlt' ? withAlleleBase(next) : next);
    // The ARMS mutant twin differs only at its 3' base, so it follows.
    if (session.key === 'armsRefPrimer' && next.arms && selections.armsAltPrimer) {
      commitSelection('armsAltPrimer', armsMutantTwin(next, selections.armsAltPrimer.name));
    }
  }

  useEffect(() => {
    if (!drag) return;
    let lastX = 0;
    let lastY = 0;
    // The base under the pointer - off the sequence (a gap, an exon label)
    // keeps the last position rather than snapping back.
    function track() {
      const hit = baseAtPoint(lastX, lastY);
      if (!hit || hit.region !== 'spliced') return;
      const next = hit.pos - drag!.anchorPos;
      deltaCharsRef.current = next;
      setDeltaChars(next);
    }
    function onMove(e: MouseEvent) {
      lastX = e.clientX;
      lastY = e.clientY;
      track();
    }
    // Wheel-scrolling mid-drag moves the sequence under a still pointer.
    function onScroll() {
      if (lastX || lastY) track();
    }
    function onUp() {
      commitDrag(drag!, deltaCharsRef.current);
      deltaCharsRef.current = 0;
      setDeltaChars(0);
      setDrag(null);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('scroll', onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  function startDrag(e: React.MouseEvent<HTMLSpanElement>, key: keyof Selections, type: DragSession['type']) {
    // Left button only - a right-click must reach the container's menu.
    if (e.button !== 0) return;
    const d = draggables.get(key);
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    setDrag({ key, type, anchorPos: Number(e.currentTarget.dataset.pos), initStart: d.start, initEnd: d.end, mustCover: d.mustCover });
    setDeltaChars(0);
  }

  const { handlers: hoverHandlers, tooltip } = useBaseHover(
    ({ pos, base }) => {
      const transcriptLine = `transcript position ${(pos + 1).toLocaleString('en-US')}`;
      const ex = data.include_introns ? exonOfSpliced(pos, pos + 1) : null;
      if (!ex) return [`${base.toUpperCase()} · ${transcriptLine}`];
      return describeGenePosition(data, ex.gStart + (pos - ex.sStart), base, `exon ${exons!.indexOf(ex) + 1} · ${transcriptLine}`);
    },
    drag === null && !pickMenu.busy && !dragSelect.active,
  );

  /** A pick's bases, one span each, carrying its move/resize handles. */
  function renderDraggable(p: Piece, i: number, key: keyof Selections) {
    const d = draggables.get(key)!;
    const first = drag?.key === key ? liveDrag!.start : d.start;
    const last = (drag?.key === key ? liveDrag!.end : d.end) - 1;
    return Array.from(p.text).map((ch, ci) => {
      const pos = p.start! + ci;
      const type: DragSession['type'] = pos === first ? 'left' : pos === last ? 'right' : 'move';
      const locked = d.onlyEdge !== undefined && type !== d.onlyEdge;
      return (
        <span
          key={`${i}-${ci}`}
          className={`${p.className ?? ''} ${locked ? '' : type === 'move' ? 'cursor-grab' : 'cursor-ew-resize'}`}
          data-region="spliced"
          data-pos={pos}
          data-pick-key={key}
          onMouseDown={locked ? undefined : (e) => startDrag(e, key, type)}
        >
          {ch}
        </span>
      );
    });
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">Spliced exon-only map (for exon-exon junction primers)</h3>
        {onHide && (
          <Button size="sm" onClick={onHide}>
            Hide exon map
          </Button>
        )}
      </div>
      <div className="mb-3 rounded-md border border-line bg-surface-2 p-2 text-sm text-ink-muted">
        Junction positions in the sequence map refer to these sequences. Horizontal bars indicate exon boundaries. Drag a primer or probe to move it, or its end to resize it.
      </div>
      <div
        ref={containerRef}
        className={`sequence-viewer max-h-[520px] overflow-y-auto rounded-lg border border-line bg-base p-4 text-sm ${drag ? 'cursor-grabbing select-none' : ''}`}
        {...hoverHandlers}
        onMouseDown={dragSelect.onMouseDown}
        onContextMenu={pickMenu.onContextMenu}
      >
        {pieces.map((p, i) =>
          p.kind === 'label' ? (
            <span key={i} className="exon-label">
              {p.text}
            </span>
          ) : p.pickKey && draggables.has(p.pickKey) ? (
            <Fragment key={i}>{renderDraggable(p, i, p.pickKey)}</Fragment>
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
