import { useRef, useState } from 'react';

export interface PlacedAmplicon {
  rsid: string;
  gene: string;
  chrom: string;
  position: number;
  ampStart: number;
  ampEnd: number;
  productSize: number;
}

interface Props {
  amplicons: PlacedAmplicon[];
  /** rsid -> rsIDs of other designed amplicons it genomically overlaps. */
  overlaps: Record<string, string[]>;
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
/** Rough SVG-unit width per character at the 9px label font — used only to
 * greedily pack labels into non-overlapping rows/spacing, not for
 * pixel-perfect layout. */
const CHAR_WIDTH = 5.4;
const MIN_TICK_LABEL_GAP = 14;
/** The smallest region a drag-to-zoom can select — keeps a near-zero-width
 * drag from producing a degenerate view. */
const MIN_ZOOM_BP = 5;
/** Every "Zoom in"/"Zoom out" click multiplies/divides the view span by
 * this — a drag is still there for jumping straight to an arbitrary
 * region, but reaching base resolution from a wide overview by dragging
 * alone means selecting a span just a few screen pixels wide, which is
 * unreliable with a mouse. A handful of clicks gets there deterministically. */
const ZOOM_STEP_FACTOR = 2.5;
/** Amplicons more than this far apart (same chromosome) never end up on the
 * same track — each gets its own, locally-scaled one instead. This is what
 * keeps a lone, far-flung SNP's amplicon a legible box rather than a
 * hairline sliver on a track sized for its whole gene's scattered SNPs. */
const CLUSTER_GAP_BP = 2000;

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
 * coordinates need — a fixed step (as a plain fraction of the view span)
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

function ClusterTrack({ items, overlaps }: { items: PlacedAmplicon[]; overlaps: Record<string, string[]> }) {
  const minPos = Math.min(...items.map((i) => i.ampStart));
  const maxPos = Math.max(...items.map((i) => i.ampEnd));
  const span = Math.max(1, maxPos - minPos);
  const pad = Math.max(50, span * 0.15);
  const naturalStart = minPos - pad;
  const naturalEnd = maxPos + pad;

  const [view, setView] = useState<ViewState>({ start: naturalStart, end: naturalEnd });
  const [drag, setDrag] = useState<{ startBp: number; currentBp: number } | null>(null);
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

  const visibleItems = items.filter((it) => isVisible(it.ampStart, it.ampEnd));

  // Greedy row-packing so rsID labels never overlap: sort by horizontal
  // position, then place each in the lowest row whose last label doesn't
  // collide with it. Labels are anchored to each item's own marker
  // (variant position) rather than the bar's midpoint, so a stacked label
  // still sits directly above (or connects via a leader line to) the exact
  // tick it names — the bar's midpoint can be well off the variant when
  // primers land asymmetrically around it.
  const bars = visibleItems.map((it) => {
    const x1 = Math.max(MARGIN, scale(it.ampStart));
    const x2raw = Math.min(WIDTH - MARGIN, scale(it.ampEnd));
    const x2 = Math.max(x2raw, x1 + 2);
    const markerX = it.position >= view.start && it.position <= view.end ? Math.max(MARGIN, Math.min(WIDTH - MARGIN, scale(it.position))) : null;
    const labelX = markerX ?? (x1 + x2) / 2;
    const halfLabelWidth = (it.rsid.length * CHAR_WIDTH) / 2;
    return { item: it, x1, x2, markerX, labelX, halfLabelWidth };
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

  // Ruler ticks: a "nice" step guaranteed to keep labels from overlapping
  // regardless of how many digits these genomic coordinates need.
  const pxPerBp = (WIDTH - 2 * MARGIN) / viewLen;
  const worstLabelWidth = Math.max(estimateLabelWidth(view.start), estimateLabelWidth(view.end));
  const tickStep = pickTickStep(pxPerBp, worstLabelWidth + MIN_TICK_LABEL_GAP);
  const startTick = Math.ceil(view.start / tickStep) * tickStep;
  const ticks: number[] = [];
  for (let t = startTick; t <= view.end; t += tickStep) ticks.push(t);

  return (
    <div className="mb-4 last:mb-0">
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">
          {[...new Set(items.map((i) => i.gene))].join(' / ')} <span className="font-normal text-slate-400">— {items.length} SNP{items.length > 1 ? 's' : ''} on {items[0].chrom}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-slate-400">showing {Math.round(viewLen).toLocaleString()} bp</span>
          <button onClick={() => zoomBy(1 / ZOOM_STEP_FACTOR)} title="Zoom out" className="text-[10px] w-5 h-5 leading-none bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded border border-slate-300 dark:border-slate-600 transition-colors">
            −
          </button>
          <button onClick={() => zoomBy(ZOOM_STEP_FACTOR)} title="Zoom in" className="text-[10px] w-5 h-5 leading-none bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded border border-slate-300 dark:border-slate-600 transition-colors">
            +
          </button>
          {zoomed && (
            <button onClick={resetZoom} className="text-[10px] bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 transition-colors">
              Reset zoom
            </button>
          )}
        </div>
      </div>
      <div className="overflow-hidden border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800">
        <svg ref={svgRef} width="100%" viewBox={`0 0 ${WIDTH} ${height}`} style={{ fontFamily: 'var(--font-sans)', cursor: 'crosshair' }} onMouseDown={handleMouseDown}>
          <line x1={MARGIN} y1={trackY + TRACK_HEIGHT / 2} x2={WIDTH - MARGIN} y2={trackY + TRACK_HEIGHT / 2} stroke="#cbd5e1" strokeWidth={1} />

          {bars.map(({ item: it, x1, x2, markerX, labelX }) => {
            const w = Math.max(2, x2 - x1);
            const overlapsWith = overlaps[it.rsid] || [];
            const hasOverlap = overlapsWith.length > 0;
            const fill = hasOverlap ? '#ef4444' : '#22c55e';
            const stroke = hasOverlap ? '#b91c1c' : '#15803d';
            const row = rowOf.get(it.rsid) ?? 0;
            const labelY = trackY - 6 - row * ROW_HEIGHT;
            return (
              <g key={it.rsid}>
                <rect x={x1} y={trackY} width={w} height={TRACK_HEIGHT} fill={fill} opacity={0.75} stroke={stroke} strokeWidth={1} rx={2}>
                  <title>
                    {`${it.rsid} (${it.gene})\nVariant: ${it.chrom}:${it.position.toLocaleString()}\nAmplicon: ${it.ampStart.toLocaleString()}-${it.ampEnd.toLocaleString()} (${it.productSize} bp)`}
                    {hasOverlap ? `\nOverlaps: ${overlapsWith.join(', ')}` : '\nNo overlap with another designed amplicon'}
                  </title>
                </rect>
                {markerX !== null && (
                  <line x1={markerX} y1={trackY - 3} x2={markerX} y2={trackY + TRACK_HEIGHT + 3} stroke="#1e293b" strokeWidth={1.5}>
                    <title>{`${it.rsid} variant @ ${it.chrom}:${it.position.toLocaleString()}`}</title>
                  </line>
                )}
                {/* A stacked (row > 0) label sits further above the track, so
                 * without a leader line it's ambiguous which marker it names
                 * once two ticks are close enough to need separate rows. */}
                {row > 0 && markerX !== null && <line x1={labelX} y1={labelY + 2} x2={markerX} y2={trackY - 3} stroke="#94a3b8" strokeWidth={1} strokeDasharray="2,2" pointerEvents="none" />}
                <text x={labelX} y={labelY} fontSize={9} fill="#475569" textAnchor="middle" pointerEvents="none">
                  {it.rsid}
                </text>
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
                  <rect x={x1} y={trackY} width={w} height={TRACK_HEIGHT} fill="rgba(74, 222, 128, 0.2)" stroke="#22c55e" strokeWidth={1} pointerEvents="none" />
                  <text x={x1 + w / 2} y={trackY + TRACK_HEIGHT / 2 + 4} fontSize={10} fill="#15803d" textAnchor="middle" fontWeight="bold" pointerEvents="none">
                    {Math.round(e - s)} bp
                  </text>
                </>
              );
            })()}

          <line x1={MARGIN} y1={rulerY} x2={WIDTH - MARGIN} y2={rulerY} stroke="#334155" strokeWidth={1} />
          {ticks.map((t, i) => {
            const x = scale(t);
            if (x > WIDTH - MARGIN || x < MARGIN) return null;
            return (
              <g key={i}>
                <line x1={x} y1={rulerY} x2={x} y2={rulerY + 5} stroke="#334155" strokeWidth={1} />
                <text x={x} y={rulerY + 15} fontSize={9} fill="#334155" textAnchor="middle">
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

/** One small genomic track per *proximity cluster* (not per gene — a gene's
 * SNPs scattered across tens of kb would otherwise all share one track
 * scaled to that whole span, making every amplicon a sub-pixel sliver).
 * Amplicons more than `CLUSTER_GAP_BP` apart always get their own track,
 * scaled to their own span. Amplicons that overlap another designed
 * amplicon render red instead of green; a dark tick marks the exact
 * variant position inside each amplicon; rsID labels are packed into rows
 * so close-together SNPs' names never overlap (with a leader line back to
 * their own tick once stacked); use the +/− buttons (reliable, since
 * dragging a several-pixel-wide selection is not) or drag a sub-region
 * directly to zoom in, down to base resolution, and "Reset zoom" to back out. */
export default function SnpAmpliconMap({ amplicons, overlaps }: Props) {
  if (!amplicons.length) return null;
  const clusters = clusterAmplicons(amplicons);

  return (
    <div>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
        Each bar is one designed amplicon, scaled per cluster of nearby SNPs (each &gt;{CLUSTER_GAP_BP.toLocaleString()} bp from its neighbors gets its own, separately-scaled track). The dark tick inside a bar marks the exact variant
        position. <span className="text-green-600 dark:text-green-400 font-medium">Green</span> = no overlap with another designed amplicon; <span className="text-red-600 dark:text-red-400 font-medium">red</span> = overlaps one.
        Use a track's +/− buttons to zoom in (down to base resolution) or out, or drag across it to jump straight to a region; "Reset zoom" backs out to the overview.
      </p>
      {clusters.map((items) => (
        <ClusterTrack key={items.map((i) => i.rsid).join(',')} items={items} overlaps={overlaps} />
      ))}
    </div>
  );
}
