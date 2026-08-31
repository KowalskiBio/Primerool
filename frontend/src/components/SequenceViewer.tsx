import { useEffect, useMemo, useRef, useState } from 'react';
import type { SequenceData } from '../api/sequence';
import type { Selection, Selections } from '../utils/regionMapping';
import { mapPrimerToGenomic } from '../utils/regionMapping';
import { reverseComplement } from '../utils/dna';
import { analyzePrimer } from '../api/design';

interface Segment {
  text: string;
  className: string;
  id?: string;
  /** Present iff these chars belong to (or buffer) an interactively
   * editable primer/probe selection — see `INTERACTIVE_KEYS` below. */
  key?: keyof Selections;
  /** True for the padding chars carved out on either side of an editable
   * primer/probe (see `DRAG_BUFFER`) — rendered with the surrounding
   * region's normal styling until a drag actually grows into them. */
  isBuffer?: boolean;
  /** What this segment would render as if it weren't highlighted — only
   * set on editable/buffer segments, used to restore a char's look when a
   * live drag shrinks the primer away from it. */
  fallbackClassName?: string;
  /** Local index (into the rawSeq/gene_seq this segment was sliced from) of
   * its first character — for editable segments this is always in the same
   * coordinate space as the owning `Selection.start`/`end`. */
  startPos: number;
}

/** Extra characters carved out on each side of an editable primer/probe's
 * highlighted span, sourced from the same chunk of sequence, so a drag can
 * grow the primer without needing to re-render neighboring segments. This
 * is also what bounds how far a single drag gesture can widen/move a
 * primer — dragging further requires picking a new candidate from the
 * design panels instead. */
const DRAG_BUFFER = 15;

/** Splits `rawSeq` into ordered, non-overlapping segments given a set of
 * (possibly-overlapping-but-pre-sorted) highlight intervals, each in
 * `[0, rawSeq.length)` local coordinates. Shared by both the flank and
 * gene-block renderers below — the legacy app duplicated this
 * merge-and-slice loop three times with copy-pasted off-by-one-prone
 * arithmetic; collapsed into one function here.
 *
 * `baseOffset` shifts every `startPos` this produces by a fixed amount —
 * needed because `geneBlockSegments` calls this once per exon/CDS/UTR/
 * intron chunk of `gene_seq`, each starting at a different absolute gene
 * position, but positions must come out in that absolute space to line up
 * with `Selection.start`/`end`.
 *
 * When an interval carries a `key` (i.e. its selection is interactively
 * editable), up to `DRAG_BUFFER` extra characters immediately before/after
 * it are carved out as separate "buffer" segments tagged with the same
 * `key` — see `DRAG_BUFFER`'s doc comment. */
function sliceWithIntervals(rawSeq: string, intervals: { start: number; end: number; className: string; id?: string; key?: keyof Selections }[], baseClassName: string, baseOffset = 0): Segment[] {
  if (intervals.length === 0) return [{ text: rawSeq, className: baseClassName, startPos: baseOffset }];

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let cur = 0;
  for (const iv of sorted) {
    const s = Math.max(0, Math.max(cur, iv.start));
    const e = Math.min(rawSeq.length, iv.end);
    if (e <= s) continue;

    if (s > cur) {
      const bufStart = iv.key ? Math.max(cur, s - DRAG_BUFFER) : s;
      if (bufStart > cur) segments.push({ text: rawSeq.substring(cur, bufStart), className: baseClassName, startPos: baseOffset + cur });
      if (iv.key && bufStart < s) {
        segments.push({ text: rawSeq.substring(bufStart, s), className: baseClassName, key: iv.key, isBuffer: true, fallbackClassName: baseClassName, startPos: baseOffset + bufStart });
      }
    }

    segments.push({ text: rawSeq.substring(s, e), className: iv.className, id: iv.id, key: iv.key, fallbackClassName: iv.key ? baseClassName : undefined, startPos: baseOffset + s });
    cur = e;

    if (iv.key) {
      const bufEnd = Math.min(rawSeq.length, cur + DRAG_BUFFER);
      if (bufEnd > cur) {
        segments.push({ text: rawSeq.substring(cur, bufEnd), className: baseClassName, key: iv.key, isBuffer: true, fallbackClassName: baseClassName, startPos: baseOffset + cur });
        cur = bufEnd;
      }
    }
  }
  if (cur < rawSeq.length) segments.push({ text: rawSeq.substring(cur), className: baseClassName, startPos: baseOffset + cur });
  return segments;
}

