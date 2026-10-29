import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { analyzeAlignment, type AlignedRow, type AlignmentAnalysis } from '../utils/alignedFasta';
import { degenerateSite, rowBases, type AlignPick, type AlignPrimers } from '../utils/alignPrimers';
import { degeneracy } from '../utils/iupac';
import SequenceContextMenu, { type MenuEntry } from './SequenceContextMenu';
import SegmentedControl from './ui/SegmentedControl';
import Button from './ui/Button';
import Checkbox from './ui/Checkbox';

const fmt = (n: number) => n.toLocaleString('en-US');

const NAME_MAX = 28;
const ROW_H = 22;
const RULER_H = 24;
/** Width of a label character at the 12px label font. */
const LABEL_CH = 7.3;
/** Oligool's overview navigator above the rows: the whole alignment,
 * the part in view boxed. */
const MINIMAP_H = 52;
/** A minimap box edge grabs within this many pixels. */
const HANDLE_PX = 8;
/** A right-drag zooms once it spans this many columns; shorter is a
 * right-click (the primer menu). */
const MIN_ZOOM_COLS = 5;
/** Strip above the rows marking the picked F/R primers' columns. */
const PRIMER_TRACK_H = 10;
const TOP = RULER_H + PRIMER_TRACK_H;
const RIGHT_PAD = 8;
/** Columns at least this wide show their letters (sequence mode); narrower
 * ones draw as Oligool's grey bars with red mismatch ticks (overview). */
const LETTER_W = 9;
/** Column width the "Sequence" toggle zooms to; the most zoom allows. */
const SEQUENCE_W = 14;
const MAX_W = 22;
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

type Colors = Record<'base' | 'surface2' | 'ink' | 'muted' | 'faint' | 'line' | 'bar' | 'mis' | 'misBg' | 'accent' | 'zoom' | 'fwd' | 'fwdBg' | 'rev' | 'revBg', string>;

