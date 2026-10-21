import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { analyzeAlignment, type AlignedRow, type AlignmentAnalysis } from '../utils/alignedFasta';
import { rowBases, type AlignPick, type AlignPrimers } from '../utils/alignPrimers';
import SequenceContextMenu, { type MenuEntry } from './SequenceContextMenu';
import SegmentedControl from './ui/SegmentedControl';
import Button from './ui/Button';
import Checkbox from './ui/Checkbox';

const fmt = (n: number) => n.toLocaleString('en-US');

const NAME_MAX = 22;
const ROW_H = 18;
const RULER_H = 20;
/** Strip above the rows marking the picked F/R primers' columns. */
const PRIMER_TRACK_H = 10;
const TOP = RULER_H + PRIMER_TRACK_H;
const RIGHT_PAD = 8;
/** Columns at least this wide show their letters (sequence mode); narrower
 * ones draw as Oligool's grey bars with red mismatch ticks (overview). */
const LETTER_W = 8;
/** Column width the "Sequence" toggle zooms to; the most zoom allows. */
const SEQUENCE_W = 12;
const MAX_W = 18;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
/** Primer3's thermodynamic models analyze oligos up to 60 bases. */
const MIN_PRIMER = 8;
const MAX_PRIMER = 60;

/** Drawn as a mismatch: a base differing from its column's majority - with
 * two sequences, any differing column, both sides. */
function isMismatch(a: AlignmentAnalysis, b: string, c: number): boolean {
  if (b === '-' || b === '.') return false;
  return a.rows.length === 2 ? !a.conserved[c] && !a.gapped[c] : b !== a.consensus[c];
}

/** A 1/2/5 × 10ⁿ ruler step whose ticks stand at least `minCols` apart. */
function niceStep(minCols: number): number {
  for (let p = 1; ; p *= 10) for (const m of [1, 2, 5]) if (m * p >= minCols) return m * p;
}

function cssVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

interface Selection {
  row: number;
  /** Inclusive columns, `c0` where the drag started. */
  c0: number;
  c1: number;
}

interface Props {
  alignment: string;
  rows: AlignedRow[];
  /** Row ids taken out of view by the Rows picker. */
  hiddenRows: string[];
  onHiddenRowsChange: (ids: string[]) => void;
  primers: AlignPrimers;
  onPickPrimer: (side: 'F' | 'R', pick: AlignPick) => void;
  /** Sets the "Design Primers in Conserved Region" column range. */
  onSetDesignRange: (colStart: number, colEnd: number) => void;
}

/** The alignment as Oligool draws it: one strip per sequence on a shared
 * column axis. Zoomed out it is an overview - each sequence a grey bar
 * over its aligned span, red ticks where a base differs from the column's
 * majority, breaks at gaps; zoomed in far enough the bars become letters.
 * Drag across a row to select bases, then right-click to make them a
 * forward or reverse primer. */