function flankSegments(rawSeq: string, regionName: 'up' | 'down', data: SequenceData, sel: Selections): Segment[] {
  const intervals: { start: number; end: number; className: string; key?: keyof Selections }[] = [];
  // Both WGA picks are checked against this flank independently, matching
  // the legacy app — a forward pick normally lands in 'up' and a reverse
  // pick in 'down', but nothing prevents either from landing in either.
  // Editable (own-region render, local coords === Selection coords).
  const wgaEntries: [keyof Selections, Selection | null][] = [
    ['wgaForward', sel.wgaForward],
    ['wgaReverse', sel.wgaReverse],
  ];
  for (const [key, p] of wgaEntries) {
    if (p && p.region === regionName) intervals.push({ start: p.start, end: p.end, className: 'seq-primer', key });
  }

  const upLen = data.upstream_len;
  const geneLen = data.gene_len;
  const checkOverlap = (p: Selection | null) => {
    if (!p || p.region !== 'gene') return;
    let s: number, e: number;
    if (regionName === 'up') {
      s = p.start + upLen;
      e = p.end + upLen;
    } else {
      s = p.start - geneLen;
      e = p.end - geneLen;
    }
    // Not editable here: this is a gene-region primer bleeding across the
    // flank/gene boundary, rendered from a different coordinate space than
    // this flank's own — dragging it here would need cross-region
    // coordinate translation, which v1 doesn't support (see `App.tsx`'s
    // `onSelect` wiring notes).
    if (e > 0 && s < rawSeq.length) intervals.push({ start: s, end: e, className: 'seq-primer' });
  };
  checkOverlap(sel.geneForward);
  checkOverlap(sel.geneReverse);
  checkOverlap(sel.geneProbe);

  const inner = sliceWithIntervals(rawSeq, intervals, '');
  // Wrap the whole flank in `seq-flank` (matches legacy: unhighlighted text
  // is flank-gray, highlighted spans override with seq-primer).
  return inner.map((s) => (s.className ? s : { ...s, className: 'seq-flank', fallbackClassName: s.key ? 'seq-flank' : s.fallbackClassName }));
}

function isInCDS(pos: number, cdsIntervals: [number, number][]): boolean {
  for (const [s, e] of cdsIntervals) {
    if (pos < s) return false;
    if (pos >= s && pos < e) return true;
  }
  return false;
}