/** The palette's CSS tokens, read once per theme (not per draw). */
function readColors(el: Element): Colors {
  const s = getComputedStyle(el);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    base: v('--base'),
    surface2: v('--surface-2'),
    ink: v('--ink'),
    muted: v('--ink-muted'),
    faint: v('--ink-faint'),
    line: v('--line'),
    bar: v('--aln-bar'),
    mis: v('--aln-mismatch-ink'),
    misBg: v('--aln-mismatch-bg'),
    accent: v('--accent'),
    zoom: v('--success'),
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

/** Prefix counts (length + 1) over columns of the rows mismatching there:
 * the minimap's red density. */
function columnMismatches(tracks: RowTrack[], len: number): Int32Array {
  const out = new Int32Array(len + 1);
  for (let c = 0; c < len; c++) {
    let n = 0;
    for (const t of tracks) if (t.mis[c + 1] > t.mis[c]) n++;
    out[c + 1] = out[c] + n;
  }
  return out;
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
  /** Column ranges `[colStart, colEnd)` of a designed primer (or pair)
   * picked in the results below: banded down every row, and scrolled to. */
  highlight?: { colStart: number; colEnd: number }[] | null;
}

/** The alignment as Oligool draws it: one strip per sequence on a shared
 * column axis. Zoomed out it is an overview - each sequence a grey bar
 * over its aligned span, red ticks where a base differs from the query's
 * (without a query, the column's majority), breaks at gaps; zoomed in far enough the bars become letters.
 * Zooming works as in Oligool: right-drag across columns zooms to them,
 * the minimap above zooms to a dragged range (its box's edges resize the
 * view), and ⌘/Ctrl + wheel zooms at the pointer. Drag across a row to
 * select bases, then right-click to make them a forward or reverse primer. */
export default function AlignmentView({ alignment, rows: allRows, queryId, identities, hiddenRows, onHiddenRowsChange, primers, designRange, onPickPrimer, onSetDesignRange, highlight }: Props) {
  const rows = useMemo(() => allRows.filter((r) => r.id === queryId || !hiddenRows.includes(r.id)), [allRows, hiddenRows, queryId]);
  const a = useMemo(() => analyzeAlignment(rows), [rows]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
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
  /** A right-drag's columns, zoomed to on release. */
  const [zoomDrag, setZoomDrag] = useState<{ c0: number; c1: number } | null>(null);
  /** A minimap drag's range, as fractions of the alignment. */
  const [miniSel, setMiniSel] = useState<{ f0: number; f1: number } | null>(null);
  /** While the right button is down on the map; then whether the browser's
   * contextmenu event (before or after the release, by platform) is spent. */
  const rightDownRef = useRef(false);
  const ctxSpentRef = useRef(false);
  const [rowsOpen, setRowsOpen] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  const [copied, setCopied] = useState(false);

  const names = rows.map((r) => (r.id.length > NAME_MAX ? `${r.id.slice(0, NAME_MAX - 1)}…` : r.id));
  const numW = String(Math.max(0, ...a.residuesBefore.map((rb) => rb[a.length] ?? 0))).length;
  const labelW = Math.ceil(Math.max(...names.map((n) => n.length), 8) * LABEL_CH + numW * LABEL_CH + 24);
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
  const colMis = useMemo(() => columnMismatches(tracks, len), [tracks, len]);

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

      // Highlighted designed primer(s): a stronger band, outlined.
      for (const h of highlight ?? []) {
        const hx = x(h.colStart);
        const hw = Math.max(2, (h.colEnd - h.colStart) * cellW);
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = col.accent;
        ctx.fillRect(hx, RULER_H, hw, PRIMER_TRACK_H + rows.length * ROW_H);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col.accent;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(hx + 0.75, RULER_H + 0.75, hw - 1.5, PRIMER_TRACK_H + rows.length * ROW_H - 1.5);
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

      const fs = Math.round(Math.min(15, Math.max(10, cellW * 0.85)));
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

      // A right-drag's columns, about to be zoomed to.
      if (zoomDrag) {
        const z0 = Math.min(zoomDrag.c0, zoomDrag.c1);
        const zw = (Math.abs(zoomDrag.c1 - zoomDrag.c0) + 1) * cellW;
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = col.zoom;
        ctx.fillRect(x(z0), 0, zw, totalH);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col.zoom;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x(z0) + 0.75, 0.75, zw - 1.5, totalH - 1.5);
      }
      ctx.restore();

      // Label column: name, and (in sequence mode) the row's own number for
      // its first base in view.
      ctx.fillStyle = col.base;
      ctx.fillRect(0, 0, labelW, totalH);
      ctx.fillStyle = col.line;
      ctx.fillRect(labelW - 1, TOP, 1, rows.length * ROW_H);
      ctx.font = `12px ${MONO}`;
      ctx.textBaseline = 'middle';
      names.forEach((name, i) => {
        const y = TOP + i * ROW_H + ROW_H / 2 + 0.5;
        ctx.textAlign = 'left';
        const isQuery = rows[i].id === queryId;
        ctx.fillStyle = isQuery ? col.accent : i === hover?.row || i === sel?.row ? col.ink : col.muted;
        ctx.font = `${isQuery ? '600 ' : ''}12px ${MONO}`;
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

      drawMinimap(col, dpr, scrollLeft);
    };
  });

  /** The minimap: every column squeezed into the sequence area's width -
   * a grey strip with red bars as tall as the share of rows mismatching
   * there - with the part in view boxed. */
  function drawMinimap(col: Colors, dpr: number, scrollLeft: number) {
    const cvs = minimapRef.current;
    const ctx = cvs?.getContext('2d');
    if (!cvs || !ctx) return;
    if (cvs.width !== Math.round(width * dpr) || cvs.height !== Math.round(MINIMAP_H * dpr)) {
      cvs.width = Math.round(width * dpr);
      cvs.height = Math.round(MINIMAP_H * dpr);
      cvs.style.width = `${width}px`;
      cvs.style.height = `${MINIMAP_H}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = col.surface2;
    ctx.fillRect(0, 0, width, MINIMAP_H);
    ctx.font = `11px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = col.faint;
    ctx.fillText('Overview', 6, MINIMAP_H / 2);

    const top = 6;
    const h = MINIMAP_H - 12;
    ctx.fillStyle = col.bar;
    ctx.fillRect(labelW, top + h / 2 - 3, seqW, 6);
    const n = rows.length;
    ctx.fillStyle = col.mis;
    for (let px = 0; px < seqW; px++) {
      const c0 = Math.floor((px / seqW) * len);
      const c1 = Math.max(c0 + 1, Math.floor(((px + 1) / seqW) * len));
      const m = colMis[Math.min(len, c1)] - colMis[c0];
      if (m === 0) continue;
      const share = m / ((c1 - c0) * n);
      const bh = Math.max(2, h * Math.sqrt(share));
      ctx.fillRect(labelW + px, top + (h - bh) / 2, 1, bh);
    }

    const box = (f0: number, f1: number, color: string) => {
      const bx = labelW + f0 * seqW;
      const bw = Math.max(2, (f1 - f0) * seqW);
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = color;
      ctx.fillRect(bx, 1, bw, MINIMAP_H - 2);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx + 0.75, 1.75, bw - 1.5, MINIMAP_H - 3.5);
    };
    if (vf < 0.999) {
      const f0 = scrollLeft / totalW;
      box(f0, Math.min(1, f0 + vf), col.accent);
    }
    if (miniSel) box(Math.min(miniSel.f0, miniSel.f1), Math.max(miniSel.f0, miniSel.f1), col.zoom);
  }

  useEffect(() => {
    scheduleDraw();
  }, [scheduleDraw, a, tracks, colMis, rows, width, totalH, vf, labelW, sel, hover?.row, primers, designRange?.colStart, designRange?.colEnd, highlight, themeTick, zoomDrag, miniSel]);

  // A newly highlighted primer: bring the map on screen and, when the
  // highlight lies outside the columns in view, center it horizontally.
  useEffect(() => {
    if (!highlight?.length) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const from = Math.min(...highlight.map((h) => h.colStart)) * cellW;
    const to = Math.max(...highlight.map((h) => h.colEnd)) * cellW;
    if (from < el.scrollLeft || to > el.scrollLeft + seqW) el.scrollLeft = Math.max(0, (from + to) / 2 - seqW / 2);
    // Only on a new highlight - not on every zoom or resize after it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight]);

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

  /** Zooms so columns `[c0, c1]` fill the view. */
  function zoomToColumns(c0: number, c1: number) {
    zoomTo((c1 - c0 + 1) / len, 0, c0);
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

  /** The column under `clientX`, clamped to the alignment. */
  function colAt(clientX: number): number {
    const rect = canvasRef.current!.getBoundingClientRect();
    const c = Math.floor((clientX - rect.left - labelW + (scrollRef.current?.scrollLeft ?? 0)) / cellW);
    return Math.max(0, Math.min(len - 1, c));
  }

  /** Right button: a drag across columns zooms to them (as in Oligool); a
   * plain right-click opens the primer menu on release. */
  function onRightDown(e: React.MouseEvent) {
    e.preventDefault();
    rightDownRef.current = true;
    ctxSpentRef.current = false;
    const rect = canvasRef.current!.getBoundingClientRect();
    const onSeq = e.clientX - rect.left >= labelW;
    const c0 = onSeq ? colAt(e.clientX) : -1;
    let c1 = c0;
    const finish = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', finish);
      rightDownRef.current = false;
      setZoomDrag(null);
      // Linux/macOS fire contextmenu at the press, Windows after the
      // release: either way it's handled here, so the next one is spent.
      ctxSpentRef.current = true;
      setTimeout(() => (ctxSpentRef.current = false), 300);
      if (c0 >= 0 && Math.abs(c1 - c0) + 1 >= MIN_ZOOM_COLS) zoomToColumns(Math.min(c0, c1), Math.max(c0, c1));
      else setMenu({ x: ev.clientX, y: ev.clientY });
    };
    const onMove = (ev: MouseEvent) => {
      // Released outside the window: finish here rather than leak.
      if (!(ev.buttons & 2)) return finish(ev);
      if (c0 < 0) return;
      c1 = colAt(ev.clientX);
      setZoomDrag(Math.abs(c1 - c0) + 1 >= MIN_ZOOM_COLS ? { c0, c1 } : null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', finish);
  }

  function onMouseDown(e: React.MouseEvent) {
    if (e.button === 2) return onRightDown(e);
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
    // A mouse right-click is handled on its release (`onRightDown`); this
    // opens the menu only from the keyboard's menu key.
    if (rightDownRef.current || ctxSpentRef.current) {
      ctxSpentRef.current = false;
      return;
    }
    setMenu({ x: e.clientX, y: e.clientY });
  }

  /* ── minimap ─────────────────────────────────────────── */
  /** Where `clientX` falls along the whole alignment, 0-1. */
  function miniFrac(clientX: number): number {
    const rect = minimapRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left - labelW) / seqW));
  }

  /** The view's span along the alignment, 0-1. */
  function viewSpan() {
    const f0 = (scrollRef.current?.scrollLeft ?? 0) / totalW;
    return { f0, f1: Math.min(1, f0 + vf), boxed: vf < 0.999 };
  }

  function miniGrab(clientX: number): 'left' | 'right' | 'select' {
    const f = miniFrac(clientX);
    const { f0, f1, boxed } = viewSpan();
    const zone = HANDLE_PX / seqW;
    if (boxed && Math.abs(f - f0) < zone && f < f1) return 'left';
    if (boxed && Math.abs(f - f1) < zone && f > f0) return 'right';
    return 'select';
  }

  /** Oligool's minimap: drag a range to zoom to it, drag the box's edges
   * to resize the view; a plain click centers the view there. */
  function onMinimapDown(e: React.MouseEvent) {
    if (e.button !== 0 || len === 0) return;
    e.preventDefault();
    const grab = miniGrab(e.clientX);
    const start = miniFrac(e.clientX);
    const { f0, f1 } = viewSpan();
    const minSpan = minFraction;
    let cur = start;
    if (grab === 'select') setMiniSel({ f0: start, f1: start });
    const onMove = (ev: MouseEvent) => {
      if (!(ev.buttons & 1)) return onUp();
      cur = miniFrac(ev.clientX);
      if (grab === 'select') setMiniSel({ f0: start, f1: cur });
      else if (grab === 'left') {
        const s = Math.max(0, Math.min(cur, f1 - minSpan));
        zoomTo(f1 - s, 0, s * len);
      } else {
        const end = Math.min(1, Math.max(cur, f0 + minSpan));
        zoomTo(end - f0, 0, f0 * len);
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (grab !== 'select') return;
      setMiniSel(null);
      const lo = Math.min(start, cur);
      const hi = Math.max(start, cur);
      if ((hi - lo) * len >= MIN_ZOOM_COLS && (hi - lo) * seqW >= 3) zoomTo(hi - lo, 0, lo * len);
      else zoomTo(vfRef.current, seqW / 2, start * len);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
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
  // Zoom on a log scale: 0 is the whole alignment, 1000 the closest zoom.
  const zoomSlider = minFraction < 1 ? Math.round((1000 * Math.log(vf)) / Math.log(minFraction)) : 0;
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
          <input
            type="range"
            aria-label="Zoom"
            title="Zoom"
            min={0}
            max={1000}
            value={zoomSlider}
            onChange={(e) => zoomTo(Math.exp((Number(e.target.value) / 1000) * Math.log(minFraction)))}
            className="mx-1 w-28 accent-accent"
          />
          <Button size="sm" aria-label="Zoom in" title="Zoom in (⌘/Ctrl + scroll also zooms)" disabled={vf <= minFraction} onClick={() => zoomTo(vf / 1.6)}>
            +
          </Button>
          <span className="ml-1 w-24 self-center text-xs tabular-nums text-ink-faint">{fmt(Math.round(vf * len))} bp in view</span>
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
                : 'Right-drag to zoom · drag across a row to select bases, then right-click'}
        </span>
      </div>
      <p className="mb-2 text-xs text-ink-muted">
        {rows.length} sequences{rows.length < allRows.length ? ` shown (of ${allRows.length})` : ''} · {fmt(len)} columns · <span className="text-ink">{fmt(identical)}</span> identical ({pct(identical)}) ·{' '}
        <span className="aln-mismatch rounded px-0.5">{fmt(mismatch)}</span> mismatch{mismatch === 1 ? '' : 'es'} · {fmt(gapColumns)} with gaps. {queryIndex >= 0 ? 'Red bases differ from the reference (first row).' : <>Mismatches are against each column&apos;s majority among the rows shown.</>}
      </p>
      <canvas
        ref={minimapRef}
        className="block cursor-crosshair select-none rounded-t-lg border border-b-0 border-line"
        title="Drag a range to zoom to it; drag the box's edges to resize the view"
        onMouseDown={onMinimapDown}
        onMouseMove={(e) => {
          const g = miniGrab(e.clientX);
          e.currentTarget.style.cursor = g === 'select' ? 'crosshair' : 'ew-resize';
        }}
      />
      <div
        ref={scrollRef}
        onScroll={scheduleDraw}
        className="max-h-[75vh] overflow-auto rounded-b-lg border border-line bg-base"
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
