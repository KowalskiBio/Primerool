import { useRef, useState } from 'react';

export interface PlacedAmplicon {
  /** Display label - one rsID for an ordinary amplicon, `+`-joined for one
   * produced by merging nearby SNPs into a single shared primer pair (see
   * `SnpBatchPanel.tsx`'s merge-distance setting). */
  rsid: string;
  gene: string;
  chrom: string;
  ampStart: number;
  ampEnd: number;
  productSize: number;
  /** Genomic position of `refSeq[0]` - lets any base within the amplicon
   * be looked up by its genomic coordinate (`refSeq[pos - intervalStart]`). */
  intervalStart: number;
  /** The full reference window (upstream flank + reference allele +
   * downstream flank, or - for a merged group - all member blocks'
   * windows spliced together, see `combineBlockWindows`) - always a
   * superset of `[ampStart, ampEnd]`, since the amplicon is designed from
   * within that same window. */
  refSeq: string;
  /** One entry per SNP this amplicon actually covers - a single-element
   * array for an ordinary amplicon, more for a merged one. Each gets its
   * own tick mark (or, at base resolution, its own highlighted base). */
  variants: { rsid: string; position: number; alleles: string[] }[];
  /** The forward primer occupying the bar's left end and the reverse
   * primer occupying its right end - each drawn as a distinct segment
   * sized to its actual length (so it's visible at a glance), doubling as
   * that segment's click/drag target (see `onPrimerClick`/`onEdgeDrag`),
   * and passed whole to `onAmpliconClick` for the detail view. */
  fwd: { sequence: string; tm: number | null };
  rev: { sequence: string; tm: number | null };
}

interface Props {
  amplicons: PlacedAmplicon[];
  /** rsid -> rsIDs of other designed amplicons it genomically overlaps. */
  overlaps: Record<string, string[]>;
  /** Fired once, on mouseup, after dragging an amplicon's start or end
   * primer segment far enough to count as a resize (see
   * `CLICK_DRAG_THRESHOLD_PX`) - `genomicPos` is the (integer) genomic
   * coordinate dropped on. The caller owns recomputing the actual primer/
   * Tm for that edge (see `SnpBatchPanel.tsx`'s `handleManualEdgeEdit`);
   * this component only reports the gesture. Omitted entirely disables
   * every draggable/clickable affordance on the map (no caller ready to
   * act on them). */
  onEdgeDrag?: (rsid: string, side: 'start' | 'end', genomicPos: number) => void;
  /** Fired on a plain click (mouse didn't move past the drag threshold) on
   * a primer segment - `side` says which end (`'start'` = forward,
   * `'end'` = reverse). The caller looks up that primer's actual sequence
   * to show its structure (see `SnpBatchPanel.tsx`'s `handlePrimerClick`). */
  onPrimerClick?: (rsid: string, side: 'start' | 'end') => void;
  /** Fired once, on mouseup, after dragging an amplicon bar's own body
   * (not an edge) - `deltaBp` is the signed shift to apply to both ends.
   * `startRsid`/`endRsid` are the group's own leftmost/rightmost member
   * (see the same note on `onEdgeDrag`'s handles). */
  onAmpliconMove?: (startRsid: string, endRsid: string, deltaBp: number) => void;
  /** Fired on a plain click (not a drag) on an amplicon bar's own body -
   * the whole clicked amplicon, for a caller to open a detail view (see
   * `SnpBatchPanel.tsx`'s `AmpliconDetailModal`). */
  onAmpliconClick?: (amplicon: PlacedAmplicon) => void;
}

interface ViewState {
  start: number;
  end: number;
}

const WIDTH = 1000;
const MARGIN = 20;
const TRACK_HEIGHT = 22;
const ROW_HEIGHT = 11;
const RULER_GAP = 20;
/** Rough SVG-unit width per character at the 9px label font - used only to
 * greedily pack labels into non-overlapping rows/spacing, not for
 * pixel-perfect layout. */