function geneBlockSegments(data: SequenceData, sel: Selections, truncateIntrons: boolean): Segment[] {
  const seq = data.gene_seq || '';
  if (!seq) return [];

  function highlightIntervalsFor(segStart: number, segLen: number): { start: number; end: number; className: string; key?: keyof Selections }[] {
    const out: { start: number; end: number; className: string; key?: keyof Selections }[] = [];
    const add = (p: Selection | null, cls: string, key?: keyof Selections) => {
      if (!p) return;
      for (const r of mapPrimerToGenomic(p, data)) {
        const s = Math.max(segStart, r.start);
        const e = Math.min(segStart + segLen, r.end);
        // Only the primer's own 'gene'-region render is editable — local
        // coords here equal `Selection.start`/`end` exactly in that case.
        // wga/junction selections bleeding into the gene block (across the
        // flank boundary, or across exon splices) render read-only.
        if (e > s) out.push({ start: s - segStart, end: e - segStart, className: cls, key: p.region === 'gene' ? key : undefined });
      }
    };
    add(sel.wgaForward, 'seq-primer');
    add(sel.wgaReverse, 'seq-primer');
    add(sel.juncLeft, 'seq-primer');
    add(sel.juncRight, 'seq-primer');
    add(sel.geneForward, 'seq-primer', 'geneForward');
    add(sel.geneReverse, 'seq-primer', 'geneReverse');
    add(sel.geneProbe, 'seq-probe', 'geneProbe');
    add(sel.armsRefPrimer, 'seq-primer', 'armsRefPrimer');
    add(sel.armsAltPrimer, 'seq-primer', 'armsAltPrimer');
    add(sel.armsCommon, 'seq-primer', 'armsCommon');
    return out;
  }

  function wrapHighlights(segmentSeq: string, startOffset: number, baseClassName: string, id?: string): Segment[] {
    const intervals = highlightIntervalsFor(startOffset, segmentSeq.length);
    const inner = sliceWithIntervals(segmentSeq, intervals, baseClassName, startOffset);
    if (id && inner.length > 0) inner[0] = { ...inner[0], id };
    return inner;
  }

  const exons = (data.annotations || []).filter((a) => a.type === 'exon');

  if (data.include_introns && exons.length > 0) {
    const exonIntervals = exons.map((a): [number, number] => [a.start, a.end]).sort((x, y) => x[0] - y[0]);
    const cdsIntervals = (data.annotations || [])
      .filter((a) => a.type === 'cds')
      .map((a): [number, number] => [a.start, a.end])
      .sort((x, y) => x[0] - y[0]);

    const segments: Segment[] = [];
    let last = 0;

    const pushIntron = (intronSeq: string, offset: number) => {
      if (truncateIntrons) {
        segments.push({ text: `...intron ${intronSeq.length}bp...`, className: 'seq-intron-placeholder', startPos: offset });
      } else {
        segments.push(...wrapHighlights(intronSeq, offset, 'seq-intron'));
      }
    };

    for (const [exS, exE] of exonIntervals) {
      if (exS > last) pushIntron(seq.substring(last, exS), last);

      let i = exS;
      while (i < exE) {
        const inCds = isInCDS(i, cdsIntervals);
        let j = i + 1;
        while (j < exE && isInCDS(j, cdsIntervals) === inCds) j++;
        const chunk = seq.substring(i, j);
        segments.push(...wrapHighlights(chunk, i, inCds ? 'seq-cds' : 'seq-utr', `seq-region-${i}`));
        i = j;
      }
      last = exE;
    }
    if (last < seq.length) pushIntron(seq.substring(last), last);

    return segments;
  }

  const cdsAnn = (data.annotations || []).filter((a) => a.type === 'cds').sort((a, b) => a.start - b.start);
  if (cdsAnn.length > 0) {
    const segments: Segment[] = [];
    let last = 0;
    for (const a of cdsAnn) {
      if (a.start > last) segments.push(...wrapHighlights(seq.substring(last, a.start), last, 'seq-utr'));
      segments.push(...wrapHighlights(seq.substring(a.start, a.end), a.start, 'seq-cds', `seq-region-${a.start}`));
      last = a.end;
    }
    if (last < seq.length) segments.push(...wrapHighlights(seq.substring(last), last, 'seq-utr'));
    return segments;
  }

  // No CDS annotations at all (e.g. a custom pasted sequence): plain
  // sequence, still highlighting any gene-region selections directly.
  return wrapHighlights(seq, 0, data.include_utr ? 'seq-utr' : 'seq-cds');
}

const PRIMER_LEN_BOUNDS: [number, number] = [18, 25];
const PROBE_LEN_BOUNDS: [number, number] = [18, 30];

function lenBounds(key: keyof Selections): [number, number] {
  return key === 'geneProbe' ? PROBE_LEN_BOUNDS : PRIMER_LEN_BOUNDS;
}

function colorClassName(key: keyof Selections): string {
  return key === 'geneProbe' ? 'seq-probe' : 'seq-primer';
}

function regionRawSeq(data: SequenceData, region: Selection['region']): string {
  if (region === 'up') return data.upstream_seq || '';
  if (region === 'down') return data.downstream_seq || '';
  return data.gene_seq || '';
}

interface DragSession {
  selKey: keyof Selections;
  type: 'move' | 'left' | 'right';
  startX: number;
  charWidth: number;
  initStart: number;
  initEnd: number;
  region: Selection['region'];
}

/** Applies `deltaChars` to a drag session's original bounds, clamping to
 * the primer/probe's length bounds, the `DRAG_BUFFER` window rendered
 * around the original span, and the sequence's own bounds. Used for both
 * the live preview (every mousemove) and the final commit (mouseup) so
 * they always agree on the same result. */
