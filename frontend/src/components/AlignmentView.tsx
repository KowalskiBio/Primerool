import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { analyzeAlignment, type AlignedRow, type AlignmentAnalysis } from '../utils/alignedFasta';
import { degenerateSite, rowBases, type AlignPick, type AlignPrimers } from '../utils/alignPrimers';
import { degeneracy } from '../utils/iupac';
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
/** Most variants a degenerate primer can have and still be analyzed (the
 * backend's `MAX_ANALYZED_VARIANTS`). */
const MAX_VARIANTS = 512;

/** Per row: its aligned span and prefix counts (length + 1) of mismatches
 * and internal gaps - how many fall in columns `[c0, c1)` is
 * `mis[c1] - mis[c0]`. With a query row (`ref`), a mismatch is a base
 * differing from the query's in that column - the query itself never has
 * any, and bases opposite a query gap are insertions, not mismatches.
 * Without one, it's a base differing from its column's majority - with two
 * sequences, any differing column, both sides. */
interface RowTrack {
  start: number;
  end: number;
  mis: Int32Array;
  gap: Int32Array;
}

function rowTracks(a: AlignmentAnalysis, ref: number): RowTrack[] {
  const pair = a.rows.length === 2;
  const refSeq = ref >= 0 ? a.rows[ref].seq.toUpperCase() : null;
  return a.rows.map((r, i) => {
    const start = r.seq.search(/[^-.]/);
    let end = r.seq.length - 1;
    while (end >= 0 && (r.seq[end] === '-' || r.seq[end] === '.')) end--;
    const mis = new Int32Array(a.length + 1);
    const gap = new Int32Array(a.length + 1);
    for (let c = 0; c < a.length; c++) {
      const b = r.seq[c] ?? '-';
      const isGap = b === '-' || b === '.';
      const q = refSeq?.[c] ?? '-';
      const isMis =
        !isGap &&
        (refSeq ? i !== ref && q !== '-' && q !== '.' && b.toUpperCase() !== q : pair ? !a.conserved[c] && !a.gapped[c] : b !== a.consensus[c]);
      mis[c + 1] = mis[c] + (isMis ? 1 : 0);
      gap[c + 1] = gap[c] + (isGap && c > start && c < end ? 1 : 0);
    }
    return { start, end, mis, gap };
  });
}

type Colors = Record<'base' | 'ink' | 'muted' | 'faint' | 'line' | 'bar' | 'mis' | 'misBg' | 'accent' | 'fwd' | 'fwdBg' | 'rev' | 'revBg', string>;

/** The palette's CSS tokens, read once per theme (not per draw). */
function readColors(el: Element): Colors {
  const s = getComputedStyle(el);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    base: v('--base'),
    ink: v('--ink'),
    muted: v('--ink-muted'),
    faint: v('--ink-faint'),
    line: v('--line'),
    bar: v('--aln-bar'),
    mis: v('--aln-mismatch-ink'),
    misBg: v('--aln-mismatch-bg'),
    accent: v('--accent'),
    fwd: v('--aln-fwd'),
    fwdBg: v('--aln-fwd-bg'),
    rev: v('--aln-rev'),
    revBg: v('--aln-rev-bg'),
  };
}

/** Each base letter rendered once per color and font size into a small
 * canvas, then stamped with `drawImage`. */
class GlyphCache {
  private key = '';
  private map = new Map<string, HTMLCanvasElement>();

  get(ch: string, color: string, fs: number, dpr: number): HTMLCanvasElement {
    const key = `${fs}|${dpr}`;
    if (key !== this.key) {
      this.key = key;
      this.map.clear();
    }
    const id = `${ch}|${color}`;
    let g = this.map.get(id);
    if (!g) {
      g = document.createElement('canvas');
      g.width = Math.ceil(fs * dpr);
      g.height = ROW_H * dpr;
      const ctx = g.getContext('2d')!;
      ctx.font = `${fs * dpr}px ${MONO}`;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ch, g.width / 2, g.height / 2 + 0.5 * dpr);
      this.map.set(id, g);
    }
    return g;
  }
}

