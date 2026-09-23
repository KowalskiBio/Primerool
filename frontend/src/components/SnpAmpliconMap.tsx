import { useRef, useState } from 'react';

export interface PlacedAmplicon {
  rsid: string;
  gene: string;
  chrom: string;
  position: number;
  ampStart: number;
  ampEnd: number;
  productSize: number;
  /** Reference allele first, matching the source report's convention. */
  alleles: string[];
  /** Genomic position of `refSeq[0]` - lets any base within the amplicon
   * be looked up by its genomic coordinate (`refSeq[pos - intervalStart]`). */
  intervalStart: number;
  /** The full reference window (upstream flank + reference allele +
   * downstream flank) - always a superset of `[ampStart, ampEnd]`, since
   * the amplicon is designed from within that same flank. */
  refSeq: string;
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
  // tick it names - the bar's midpoint can be well off the variant when
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

  return (
    <div className="mb-4 last:mb-0">
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs font-semibold text-ink">
          {[...new Set(items.map((i) => i.gene))].join(' / ')} <span className="font-normal text-ink-faint">({items.length} SNP{items.length > 1 ? 's' : ''} on {items[0].chrom})</span>
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

          {bars.map(({ item: it, x1, x2, markerX, labelX }) => {
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
                    {`${it.rsid} (${it.gene})\nVariant: ${it.chrom}:${it.position.toLocaleString()} (${it.alleles.join('/')})\nAmplicon: ${it.ampStart.toLocaleString()}-${it.ampEnd.toLocaleString()} (${it.productSize} bp)`}
                    {hasOverlap ? `\nOverlaps: ${overlapsWith.join(', ')}` : '\nNo overlap with another designed amplicon'}
                  </title>
                </rect>
                {!showBases && markerX !== null && (
                  <line x1={markerX} y1={trackY - 3} x2={markerX} y2={trackY + TRACK_HEIGHT + 3} stroke="var(--ink)" strokeWidth={1.5}>
                    <title>{`${it.rsid} variant @ ${it.chrom}:${it.position.toLocaleString()}`}</title>
                  </line>
                )}
                {/* A stacked (row > 0) label sits further above the track, so
                 * without a leader line it's ambiguous which marker it names
                 * once two ticks are close enough to need separate rows. */}
                {row > 0 && markerX !== null && <line x1={labelX} y1={labelY + 2} x2={markerX} y2={trackY - 3} stroke="var(--ink-faint)" strokeWidth={1} strokeDasharray="2,2" pointerEvents="none" />}
                <text x={labelX} y={labelY} fontSize={9} fill="var(--ink-muted)" textAnchor="middle" pointerEvents="none">
                  {it.rsid}
                </text>
              </g>
            );
          })}

          {showBases &&
            baseCells.map(({ pos, base, owner }) => {
              const cellX1 = scale(pos);
              const cellX2 = scale(pos + 1);
              const cx = (cellX1 + cellX2) / 2;
              const isVariant = visibleItems.some((it) => it.position === pos);
              return (
                <g key={pos}>
                  {isVariant && <rect x={cellX1} y={trackY} width={Math.max(1, cellX2 - cellX1)} height={TRACK_HEIGHT} fill="var(--warning)" opacity={0.55} />}
                  <text x={cx} y={trackY + TRACK_HEIGHT / 2 + 4} fontSize={11} fontFamily="var(--font-mono, monospace)" fontWeight={isVariant ? 'bold' : 'normal'} fill={isVariant ? 'var(--warning)' : 'var(--ink)'} textAnchor="middle" pointerEvents="none">
                    {base}
                  </text>
                  {isVariant && <title>{`${owner.rsid} @ ${owner.chrom}:${pos.toLocaleString()}\nAlleles: ${owner.alleles.join('/')} (reference base shown here: ${base})`}</title>}
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
export default function SnpAmpliconMap({ amplicons, overlaps }: Props) {
  if (!amplicons.length) return null;
  const clusters = clusterAmplicons(amplicons);

  return (
    <div>
      <p className="mb-3 text-xs text-ink-muted">
        Each bar is one designed amplicon, scaled per cluster of nearby SNPs (each &gt;{CLUSTER_GAP_BP.toLocaleString()} bp from its neighbors gets its own, separately-scaled track).{' '}
        <span className="font-medium text-success">Green</span> = no overlap with another designed amplicon; <span className="font-medium text-danger">red</span> = overlaps one. Use a track's
        +/− buttons to zoom in or out, or drag across it to jump straight to a region; "Reset zoom" backs out to the overview. Zoomed in close enough, the actual reference bases are shown, with the variant's own base highlighted{' '}
        <span className="font-medium text-warning">amber</span>.
      </p>
      {clusters.map((items) => (
        <ClusterTrack key={items.map((i) => i.rsid).join(',')} items={items} overlaps={overlaps} />
      ))}
    </div>
  );
}
