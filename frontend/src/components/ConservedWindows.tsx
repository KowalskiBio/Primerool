import { useMemo } from 'react';
import { useSessionState } from '../session/sessionContext';
import { findConservedWindows, type AlignmentAnalysis, type ConservedWindow } from '../utils/alignedFasta';
import Button from './ui/Button';
import Field from './ui/Field';
import TextInput from './ui/TextInput';

const fmt = (n: number) => n.toLocaleString('en-US');

interface Props {
  analysis: AlignmentAnalysis;
  designing: boolean;
  /** Single primers anywhere in one window. */
  onDesignIn: (w: ConservedWindow) => void;
  /** A forward primer in `left`, a reverse one in `right`. */
  onDesignPair: (left: ConservedWindow, right: ConservedWindow) => void;
}

/** Per-column identity as a bar strip, with the conserved windows shaded. */
function ConservationTrack({ identity, windows, threshold, selected }: { identity: number[]; windows: ConservedWindow[]; threshold: number; selected: ConservedWindow[] }) {
  const n = identity.length;
  return (
    <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" className="block h-16 w-full rounded border border-line bg-base" role="img" aria-label="Conservation per alignment column">
      {windows.map((w) => (
        <rect key={w.start} x={w.start} width={w.end - w.start} y={0} height={100} className={selected.includes(w) ? 'fill-accent/30' : 'fill-success/15'} />
      ))}
      {identity.map((v, c) => (v > 0 ? <rect key={c} x={c} width={1} y={100 - v * 100} height={v * 100} className={v >= threshold ? 'fill-success' : 'fill-ink-faint'} /> : null))}
      <line x1={0} x2={n} y1={100 - threshold * 100} y2={100 - threshold * 100} className="stroke-warning" strokeWidth={0.6} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** The conservation track and the list of conserved windows it finds: a
 * window's own primers in one click, or a pair across two ticked ones. */
export default function ConservedWindows({ analysis, designing, onDesignIn, onDesignPair }: Props) {
  const [thresholdPct, setThresholdPct] = useSessionState('align.windowIdentity', 100);
  const [minLength, setMinLength] = useSessionState('align.windowMinLength', 18);
  const [picked, setPicked] = useSessionState<number[]>('align.windowsPicked', []);

  const threshold = thresholdPct / 100;
  const windows = useMemo(() => findConservedWindows(analysis.identity, threshold, minLength), [analysis, threshold, minLength]);
  const byLength = useMemo(() => [...windows].sort((a, b) => b.end - b.start - (a.end - a.start)), [windows]);
  // Ticked windows by start column, in alignment order.
  const selected = windows.filter((w) => picked.includes(w.start));

  const toggle = (w: ConservedWindow, on: boolean) => {
    const keep = picked.filter((s) => windows.some((x) => x.start === s) && s !== w.start);
    setPicked(on ? [...keep, w.start].slice(-2) : keep);
  };

  return (
    <div className="mt-4 rounded-md border border-line bg-surface-2 p-4">
      <h4 className="mb-1 text-sm font-semibold text-ink">Conserved windows</h4>
      <p className="mb-3 text-sm text-ink-muted">
        Bars show, per alignment column, the share of sequences carrying the most common base (a gap counts as not carrying it). Shaded stretches are long enough for a primer and at least as conserved as the threshold line.
      </p>
      <ConservationTrack identity={analysis.identity} windows={windows} threshold={threshold} selected={selected} />
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-ink-faint">
        <span>1</span>
        <span>{fmt(analysis.length)}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3">
        <Field label={`Identity threshold: ${thresholdPct}%`} className="w-56">
          <input type="range" min={70} max={100} step={1} value={thresholdPct} onChange={(e) => setThresholdPct(parseInt(e.target.value, 10))} className="h-9 w-full cursor-pointer accent-accent" />
        </Field>
        <Field label="Min. length (columns)" className="w-36">
          <TextInput type="number" min={10} max={60} value={minLength} onChange={(e) => setMinLength(Math.max(10, parseInt(e.target.value, 10) || 18))} className="tabular-nums" />
        </Field>
        <Button variant="primary" disabled={designing || selected.length !== 2} onClick={() => onDesignPair(selected[0], selected[1])} title="Tick two windows: forward primer in the first, reverse in the second">
          Design pair across the 2 ticked windows
        </Button>
      </div>

      {windows.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">No stretch of {minLength}+ columns reaches {thresholdPct}% identity. Lower the threshold, or drop the most divergent sequences.</p>
      ) : (
        <div className="mt-3 max-h-72 overflow-auto rounded-md border border-line bg-surface">
          <table className="w-full text-left text-xs text-ink-muted">
            <thead className="sticky top-0 bg-surface-2 uppercase">
              <tr>
                <th className="border-b border-line px-3 py-2 font-medium">Pair</th>
                <th className="border-b border-line px-3 py-2 font-medium">Columns</th>
                <th className="border-b border-line px-3 py-2 font-medium">Length</th>
                <th className="border-b border-line px-3 py-2 font-medium">Min. identity</th>
                <th className="border-b border-line px-3 py-2 font-medium">Consensus</th>
                <th className="border-b border-line px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {byLength.map((w) => (
                <tr key={w.start} className="border-b border-line last:border-0 hover:bg-surface-2">
                  <td className="px-3 py-1.5">
                    <input type="checkbox" aria-label={`Use columns ${w.start + 1}-${w.end} in a pair`} className="h-4 w-4 cursor-pointer accent-accent" checked={picked.includes(w.start)} onChange={(e) => toggle(w, e.target.checked)} />
                  </td>
                  <td className="px-3 py-1.5 tabular-nums text-ink">
                    {fmt(w.start + 1)}-{fmt(w.end)}
                  </td>
                  <td className="px-3 py-1.5 tabular-nums">{w.end - w.start}</td>
                  <td className="px-3 py-1.5 tabular-nums">{Math.round(w.minIdentity * 100)}%</td>
                  <td className="max-w-[18rem] truncate px-3 py-1.5 font-mono" title={analysis.consensus.slice(w.start, w.end).join('')}>
                    {analysis.consensus.slice(w.start, w.end).join('')}
                  </td>
                  <td className="px-3 py-1.5">
                    <Button size="sm" disabled={designing} onClick={() => onDesignIn(w)}>
                      Design here
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