/** A 1/2/5 × 10ⁿ ruler step whose ticks stand at least `minCols` apart. */
function niceStep(minCols: number): number {
  for (let p = 1; ; p *= 10) for (const m of [1, 2, 5]) if (m * p >= minCols) return m * p;
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
  /** The reference (query) row's id - the loaded sequence unless swapped;
   * first, marked, and never hidden. */
  queryId?: string | null;
  /** Each other row's percent identity to the query, when there is one. */
  identities?: Map<string, number>;
  /** Row ids taken out of view by the Rows picker. */
  hiddenRows: string[];
  onHiddenRowsChange: (ids: string[]) => void;
  primers: AlignPrimers;
  /** The "Design Primers in Conserved Region" column range `[colStart,
   * colEnd)`; outlined on the map unless it spans the whole alignment. */
  designRange?: { colStart: number; colEnd: number };
  /** `degenerate`: the primer covers every shown sequence's bases. */
  onPickPrimer: (side: 'F' | 'R', pick: AlignPick, degenerate: boolean) => void;
  /** Sets the "Design Primers in Conserved Region" column range. */
  onSetDesignRange: (colStart: number, colEnd: number) => void;
}

/** The alignment as Oligool draws it: one strip per sequence on a shared
 * column axis. Zoomed out it is an overview - each sequence a grey bar
 * over its aligned span, red ticks where a base differs from the query's
 * (without a query, the column's majority), breaks at gaps; zoomed in far enough the bars become letters.
 * Drag across a row to select bases, then right-click to make them a
 * forward or reverse primer. */
