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
}

interface Props {
  amplicons: PlacedAmplicon[];
  /** rsid -> rsIDs of other designed amplicons it genomically overlaps. */
  overlaps: Record<string, string[]>;
  /** Fired once, on mouseup, after dragging an amplicon's start or end
   * handle - `genomicPos` is the (integer) genomic coordinate dropped on.
   * The caller owns recomputing the actual primer/Tm for that edge (see
   * `SnpBatchPanel.tsx`'s `handleManualEdgeEdit`); this component only
   * reports the gesture. Omitted entirely disables the drag handles. */
  onEdgeDrag?: (rsid: string, side: 'start' | 'end', genomicPos: number) => void;
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

/** How many SVG units wide each edge's invisible drag hit-area is - wider
 * than the bar's own 1px stroke so it's actually grabbable with a mouse. */
const EDGE_HANDLE_WIDTH = 6;

function ClusterTrack({ items, overlaps, onEdgeDrag }: { items: PlacedAmplicon[]; overlaps: Record<string, string[]>; onEdgeDrag?: Props['onEdgeDrag'] }) {
  const minPos = Math.min(...items.map((i) => i.ampStart));
  const maxPos = Math.max(...items.map((i) => i.ampEnd));
  const span = Math.max(1, maxPos - minPos);
  const pad = Math.max(50, span * 0.15);
  const naturalStart = minPos - pad;
  const naturalEnd = maxPos + pad;

  const [view, setView] = useState<ViewState>({ start: naturalStart, end: naturalEnd });
  const [drag, setDrag] = useState<{ startBp: number; currentBp: number } | null>(null);
  const [edgeDrag, setEdgeDrag] = useState<{ rsid: string; side: 'start' | 'end'; currentBp: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const zoomed = view.start !== naturalStart || view.end !== naturalEnd;
  const viewLen = view.end - view.start;
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

  function handleMouseDown(e: React.MouseEvent<SVGSVGElement>) {
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

  /** Starts dragging one amplicon's start or end handle - `stopPropagation`
   * keeps this from also triggering `handleMouseDown`'s drag-to-zoom on the
   * same mousedown. Reports the final position via `onEdgeDrag` on mouseup;
   * this component itself has no idea what a valid primer position is
   * (that's `SnpBatchPanel.tsx`'s `handleManualEdgeEdit`), so nothing here
   * is clamped beyond the view's own visible range. */
  function startEdgeDrag(e: React.MouseEvent<SVGRectElement>, rsid: string, side: 'start' | 'end') {
    e.preventDefault();
    e.stopPropagation();
    const startBp = bpFromClientX(e.clientX);
    setEdgeDrag({ rsid, side, currentBp: startBp });

    const onMove = (ev: MouseEvent) => {
      setEdgeDrag((d) => (d ? { ...d, currentBp: bpFromClientX(ev.clientX) } : d));
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      onEdgeDrag?.(rsid, side, Math.round(bpFromClientX(ev.clientX)));
      setEdgeDrag(null);
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
    // One marker per variant this amplicon covers (more than one for a
    // merged group) - only those currently in view get a screen position.
    const markers = it.variants
      .filter((v) => v.position >= view.start && v.position <= view.end)
      .map((v) => ({ variant: v, x: Math.max(MARGIN, Math.min(WIDTH - MARGIN, scale(v.position))) }));
    const labelX = markers.length > 0 ? markers[0].x : (x1 + x2) / 2;
    const halfLabelWidth = (it.rsid.length * CHAR_WIDTH) / 2;
    return { item: it, x1, x2, markers, labelX, halfLabelWidth };
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

  const pxPerBp = (WIDTH - 2 * MARGIN) / viewLen;
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
          {[...new Set(items.map((i) => i.gene))].join(' / ')} <span className="font-normal text-ink-faint">({snpCount} SNP{snpCount > 1 ? 's' : ''} on {items[0].chrom}{items.length !== snpCount ? `, ${items.length} amplicon${items.length > 1 ? 's' : ''}` : ''})</span>
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
        <svg ref={svgRef} width="100%" viewBox={`0 0 ${WIDTH} ${height}`} style={{ fontFamily: 'var(--font-sans)', cursor: 'crosshair' }} onMouseDown={handleMouseDown}>
          <line x1={MARGIN} y1={trackY + TRACK_HEIGHT / 2} x2={WIDTH - MARGIN} y2={trackY + TRACK_HEIGHT / 2} stroke="var(--line-strong)" strokeWidth={1} />

          {bars.map(({ item: it, x1, x2, markers, labelX }) => {
            const w = Math.max(2, x2 - x1);
            const overlapsWith = overlaps[it.rsid] || [];
            const hasOverlap = overlapsWith.length > 0;
            const fill = hasOverlap ? 'var(--danger)' : 'var(--success)';
            const stroke = hasOverlap ? 'var(--danger)' : 'var(--success)';
            const row = rowOf.get(it.rsid) ?? 0;
            const labelY = trackY - 6 - row * ROW_HEIGHT;
            return (
              <g key={it.rsid}>
                <rect x={x1} y={trackY} width={w} height={TRACK_HEIGHT} fill={fill} opacity={showBases ? 0.25 : 0.75} stroke={stroke} strokeWidth={1} rx={2}>
                  <title>
                    {`${it.rsid} (${it.gene})\n${it.variants.map((v) => `${v.rsid} @ ${it.chrom}:${v.position.toLocaleString()} (${v.alleles.join('/')})`).join('\n')}\nAmplicon: ${it.ampStart.toLocaleString()}-${it.ampEnd.toLocaleString()} (${it.productSize} bp)`}
                    {hasOverlap ? `\nOverlaps: ${overlapsWith.join(', ')}` : '\nNo overlap with another designed amplicon'}
                  </title>
                </rect>
                {!showBases &&
                  markers.map(({ variant, x }) => (
                    <line key={variant.rsid} x1={x} y1={trackY - 3} x2={x} y2={trackY + TRACK_HEIGHT + 3} stroke="var(--ink)" strokeWidth={1.5}>
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
                {onEdgeDrag && (
                  <>
                    {/* For a merged amplicon, the shared forward primer was
                     * anchored to the *leftmost* member and the shared
                     * reverse primer to the *rightmost* (see `runBatch`'s
                     * merged design path) - `handleManualEdgeEdit` looks
                     * the block back up by rsID, so each handle must pass
                     * that specific one, not `it.rsid`'s joined label. */}
                    <rect
                      x={x1 - EDGE_HANDLE_WIDTH / 2}
                      y={trackY - 2}
                      width={EDGE_HANDLE_WIDTH}
                      height={TRACK_HEIGHT + 4}
                      fill="transparent"
                      style={{ cursor: 'ew-resize' }}
                      onMouseDown={(e) => startEdgeDrag(e, it.variants[0].rsid, 'start')}
                    >
                      <title>{`Drag to move ${it.rsid}'s forward-primer position`}</title>
                    </rect>
                    <rect
                      x={x2 - EDGE_HANDLE_WIDTH / 2}
                      y={trackY - 2}
                      width={EDGE_HANDLE_WIDTH}
                      height={TRACK_HEIGHT + 4}
                      fill="transparent"
                      style={{ cursor: 'ew-resize' }}
                      onMouseDown={(e) => startEdgeDrag(e, it.variants[it.variants.length - 1].rsid, 'end')}
                    >
                      <title>{`Drag to move ${it.rsid}'s reverse-primer position`}</title>
                    </rect>
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
                <g key={pos}>
                  {isVariant && <rect x={cellX1} y={trackY} width={Math.max(1, cellX2 - cellX1)} height={TRACK_HEIGHT} fill="var(--warning)" opacity={0.55} />}
                  <text x={cx} y={trackY + TRACK_HEIGHT / 2 + 4} fontSize={11} fontFamily="var(--font-mono, monospace)" fontWeight={isVariant ? 'bold' : 'normal'} fill={isVariant ? 'var(--warning)' : 'var(--ink)'} textAnchor="middle" pointerEvents="none">
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
 * dragging a several-pixel-wide selection is not) or drag a sub-region
 * directly to zoom in. Below ~10px/bp a dark tick marks the exact variant
 * position; above it, the amplicon bar fades and the actual reference
 * bases are drawn instead, with the variant's own base highlighted amber. */
export default function SnpAmpliconMap({ amplicons, overlaps, onEdgeDrag }: Props) {
  if (!amplicons.length) return null;
  const clusters = clusterAmplicons(amplicons);

  return (
    <div>
      <p className="mb-3 text-xs text-ink-muted">
        Each bar is one designed amplicon, scaled per cluster of nearby SNPs (each &gt;{CLUSTER_GAP_BP.toLocaleString()} bp from its neighbors gets its own, separately-scaled track).{' '}
        <span className="font-medium text-success">Green</span> = no overlap with another designed amplicon; <span className="font-medium text-danger">red</span> = overlaps one. Use a track's
        +/− buttons to zoom in or out, or drag across it to jump straight to a region; "Reset zoom" backs out to the overview. Zoomed in close enough, the actual reference bases are shown, with the variant's own base highlighted{' '}
        <span className="font-medium text-warning">amber</span>.
        {onEdgeDrag && (
          <>
            {' '}
            Drag a bar's own start or end (cursor turns to <span className="font-mono">↔</span>) to reposition that primer - it's re-analyzed for the new spot and marked{' '}
            <span className="font-medium text-accent">★ manual</span> in the results table above.
          </>
        )}
      </p>
      {clusters.map((items) => (
        <ClusterTrack key={items.map((i) => i.rsid).join(',')} items={items} overlaps={overlaps} onEdgeDrag={onEdgeDrag} />
      ))}
    </div>
  );
}