export default function AlignmentView({ alignment, rows: allRows, hiddenRows, onHiddenRowsChange, primers, onPickPrimer, onSetDesignRange }: Props) {
  const rows = useMemo(() => allRows.filter((r) => !hiddenRows.includes(r.id)), [allRows, hiddenRows]);
  const a = useMemo(() => analyzeAlignment(rows), [rows]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  /** Share of the alignment's columns in view: 1 fits it all. */
  const [viewFraction, setViewFraction] = useState(1);
  const pendingScroll = useRef<number | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [rowsOpen, setRowsOpen] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  const [copied, setCopied] = useState(false);

  const names = rows.map((r) => (r.id.length > NAME_MAX ? `${r.id.slice(0, NAME_MAX - 1)}…` : r.id));
  const numW = String(Math.max(0, ...a.residuesBefore.map((rb) => rb[a.length] ?? 0))).length;
  const labelW = Math.ceil(Math.max(...names.map((n) => n.length), 4) * 6.6 + numW * 6.6 + 22);
  const seqW = Math.max(1, width - labelW - RIGHT_PAD);
  const len = a.length;
  const minFraction = len > 0 ? Math.min(1, seqW / (len * MAX_W)) : 1;
  const vf = Math.max(minFraction, Math.min(1, viewFraction));
  const totalW = seqW / vf;
  const cellW = len > 0 ? totalW / len : 1;
  const letters = cellW >= LETTER_W;
  const totalH = TOP + rows.length * ROW_H + 4;
  /** Whether the canvas (not the plain-text fallback) is on screen. */
  const drawable = allRows.length >= 2 && len > 0;

  // A new alignment or a different set of rows: drop the selection.
  const selScope = `${alignment}\0${hiddenRows.join('\n')}`;
  const [selFor, setSelFor] = useState(selScope);
  if (selScope !== selFor) {
    setSelFor(selScope);
    setSel(null);
    setMenu(null);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [drawable]);

  // Theme or accent changes recolor the canvas.
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((t) => t + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => mo.disconnect();
  }, []);

  // A zoom resizes the scroll content first; the scroll position it wants
  // can only be applied once that has rendered, or the browser clamps it.
  useLayoutEffect(() => {
    if (pendingScroll.current === null || !scrollRef.current) return;
    scrollRef.current.scrollLeft = pendingScroll.current;
    pendingScroll.current = null;
  });

  /** Zooms to `nextFraction`, keeping the column under `anchorPx` (from
   * the sequence area's left edge) where it is. */
  function zoomTo(nextFraction: number, anchorPx = seqW / 2, anchorCol?: number) {
    const next = Math.max(minFraction, Math.min(1, nextFraction));
    const col = anchorCol ?? (scrollLeft + anchorPx) / cellW;
    const nextCell = seqW / next / Math.max(1, len);
    const nextTotal = seqW / next;
    const left = Math.max(0, Math.min(nextTotal - seqW, col * nextCell - anchorPx));
    pendingScroll.current = left;
    setScrollLeft(left);
    setViewFraction(next);
  }

  // ⌘/Ctrl + wheel (and trackpad pinch) zooms at the pointer. The listener
  // is attached once (non-passive, to stop the page zooming) and calls
  // this render's handler through the ref.
  const onWheelRef = useRef<(e: WheelEvent) => void>(() => undefined);
  useEffect(() => {
    onWheelRef.current = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const x = e.clientX - (scrollRef.current?.getBoundingClientRect().left ?? 0) - labelW;
      zoomTo(vf * Math.exp(e.deltaY * 0.01), Math.max(0, Math.min(seqW, x)));
    };
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => onWheelRef.current(e);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [drawable]);

  const selCols = sel ? { from: Math.min(sel.c0, sel.c1), to: Math.max(sel.c0, sel.c1) + 1 } : null;

  /* ── drawing ─────────────────────────────────────────── */
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs || width === 0 || len === 0) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    cvs.width = width * dpr;
    cvs.height = totalH * dpr;
    cvs.style.width = `${width}px`;
    cvs.style.height = `${totalH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const col = {
      base: cssVar(cvs, '--base'),
      ink: cssVar(cvs, '--ink'),
      muted: cssVar(cvs, '--ink-muted'),
      faint: cssVar(cvs, '--ink-faint'),
      line: cssVar(cvs, '--line'),
      bar: cssVar(cvs, '--aln-bar'),
      mis: cssVar(cvs, '--aln-mismatch-ink'),
      misBg: cssVar(cvs, '--aln-mismatch-bg'),
      accent: cssVar(cvs, '--accent'),
      fwd: cssVar(cvs, '--aln-fwd'),
      fwdBg: cssVar(cvs, '--aln-fwd-bg'),
      rev: cssVar(cvs, '--aln-rev'),
      revBg: cssVar(cvs, '--aln-rev-bg'),
    };
    ctx.fillStyle = col.base;
    ctx.fillRect(0, 0, width, totalH);

    const first = Math.max(0, Math.floor(scrollLeft / cellW));
    const last = Math.min(len - 1, Math.ceil((scrollLeft + seqW) / cellW));
    const x = (c: number) => labelW + c * cellW - scrollLeft;
    // Zoomed far out, many columns share a pixel: visit one per pixel.
    const step = Math.max(1, Math.floor(1 / cellW));

    ctx.save();
    ctx.beginPath();
    ctx.rect(labelW, 0, seqW + RIGHT_PAD, totalH);
    ctx.clip();

    // Ruler: alignment columns, 1-based.
    const tick = niceStep(Math.max(1, 64 / cellW));
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = col.faint;
    for (let n = Math.max(tick, Math.ceil((first + 1) / tick) * tick); n <= last + 1; n += tick) {
      const cx = x(n - 1) + cellW / 2;
      ctx.fillRect(Math.round(cx), RULER_H - 5, 1, 4);
      ctx.fillText(fmt(n), cx, RULER_H - 8);
    }

    // Selected columns: a faint band down every row.
    if (selCols) {
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = col.accent;
      ctx.fillRect(x(selCols.from), TOP, (selCols.to - selCols.from) * cellW, rows.length * ROW_H);
      ctx.globalAlpha = 1;
    }

    // Primer track.
    for (const p of [primers.F, primers.R]) {
      if (!p) continue;
      const px = x(p.colStart);
      const pw = Math.max(2, (p.colEnd - p.colStart) * cellW);
      ctx.fillStyle = p.side === 'F' ? col.fwd : col.rev;
      ctx.fillRect(px, RULER_H + 2, pw, PRIMER_TRACK_H - 4);
      // Arrowhead at the 3' end.
      const tipX = p.side === 'F' ? px + pw : px;
      const dir = p.side === 'F' ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(tipX, RULER_H);
      ctx.lineTo(tipX + dir * 5, RULER_H + PRIMER_TRACK_H / 2);
      ctx.lineTo(tipX, RULER_H + PRIMER_TRACK_H);
      ctx.fill();
    }

    ctx.font = `${Math.min(13, Math.max(9, cellW * 0.85))}px ${MONO}`;
    ctx.textBaseline = 'middle';
    rows.forEach((r, i) => {
      const y = TOP + i * ROW_H;
      const primerOn = [primers.F, primers.R].filter((p) => p && p.rowId === r.id);
      if (letters) {
        for (let c = first; c <= last; c++) {
          const b = r.seq[c] ?? '-';
          let bg = '';
          let fg = col.ink;
          const p = primerOn.find((q) => q && c >= q.colStart && c < q.colEnd);
          if (b === '-' || b === '.') fg = col.faint;
          else if (isMismatch(a, b, c)) {
            bg = col.misBg;
            fg = col.mis;
          } else if (p) bg = p.side === 'F' ? col.fwdBg : col.revBg;
          if (bg) {
            ctx.fillStyle = bg;
            ctx.fillRect(x(c), y + 1, cellW + 0.5, ROW_H - 2);
          }
          ctx.fillStyle = fg;
          ctx.fillText(b, x(c) + cellW / 2, y + ROW_H / 2 + 0.5);
        }
      } else {
        // Grey bar over the row's aligned span, then mismatches in red and
        // gaps cut out of it.
        const s = r.seq.search(/[^-.]/);
        let e = r.seq.length - 1;
        while (e >= 0 && (r.seq[e] === '-' || r.seq[e] === '.')) e--;
        if (s >= 0 && e >= s) {
          ctx.fillStyle = col.bar;
          ctx.fillRect(x(s), y + 4, (e - s + 1) * cellW, ROW_H - 8);
        }
        const w = Math.max(1, cellW * step);
        for (let c = first - (first % step); c <= last; c += step) {
          let mis = false;
          let gap = false;
          for (let k = c; k < c + step && k < len; k++) {
            const b = r.seq[k] ?? '-';
            if (b === '-' || b === '.') gap = gap || (k > s && k < e);
            else if (isMismatch(a, b, k)) mis = true;
          }
          if (mis) {
            ctx.fillStyle = col.mis;
            ctx.fillRect(x(c), y + 2, w, ROW_H - 4);
          } else if (gap) {
            ctx.fillStyle = col.base;
            ctx.fillRect(x(c), y + 4, w, ROW_H - 8);
          }
        }
        for (const p of primerOn) {
          if (!p) continue;
          ctx.strokeStyle = p.side === 'F' ? col.fwd : col.rev;
          ctx.lineWidth = 2;
          ctx.strokeRect(x(p.colStart), y + 2, Math.max(2, (p.colEnd - p.colStart) * cellW), ROW_H - 4);
        }
      }
    });

    if (sel && selCols) {
      const y = TOP + sel.row * ROW_H;
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = col.accent;
      ctx.fillRect(x(selCols.from), y + 1, (selCols.to - selCols.from) * cellW, ROW_H - 2);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = col.accent;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x(selCols.from), y + 1, Math.max(1.5, (selCols.to - selCols.from) * cellW), ROW_H - 2);
    }
    ctx.restore();

    // Label column: name, and (in sequence mode) the row's own number for
    // its first base in view.
    ctx.fillStyle = col.base;
    ctx.fillRect(0, 0, labelW, totalH);
    ctx.fillStyle = col.line;
    ctx.fillRect(labelW - 1, TOP, 1, rows.length * ROW_H);
    ctx.font = `11px ${MONO}`;
    ctx.textBaseline = 'middle';
    names.forEach((name, i) => {
      const y = TOP + i * ROW_H + ROW_H / 2 + 0.5;
      ctx.textAlign = 'left';
      ctx.fillStyle = i === hover?.row || i === sel?.row ? col.ink : col.muted;
      ctx.fillText(name, 6, y);
      if (letters) {
        const rb = a.residuesBefore[i];
        if (rb[Math.min(len, last + 1)] > rb[first]) {
          ctx.textAlign = 'right';
          ctx.fillStyle = col.faint;
          ctx.fillText(String(rb[first] + 1), labelW - 6, y);
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selCols derives from sel
  }, [a, rows, names.join('\n'), width, totalH, scrollLeft, cellW, seqW, labelW, letters, len, sel, hover?.row, primers, themeTick]);

  /* ── pointer ─────────────────────────────────────────── */
  function cellAt(clientX: number, clientY: number, clamp = false): { row: number; col: number } | null {
    const cvs = canvasRef.current;
    if (!cvs || len === 0) return null;
    const rect = cvs.getBoundingClientRect();
    const px = clientX - rect.left;
    const row = Math.floor((clientY - rect.top - TOP) / ROW_H);
    // Read live: a drag scrolls the view while its handlers stay the same.
    const left = scrollRef.current?.scrollLeft ?? scrollLeft;
    let c = Math.floor((px - labelW + left) / cellW);
    if (clamp) c = Math.max(0, Math.min(len - 1, c));
    else if (px < labelW || c < 0 || c >= len || row < 0 || row >= rows.length) return null;
    return { row, col: c };
  }

  function onMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    const at = cellAt(e.clientX, e.clientY);
    if (!at) return;
    e.preventDefault();
    const start = { ...at };
    let moved = false;
    setSel({ row: at.row, c0: at.col, c1: at.col });
    const onMove = (ev: MouseEvent) => {
      const el = scrollRef.current;
      if (el) {
        // Dragging past either edge scrolls the view along.
        const r = el.getBoundingClientRect();
        if (ev.clientX > r.right - 16) el.scrollLeft += 24;
        else if (ev.clientX < r.left + labelW + 8) el.scrollLeft -= 24;
      }
      const cur = cellAt(ev.clientX, ev.clientY, true);
      if (!cur) return;
      if (cur.col !== start.col) moved = true;
      setSel({ row: start.row, c0: start.col, c1: cur.col });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!moved) setSel(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }

  const selRow = sel ? rows[sel.row] : null;
  const selBases = selRow && selCols ? rowBases(selRow, selCols.from, selCols.to) : '';

  function menuContent(): { heading: string; error?: string; entries: MenuEntry[] } {
    if (!sel || !selRow || !selCols) return { heading: '', error: 'Select bases first: drag across one sequence row, then right-click the selection.', entries: [] };
    const n = selBases.length;
    const tooShort = n < MIN_PRIMER ? `Select at least ${MIN_PRIMER} bases (this is ${n})` : null;
    const tooLong = n > MAX_PRIMER ? `Primers are analyzed up to ${MAX_PRIMER} bases (this is ${n})` : null;
    const pick: AlignPick = { rowId: selRow.id, colStart: selCols.from, colEnd: selCols.to };
    const done = () => {
      setMenu(null);
      setSel(null);
    };
    return {
      heading: `${n} bp · columns ${fmt(selCols.from + 1)}–${fmt(selCols.to)} · ${selRow.id}`,
      entries: [
        {
          shortcut: 'F',
          label: 'Use as forward primer',
          hint: primers.F ? `replaces ${primers.F.name}` : 'the selected bases, 5′→3′',
          disabledReason: tooShort ?? tooLong,
          onRun: () => {
            onPickPrimer('F', pick);
            done();
          },
        },
        {
          shortcut: 'R',
          label: 'Use as reverse primer',
          hint: primers.R ? `replaces ${primers.R.name}` : 'reverse complement of the selection',
          disabledReason: tooShort ?? tooLong,
          onRun: () => {
            onPickPrimer('R', pick);
            done();
          },
        },
        {
          shortcut: 'D',
          label: 'Set as design column range',
          hint: 'for "Design Primers in Conserved Region"',
          disabledReason: null,
          onRun: () => {
            onSetDesignRange(selCols.from, selCols.to);
            done();
          },
        },
        {
          shortcut: 'C',
          label: 'Copy selected bases',
          disabledReason: navigator.clipboard ? null : 'Clipboard unavailable',
          onRun: () => {
            void navigator.clipboard.writeText(selBases).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
            setMenu(null);
          },
        },
      ],
    };
  }

  /* ── toolbar ─────────────────────────────────────────── */
  const viewCenterCol = (scrollLeft + seqW / 2) / cellW;
  function showSequence() {
    const target = selCols ? (selCols.from + selCols.to) / 2 : viewCenterCol;
    zoomTo(seqW / (len * SEQUENCE_W), seqW / 2, target);
  }

  if (!drawable) {
    return <pre className="sequence-viewer rounded-lg border border-line bg-base p-4 text-xs">{alignment}</pre>;
  }

  const { identical, mismatch, gapColumns } = a.stats;
  const pct = (n: number) => `${((100 * n) / len).toFixed(1)}%`;
  const hoverRow = hover ? rows[hover.row] : null;
  const m = menu ? menuContent() : null;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SegmentedControl
          size="sm"
          ariaLabel="Alignment view"
          value={letters ? 'sequence' : 'overview'}
          onChange={(v) => (v === 'overview' ? zoomTo(1, 0, 0) : showSequence())}
          options={[
            { value: 'overview', label: 'Overview', title: 'Whole alignment: grey bars, red mismatches' },
            { value: 'sequence', label: 'Sequence', title: 'Zoom in to the bases (around the selection, if any)' },
          ]}
        />
        <div className="inline-flex gap-1">
          <Button size="sm" aria-label="Zoom out" title="Zoom out (⌘/Ctrl + scroll also zooms)" disabled={vf >= 1} onClick={() => zoomTo(vf * 1.6)}>
            −
          </Button>
          <Button size="sm" aria-label="Zoom in" title="Zoom in (⌘/Ctrl + scroll also zooms)" disabled={vf <= minFraction} onClick={() => zoomTo(vf / 1.6)}>
            +
          </Button>
        </div>
        <div className="relative">
          <Button size="sm" aria-expanded={rowsOpen} aria-haspopup="true" onClick={() => setRowsOpen((o) => !o)}>
            Rows {rows.length}/{allRows.length} ▾
          </Button>
          {rowsOpen && <RowsPicker rows={allRows} hidden={hiddenRows} onChange={onHiddenRowsChange} onClose={() => setRowsOpen(false)} />}
        </div>
        <span className="ml-auto text-xs text-ink-faint" aria-live="polite">
          {copied
            ? 'Copied'
            : hover && hoverRow
              ? `${hoverRow.id} · column ${fmt(hover.col + 1)}${hoverRow.seq[hover.col] && hoverRow.seq[hover.col] !== '-' ? ` · base ${fmt(a.residuesBefore[hover.row][hover.col] + 1)} (${hoverRow.seq[hover.col]})` : ' · gap'}`
              : sel && selCols
                ? `${selBases.length} bp selected - right-click for primer options`
                : 'Drag across a row to select bases, then right-click'}
        </span>
      </div>
      <p className="mb-2 text-xs text-ink-muted">
        {rows.length} sequences{rows.length < allRows.length ? ` shown (of ${allRows.length})` : ''} · {fmt(len)} columns · <span className="text-ink">{fmt(identical)}</span> identical ({pct(identical)}) ·{' '}
        <span className="aln-mismatch rounded px-0.5">{fmt(mismatch)}</span> mismatch{mismatch === 1 ? '' : 'es'} · {fmt(gapColumns)} with gaps. Mismatches are against each column&apos;s majority among the rows shown.
      </p>
      <div
        ref={scrollRef}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        className="max-h-[520px] overflow-auto rounded-lg border border-line bg-base"
      >
        <div style={{ width: labelW + totalW + RIGHT_PAD, height: totalH }}>
          <canvas
            ref={canvasRef}
            className="sticky left-0 block cursor-text select-none"
            onMouseDown={onMouseDown}
            onContextMenu={onContextMenu}
            onMouseMove={(e) => {
              const at = cellAt(e.clientX, e.clientY);
              setHover((h) => (h?.row === at?.row && h?.col === at?.col ? h : at));
            }}
            onMouseLeave={() => setHover(null)}
            onDoubleClick={(e) => {
              if (letters) return;
              const at = cellAt(e.clientX, e.clientY);
              if (at) zoomTo(seqW / (len * SEQUENCE_W), seqW / 2, at.col);
            }}
          />
        </div>
      </div>
      {m && menu && <SequenceContextMenu x={menu.x} y={menu.y} heading={m.heading} error={m.error} entries={m.entries} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Checkbox list of every aligned sequence; at least one stays shown. */
function RowsPicker({ rows, hidden, onChange, onClose }: { rows: AlignedRow[]; hidden: string[]; onChange: (ids: string[]) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const shown = rows.length - hidden.length;
  return (
    <div ref={ref} className="absolute left-0 top-full z-30 mt-1 max-h-80 w-72 overflow-auto rounded-md border border-line bg-surface p-2 shadow-lg">
      <div className="mb-1 flex gap-1.5 border-b border-line pb-2">
        <Button size="sm" variant="ghost" disabled={hidden.length === 0} onClick={() => onChange([])}>
          Show all
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onChange(rows.slice(1).map((r) => r.id))}>
          First only
        </Button>
      </div>
      <div className="flex flex-col gap-1 pt-1">
        {rows.map((r, i) => {
          const on = !hidden.includes(r.id);
          return (
            <Checkbox
              key={`${i}-${r.id}`}
              checked={on}
              disabled={on && shown <= 1}
              title={r.id}
              label={<span className="truncate font-mono text-xs">{r.id}</span>}
              className="min-w-0"
              onChange={() => onChange(on ? [...hidden, r.id] : hidden.filter((h) => h !== r.id))}
            />
          );
        })}
      </div>
    </div>
  );
}