function computeDraggedInterval(session: DragSession, deltaChars: number, seqLen: number): { start: number; end: number } {
  const [minLen, maxLen] = lenBounds(session.selKey);
  let start = session.initStart;
  let end = session.initEnd;

  if (session.type === 'move') {
    start += deltaChars;
    end += deltaChars;
  } else if (session.type === 'left') {
    start += deltaChars;
  } else {
    end += deltaChars;
  }

  const len = end - start;
  if (len < minLen) {
    if (session.type === 'left') start = end - minLen;
    else if (session.type === 'right') end = start + minLen;
  } else if (len > maxLen) {
    if (session.type === 'left') start = end - maxLen;
    else if (session.type === 'right') end = start + maxLen;
  }

  const lowBound = Math.max(0, session.initStart - DRAG_BUFFER);
  const highBound = Math.min(seqLen, session.initEnd + DRAG_BUFFER);
  if (start < lowBound) {
    const shift = lowBound - start;
    start += shift;
    if (session.type === 'move') end += shift;
  }
  if (end > highBound) {
    const shift = end - highBound;
    end -= shift;
    if (session.type === 'move') start -= shift;
  }

  start = Math.max(0, start);
  end = Math.min(seqLen, end);
  if (end - start < minLen) end = Math.min(seqLen, start + minLen);

  return { start, end };
}

/** Fallback row width used for exactly one render, before the container
 * has been measured (see `useResponsiveLineWidth` below). */
const DEFAULT_LINE_WIDTH = 60;
/** Ceiling only — deliberately no floor above 1. A floor like "never go
 * below 30 chars" sounds like a reasonable readability guard, but it
 * directly fights "never horizontal scroll": in a genuinely narrow
 * container (a phone-width window, a narrow split pane), forcing 30
 * characters when only, say, 8 fit doesn't make the row more readable —
 * it makes ~22 of those characters render past the edge, silently clipped
 * by `overflow-x-hidden` instead of ever being visible. Respecting
 * whatever the container actually measures, however small, is what keeps
 * every character of every row on-screen. */
const MIN_LINE_WIDTH = 1;
const MAX_LINE_WIDTH = 140;

/** One contiguous run of same-styled text (or a single interactive
 * character) queued for row-chunking — a resolved, render-ready form of
 * `Segment`: `buildCells` below already makes every interactive-vs-plain,
 * dragging-vs-static decision the old per-render logic used to make
 * inline, so `buildRows` only ever needs to know how to *slice* a cell's
 * text at a row boundary, never re-derive styling. */
interface Cell {
  text: string;
  className: string;
  id?: string;
  startPos: number;
  isPlaceholder?: boolean;
  cursorClass?: string;
  onMouseDown?: (e: React.MouseEvent<HTMLSpanElement>) => void;
}

interface Row {
  startPos: number;
  pieces: Cell[];
  isPlaceholder: boolean;
}

/** Resolves every segment into render-ready `Cell`s. Plain segments stay
 * as one cell each — cheap, since a full genomic view can be ~19,000
 * characters across only ~20-50 segments — while an editable or
 * currently-dragging segment explodes into one cell per character,
 * exactly the granularity the interactive drag handling already needs
 * (unifying what used to be two separate per-character code paths: the
 * inline map in the render loop, and `renderEditableChars`). */
function buildCells(
  segments: Segment[],
  interactive: boolean,
  dragSession: DragSession | null,
  deltaChars: number,
  editableKeys: Set<keyof Selections>,
  data: SequenceData,
  selections: Selections,
  startDrag: (e: React.MouseEvent<HTMLSpanElement>, key: keyof Selections, type: 'move' | 'left' | 'right', sel: Selection) => void,
): Cell[] {
  const cells: Cell[] = [];

  for (const s of segments) {
    if (s.className === 'seq-intron-placeholder') {
      cells.push({ text: s.text, className: s.className, startPos: s.startPos, isPlaceholder: true });
      continue;
    }

    const isDraggingThisKey = interactive && dragSession?.selKey === s.key;

    if (interactive && s.key && editableKeys.has(s.key) && !s.isBuffer) {
      const sel = selections[s.key]!;
      const live = isDraggingThisKey ? computeDraggedInterval(dragSession!, deltaChars, regionRawSeq(data, sel.region).length) : { start: sel.start, end: sel.end };
      const chars = Array.from(s.text);
      chars.forEach((ch, ci) => {
        const pos = s.startPos + ci;
        const within = pos >= live.start && pos < live.end;
        const className = within ? colorClassName(s.key!) : (s.fallbackClassName ?? s.className);
        const isEdge = ci === 0 || ci === chars.length - 1;
        const type: 'move' | 'left' | 'right' = ci === 0 ? 'left' : ci === chars.length - 1 ? 'right' : 'move';
        cells.push({ text: ch, className, startPos: pos, cursorClass: isEdge ? 'cursor-ew-resize' : 'cursor-grab', onMouseDown: (e) => startDrag(e, s.key!, type, sel) });
      });
      continue;
    }

    if (isDraggingThisKey && s.isBuffer) {
      const sel = selections[s.key!]!;
      const live = computeDraggedInterval(dragSession!, deltaChars, regionRawSeq(data, sel.region).length);
      const chars = Array.from(s.text);
      chars.forEach((ch, ci) => {
        const pos = s.startPos + ci;
        const within = pos >= live.start && pos < live.end;
        const className = within ? colorClassName(s.key!) : (s.fallbackClassName ?? s.className);
        cells.push({ text: ch, className, startPos: pos });
      });
      continue;
    }

    cells.push({ text: s.text, className: s.className, id: s.id, startPos: s.startPos });
  }

  return cells;
}

