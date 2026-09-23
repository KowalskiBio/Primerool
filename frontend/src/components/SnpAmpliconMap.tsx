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
const TRACK_Y = 26;
const RULER_Y = TRACK_Y + TRACK_HEIGHT + 20;
const HEIGHT = RULER_Y + 20;

function GeneTrack({ gene, chrom, items, overlaps }: { gene: string; chrom: string; items: PlacedAmplicon[]; overlaps: Record<string, string[]> }) {
  const minPos = Math.min(...items.map((i) => i.ampStart));
  const maxPos = Math.max(...items.map((i) => i.ampEnd));
  const span = Math.max(1, maxPos - minPos);
  const pad = Math.max(50, span * 0.1);
  const start = minPos - pad;
  const end = maxPos + pad;
  const viewLen = end - start;
  const scale = (bp: number) => ((bp - start) / viewLen) * (WIDTH - 2 * MARGIN) + MARGIN;

  // Same adaptive ruler-tick spacing as FeatureMap.
  const tickStep = Math.pow(10, Math.floor(Math.log10(viewLen)) - 1) || 1;
  const effectiveStep = tickStep * (viewLen / tickStep > 20 ? 2 : 1) * (viewLen / tickStep > 50 ? 2.5 : 1);
  const startTick = Math.floor(start / effectiveStep) * effectiveStep;
  const ticks: number[] = [];
  for (let t = startTick; t <= end; t += effectiveStep) {
    if (t >= start) ticks.push(t);
  }

  return (
    <div className="mb-4 last:mb-0">
      <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
        {gene} <span className="font-normal text-slate-400">— {items.length} SNP{items.length > 1 ? 's' : ''} on {chrom}</span>
      </div>
      <div className="overflow-hidden border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800">
        <svg width="100%" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ fontFamily: 'var(--font-sans)' }}>
          <line x1={MARGIN} y1={TRACK_Y + TRACK_HEIGHT / 2} x2={WIDTH - MARGIN} y2={TRACK_Y + TRACK_HEIGHT / 2} stroke="#cbd5e1" strokeWidth={1} />

          {items.map((it) => {
            const x1 = scale(it.ampStart);
            const x2 = scale(it.ampEnd);
            const w = Math.max(2, x2 - x1);
            const overlapsWith = overlaps[it.rsid] || [];
            const hasOverlap = overlapsWith.length > 0;
            const fill = hasOverlap ? '#ef4444' : '#22c55e';
            const stroke = hasOverlap ? '#b91c1c' : '#15803d';
            return (
              <g key={it.rsid}>
                <rect x={x1} y={TRACK_Y} width={w} height={TRACK_HEIGHT} fill={fill} opacity={0.75} stroke={stroke} strokeWidth={1} rx={2}>
                  <title>
                    {`${it.rsid} (${it.gene})\n${it.chrom}:${it.ampStart.toLocaleString()}-${it.ampEnd.toLocaleString()} (${it.productSize} bp amplicon)`}
                    {hasOverlap ? `\nOverlaps: ${overlapsWith.join(', ')}` : '\nNo overlap with another designed amplicon'}
                  </title>
                </rect>
                <text x={(x1 + x2) / 2} y={TRACK_Y - 6} fontSize={9} fill="#475569" textAnchor="middle" pointerEvents="none">
                  {it.rsid}
                </text>
              </g>
            );
          })}

          <line x1={MARGIN} y1={RULER_Y} x2={WIDTH - MARGIN} y2={RULER_Y} stroke="#334155" strokeWidth={1} />
          {ticks.map((t, i) => {
            const x = scale(t);
            if (x > WIDTH - MARGIN) return null;
            return (
              <g key={i}>
                <line x1={x} y1={RULER_Y} x2={x} y2={RULER_Y + 5} stroke="#334155" strokeWidth={1} />
                <text x={x} y={RULER_Y + 15} fontSize={9} fill="#334155" textAnchor="middle">
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

/** One small genomic track per gene, showing every successfully-designed
 * amplicon in that gene positioned to scale (min–max span across that
 * gene's SNPs, padded) — a visual complement to the results table's
 * per-row overlap column, grouped the same way the source report groups
 * SNPs by gene. Amplicons that overlap another designed amplicon render
 * red instead of green. */
export default function SnpAmpliconMap({ amplicons, overlaps }: Props) {
  if (!amplicons.length) return null;

  const byGene = new Map<string, PlacedAmplicon[]>();
  for (const a of amplicons) {
    const list = byGene.get(a.gene) || [];
    list.push(a);
    byGene.set(a.gene, list);
  }

  return (
    <div className="mt-4">
      <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Amplicon map (by gene)</h4>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
        Each bar is one designed amplicon, scaled to that gene's SNP span. <span className="text-green-600 dark:text-green-400 font-medium">Green</span> = no overlap with another designed amplicon;{' '}
        <span className="text-red-600 dark:text-red-400 font-medium">red</span> = overlaps one. Hover a bar for exact coordinates.
      </p>
      {[...byGene.entries()].map(([gene, items]) => (
        <GeneTrack key={gene} gene={gene} chrom={items[0].chrom} items={[...items].sort((a, b) => a.position - b.position)} overlaps={overlaps} />
      ))}
    </div>
  );
}