const CHAR_WIDTH = 5.4;
const MIN_TICK_LABEL_GAP = 14;
/** The smallest region a drag-to-zoom can select - keeps a near-zero-width
 * drag from producing a degenerate view. */
const MIN_ZOOM_BP = 5;
/** Every "Zoom in"/"Zoom out" click multiplies/divides the view span by
 * this - a drag is still there for jumping straight to an arbitrary
 * region, but reaching base resolution from a wide overview by dragging
 * alone means selecting a span just a few screen pixels wide, which is
 * unreliable with a mouse. A handful of clicks gets there deterministically. */
const ZOOM_STEP_FACTOR = 2.5;
/** Amplicons more than this far apart (same chromosome) never end up on the
 * same track - each gets its own, locally-scaled one instead. This is what
 * keeps a lone, far-flung SNP's amplicon a legible box rather than a
 * hairline sliver on a track sized for its whole gene's scattered SNPs. */
const CLUSTER_GAP_BP = 2000;
/** Below this many screen px per base pair, a letter wouldn't be legible
 * anyway - above it, show the actual reference bases instead of a plain
 * colored bar. */
const MIN_PX_PER_BP_FOR_BASES = 10;
/** A primer segment never renders (or hit-tests) narrower than this many
 * SVG units, however short it is in actual bp at the current zoom - a
 * sub-pixel-wide target would be unclickable and undraggable. */
const MIN_PRIMER_SEGMENT_PX = 8;
/** How far the mouse has to move (in real screen pixels, not SVG units)
 * before a mousedown-then-mouseup on a primer segment or a bar's body
 * counts as a drag (resize/move) instead of a click (inspect) - small
 * enough that a deliberate drag never reads as a click, large enough that
 * a hand that isn't perfectly still during a click doesn't accidentally
 * start one. */
const CLICK_DRAG_THRESHOLD_PX = 4;

function baseAt(items: PlacedAmplicon[], pos: number): { base: string; owner: PlacedAmplicon } | null {
  for (const it of items) {
    if (pos >= it.ampStart && pos <= it.ampEnd) {
      const base = it.refSeq[pos - it.intervalStart];
      if (base) return { base, owner: it };
    }
  }
  return null;
}

function clusterAmplicons(amplicons: PlacedAmplicon[]): PlacedAmplicon[][] {
  const sorted = [...amplicons].sort((a, b) => (a.chrom === b.chrom ? a.ampStart - b.ampStart : a.chrom.localeCompare(b.chrom)));
  const clusters: PlacedAmplicon[][] = [];
  let clusterEnd = -Infinity;
  for (const a of sorted) {
    const current = clusters[clusters.length - 1];
    if (current && current[0].chrom === a.chrom && a.ampStart - clusterEnd <= CLUSTER_GAP_BP) {
      current.push(a);
      clusterEnd = Math.max(clusterEnd, a.ampEnd);
    } else {
      clusters.push([a]);
      clusterEnd = a.ampEnd;
    }
  }
  return clusters;
}

/** Picks a "nice" (1/2/5 × 10^n) tick step that keeps adjacent tick labels
 * at least `minPxGap` apart on screen, however many digits the genomic
 * coordinates need - a fixed step (as a plain fraction of the view span)
 * looks fine for small numbers but overlaps once positions run into the
 * hundreds of millions. */
function pickTickStep(pxPerBp: number, minPxGap: number): number {
  const rawStep = minPxGap / pxPerBp;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / magnitude;
  const niceMultiplier = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10;
  return Math.max(1, niceMultiplier * magnitude);
}

function estimateLabelWidth(value: number): number {
  const digits = Math.round(Math.abs(value)).toLocaleString().length;
  return digits * CHAR_WIDTH;
}