/** Chunks `cells` into fixed-`lineWidth` rows for the position gutter.
 * Every cell already carries the real `startPos` its own originating
 * segment computed (a flank segment resets to 0 at its own start; a gene
 * segment runs continuously across the whole gene) — a row's number is
 * just whichever cell (or slice of one) happens to open it, so no
 * separate running position counter is needed here. An intron-truncation
 * placeholder always gets its own row: its visible text is far shorter
 * than the real span it stands in for, so folding it into normal
 * character counting would make that row's width — and every row after it
 * mid-row — meaningless. */
function buildRows(cells: Cell[], lineWidth: number): Row[] {
  const rows: Row[] = [];
  let current: Cell[] = [];
  let currentLen = 0;
  let rowStart = 0;

  function flush() {
    if (current.length > 0) {
      rows.push({ startPos: rowStart, pieces: current, isPlaceholder: false });
      current = [];
      currentLen = 0;
    }
  }

  for (const cell of cells) {
    if (cell.isPlaceholder) {
      flush();
      rows.push({ startPos: cell.startPos, pieces: [cell], isPlaceholder: true });
      continue;
    }

    let remaining = cell.text;
    let consumed = 0;
    let firstPiece = true;
    while (remaining.length > 0) {
      if (currentLen === 0) rowStart = cell.startPos + consumed;
      const take = remaining.slice(0, lineWidth - currentLen);
      current.push({ text: take, className: cell.className, id: firstPiece ? cell.id : undefined, startPos: cell.startPos + consumed, cursorClass: cell.cursorClass, onMouseDown: cell.onMouseDown });
      firstPiece = false;
      currentLen += take.length;
      consumed += take.length;
      remaining = remaining.slice(take.length);
      if (currentLen >= lineWidth) flush();
    }
  }
  flush();
  return rows;
}

/** Recomputes how many characters fit in one row whenever the container
 * resizes (window resize, sidebar/density toggle, etc.) by measuring two
 * hidden probe elements built from the exact same classes the real
 * gutter/character spans use — more reliable than assuming a pixel width
 * from font-size, since it automatically tracks the actual rendered font
 * (loading, zoom, any future style tweak) instead of a guess. */
