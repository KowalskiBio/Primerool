import { useRef, useState } from 'react';
import type { SequenceData } from '../api/sequence';
import type { Selections } from '../utils/regionMapping';
import { mapPrimerToGenomic } from '../utils/regionMapping';

interface ViewState {
  start: number;
  end: number;
}

interface Props {
  data: SequenceData;
  selections: Selections;
}

const WIDTH = 1000;
const HEIGHT = 180;
const TRACK_HEIGHT = 40;
const TRACK_Y = 60;
const RULER_Y = 130;
const MARGIN = 20;

/** Scrolls the sequence viewer (Card 3's `SequenceViewer`, identified by a
 * shared DOM id since the two components are siblings, not parent/child)
 * to the exon/CDS span starting at `startPos` — clicking a feature-map rect
 * or an amplicon/primer overlay jumps the reader straight to that base. */
function teleportTo(startPos: number) {
  const el = document.getElementById(`seq-region-${startPos}`);
  const container = document.getElementById('sequence-map');
  if (!el) return;
  if (container) {
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const relativeTop = elRect.top - containerRect.top;
    container.scrollTo({ top: container.scrollTop + relativeTop - container.clientHeight / 2 + (el as HTMLElement).offsetHeight / 2, behavior: 'smooth' });
  } else {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  const original = el.style.backgroundColor;
  el.style.backgroundColor = '#fef08a';
  el.style.transition = 'background-color 0.3s';
  setTimeout(() => {
    el.style.backgroundColor = original;
  }, 1000);
}

/** `data` is only read for its *initial* view range — the caller
 * (`SequenceFeaturesPanel`) must pass a `key` tied to the sequence's
 * identity so a genuinely new sequence remounts this component (and
 * re-runs the lazy initializer below) instead of leaving a stale zoom
 * range from the previous one. */
export default function FeatureMap({ data, selections }: Props) {
  const [view, setView] = useState<ViewState>(() => ({ start: -(data.upstream_len || 0), end: data.gene_len + (data.downstream_len || 0) }));
  const [showPrimers, setShowPrimers] = useState(true);
  const [showAmplicons, setShowAmplicons] = useState(true);
  const [drag, setDrag] = useState<{ startBp: number; currentBp: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  function resetZoom() {
    setView({ start: -(data.upstream_len || 0), end: data.gene_len + (data.downstream_len || 0) });
  }

  const viewLen = view.end - view.start;
  const scale = (bp: number) => ((bp - view.start) / viewLen) * (WIDTH - 2 * MARGIN) + MARGIN;
  const bpFromClientX = (clientX: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * WIDTH - MARGIN;
    return (x / (WIDTH - 2 * MARGIN)) * viewLen + view.start;
  };
  const isVisible = (start: number, end: number) => !(end < view.start || start > view.end);

  function handleMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    const targetStart = (e.target as SVGElement).getAttribute('data-start');
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
          const span = end - start;
          if (span > 50) {
            setView({ start, end });
          } else if (targetStart) {
            teleportTo(parseFloat(targetStart));
          }
        }
        return null;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const exons = (data.annotations || []).filter((a) => a.type === 'exon');
  const cds = (data.annotations || []).filter((a) => a.type === 'cds');

  const primerHighlights: { sel: typeof selections.wgaForward; label: string; color: string }[] = [
    { sel: selections.wgaForward, label: 'F', color: '#ef4444' },
    { sel: selections.wgaReverse, label: 'R', color: '#ef4444' },
    { sel: selections.juncLeft, label: 'F', color: '#ef4444' },
    { sel: selections.juncRight, label: 'R', color: '#ef4444' },
    { sel: selections.geneForward, label: 'F', color: '#ef4444' },
    { sel: selections.geneReverse, label: 'R', color: '#ef4444' },
    { sel: selections.geneProbe, label: 'P', color: '#3b82f6' },
  ];

  const fwdPrimers = [selections.wgaForward, selections.juncLeft, selections.geneForward].filter((p) => p !== null);
  const revPrimers = [selections.wgaReverse, selections.juncRight, selections.geneReverse].filter((p) => p !== null);

  // Adaptive ruler tick spacing — mirrors the legacy formula.
  const tickStep = Math.pow(10, Math.floor(Math.log10(viewLen)) - 1) || 1;
  const effectiveStep = tickStep * (viewLen / tickStep > 20 ? 2 : 1) * (viewLen / tickStep > 50 ? 2.5 : 1);
  const startTick = Math.floor(view.start / effectiveStep) * effectiveStep;
  const ticks: number[] = [];
  for (let i = startTick; i <= view.end; i += effectiveStep) {
    if (i >= view.start) ticks.push(i);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-md font-semibold text-slate-800 dark:text-slate-200">Feature map</h3>
        <div className="flex gap-2 items-center">
          <button
            onClick={resetZoom}
            className="text-xs bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 px-3 py-1 rounded border border-slate-300 dark:border-slate-600 transition-colors"
          >
            Reset Zoom
          </button>
          <label className="inline-flex items-center text-xs ml-2 cursor-pointer text-slate-700 dark:text-slate-300">
            <input type="checkbox" checked={showPrimers} onChange={(e) => setShowPrimers(e.target.checked)} className="h-4 w-4 text-green-600 rounded border-slate-300" />
            <span className="ml-1">Primers</span>
          </label>
          <label className="inline-flex items-center text-xs ml-2 cursor-pointer text-slate-700 dark:text-slate-300">
            <input type="checkbox" checked={showAmplicons} onChange={(e) => setShowAmplicons(e.target.checked)} className="h-4 w-4 text-green-600 rounded border-slate-300" />
            <span className="ml-1">Amplicons</span>
          </label>
        </div>
      </div>

      <div className="overflow-hidden relative select-none border border-slate-200 dark:border-slate-700 rounded-lg bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900">
        <svg ref={svgRef} width="100%" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ fontFamily: 'var(--font-sans)', cursor: 'crosshair' }} onMouseDown={handleMouseDown}>
          <line x1={MARGIN} y1={TRACK_Y + TRACK_HEIGHT / 2} x2={WIDTH - MARGIN} y2={TRACK_Y + TRACK_HEIGHT / 2} stroke="#94a3b8" strokeWidth={2} />

          {exons.map((ex, i) => {
            if (!isVisible(ex.start, ex.end)) return null;
            const x1 = Math.max(MARGIN, scale(ex.start));
            const x2 = Math.min(WIDTH - MARGIN, scale(ex.end));
            const w = Math.max(1, x2 - x1);
            return (
              <g key={`ex-${i}`}>
                <rect
                  x={x1}
                  y={TRACK_Y}
                  width={w}
                  height={TRACK_HEIGHT}
                  fill="#fed7aa"
                  stroke="#fbbf24"
                  strokeWidth={1}
                  data-start={ex.start}
                  className="cursor-pointer opacity-90 hover:opacity-100"
                >
                  <title>{`Exon/UTR ${ex.start}-${ex.end}`}</title>
                </rect>
                {w > 20 && (
                  <>
                    {scale(ex.start) >= MARGIN && (
                      <text x={x1} y={TRACK_Y - 8} fontSize={10} fill="#64748b" textAnchor="middle" pointerEvents="none">
                        {ex.start}
                      </text>
                    )}
                    {scale(ex.end) <= WIDTH - MARGIN && (
                      <text x={x2} y={TRACK_Y + TRACK_HEIGHT + 15} fontSize={10} fill="#64748b" textAnchor="middle" pointerEvents="none">
                        {ex.end}
                      </text>
                    )}
                  </>
                )}
              </g>
            );
          })}

          {cds.map((c, i) => {
            if (!isVisible(c.start, c.end)) return null;
            const x1 = Math.max(MARGIN, scale(c.start));
            const x2 = Math.min(WIDTH - MARGIN, scale(c.end));
            const w = Math.max(1, x2 - x1);
            return (
              <rect key={`cds-${i}`} x={x1} y={TRACK_Y} width={w} height={TRACK_HEIGHT} fill="#fed7aa" stroke="#fbbf24" strokeWidth={1} data-start={c.start} className="cursor-pointer opacity-90 hover:opacity-100">
                <title>{`CDS ${c.start}-${c.end}`}</title>
              </rect>
            );
          })}

          {showAmplicons &&
            fwdPrimers.flatMap((fp, fi) =>
              revPrimers.map((rp, ri) => {
                const rangesF = mapPrimerToGenomic(fp, data);
                const rangesR = mapPrimerToGenomic(rp, data);
                if (!rangesF.length || !rangesR.length) return null;
                const startPos = Math.min(...rangesF.map((r) => r.start));
                const endPos = Math.max(...rangesR.map((r) => r.end));
                const x1 = scale(startPos);
                const x2 = scale(endPos);
                if (!(x2 > x1 && x2 > MARGIN && x1 < WIDTH - MARGIN)) return null;
                return <line key={`amp-${fi}-${ri}`} x1={x1} y1={TRACK_Y - 28} x2={x2} y2={TRACK_Y - 28} stroke="#9333ea" strokeWidth={2} strokeDasharray="4,4" opacity={0.5} />;
              }),
            )}

          {showPrimers &&
            primerHighlights.flatMap((item, hi) => {
              const ranges = mapPrimerToGenomic(item.sel, data);
              return ranges
                .filter((r) => isVisible(r.start, r.end))
                .map((r, ri) => {
                  const x1 = scale(r.start);
                  const x2 = scale(r.end);
                  const w = Math.max(2, x2 - x1);
                  return (
                    <g key={`ph-${hi}-${ri}`} className="cursor-pointer" onClick={(e) => { e.stopPropagation(); teleportTo(r.start); }}>
                      <rect x={x1} y={TRACK_Y - 22} width={w} height={18} fill={item.color} opacity={0.8} rx={2}>
                        <title>{`${item.label}: ${r.start}-${r.end}`}</title>
                      </rect>
                      <text x={x1 + w / 2} y={TRACK_Y - 10} fontSize={9} fill="white" textAnchor="middle" fontWeight="bold" pointerEvents="none">
                        {item.label}
                      </text>
                    </g>
                  );
                });
            })}

          {drag &&
            (() => {
              const start = Math.min(drag.startBp, drag.currentBp);
              const end = Math.max(drag.startBp, drag.currentBp);
              if (end - start <= 0) return null;
              const x1 = Math.max(MARGIN, scale(start));
              const x2 = Math.min(WIDTH - MARGIN, scale(end));
              const w = Math.max(1, x2 - x1);
              return (
                <>
                  <rect x={x1} y={TRACK_Y} width={w} height={TRACK_HEIGHT} fill="rgba(74, 222, 128, 0.15)" stroke="#22c55e" strokeWidth={1} pointerEvents="none" />
                  <text x={x1 + w / 2} y={TRACK_Y + TRACK_HEIGHT / 2} fontSize={12} fill="#15803d" textAnchor="middle" fontWeight="bold" pointerEvents="none">
                    {Math.round(end - start)} bp
                  </text>
                </>
              );
            })()}

          <line x1={MARGIN} y1={RULER_Y} x2={WIDTH - MARGIN} y2={RULER_Y} stroke="#334155" strokeWidth={1} />
          {ticks.map((t, i) => {
            const x = scale(t);
            if (x > WIDTH - MARGIN) return null;
            return (
              <g key={`tick-${i}`}>
                <line x1={x} y1={RULER_Y} x2={x} y2={RULER_Y + 5} stroke="#334155" strokeWidth={1} />
                <text x={x} y={RULER_Y + 15} fontSize={10} fill="#334155" textAnchor="middle">
                  {Math.round(t)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