export default function AlignmentView({ alignment, rows: allRows, queryId, identities, hiddenRows, onHiddenRowsChange, primers, designRange, onPickPrimer, onSetDesignRange }: Props) {
  const rows = useMemo(() => allRows.filter((r) => r.id === queryId || !hiddenRows.includes(r.id)), [allRows, hiddenRows, queryId]);
  const a = useMemo(() => analyzeAlignment(rows), [rows]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  /** Share of the alignment's columns in view: 1 fits it all. */
  const [viewFraction, setViewFraction] = useState(1);
  /** The zoom and scroll the latest zoom asked for, ahead of React: wheel
   * events can outpace renders, and each must build on the one before. */
  const vfRef = useRef(1);
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
  const queryIndex = rows.findIndex((r) => r.id === queryId);
  const tracks = useMemo(() => rowTracks(a, queryIndex), [a, queryIndex]);

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

  const selCols = sel ? { from: Math.min(sel.c0, sel.c1), to: Math.max(sel.c0, sel.c1) + 1 } : null;

  /* ── drawing ─────────────────────────────────────────── */
  // Drawing runs outside React, at most once per animation frame: scrolling
  // only redraws (no render), and a burst of zoom steps costs one draw.
  const drawRef = useRef<() => void>(() => undefined);
  const frameRef = useRef(0);
  const colorsRef = useRef<{ tick: number; col: Colors } | null>(null);
  const glyphsRef = useRef(new GlyphCache());
  const scheduleDraw = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      drawRef.current();
    });
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    },
    [],
  );

  useLayoutEffect(() => {
    // A zoom resizes the scroll content first; the scroll position it
    // wants can only be applied once that has rendered, or the browser
    // clamps it.
    if (pendingScroll.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
    vfRef.current = vf;

    drawRef.current = () => {
      const cvs = canvasRef.current;
      if (!cvs || width === 0 || len === 0) return;
      const ctx = cvs.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      // Resizing reallocates the canvas: only when its size changed.
      if (cvs.width !== Math.round(width * dpr) || cvs.height !== Math.round(totalH * dpr)) {
        cvs.width = Math.round(width * dpr);
        cvs.height = Math.round(totalH * dpr);
        cvs.style.width = `${width}px`;
        cvs.style.height = `${totalH}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (colorsRef.current?.tick !== themeTick) colorsRef.current = { tick: themeTick, col: readColors(cvs) };
      const col = colorsRef.current.col;
      const scrollLeft = scrollRef.current?.scrollLeft ?? 0;

      ctx.fillStyle = col.base;
      ctx.fillRect(0, 0, width, totalH);

      const first = Math.max(0, Math.floor(scrollLeft / cellW));
      const last = Math.min(len - 1, Math.ceil((scrollLeft + seqW) / cellW));
      const x = (c: number) => labelW + c * cellW - scrollLeft;

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

      // Design column range: a dashed frame down every row.
      if (designRange && designRange.colEnd > designRange.colStart && (designRange.colStart > 0 || designRange.colEnd < len)) {
        const dx = x(designRange.colStart);
        const dw = Math.max(2, (designRange.colEnd - designRange.colStart) * cellW);
        ctx.globalAlpha = 0.06;
        ctx.fillStyle = col.accent;
        ctx.fillRect(dx, TOP, dw, rows.length * ROW_H);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col.accent;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(dx + 0.5, TOP + 0.5, dw - 1, rows.length * ROW_H - 1);
        ctx.setLineDash([]);
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

      const fs = Math.round(Math.min(13, Math.max(9, cellW * 0.85)));
      rows.forEach((r, i) => {
        const y = TOP + i * ROW_H;
        const t = tracks[i];
        const primerOn = [primers.F, primers.R].filter((p): p is NonNullable<typeof p> => p !== null && p.rowId === r.id);
        if (letters) {
          for (let c = first; c <= last; c++) {
            const b = r.seq[c] ?? '-';
            let bg = '';
            let fg = col.ink;
            if (b === '-' || b === '.') fg = col.faint;
            else if (t.mis[c + 1] > t.mis[c]) {
              bg = col.misBg;
              fg = col.mis;
            } else {
              const p = primerOn.find((q) => c >= q.colStart && c < q.colEnd);
              if (p) bg = p.side === 'F' ? col.fwdBg : col.revBg;
            }
            if (bg) {
              ctx.fillStyle = bg;
              ctx.fillRect(x(c), y + 1, cellW + 0.5, ROW_H - 2);
            }
            // Pre-rendered letters: far cheaper than a fillText per base.
            const g = glyphsRef.current.get(b, fg, fs, dpr);
            const gw = g.width / dpr;
            ctx.drawImage(g, x(c) + (cellW - gw) / 2, y, gw, ROW_H);
          }
        } else {
          // Grey bar over the row's aligned span, then mismatches in red and
          // gaps cut out of it - read off prefix counts, so a pixel holding
          // many columns costs the same as one holding a single column.
          if (t.start >= 0) {
            ctx.fillStyle = col.bar;
            ctx.fillRect(x(t.start), y + 4, (t.end - t.start + 1) * cellW, ROW_H - 8);
          }
          const mark = (px: number, w: number, c0: number, c1: number) => {
            if (t.mis[c1] > t.mis[c0]) {
              ctx.fillStyle = col.mis;
              ctx.fillRect(px, y + 2, w, ROW_H - 4);
            } else if (t.gap[c1] > t.gap[c0]) {
              ctx.fillStyle = col.base;
              ctx.fillRect(px, y + 4, w, ROW_H - 8);
            }
          };
          if (cellW >= 1) {
            for (let c = first; c <= last; c++) mark(x(c), cellW, c, c + 1);
          } else {
            for (let px = 0; px < seqW; px++) {
              const c0 = Math.floor((scrollLeft + px) / cellW);
              if (c0 >= len) break;
              const c1 = Math.min(len, Math.max(c0 + 1, Math.floor((scrollLeft + px + 1) / cellW)));
              mark(labelW + px, 1, c0, c1);
            }
          }
          for (const p of primerOn) {
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
        const isQuery = rows[i].id === queryId;
        ctx.fillStyle = isQuery ? col.accent : i === hover?.row || i === sel?.row ? col.ink : col.muted;
        ctx.font = `${isQuery ? '600 ' : ''}11px ${MONO}`;
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
    };
  });

  useEffect(() => {
    scheduleDraw();
  }, [scheduleDraw, a, tracks, rows, width, totalH, vf, labelW, sel, hover?.row, primers, designRange?.colStart, designRange?.colEnd, themeTick]);

  /** Zooms to `nextFraction`, keeping the column under `anchorPx` (from
   * the sequence area's left edge) where it is. */
  function zoomTo(nextFraction: number, anchorPx = seqW / 2, anchorCol?: number) {
    if (len === 0) return;
    const curVf = vfRef.current;
    const curLeft = pendingScroll.current ?? scrollRef.current?.scrollLeft ?? 0;
    const next = Math.max(minFraction, Math.min(1, nextFraction));
    const col = anchorCol ?? (curLeft + anchorPx) / (seqW / curVf / len);
    const nextTotal = seqW / next;
    pendingScroll.current = Math.max(0, Math.min(nextTotal - seqW, (col * nextTotal) / len - anchorPx));
    vfRef.current = next;
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
      zoomTo(vfRef.current * Math.exp(e.deltaY * 0.01), Math.max(0, Math.min(seqW, x)));
    };
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => onWheelRef.current(e);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [drawable]);

  /* ── pointer ─────────────────────────────────────────── */
  function cellAt(clientX: number, clientY: number, clamp = false): { row: number; col: number } | null {
    const cvs = canvasRef.current;
    if (!cvs || len === 0) return null;
    const rect = cvs.getBoundingClientRect();
    const px = clientX - rect.left;
    const row = Math.floor((clientY - rect.top - TOP) / ROW_H);
    // Read live: a drag scrolls the view while its handlers stay the same.
    const left = scrollRef.current?.scrollLeft ?? 0;
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
    // The selection stays on the map after an action; a click elsewhere
    // (or a new drag) clears it.
    const done = () => setMenu(null);

    /** The same pick widened to every shown sequence's bases (IUPAC). */
    function degenerateEntry(): MenuEntry {
      const site = degenerateSite(rows, selCols!.from, selCols!.to);
      const n = site.replace(/-/g, '').length;
      const fold = degeneracy(site);
      const reason =
        n < MIN_PRIMER
          ? `Select at least ${MIN_PRIMER} bases (this is ${n})`
          : n > MAX_PRIMER
            ? `Primers are analyzed up to ${MAX_PRIMER} bases (this is ${n})`
            : fold > MAX_VARIANTS
              ? `${fmt(fold)}-fold degenerate - too many variants to analyze (max ${MAX_VARIANTS})`
              : null;
      const hint = fold === 1 ? 'no variation here - same as a plain primer' : `${fmt(fold)}-fold over the ${rows.length} sequences shown`;
      const run = (side: 'F' | 'R') => () => {
        onPickPrimer(side, pick, true);
        done();
      };
      return {
        shortcut: 'G',
        label: 'Degenerate primer',
        hint,
        disabledReason: reason,
        submenu: [
          { shortcut: 'F', label: 'Degenerate forward primer', hint: site.replace(/-/g, ''), disabledReason: null, onRun: run('F') },
          { shortcut: 'R', label: 'Degenerate reverse primer', hint: 'reverse complement, IUPAC-aware', disabledReason: null, onRun: run('R') },
        ],
      };
    }
    return {
      heading: `${n} bp · columns ${fmt(selCols.from + 1)}–${fmt(selCols.to)} · ${selRow.id}`,
      entries: [
        {
          shortcut: 'F',
          label: 'Use as forward primer',
          hint: primers.F ? `replaces ${primers.F.name}` : 'the selected bases, 5′→3′',
          disabledReason: tooShort ?? tooLong,
          onRun: () => {
            onPickPrimer('F', pick, false);
            done();
          },
        },
        {
          shortcut: 'R',
          label: 'Use as reverse primer',
          hint: primers.R ? `replaces ${primers.R.name}` : 'reverse complement of the selection',
          disabledReason: tooShort ?? tooLong,
          onRun: () => {
            onPickPrimer('R', pick, false);
            done();
          },
        },
        degenerateEntry(),
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
  const viewCenterCol = ((scrollRef.current?.scrollLeft ?? 0) + seqW / 2) / cellW;
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
          {rowsOpen && <RowsPicker rows={allRows} queryId={queryId} identities={identities} hidden={hiddenRows} onChange={onHiddenRowsChange} onClose={() => setRowsOpen(false)} />}
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
        <span className="aln-mismatch rounded px-0.5">{fmt(mismatch)}</span> mismatch{mismatch === 1 ? '' : 'es'} · {fmt(gapColumns)} with gaps. {queryIndex >= 0 ? 'Red bases differ from the reference (first row).' : <>Mismatches are against each column&apos;s majority among the rows shown.</>}
      </p>
      <div
        ref={scrollRef}
        onScroll={scheduleDraw}
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
function RowsPicker({
  rows,
  queryId,
  identities,
  hidden,
  onChange,
  onClose,
}: {
  rows: AlignedRow[];
  queryId?: string | null;
  identities?: Map<string, number>;
  hidden: string[]; onChange: (ids: string[]) => void; onClose: () => void }) {
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
          {queryId ? 'Reference only' : 'First only'}
        </Button>
      </div>
      <div className="flex flex-col gap-1 pt-1">
        {rows.map((r, i) => {
          const isQuery = r.id === queryId;
          const on = isQuery || !hidden.includes(r.id);
          return (
            <Checkbox
              key={`${i}-${r.id}`}
              checked={on}
              disabled={isQuery || (on && shown <= 1)}
              title={isQuery ? 'The reference always stays shown' : r.id}
              label={
                <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-xs">{r.id}</span>
                  {identities?.has(r.id) && (
                    <span className="shrink-0 text-[11px] tabular-nums text-ink-faint" title="Identity to the reference, over the columns both have a base">
                      {identities.get(r.id)!.toFixed(1)}%
                    </span>
                  )}
                </span>
              }
              className="min-w-0 w-full"
              onChange={() => onChange(on ? [...hidden, r.id] : hidden.filter((h) => h !== r.id))}
            />
          );
        })}
      </div>
    </div>
  );
}