function useResponsiveLineWidth(containerRef: React.RefObject<HTMLDivElement | null>, gutterProbeRef: React.RefObject<HTMLSpanElement | null>, charProbeRef: React.RefObject<HTMLSpanElement | null>): number {
  const [lineWidth, setLineWidth] = useState(DEFAULT_LINE_WIDTH);

  useEffect(() => {
    function recompute() {
      const container = containerRef.current;
      const gutter = gutterProbeRef.current;
      const char = charProbeRef.current;
      if (!container || !gutter || !char) return;
      const charWidth = char.getBoundingClientRect().width;
      const gutterWidth = gutter.getBoundingClientRect().width;
      if (!charWidth) return;
      // Deliberately under-fill by two whole characters' width: one purely
      // as overflow-safety margin (a "never horizontal scroll" requirement
      // can't rely on font-metric measurement being pixel-perfect —
      // sub-pixel layout, a scrollbar appearing/disappearing between
      // measurements, browser-specific rounding — one character of slack
      // makes those errors harmless instead of needing to be exactly
      // right), the other purely cosmetic (filling a row to the very last
      // pixel reads as cramped — a little unused space on the right is
      // what makes it look like a designed gutter/margin instead of text
      // that just happens to stop where the container does).
      const available = container.clientWidth - gutterWidth - charWidth * 2;
      const chars = Math.floor(available / charWidth);
      setLineWidth(Math.min(MAX_LINE_WIDTH, Math.max(MIN_LINE_WIDTH, chars)));
    }

    recompute();
    const ro = new ResizeObserver(recompute);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('resize', recompute);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [containerRef, gutterProbeRef, charProbeRef]);

  return lineWidth;
}

interface Props {
  data: SequenceData;
  selections: Selections;
  truncateIntrons: boolean;
  /** Called when an interactive drag/resize commits a new primer/probe
   * span. Absent (not just a no-op) disables interactive editing entirely
   * — primers render read-only, exactly as before. */
  onSelect?: (key: keyof Selections, value: Selection) => void;
}

export default function SequenceViewer({ data, selections, truncateIntrons, onSelect }: Props) {
  const interactive = Boolean(onSelect);
  const [dragSession, setDragSession] = useState<DragSession | null>(null);
  const [deltaChars, setDeltaChars] = useState(0);
  // Mirrors `deltaChars`, kept in sync synchronously by `onMove` — read at
  // `onUp` time instead of `deltaChars` itself so `commitDrag` (which has
  // side effects: it calls `onSelect` and fires an `analyzePrimer` request)
  // never runs inside a `setState` updater function. React (StrictMode
  // especially) can invoke updater functions more than once to verify
  // they're pure, which was silently double-firing the commit/analyze call.
  const deltaCharsRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const gutterProbeRef = useRef<HTMLSpanElement>(null);
  const charProbeRef = useRef<HTMLSpanElement>(null);
  const lineWidth = useResponsiveLineWidth(containerRef, gutterProbeRef, charProbeRef);

  const segments = useMemo(() => {
    const up = flankSegments(data.upstream_seq || '', 'up', data, selections);
    const gene = geneBlockSegments(data, selections, truncateIntrons);
    const down = flankSegments(data.downstream_seq || '', 'down', data, selections);
    return [...up, ...gene, ...down];
  }, [data, selections, truncateIntrons]);

  // A selection is only draggable when its highlighted primer/probe render
  // is exactly one contiguous span — split across an exon/CDS/UTR boundary
  // (or clamped away entirely), it falls back to plain read-only
  // highlighting instead (see `sliceWithIntervals`'s and `geneBlockSegments`'
  // docs for why crossing those boundaries isn't supported in v1).
  const editableKeys = useMemo(() => {
    if (!interactive) return new Set<keyof Selections>();
    const counts = new Map<keyof Selections, number>();
    for (const s of segments) {
      if (s.key && !s.isBuffer) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
    }
    const keys = new Set<keyof Selections>();
    for (const [k, c] of counts) if (c === 1) keys.add(k);
    return keys;
  }, [segments, interactive]);

  function commitDrag(session: DragSession, finalDeltaChars: number) {
    if (finalDeltaChars === 0) return; // a click with no drag — leave the selection untouched
    const sel = selections[session.selKey];
    if (!sel || !onSelect) return;

    const rawSeq = regionRawSeq(data, session.region);
    const { start, end } = computeDraggedInterval(session, finalDeltaChars, rawSeq.length);
    if (start === sel.start && end === sel.end) return;

    const bindingSeq = rawSeq.substring(start, end);
    // `bindingSeq` is always the sense-strand slice; `primerSeq` matches it
    // for a forward-strand pick and is its reverse complement for a
    // reverse-strand one — inferred from how the pre-drag selection itself
    // relates the two (see `ArmsDesignPanel.tsx`/`ManualDesignPanel.tsx`,
    // which both set this invariant up when a selection is first made).
    const isReverseStrand = sel.primerSeq !== sel.bindingSeq;
    const primerSeq = isReverseStrand ? reverseComplement(bindingSeq) : bindingSeq;

    const next: Selection = { ...sel, start, end, primerSeq, bindingSeq, source: 'manual', analysis: undefined };
    onSelect(session.selKey, next);

    analyzePrimer({ sequence: primerSeq }).then(
      (analysis) => onSelect(session.selKey, { ...next, analysis }),
      () => onSelect(session.selKey, { ...next, analysis: null }),
    );
  }

  useEffect(() => {
    if (!dragSession) return;
    function onMove(e: MouseEvent) {
      const next = Math.round((e.clientX - dragSession!.startX) / dragSession!.charWidth);
      deltaCharsRef.current = next;
      setDeltaChars(next);
    }
    function onUp() {
      commitDrag(dragSession!, deltaCharsRef.current);
      deltaCharsRef.current = 0;
      setDeltaChars(0);
      setDragSession(null);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragSession]);

  function startDrag(e: React.MouseEvent<HTMLSpanElement>, key: keyof Selections, type: 'move' | 'left' | 'right', sel: Selection) {
    e.preventDefault();
    e.stopPropagation();
    const charWidth = e.currentTarget.getBoundingClientRect().width || 8;
    setDragSession({ selKey: key, type, startX: e.clientX, charWidth, initStart: sel.start, initEnd: sel.end, region: sel.region });
    setDeltaChars(0);
  }

  const cells = buildCells(segments, interactive, dragSession, deltaChars, editableKeys, data, selections, startDrag);
  const rows = buildRows(cells, lineWidth);

  const modeText = data.include_introns
    ? 'Genomic DNA (with introns; CDS bold, UTR highlighted)'
    : data.include_utr
      ? 'Spliced transcript (UTR highlighted, CDS bold)'
      : 'Spliced CDS only (no UTR)';

  return (
    <div>
      <div className="mb-4 text-slate-700 dark:text-slate-300">
        <p>
          <strong>Transcript:</strong> {data.transcript_name} ({data.transcript_id})
        </p>
        <p>
          <strong>Mode:</strong> {modeText} | <strong>Length:</strong> {data.gene_len} bp
        </p>
        <p>
          <strong>Flanking:</strong> {data.upstream_len} bp upstream, {data.downstream_len} bp downstream
        </p>
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
          Numbers on the left mark each row's first position — 0-based from the start of its own region (upstream flank, gene, or downstream flank).
        </p>
      </div>
      <div
        id="sequence-map"
        ref={containerRef}
        className="sequence-viewer relative bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg p-4 text-sm overflow-y-auto overflow-x-hidden max-h-[520px] text-slate-800 dark:text-slate-200"
      >
        {/* Unrendered (out of flow, invisible) — measured only, to figure
         * out how many characters actually fit in one row of this
         * container at its current width/font, so rows can fill the
         * available space instead of wrapping at an arbitrary fixed
         * count. `relative` on the container above makes it the probes'
         * (and every row's) positioning/containing-block context, so
         * nothing here can ever leak width to an ancestor and cause page-
         * level horizontal scroll; `overflow-x-hidden` (not `-auto`) below
         * makes "never horizontal scroll" a hard guarantee rather than a
         * best-effort of the width math above — if a row's content is
         * ever a hair wider than computed (a rounding edge case), it's
         * silently clipped instead of ever showing a scrollbar. */}
        <span ref={gutterProbeRef} aria-hidden className="select-none pl-1 pr-3 text-right tabular-nums shrink-0 min-w-[5.5ch]" style={{ position: 'absolute', visibility: 'hidden', whiteSpace: 'pre' }}>
          -00000
        </span>
        {/* `fontWeight: 700` deliberately — `seq-cds`/`seq-primer`/`seq-probe`
         * (see `index.css`) all render bold, and bold glyphs are wider than
         * regular ones even in a true monospace family. Measuring the
         * widest weight actually used, not just the default one, is what
         * keeps CDS/primer/probe rows from being sized using a narrower
         * character than what they actually render. */}
        <span ref={charProbeRef} aria-hidden style={{ position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', fontWeight: 700 }}>
          0
        </span>
        {rows.map((row, ri) => (
          <div key={ri} className="flex whitespace-pre">
            <span className="select-none pl-1 pr-3 text-right text-slate-400 dark:text-slate-600 tabular-nums shrink-0 min-w-[5.5ch]">{row.startPos}</span>
            <span>
              {row.pieces.map((p, pi) => (
                <span key={pi} className={`${p.className}${p.cursorClass ? ` ${p.cursorClass}` : ''}`} id={p.id} onMouseDown={p.onMouseDown}>
                  {p.text}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
