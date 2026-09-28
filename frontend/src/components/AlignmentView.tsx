import { useEffect, useMemo, useRef, useState } from 'react';
import { analyzeAlignment, parseAlignedFasta, type AlignmentAnalysis } from '../utils/alignedFasta';

const NAME_MAX = 20;
const fmt = (n: number) => n.toLocaleString('en-US');

/** Columns per block: as many tens as fit the container's width, after the
 * name and number gutters - remeasured when the container resizes. */
function useBlockWidth(containerRef: React.RefObject<HTMLDivElement | null>, probeRef: React.RefObject<HTMLSpanElement | null>, gutterChars: number) {
  const [width, setWidth] = useState(60);
  useEffect(() => {
    function recompute() {
      const el = containerRef.current;
      const probe = probeRef.current;
      if (!el || !probe) return;
      const charW = probe.getBoundingClientRect().width / 10;
      const style = getComputedStyle(el);
      const inner = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (!charW || inner <= 0) return;
      setWidth(Math.max(10, Math.floor((Math.floor(inner / charW) - gutterChars) / 10) * 10));
    }
    recompute();
    const ro = new ResizeObserver(recompute);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [containerRef, probeRef, gutterChars]);
  return width;
}

/** A column ruler for columns `[from, to)`: each multiple of ten's number
 * ends right above its own column (1-based alignment columns). */
function ruler(from: number, to: number): string {
  const chars = new Array(to - from).fill(' ');
  for (let n = Math.ceil((from + 1) / 10) * 10; n <= to; n += 10) {
    const label = String(n);
    const end = n - 1 - from;
    for (let i = 0; i < label.length; i++) {
      const at = end - (label.length - 1 - i);
      if (at >= 0) chars[at] = label[i];
    }
  }
  return chars.join('');
}

/** How each base of a row is drawn in columns `[from, to)`, as runs of one
 * class: gaps dimmed; a base differing from its column's majority - with
 * two sequences, any mismatch, both sides - highlighted. */
function rowRuns(a: AlignmentAnalysis, row: number, from: number, to: number): { text: string; className: string }[] {
  const seq = a.rows[row].seq;
  const pair = a.rows.length === 2;
  const runs: { text: string; className: string }[] = [];
  for (let c = from; c < to; c++) {
    const b = seq[c] ?? '-';
    const cls = b === '-' ? 'aln-gap' : (pair ? !a.conserved[c] && !a.gapped[c] : b !== a.consensus[c]) ? 'aln-mismatch' : '';
    const last = runs[runs.length - 1];
    if (last && last.className === cls) last.text += b;
    else runs.push({ text: b, className: cls });
  }
  return runs;
}

/** A multiple alignment laid out the classic way: blocks of columns, one
 * row per sequence with its own base numbering at both ends, a column
 * ruler above and a match line below (`|` identical for two sequences,
 * `*` fully conserved for more). */
export default function AlignmentView({ alignment }: { alignment: string }) {
  const a = useMemo(() => analyzeAlignment(parseAlignedFasta(alignment)), [alignment]);
  const containerRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);

  const names = a.rows.map((r) => (r.id.length > NAME_MAX ? `${r.id.slice(0, NAME_MAX - 1)}…` : r.id));
  const nameW = Math.max(...names.map((n) => n.length), 1);
  const numW = Math.max(...a.residuesBefore.map((rb) => String(rb[a.length]).length), 1);
  // name, space, start number, space | sequence | space, end number
  const lead = nameW + 1 + numW + 1;
  const blockW = useBlockWidth(containerRef, probeRef, lead + 1 + numW);

  if (a.rows.length < 2 || a.length === 0) {
    return <pre className="sequence-viewer rounded-lg border border-line bg-base p-4 text-xs">{alignment}</pre>;
  }

  const { identical, mismatch, gapColumns } = a.stats;
  const pct = (n: number) => `${((100 * n) / a.length).toFixed(1)}%`;
  const matchChar = a.rows.length === 2 ? '|' : '*';
  const blocks: number[] = [];
  for (let from = 0; from < a.length; from += blockW) blocks.push(from);

  return (
    <div>
      <p className="mb-2 text-xs text-ink-muted">
        {a.rows.length} sequences · {fmt(a.length)} columns · <span className="text-ink">{fmt(identical)}</span> identical ({pct(identical)}) ·{' '}
        <span className="aln-mismatch rounded px-0.5">{fmt(mismatch)}</span> mismatch{mismatch === 1 ? '' : 'es'} · {fmt(gapColumns)} with gaps (<span className="aln-gap">-</span>). Numbers at the ends of each row are that sequence&apos;s own base positions; the ruler counts alignment columns.
      </p>
      <div ref={containerRef} className="relative max-h-[520px] overflow-auto rounded-lg border border-line bg-base p-4 font-mono text-xs leading-5 text-ink">
        <span ref={probeRef} aria-hidden="true" className="invisible absolute whitespace-pre">
          0000000000
        </span>
        {blocks.map((from) => {
          const to = Math.min(a.length, from + blockW);
          let match = '';
          for (let c = from; c < to; c++) match += a.conserved[c] ? matchChar : ' ';
          return (
            <div key={from} className="mb-4 whitespace-pre last:mb-0">
              <div className="aln-meta select-none">
                {' '.repeat(lead)}
                {ruler(from, to)}
              </div>
              {a.rows.map((r, i) => {
                const rb = a.residuesBefore[i];
                const any = rb[to] > rb[from];
                const start = any ? String(rb[from] + 1) : '';
                const end = any ? String(rb[to]) : '';
                return (
                  <div key={i}>
                    <span className="aln-meta select-none" title={r.id}>
                      {names[i].padEnd(nameW)} {start.padStart(numW)}{' '}
                    </span>
                    {rowRuns(a, i, from, to).map((run, k) =>
                      run.className ? (
                        <span key={k} className={run.className}>
                          {run.text}
                        </span>
                      ) : (
                        run.text
                      ),
                    )}
                    <span className="aln-meta select-none"> {end}</span>
                  </div>
                );
              })}
              <div className="aln-meta select-none">
                {' '.repeat(lead)}
                {match}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