function ClusterTrack({
  items,
  overlaps,
  onEdgeDrag,
  onPrimerClick,
  onAmpliconMove,
  onAmpliconClick,
}: {
  items: PlacedAmplicon[];
  overlaps: Record<string, string[]>;
  onEdgeDrag?: Props['onEdgeDrag'];
  onPrimerClick?: Props['onPrimerClick'];
  onAmpliconMove?: Props['onAmpliconMove'];
  onAmpliconClick?: Props['onAmpliconClick'];
}) {
  const minPos = Math.min(...items.map((i) => i.ampStart));
  const maxPos = Math.max(...items.map((i) => i.ampEnd));
  const span = Math.max(1, maxPos - minPos);
  const pad = Math.max(50, span * 0.15);
  const naturalStart = minPos - pad;
  const naturalEnd = maxPos + pad;

  const [view, setView] = useState<ViewState>({ start: naturalStart, end: naturalEnd });
  const [drag, setDrag] = useState<{ startBp: number; currentBp: number } | null>(null);
  const [edgeDrag, setEdgeDrag] = useState<{ rsid: string; side: 'start' | 'end'; currentBp: number } | null>(null);
  const [moveDrag, setMoveDrag] = useState<{ rsid: string; deltaBp: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const zoomed = view.start !== naturalStart || view.end !== naturalEnd;
  const viewLen = view.end - view.start;
  const pxPerBp = (WIDTH - 2 * MARGIN) / viewLen;
  const scale = (bp: number) => ((bp - view.start) / viewLen) * (WIDTH - 2 * MARGIN) + MARGIN;
  const bpFromClientX = (clientX: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * WIDTH - MARGIN;
    return (x / (WIDTH - 2 * MARGIN)) * viewLen + view.start;
  };
  const isVisible = (s: number, e: number) => !(e < view.start || s > view.end);

  function resetZoom() {
    setView({ start: naturalStart, end: naturalEnd });
  }

  function zoomBy(factor: number) {
    const center = (view.start + view.end) / 2;
    const naturalLen = naturalEnd - naturalStart;
    const newLen = Math.min(naturalLen, Math.max(MIN_ZOOM_BP, viewLen / factor));
    let start = center - newLen / 2;
    let end = start + newLen;
    if (start < naturalStart) {
      start = naturalStart;
      end = start + newLen;
    } else if (end > naturalEnd) {
      end = naturalEnd;
      start = end - newLen;
    }
    setView({ start, end });
  }

  /** Drag-to-zoom-to-region - right mouse button only (left is reserved for
   * moving/resizing/inspecting an amplicon's own bar, see `startBodyDrag`/
   * `startPrimerHandle`). */
  function handleMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    if (e.button !== 2) return;
    e.preventDefault();
    const startBp = Math.max(view.start, Math.min(view.end, bpFromClientX(e.clientX)));
    setDrag({ startBp, currentBp: startBp });

    const onMove = (ev: MouseEvent) => {
      const bp = Math.max(view.start, Math.min(view.end, bpFromClientX(ev.clientX)));
      setDrag((d) => (d ? { ...d, currentBp: bp } : d));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setDrag((d) => {
        if (d) {
          const start = Math.min(d.startBp, d.currentBp);
          const end = Math.max(d.startBp, d.currentBp);
          if (end - start >= MIN_ZOOM_BP) setView({ start, end });
        }
        return null;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /** Starts interacting with one primer segment (the forward primer's
   * segment at a bar's left end, or the reverse primer's at its right) -
   * left button only; `stopPropagation` keeps this from also triggering
   * `startBodyDrag`'s whole-bar move on the same mousedown. Resolves on
   * mouseup into either a click (`onPrimerClick`, mouse never moved past
   * `CLICK_DRAG_THRESHOLD_PX`) or a resize drag (`onEdgeDrag`) - the same
   * gesture serves both because a primer segment's whole visible span
   * *is* that primer, so "grab it and move it" and "click it to inspect
   * it" are both natural readings of interacting with it directly. */
  function startPrimerHandle(e: React.MouseEvent<SVGRectElement>, rsid: string, side: 'start' | 'end') {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startClientX = e.clientX;
    setEdgeDrag({ rsid, side, currentBp: bpFromClientX(e.clientX) });
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - startClientX) > CLICK_DRAG_THRESHOLD_PX) moved = true;
      setEdgeDrag((d) => (d ? { ...d, currentBp: bpFromClientX(ev.clientX) } : d));
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setEdgeDrag(null);
      if (moved) {
        onEdgeDrag?.(rsid, side, Math.round(bpFromClientX(ev.clientX)));
      } else {
        onPrimerClick?.(rsid, side);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /** Starts interacting with an amplicon bar's own body (not a primer
   * segment) - left button only. Resolves on mouseup into either a click
   * (`onAmpliconClick`, opens the detail view - mouse never moved past
   * `CLICK_DRAG_THRESHOLD_PX`) or a move drag (`onAmpliconMove`, shifts
   * both primers by the same distance) - same click-vs-drag disambiguation
   * as `startPrimerHandle`. A live preview translates the bar's whole `<g>`
   * during a move (see `moveDrag`'s use in the render below) without
   * touching any real data until mouseup. */
  function startBodyDrag(e: React.MouseEvent<SVGRectElement>, it: PlacedAmplicon) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startClientX = e.clientX;
    const startBp = bpFromClientX(e.clientX);
    setMoveDrag({ rsid: it.rsid, deltaBp: 0 });
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - startClientX) > CLICK_DRAG_THRESHOLD_PX) moved = true;
      const bp = bpFromClientX(ev.clientX);
      setMoveDrag((d) => (d ? { ...d, deltaBp: bp - startBp } : d));
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setMoveDrag(null);
      if (moved) {
        const bp = bpFromClientX(ev.clientX);
        const delta = Math.round(bp - startBp);
        if (delta !== 0 && it.variants.length > 0) {
          onAmpliconMove?.(it.variants[0].rsid, it.variants[it.variants.length - 1].rsid, delta);
        }
      } else {
        onAmpliconClick?.(it);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const visibleItems = items.filter((it) => isVisible(it.ampStart, it.ampEnd));

  // Greedy row-packing so rsID labels never overlap: sort by horizontal
  // position, then place each in the lowest row whose last label doesn't
  // collide with it. Labels are anchored to each item's own marker
  // (variant position) rather than the bar's midpoint, so a stacked label
  // still sits directly above (or connects via a leader line to) the exact
  // tick it names - the bar's midpoint can be well off the variant when
  // primers land asymmetrically around it.
  const bars = visibleItems.map((it) => {
    const x1 = Math.max(MARGIN, scale(it.ampStart));
    const x2raw = Math.min(WIDTH - MARGIN, scale(it.ampEnd));
    const x2 = Math.max(x2raw, x1 + 2);
    // The two primer segments - clamped to at least `MIN_PRIMER_SEGMENT_PX`
    // wide (for clickability) and to never cross past the bar's own far
    // edge (a primer longer than the whole visible bar at this zoom just
    // fills it) or past each other (a bar barely wider than MIN_ZOOM_BP).
    const fwdX1 = x1;
    const fwdX2 = Math.min(x2, Math.max(x1 + MIN_PRIMER_SEGMENT_PX, scale(it.ampStart + it.fwd.sequence.length)));
    const revX2 = x2;
    const revX1 = Math.max(fwdX2, Math.min(x2 - MIN_PRIMER_SEGMENT_PX, scale(it.ampEnd - it.rev.sequence.length + 1)));
    // One marker per variant this amplicon covers (more than one for a
    // merged group) - only those currently in view get a screen position.
    const markers = it.variants
      .filter((v) => v.position >= view.start && v.position <= view.end)
      .map((v) => ({ variant: v, x: Math.max(MARGIN, Math.min(WIDTH - MARGIN, scale(v.position))) }));
    const labelX = markers.length > 0 ? markers[0].x : (x1 + x2) / 2;
    const halfLabelWidth = (it.rsid.length * CHAR_WIDTH) / 2;
    return { item: it, x1, x2, fwdX1, fwdX2, revX1, revX2, markers, labelX, halfLabelWidth };
  });
  const sortedByLabelX = [...bars].sort((a, b) => a.labelX - b.labelX);
  const rowEnds: number[] = [];
  const rowOf = new Map<string, number>();
  for (const b of sortedByLabelX) {
    let row = 0;
    while (row < rowEnds.length && b.labelX - b.halfLabelWidth < rowEnds[row] + 4) row++;
    rowEnds[row] = b.labelX + b.halfLabelWidth;
    rowOf.set(b.item.rsid, row);
  }
  const maxRow = Math.max(0, ...rowOf.values());
  const labelAreaHeight = (maxRow + 1) * ROW_HEIGHT + 4;

  const trackY = labelAreaHeight + 4;
  const rulerY = trackY + TRACK_HEIGHT + RULER_GAP;
  const height = rulerY + 20;

  const showBases = pxPerBp >= MIN_PX_PER_BP_FOR_BASES;
  const baseCells: { pos: number; base: string; owner: PlacedAmplicon }[] = [];
  if (showBases && visibleItems.length > 0) {
    const from = Math.max(Math.ceil(view.start), Math.min(...visibleItems.map((i) => i.ampStart)));
    const to = Math.min(Math.floor(view.end), Math.max(...visibleItems.map((i) => i.ampEnd)));
    for (let pos = from; pos <= to; pos++) {
      const hit = baseAt(visibleItems, pos);
      if (hit) baseCells.push({ pos, ...hit });
    }
  }

  // Ruler ticks: a "nice" step guaranteed to keep labels from overlapping
  // regardless of how many digits these genomic coordinates need.
  const worstLabelWidth = Math.max(estimateLabelWidth(view.start), estimateLabelWidth(view.end));
  const tickStep = pickTickStep(pxPerBp, worstLabelWidth + MIN_TICK_LABEL_GAP);
  const startTick = Math.ceil(view.start / tickStep) * tickStep;
  const ticks: number[] = [];
  for (let t = startTick; t <= view.end; t += tickStep) ticks.push(t);

  const snpCount = items.reduce((n, it) => n + it.variants.length, 0);
  return (
    <div className="mb-4 last:mb-0">
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs font-semibold text-ink">
          {[...new Set(items.map((i) => i.gene))].join(' / ')}{' '}
          <span className="font-normal text-ink-faint">
            ({snpCount} SNP{snpCount > 1 ? 's' : ''} on {items[0].chrom}
            {items.length !== snpCount ? `, ${items.length} amplicon${items.length > 1 ? 's' : ''}` : ''}) - {items.map((it) => `${it.rsid} (${it.productSize} bp)`).join(', ')}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] tabular-nums text-ink-faint">showing {Math.round(viewLen).toLocaleString()} bp</span>
          <button onClick={() => zoomBy(1 / ZOOM_STEP_FACTOR)} title="Zoom out" aria-label="Zoom out" className="h-5 w-5 rounded border border-line-strong bg-surface leading-none text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
            −
          </button>
          <button onClick={() => zoomBy(ZOOM_STEP_FACTOR)} title="Zoom in" aria-label="Zoom in" className="h-5 w-5 rounded border border-line-strong bg-surface leading-none text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
            +
          </button>
          {zoomed && (
            <button onClick={resetZoom} className="rounded border border-line-strong bg-surface px-2 py-0.5 text-[10px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
              Reset zoom
            </button>
          )}
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-base">
        <svg ref={svgRef} width="100%" viewBox={`0 0 ${WIDTH} ${height}`} style={{ fontFamily: 'var(--font-sans)' }} onMouseDown={handleMouseDown} onContextMenu={(e) => e.preventDefault()}>
          <line x1={MARGIN} y1={trackY + TRACK_HEIGHT / 2} x2={WIDTH - MARGIN} y2={trackY + TRACK_HEIGHT / 2} stroke="var(--line-strong)" strokeWidth={1} />

          {bars.map(({ item: it, x1, x2, fwdX1, fwdX2, revX1, revX2, markers, labelX }) => {
            const w = Math.max(2, x2 - x1);
            const overlapsWith = overlaps[it.rsid] || [];
            const hasOverlap = overlapsWith.length > 0;
            const fill = hasOverlap ? 'var(--danger)' : 'var(--success)';
            const stroke = hasOverlap ? 'var(--danger)' : 'var(--success)';
            const row = rowOf.get(it.rsid) ?? 0;
            const labelY = trackY - 6 - row * ROW_HEIGHT;
            const startRsid = it.variants[0].rsid;
            const endRsid = it.variants[it.variants.length - 1].rsid;
            const moving = moveDrag?.rsid === it.rsid;
            const moveDx = moving ? moveDrag.deltaBp * pxPerBp : 0;
            const bodyInteractive = Boolean(onAmpliconMove || onAmpliconClick);
            const showPrimerSegments = Boolean(onEdgeDrag || onPrimerClick);
            const showFwdLabel = showPrimerSegments && fwdX2 - fwdX1 >= 18;
            const showRevLabel = showPrimerSegments && revX2 - revX1 >= 18;
            return (
              <g key={it.rsid} transform={moving ? `translate(${moveDx}, 0)` : undefined}>
                <rect
                  x={x1}
                  y={trackY}
                  width={w}
                  height={TRACK_HEIGHT}
                  fill={fill}
                  opacity={showBases ? 0.25 : 0.75}
                  stroke={stroke}
                  strokeWidth={1}
                  rx={2}
                  style={bodyInteractive ? { cursor: moving ? 'grabbing' : 'pointer' } : undefined}
                  onMouseDown={bodyInteractive ? (e) => startBodyDrag(e, it) : undefined}
                >
                  <title>
                    {`${it.rsid} (${it.gene})\n${it.variants.map((v) => `${v.rsid} @ ${it.chrom}:${v.position.toLocaleString()} (${v.alleles.join('/')})`).join('\n')}\nAmplicon: ${it.ampStart.toLocaleString()}-${it.ampEnd.toLocaleString()} (${it.productSize} bp)${bodyInteractive ? '\nClick to see full detail; drag to move the whole amplicon' : ''}`}
                    {hasOverlap ? `\nOverlaps: ${overlapsWith.join(', ')}` : '\nNo overlap with another designed amplicon'}
                  </title>
                </rect>
                {!showBases &&
                  markers.map(({ variant, x }) => (
                    <line key={variant.rsid} x1={x} y1={trackY - 3} x2={x} y2={trackY + TRACK_HEIGHT + 3} stroke="var(--ink)" strokeWidth={1.5} pointerEvents="none">
                      <title>{`${variant.rsid} variant @ ${it.chrom}:${variant.position.toLocaleString()}`}</title>
                    </line>
                  ))}
                {/* A stacked (row > 0) label sits further above the track, so
                 * without a leader line it's ambiguous which marker it names
                 * once two ticks are close enough to need separate rows - it
                 * points at the first (leftmost) visible variant. */}
                {row > 0 && markers.length > 0 && <line x1={labelX} y1={labelY + 2} x2={markers[0].x} y2={trackY - 3} stroke="var(--ink-faint)" strokeWidth={1} strokeDasharray="2,2" pointerEvents="none" />}
                <text x={labelX} y={labelY} fontSize={9} fill="var(--ink-muted)" textAnchor="middle" pointerEvents="none">
                  {it.rsid}
                </text>
                {showPrimerSegments && (
                  <>
                    {/* For a merged amplicon, the shared forward primer was
                     * anchored to the *leftmost* member and the shared
                     * reverse primer to the *rightmost* (see `runBatch`'s
                     * merged design path) - each segment must pass that
                     * specific rsID, not `it.rsid`'s joined display label. */}
                    <rect x={fwdX1} y={trackY} width={Math.max(1, fwdX2 - fwdX1)} height={TRACK_HEIGHT} fill="var(--seq-primer-ink)" opacity={0.45} style={{ cursor: 'ew-resize' }} onMouseDown={(e) => startPrimerHandle(e, startRsid, 'start')}>
                      <title>{`Forward primer - ${it.fwd.sequence.length} bp - click to view its secondary structure, drag to reposition`}</title>
                    </rect>
                    <rect x={revX1} y={trackY} width={Math.max(1, revX2 - revX1)} height={TRACK_HEIGHT} fill="var(--seq-primer-ink)" opacity={0.45} style={{ cursor: 'ew-resize' }} onMouseDown={(e) => startPrimerHandle(e, endRsid, 'end')}>
                      <title>{`Reverse primer - ${it.rev.sequence.length} bp - click to view its secondary structure, drag to reposition`}</title>
                    </rect>
                    {showFwdLabel && (
                      <text x={(fwdX1 + fwdX2) / 2} y={trackY + TRACK_HEIGHT + 11} fontSize={8} fill="var(--ink-faint)" textAnchor="middle" pointerEvents="none">
                        {it.fwd.sequence.length}bp
                      </text>
                    )}
                    {showRevLabel && (
                      <text x={(revX1 + revX2) / 2} y={trackY + TRACK_HEIGHT + 11} fontSize={8} fill="var(--ink-faint)" textAnchor="middle" pointerEvents="none">
                        {it.rev.sequence.length}bp
                      </text>
                    )}
                  </>
                )}
              </g>
            );
          })}

          {showBases &&
            baseCells.map(({ pos, base, owner }) => {
              const cellX1 = scale(pos);
              const cellX2 = scale(pos + 1);
              const cx = (cellX1 + cellX2) / 2;
              const hitVariant = owner.variants.find((v) => v.position === pos);
              const isVariant = hitVariant !== undefined;
              return (
                <g key={pos} pointerEvents="none">
                  {isVariant && <rect x={cellX1} y={trackY} width={Math.max(1, cellX2 - cellX1)} height={TRACK_HEIGHT} fill="var(--warning)" opacity={0.55} />}
                  <text x={cx} y={trackY + TRACK_HEIGHT / 2 + 4} fontSize={11} fontFamily="var(--font-mono, monospace)" fontWeight={isVariant ? 'bold' : 'normal'} fill={isVariant ? 'var(--warning)' : 'var(--ink)'} textAnchor="middle">
                    {base}
                  </text>
                  {hitVariant && <title>{`${hitVariant.rsid} @ ${owner.chrom}:${pos.toLocaleString()}\nAlleles: ${hitVariant.alleles.join('/')} (reference base shown here: ${base})`}</title>}
                </g>
              );
            })}

          {drag &&
            (() => {
              const s = Math.min(drag.startBp, drag.currentBp);
              const e = Math.max(drag.startBp, drag.currentBp);
              if (e - s <= 0) return null;
              const x1 = Math.max(MARGIN, scale(s));
              const x2 = Math.min(WIDTH - MARGIN, scale(e));
              const w = Math.max(1, x2 - x1);
              return (
                <>
                  <rect x={x1} y={trackY} width={w} height={TRACK_HEIGHT} fill="var(--accent-subtle)" stroke="var(--accent)" strokeWidth={1} pointerEvents="none" />
                  <text x={x1 + w / 2} y={trackY + TRACK_HEIGHT / 2 + 4} fontSize={10} fill="var(--accent)" textAnchor="middle" fontWeight="bold" pointerEvents="none">
                    {Math.round(e - s)} bp
                  </text>
                </>
              );
            })()}

          {edgeDrag &&
            items.some((it) => it.variants.some((v) => v.rsid === edgeDrag.rsid)) &&
            (() => {
              const x = scale(edgeDrag.currentBp);
              if (x < MARGIN || x > WIDTH - MARGIN) return null;
              return (
                <g pointerEvents="none">
                  <line x1={x} y1={trackY - 8} x2={x} y2={trackY + TRACK_HEIGHT + 8} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="3,2" />
                  <text x={x} y={trackY - 10} fontSize={9} fill="var(--accent)" textAnchor="middle" fontWeight="bold">
                    {Math.round(edgeDrag.currentBp).toLocaleString()}
                  </text>
                </g>
              );
            })()}

          <line x1={MARGIN} y1={rulerY} x2={WIDTH - MARGIN} y2={rulerY} stroke="var(--ink-muted)" strokeWidth={1} />
          {ticks.map((t, i) => {
            const x = scale(t);
            if (x > WIDTH - MARGIN || x < MARGIN) return null;
            return (
              <g key={i}>
                <line x1={x} y1={rulerY} x2={x} y2={rulerY + 5} stroke="var(--ink-muted)" strokeWidth={1} />
                <text x={x} y={rulerY + 15} fontSize={9} fill="var(--ink-muted)" textAnchor="middle">
                  {Math.round(t).toLocaleString()}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/** One small genomic track per *proximity cluster* (not per gene - a gene's
 * SNPs scattered across tens of kb would otherwise all share one track
 * scaled to that whole span, making every amplicon a sub-pixel sliver).
 * Amplicons more than `CLUSTER_GAP_BP` apart always get their own track,
 * scaled to their own span. Amplicons that overlap another designed
 * amplicon render red instead of green; rsID labels are packed into rows
 * so close-together SNPs' names never overlap (with a leader line back to
 * their own tick once stacked); use the +/− buttons (reliable, since
 * dragging a several-pixel-wide selection is not) or right-drag a
 * sub-region directly to zoom in. Below ~10px/bp a dark tick marks the
 * exact variant position; above it, the amplicon bar fades and the actual
 * reference bases are drawn instead, with the variant's own base
 * highlighted amber. A darker segment at each end of a bar is that
 * primer's own footprint. */
export default function SnpAmpliconMap({ amplicons, overlaps, onEdgeDrag, onPrimerClick, onAmpliconMove, onAmpliconClick }: Props) {
  if (!amplicons.length) return null;
  const clusters = clusterAmplicons(amplicons);
  const bodyInteractive = Boolean(onAmpliconMove || onAmpliconClick);
  const primerInteractive = Boolean(onEdgeDrag || onPrimerClick);

  return (
    <div>
      <p className="mb-3 text-xs text-ink-muted">
        Each bar is one designed amplicon, scaled per cluster of nearby SNPs (each &gt;{CLUSTER_GAP_BP.toLocaleString()} bp from its neighbors gets its own, separately-scaled track) - each
        track's header lists its own rsID(s) and amplicon length(s) next to the gene name.{' '}
        <span className="font-medium text-success">Green</span> = no overlap with another designed amplicon; <span className="font-medium text-danger">red</span> = overlaps one.{' '}
        <span className="font-medium text-accent">Darker ends</span> mark each primer's own length. Zoomed in close enough, the actual reference bases are shown, with the variant's own base
        highlighted <span className="font-medium text-warning">amber</span>. Use a track's +/− buttons, or right-click-drag across it, to zoom; "Reset zoom" backs out to the overview.
        {bodyInteractive && (
          <>
            {' '}
            Click a bar's middle (not an end) for its full detail view - an editable sequence map, both primers, and their structures; drag it instead to move the whole amplicon (both primers
            shift and are re-analyzed).
          </>
        )}
        {primerInteractive && (
          <>
            {' '}
            Drag a primer's own end to resize just it; click it without dragging to see its <span className="font-medium text-accent">hairpin/dimer structure</span> directly. A moved or resized
            primer is marked <span className="font-medium text-accent">★ manual</span> in the results table above.
          </>
        )}
      </p>
      {clusters.map((items) => (
        <ClusterTrack key={items.map((i) => i.rsid).join(',')} items={items} overlaps={overlaps} onEdgeDrag={onEdgeDrag} onPrimerClick={onPrimerClick} onAmpliconMove={onAmpliconMove} onAmpliconClick={onAmpliconClick} />
      ))}
    </div>
  );
}
