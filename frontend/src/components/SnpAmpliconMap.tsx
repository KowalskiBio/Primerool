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

const WIDTH = 1000;
const MARGIN = 20;
const TRACK_HEIGHT = 22;
const ROW_HEIGHT = 11;
const RULER_GAP = 20;
/** Rough SVG-unit width per character at the label's 9px font size — used only
 * to greedily pack rsID labels into non-overlapping rows, not for pixel-perfect layout. */
const CHAR_WIDTH = 5.4;
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

function ClusterTrack({ items, overlaps }: { items: PlacedAmplicon[]; overlaps: Record<string, string[]> }) {
  const genes = [...new Set(items.map((i) => i.gene))].join(' / ');
  const minPos = Math.min(...items.map((i) => i.ampStart));
  const maxPos = Math.max(...items.map((i) => i.ampEnd));
  const span = Math.max(1, maxPos - minPos);
  const pad = Math.max(50, span * 0.15);
  const start = minPos - pad;
  const end = maxPos + pad;
  const viewLen = end - start;
  const scale = (bp: number) => ((bp - start) / viewLen) * (WIDTH - 2 * MARGIN) + MARGIN;

  const tickStep = Math.pow(10, Math.floor(Math.log10(viewLen)) - 1) || 1;
  const effectiveStep = tickStep * (viewLen / tickStep > 20 ? 2 : 1) * (viewLen / tickStep > 50 ? 2.5 : 1);
  const startTick = Math.floor(start / effectiveStep) * effectiveStep;
  const ticks: number[] = [];
  for (let t = startTick; t <= end; t += effectiveStep) {
    if (t >= start) ticks.push(t);
  }

  // Greedy row-packing so rsID labels never overlap: sort by horizontal
  // position, then place each in the lowest row whose last label doesn't
  // collide with it.
  const bars = items.map((it) => {
    const x1 = scale(it.ampStart);
    const x2raw = scale(it.ampEnd);
    const x2 = Math.max(x2raw, x1 + 2);
    const xMid = (x1 + x2) / 2;
    const halfLabelWidth = (it.rsid.length * CHAR_WIDTH) / 2;
    return { item: it, x1, x2, xMid, halfLabelWidth };
  });
  const sortedByMid = [...bars].sort((a, b) => a.xMid - b.xMid);
  const rowEnds: number[] = [];
  const rowOf = new Map<string, number>();
  for (const b of sortedByMid) {
    let row = 0;
    while (row < rowEnds.length && b.xMid - b.halfLabelWidth < rowEnds[row] + 4) row++;
    rowEnds[row] = b.xMid + b.halfLabelWidth;
    rowOf.set(b.item.rsid, row);
  }
  const maxRow = Math.max(0, ...rowOf.values());
  const labelAreaHeight = (maxRow + 1) * ROW_HEIGHT + 4;

  const trackY = labelAreaHeight + 4;
  const rulerY = trackY + TRACK_HEIGHT + RULER_GAP;
  const height = rulerY + 20;

  return (
    <div className="mb-4 last:mb-0">
      <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
        {genes} <span className="font-normal text-slate-400">— {items.length} SNP{items.length > 1 ? 's' : ''} on {items[0].chrom}</span>
      </div>
      <div className="overflow-hidden border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800">
        <svg width="100%" viewBox={`0 0 ${WIDTH} ${height}`} style={{ fontFamily: 'var(--font-sans)' }}>
          <line x1={MARGIN} y1={trackY + TRACK_HEIGHT / 2} x2={WIDTH - MARGIN} y2={trackY + TRACK_HEIGHT / 2} stroke="#cbd5e1" strokeWidth={1} />

          {bars.map(({ item: it, x1, x2 }) => {
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
                    {`${it.rsid} (${it.gene})\n${it.chrom}:${it.ampStart.toLocaleString()}-${it.ampEnd.toLocaleString()} (${it.productSize} bp amplicon)`}
                    {hasOverlap ? `\nOverlaps: ${overlapsWith.join(', ')}` : '\nNo overlap with another designed amplicon'}
                  </title>
                </rect>
                <text x={(x1 + x2) / 2} y={labelY} fontSize={9} fill="#475569" textAnchor="middle" pointerEvents="none">
                  {it.rsid}
                </text>
              </g>
            );
          })}

          <line x1={MARGIN} y1={rulerY} x2={WIDTH - MARGIN} y2={rulerY} stroke="#334155" strokeWidth={1} />
          {ticks.map((t, i) => {
            const x = scale(t);
            if (x > WIDTH - MARGIN) return null;
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
 * scaled to their own span — visually consistent boxes regardless of how
 * spread out the rest of that gene's SNPs are. Amplicons that overlap
 * another designed amplicon render red instead of green; rsID labels are
 * packed into rows so close-together SNPs' names never overlap. */
export default function SnpAmpliconMap({ amplicons, overlaps }: Props) {
  if (!amplicons.length) return null;
  const clusters = clusterAmplicons(amplicons);

  return (
    <div>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
        Each bar is one designed amplicon, scaled per cluster of nearby SNPs (each &gt;{CLUSTER_GAP_BP.toLocaleString()} bp from its neighbors gets its own, separately-scaled track).{' '}
        <span className="text-green-600 dark:text-green-400 font-medium">Green</span> = no overlap with another designed amplicon; <span className="text-red-600 dark:text-red-400 font-medium">red</span> = overlaps one. Hover a
        bar for exact coordinates.
      </p>
      {clusters.map((items) => (
        <ClusterTrack key={items.map((i) => i.rsid).join(',')} items={items} overlaps={overlaps} />
      ))}
    </div>
  );
}
