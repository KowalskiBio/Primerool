import { useEffect, useMemo, useRef, useState } from 'react';
import type { SequenceData } from '../api/sequence';
import type { Selection, Selections } from '../utils/regionMapping';
import { mapPrimerToGenomic, selectionStrand } from '../utils/regionMapping';
import { cleanDNA, reverseComplement } from '../utils/dna';
import { lookupVariant, type VariantHit } from '../api/variants';
import { localGenePos } from '../utils/variantMapping';
import { baseAtPoint, describeGenePosition, useBaseHover } from './BaseHoverTooltip';
import { ALL_PICK_KINDS, alleleMutantProbe, armsMutantTwin, LIMITS, type PickKind } from '../utils/mapPickMenu';
import { useMapPickMenu } from './useMapPickMenu';
import { useMapDragSelect } from './useMapDragSelect';
import { useSessionState } from '../session/sessionContext';
import { findBestAlignment, type AlignmentHit } from '../utils/localAlign';
import { resolveSequenceIds, type SequenceIds } from '../utils/lookupIds';
import { getNcbiApiKey } from '../api/ncbiApiKey';

interface Segment {
  text: string;
  className: string;
  id?: string;
  /** Present iff these chars belong to (or buffer) an interactively
   * editable primer/probe selection - see `INTERACTIVE_KEYS` below. */
  key?: keyof Selections;
  /** What this segment would render as if it weren't highlighted - only
   * set on editable segments, used to restore a char's look when a live
   * drag moves the primer away from it. */
  fallbackClassName?: string;
  /** Local index (into the rawSeq/gene_seq this segment was sliced from) of
   * its first character - for editable segments this is always in the same
   * coordinate space as the owning `Selection.start`/`end`. */
  startPos: number;
  /** Which raw sequence `startPos` is local to - 'up'/'down' reset to 0 at
   * their own flank's start, 'gene' runs continuously across the whole
   * gene block. Needed by the sequence-search highlighter below to look up
   * match intervals (computed once per region against `data.*_seq`)
   * against the right coordinate space. */
  region: 'up' | 'gene' | 'down';
}

/** Splits `rawSeq` into ordered, non-overlapping segments given a set of
 * (possibly-overlapping-but-pre-sorted) highlight intervals, each in
 * `[0, rawSeq.length)` local coordinates. Shared by both the flank and
 * gene-block renderers below - the legacy app duplicated this
 * merge-and-slice loop three times with copy-pasted off-by-one-prone
 * arithmetic; collapsed into one function here.
 *
 * `baseOffset` shifts every `startPos` this produces by a fixed amount -
 * needed because `geneBlockSegments` calls this once per exon/CDS/UTR/
 * intron chunk of `gene_seq`, each starting at a different absolute gene
 * position, but positions must come out in that absolute space to line up
 * with `Selection.start`/`end`. */
function sliceWithIntervals(rawSeq: string, intervals: { start: number; end: number; className: string; id?: string; key?: keyof Selections }[], baseClassName: string, baseOffset = 0): Omit<Segment, 'region'>[] {
  if (intervals.length === 0) return [{ text: rawSeq, className: baseClassName, startPos: baseOffset }];

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const segments: Omit<Segment, 'region'>[] = [];
  let cur = 0;
  for (const iv of sorted) {
    const s = Math.max(0, Math.max(cur, iv.start));
    const e = Math.min(rawSeq.length, iv.end);
    if (e <= s) continue;

    if (s > cur) segments.push({ text: rawSeq.substring(cur, s), className: baseClassName, startPos: baseOffset + cur });

    segments.push({ text: rawSeq.substring(s, e), className: iv.className, id: iv.id, key: iv.key, fallbackClassName: iv.key ? baseClassName : undefined, startPos: baseOffset + s });
    cur = e;
  }
  if (cur < rawSeq.length) segments.push({ text: rawSeq.substring(cur), className: baseClassName, startPos: baseOffset + cur });
  return segments;
}

function flankSegments(rawSeq: string, regionName: 'up' | 'down', data: SequenceData, sel: Selections): Segment[] {
  const intervals: { start: number; end: number; className: string; key?: keyof Selections }[] = [];
  // Both WGA picks are checked against this flank independently, matching
  // the legacy app - a forward pick normally lands in 'up' and a reverse
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
    // this flank's own - dragging it here would need cross-region
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
  return inner.map((s) => ({ ...(s.className ? s : { ...s, className: 'seq-flank', fallbackClassName: s.key ? 'seq-flank' : s.fallbackClassName }), region: regionName }));
}

function isInCDS(pos: number, cdsIntervals: [number, number][]): boolean {
  for (const [s, e] of cdsIntervals) {
    if (pos < s) return false;
    if (pos >= s && pos < e) return true;
  }
  return false;
}

function geneBlockSegments(data: SequenceData, sel: Selections, truncateIntrons: boolean, variantMarkers: VariantMarker[]): Segment[] {
  const seq = data.gene_seq || '';
  if (!seq) return [];

  function highlightIntervalsFor(segStart: number, segLen: number): { start: number; end: number; className: string; key?: keyof Selections }[] {
    const out: { start: number; end: number; className: string; key?: keyof Selections }[] = [];
    const add = (p: Selection | null, cls: string, key?: keyof Selections) => {
      if (!p) return;
      for (const r of mapPrimerToGenomic(p, data)) {
        const s = Math.max(segStart, r.start);
        const e = Math.min(segStart + segLen, r.end);
        // Only the primer's own 'gene'-region render is editable - local
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
    const inner: Segment[] = sliceWithIntervals(segmentSeq, intervals, baseClassName, startOffset).map((s) => ({ ...s, region: 'gene' as const }));
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

    // A truncated intron collapses to a short placeholder - fine for an
    // unmarked one, but it would silently swallow any variant marker or
    // gene-region primer/probe selection landing inside it (nothing left
    // at that position to hang it on). Collected once, not per intron.
    const geneSelectionRanges = (Object.values(sel) as (Selection | null)[]).filter((s): s is Selection => s !== null && s.region === 'gene').map((s) => ({ start: s.start, end: s.end }));

    const segments: Segment[] = [];
    let last = 0;

    const pushIntron = (intronSeq: string, offset: number) => {
      // An intron carrying one of these is always rendered in full
      // instead, regardless of the toggle - "truncate introns" means "the
      // ones I don't need to see", not "hide my SNPs/primers".
      const hasMarker =
        variantMarkers.some((m) => m.end > offset && m.start < offset + intronSeq.length) || geneSelectionRanges.some((r) => r.end > offset && r.start < offset + intronSeq.length);
      if (truncateIntrons && !hasMarker) {
        segments.push({ text: `...intron ${intronSeq.length}bp...`, className: 'seq-intron-placeholder', startPos: offset, region: 'gene' });
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

/** Drag-resizing allows the same lengths as a right-click pick - tighter
 * bounds snapped any longer pick (e.g. a 35 bp probe) down on its first
 * edge drag, and it could never be lengthened back. */
function lenBounds(): readonly [number, number] {
  return LIMITS.primer;
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
  /** Local position of the base the drag grabbed - the drag distance is
   * the base now under the pointer minus this one, so it follows the
   * pointer across row wraps, not just along one row. */
  anchorPos: number;
  initStart: number;
  initEnd: number;
  region: Selection['region'];
  /** A base the span must keep covering - an allele probe's SNP. */
  mustCover?: number;
}

/** Applies `deltaChars` to a drag session's original bounds, clamping to
 * the primer/probe's length bounds and the sequence's own bounds. Used for both
 * the live preview (every mousemove) and the final commit (mouseup) so
 * they always agree on the same result. */
function computeDraggedInterval(session: DragSession, deltaChars: number, seqLen: number): { start: number; end: number } {
  const [minLen, maxLen] = lenBounds();
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

  if (start < 0) {
    if (session.type === 'move') end -= start;
    start = 0;
  }
  if (end > seqLen) {
    if (session.type === 'move') start -= end - seqLen;
    end = seqLen;
  }

  if (session.mustCover !== undefined) {
    const p = session.mustCover;
    if (start > p) {
      if (session.type === 'move') end -= start - p;
      start = p;
    }
    if (end <= p) {
      if (session.type === 'move') start += p + 1 - end;
      end = p + 1;
    }
  }

  start = Math.max(0, start);
  end = Math.min(seqLen, end);
  if (end - start < minLen) end = Math.min(seqLen, start + minLen);

  return { start, end };
}

/** Fallback row width used for exactly one render, before the container
 * has been measured (see `useResponsiveLineWidth` below). */
const DEFAULT_LINE_WIDTH = 60;
/** Ceiling only - deliberately no floor above 1. A floor like "never go
 * below 30 chars" sounds like a reasonable readability guard, but it
 * directly fights "never horizontal scroll": in a genuinely narrow
 * container (a phone-width window, a narrow split pane), forcing 30
 * characters when only, say, 8 fit doesn't make the row more readable -
 * it makes ~22 of those characters render past the edge, silently clipped
 * by `overflow-x-hidden` instead of ever being visible. Respecting
 * whatever the container actually measures, however small, is what keeps
 * every character of every row on-screen. */
const MIN_LINE_WIDTH = 1;
// A safety ceiling only, far above any real screen: rows should fill
// whatever width the map actually has - a lower cap (it was 140) left an
// empty band on the right once the page itself got wider.
const MAX_LINE_WIDTH = 400;

/** One contiguous run of same-styled text (or a single interactive
 * character) queued for row-chunking - a resolved, render-ready form of
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
  /** Which primer/probe pick these characters render, when they belong to
   * one - emitted as `data-pick-key` so a right-click on the span can open
   * that pick's own menu (see `useMapPickMenu`), separate from the
   * editability `key` implies (a pick also renders read-only outside its
   * own region, e.g. a junction primer bleeding into the gene block). */
  pickKey?: keyof Selections;
  /** Which raw sequence `startPos` is local to - see `Segment.region`.
   * Absent on placeholder cells (they don't correspond to real characters
   * a search could land on). */
  region?: Segment['region'];
  /** Set by `applySearchHighlight` (post-`buildCells`, pre-`buildRows`) for
   * any cell/sub-cell landing inside a "find in sequence" match. */
  isSearchHit?: boolean;
  isActiveSearchHit?: boolean;
  searchIdx?: number;
  /** Set by `applyVariantHighlight` for a cell/sub-cell landing on a
   * `VariantMarker`'s position. */
  isVariant?: boolean;
  /** The bare rsID - rendered as a `data-variant-rsid` attribute so an
   * outside "jump to this SNP" control can find and scroll to it without
   * `SequenceViewer` needing to expose an imperative API, and read back by
   * the hover tooltip to name the SNP under the pointer (see
   * `baseAtPoint`'s `variantRsid`). The alleles themselves are looked up
   * from the marker at hover time rather than duplicated onto every cell. */
  variantRsid?: string;
}

interface Row {
  startPos: number;
  pieces: Cell[];
  isPlaceholder: boolean;
}

/** Resolves every segment into render-ready `Cell`s. Plain segments stay
 * as one cell each - cheap, since a full genomic view can be ~19,000
 * characters across only ~20-50 segments - while an editable or
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

    if (interactive && s.key && editableKeys.has(s.key)) {
      const sel = selections[s.key]!;
      const live = isDraggingThisKey ? computeDraggedInterval(dragSession!, deltaChars, regionRawSeq(data, sel.region).length) : { start: sel.start, end: sel.end };
      const chars = Array.from(s.text);
      chars.forEach((ch, ci) => {
        const pos = s.startPos + ci;
        const within = pos >= live.start && pos < live.end;
        const className = within ? colorClassName(s.key!) : (s.fallbackClassName ?? s.className);
        // Handles sit on the selection's own first/last base, not this
        // piece's - a primer split across chunks has several pieces.
        const type: 'move' | 'left' | 'right' = pos === sel.start ? 'left' : pos === sel.end - 1 ? 'right' : 'move';
        // An ARMS twin's 3' end is locked on its SNP: only the 5' end (the
        // first base for a forward twin, the last for a reverse one) drags.
        const locked = sel.arms ? (selectionStrand(sel) === 'F' ? type !== 'left' : type !== 'right') : false;
        if (locked) {
          cells.push({ text: ch, className, startPos: pos, region: s.region, pickKey: s.key });
          return;
        }
        const isEdge = type !== 'move';
        cells.push({ text: ch, className, startPos: pos, cursorClass: isEdge ? 'cursor-ew-resize' : 'cursor-grab', onMouseDown: (e) => startDrag(e, s.key!, type, sel), region: s.region, pickKey: s.key });
      });
      continue;
    }

    // Any other stretch of the dragged selection's region the live span has
    // moved onto: split out the covered part and paint it as the primer.
    if (interactive && dragSession && s.region === dragSession.region && !s.key) {
      const live = computeDraggedInterval(dragSession, deltaChars, regionRawSeq(data, dragSession.region).length);
      const a = Math.max(live.start, s.startPos) - s.startPos;
      const b = Math.min(live.end, s.startPos + s.text.length) - s.startPos;
      if (b > a) {
        if (a > 0) cells.push({ text: s.text.slice(0, a), className: s.className, id: s.id, startPos: s.startPos, region: s.region });
        cells.push({ text: s.text.slice(a, b), className: colorClassName(dragSession.selKey), id: a === 0 ? s.id : undefined, startPos: s.startPos + a, region: s.region });
        if (b < s.text.length) cells.push({ text: s.text.slice(b), className: s.className, startPos: s.startPos + b, region: s.region });
        continue;
      }
    }

    cells.push({ text: s.text, className: s.className, id: s.id, startPos: s.startPos, region: s.region, pickKey: s.key });
  }

  return cells;
}

export interface VariantMarker {
  /** Shown in the marker's tooltip and used as the React key. */
  rsid: string;
  /** 0-based, in `data.gene_seq` coordinates (only meaningful when
   * `data.include_introns` is true - see `SequenceData.gene_start_genomic`'s
   * doc for how a genomic position maps here). */
  start: number;
  end: number;
  alleles?: string[];
}

/** Marks every cell whose `('gene', startPos)` falls inside a variant's
 * `[start, end)` span - same additive, non-destructive splitting shape as
 * `applySearchHighlight` below (one level later in the pipeline, over
 * already-built `Cell`s), so a variant marker never fights the base
 * CDS/UTR/intron styling for the same character, it just decorates it. */
function applyVariantHighlight(cells: Cell[], markers: VariantMarker[]): Cell[] {
  if (markers.length === 0) return cells;
  const out: Cell[] = [];

  for (const cell of cells) {
    if (cell.isPlaceholder || cell.region !== 'gene') {
      out.push(cell);
      continue;
    }

    const cellStart = cell.startPos;
    const cellEnd = cellStart + cell.text.length;
    const relevant = markers.filter((m) => m.end > cellStart && m.start < cellEnd).sort((a, b) => a.start - b.start);
    if (relevant.length === 0) {
      out.push(cell);
      continue;
    }

    let cur = cellStart;
    for (const m of relevant) {
      const s = Math.max(cellStart, cur, m.start);
      const e = Math.min(cellEnd, m.end);
      if (e <= s) continue;
      if (s > cur) out.push({ ...cell, text: cell.text.slice(cur - cellStart, s - cellStart), startPos: cur });
      out.push({
        ...cell,
        text: cell.text.slice(s - cellStart, e - cellStart),
        startPos: s,
        isVariant: true,
        variantRsid: m.rsid,
      });
      cur = e;
    }
    if (cur < cellEnd) out.push({ ...cell, text: cell.text.slice(cur - cellStart), startPos: cur });
  }

  return out;
}

interface SearchMatch {
  start: number;
  end: number;
  region: 'up' | 'gene' | 'down';
  idx: number;
}

const SEARCH_REGION_ORDER: Record<SearchMatch['region'], number> = { up: 0, gene: 1, down: 2 };

/** Finds every occurrence of `query` (and, optionally, its reverse
 * complement) in each of the sequence's three raw regions independently -
 * matches are reported in each region's own local coordinates, matching
 * `Segment`/`Cell.startPos`'s coordinate space, so `applySearchHighlight`
 * can look them up against a cell without any region-to-region offset
 * math. Ordered up -> gene -> down, by start within each, so match index 0
 * is always the first hit a reader would scroll past. */
function computeSearchMatches(data: SequenceData, query: string, includeRevComp: boolean): SearchMatch[] {
  const q = cleanDNA(query);
  if (!q) return [];
  const terms = includeRevComp ? Array.from(new Set([q, reverseComplement(q)])) : [q];

  function matchesIn(raw: string, region: SearchMatch['region']): Omit<SearchMatch, 'idx'>[] {
    const haystack = raw.toUpperCase();
    const out: Omit<SearchMatch, 'idx'>[] = [];
    for (const term of terms) {
      if (!term) continue;
      let i = haystack.indexOf(term);
      while (i !== -1) {
        out.push({ start: i, end: i + term.length, region });
        i = haystack.indexOf(term, i + 1);
      }
    }
    return out;
  }

  const all = [...matchesIn(data.upstream_seq || '', 'up'), ...matchesIn(data.gene_seq || '', 'gene'), ...matchesIn(data.downstream_seq || '', 'down')];
  all.sort((a, b) => SEARCH_REGION_ORDER[a.region] - SEARCH_REGION_ORDER[b.region] || a.start - b.start);
  return all.map((m, idx) => ({ ...m, idx }));
}

/** Splits any cell that overlaps a search match into up to three pieces
 * (before / hit / after), tagging the hit piece for styling - the same
 * merge-and-slice shape as `sliceWithIntervals`, one level later in the
 * pipeline (over already-built `Cell`s instead of raw sequence, since a
 * match can land inside any kind of cell: flank, CDS, an already-selected
 * primer, even a single dragged character). Placeholder cells (truncated
 * introns) are left alone - nothing to show inside a collapsed intron. */
/** Renders an imperfect alignment's traceback rows in the classic
 * BLAST-style three-line layout - user's query on top, a match midline
 * (| identical, . aligned-but-different, space for gaps), the map's own
 * sequence below. Chunked at 80 columns so a long amplicon wraps instead of
 * forcing a giant horizontal strip. */
function formatAlignmentRows(hit: AlignmentHit, width = 80): string {
  const mid: string[] = [];
  for (let i = 0; i < hit.alignedQuery.length; i++) {
    const qb = hit.alignedQuery[i];
    const sb = hit.alignedSubject[i];
    mid.push(qb === '-' || sb === '-' ? ' ' : qb === sb ? '|' : '.');
  }
  const midStr = mid.join('');
  const out: string[] = [];
  for (let off = 0; off < hit.alignedQuery.length; off += width) {
    out.push(`Query    ${hit.alignedQuery.slice(off, off + width)}`, `         ${midStr.slice(off, off + width)}`, `Sequence ${hit.alignedSubject.slice(off, off + width)}`);
    if (off + width < hit.alignedQuery.length) out.push('');
  }
  return out.join('\n');
}

function applySearchHighlight(cells: Cell[], matches: SearchMatch[], activeIdx: number): Cell[] {
  if (matches.length === 0) return cells;
  const out: Cell[] = [];

  for (const cell of cells) {
    if (cell.isPlaceholder || !cell.region) {
      out.push(cell);
      continue;
    }

    const cellStart = cell.startPos;
    const cellEnd = cellStart + cell.text.length;
    const relevant = matches.filter((m) => m.region === cell.region && m.end > cellStart && m.start < cellEnd).sort((a, b) => a.start - b.start);
    if (relevant.length === 0) {
      out.push(cell);
      continue;
    }

    let cur = cellStart;
    for (const m of relevant) {
      const s = Math.max(cellStart, cur, m.start);
      const e = Math.min(cellEnd, m.end);
      if (e <= s) continue;
      if (s > cur) out.push({ ...cell, text: cell.text.slice(cur - cellStart, s - cellStart), startPos: cur });
      out.push({ ...cell, text: cell.text.slice(s - cellStart, e - cellStart), startPos: s, isSearchHit: true, isActiveSearchHit: m.idx === activeIdx, searchIdx: m.idx });
      cur = e;
    }
    if (cur < cellEnd) out.push({ ...cell, text: cell.text.slice(cur - cellStart), startPos: cur });
  }

  return out;
}

/** Chunks `cells` into fixed-`lineWidth` rows for the position gutter.
 * Every cell already carries the real `startPos` its own originating
 * segment computed (a flank segment resets to 0 at its own start; a gene
 * segment runs continuously across the whole gene) - a row's number is
 * just whichever cell (or slice of one) happens to open it, so no
 * separate running position counter is needed here. An intron-truncation
 * placeholder always gets its own row: its visible text is far shorter
 * than the real span it stands in for, so folding it into normal
 * character counting would make that row's width - and every row after it
 * mid-row - meaningless. */
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
      current.push({
        text: take,
        className: cell.className,
        id: firstPiece ? cell.id : undefined,
        startPos: cell.startPos + consumed,
        region: cell.region,
        cursorClass: cell.cursorClass,
        onMouseDown: cell.onMouseDown,
        pickKey: cell.pickKey,
        isSearchHit: cell.isSearchHit,
        isActiveSearchHit: cell.isActiveSearchHit,
        searchIdx: cell.searchIdx,
        isVariant: cell.isVariant,
        variantRsid: cell.variantRsid,
      });
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
 * gutter/character spans use - more reliable than assuming a pixel width
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
      // can't rely on font-metric measurement being pixel-perfect -
      // sub-pixel layout, a scrollbar appearing/disappearing between
      // measurements, browser-specific rounding - one character of slack
      // makes those errors harmless instead of needing to be exactly
      // right), the other purely cosmetic (filling a row to the very last
      // pixel reads as cramped - a little unused space on the right is
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
   * - primers render read-only, exactly as before. */
  onSelect?: (key: keyof Selections, value: Selection | null) => void;
  /** Which primer picks the right-click menu offers (default: all). Only
   * meaningful with `onSelect`. */
  pickKinds?: readonly PickKind[];
  /** Read-only markers (e.g. a gene's known SNPs) decorated onto the gene
   * block - see `VariantMarker`. */
  variantMarkers?: VariantMarker[];
  /** Species + source the loaded `data` was fetched from, when the caller
   * knows them - what "Find in sequence" resolves an rsID query against
   * first (a hit in this species can be placed on the map below). Absent
   * (e.g. a custom pasted sequence) just means no hit can be placed, not
   * that lookup is disabled. */
  species?: string;
  apiSource?: string;
  /** The organism currently selected in the input panel's toggle, when
   * the caller knows it - tried as a lookup fallback after `species` (the
   * loaded sequence's own), since an rsID may exist only in the organism
   * the user is analyzing while the loaded sequence is from another (or
   * is a custom paste). Human is always tried last as the common case. */
  selectedSpecies?: string;
  /** Saves the "Find in sequence" query in the session under this key
   * prefix - only the main map passes it, not viewers inside modals. */
  persistKey?: string;
}

export default function SequenceViewer({ data, selections, truncateIntrons, onSelect, pickKinds = ALL_PICK_KINDS, variantMarkers = [], species, apiSource, selectedSpecies, persistKey }: Props) {
  const interactive = Boolean(onSelect);

  // External-ID header links (GenBank/Gene/transcript/assembly) - resolved
  // from the provider's REST API, client-side; see utils/lookupIds.ts.
  const isCustomSequence = data.transcript_id === 'custom';
  const [seqIds, setSeqIds] = useState<SequenceIds | null>(null);
  const idsKey = `${apiSource ?? ''}:${data.transcript_id}`;
  useEffect(() => {
    if (isCustomSequence || !apiSource || !data.transcript_id) {
      setSeqIds(null);
      return;
    }
    let cancelled = false;
    resolveSequenceIds(apiSource as 'ensembl' | 'ncbi', data.transcript_id, getNcbiApiKey()).then((ids) => {
      if (!cancelled) setSeqIds(ids);
    });
    return () => {
      cancelled = true;
    };
  }, [idsKey, isCustomSequence]);
  const [dragSession, setDragSession] = useState<DragSession | null>(null);
  const [deltaChars, setDeltaChars] = useState(0);
  // Mirrors `deltaChars`, kept in sync synchronously by `onMove` - read at
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

  // "Find in sequence" - lets a reader locate a pasted primer/probe (or any
  // sequence) within the map below, forward and/or reverse-complement; an
  // rsID-shaped query takes the variant-lookup path instead (see below).
  const [searchQuery, setSearchQuery] = useSessionState(persistKey ? `${persistKey}.searchQuery` : null, '');
  const [includeRevComp, setIncludeRevComp] = useSessionState(persistKey ? `${persistKey}.includeRevComp` : null, true);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  // "Align in sequence" - best Smith-Waterman binding site of an arbitrary
  // pasted primer/amplicon (mismatches/indels tolerated), reusing the same
  // highlight/scroll pipeline as a literal hit. Cleared alongside the
  // literal query on sequence change.
  const [alignQuery, setAlignQuery] = useSessionState(persistKey ? `${persistKey}.alignQuery` : null, '');
  const [alignHit, setAlignHit] = useState<AlignmentHit | null>(null);
  // Which match the map last scrolled to (-1 = none yet). Set only by an
  // explicit action - never by typing; see the scroll effect below.
  const [scrollToIdx, setScrollToIdx] = useState(-1);

  // A newly loaded sequence invalidates any in-progress search, and a
  // changed query/checkbox should always land back on its first hit rather
  // than keep whatever numeric index the previous search happened to be
  // on. Adjusted here (render-time), not in an effect - React's documented
  // pattern for "reset state when a prop/derived value changes" - so it
  // resolves before this render paints instead of costing an extra one.
  const [prevData, setPrevData] = useState(data);
  const searchKey = `${searchQuery} ${includeRevComp}`;
  const [prevSearchKey, setPrevSearchKey] = useState(searchKey);
  if (data !== prevData) {
    setPrevData(data);
    if (searchQuery !== '') setSearchQuery('');
    if (alignQuery !== '') {
      setAlignQuery('');
      setAlignHit(null);
    }
  } else if (searchKey !== prevSearchKey) {
    setPrevSearchKey(searchKey);
    // Typing in the literal field resets where Prev/Next sits (back to the
    // first hit) - deliberately WITHOUT scrolling, so editing one field
    // doesn't yank the map away from whatever the other search highlighted.
    if (activeMatchIndex !== 0) setActiveMatchIndex(0);
    setScrollToIdx(-1);
  }

  const literalMatches = useMemo(() => computeSearchMatches(data, searchQuery, includeRevComp), [data, searchQuery, includeRevComp]);

  /** Scrolls match idx 0 on an align/rsID hit landing; assigned after
   * `scrollToMatch` is defined below (the debounced align effect and the
   * report blocks run before it is). */
  const scrollToFirstRef = useRef(() => {});

  // Debounced like the typing: the DP is cheap but pointless to rerun per
  // keystroke of a half-pasted sequence. Below ~10 bases a local alignment
  // is noise (any 6-mer "binds" somewhere), so the search stays off - same
  // threshold the button is disabled at.
  useEffect(() => {
    const q = cleanDNA(alignQuery);
    if (q.length < 10) {
      setAlignHit(null);
      return;
    }
    const timer = setTimeout(() => {
      setAlignHit(findBestAlignment(data, q));
      // The binding site lands as match idx 0 - scroll to it once on
      // landing so it's visible without the user hunting for it (typing
      // a longer query replaces the hit in kind, so this stays put).
      scrollToFirstRef.current();
    }, 300);
    return () => clearTimeout(timer);
  }, [data, alignQuery]);

  // --- rsID ("rs334") search ----------------------------------------------
  // A query shaped like a bare rsID can never be a meaningful literal
  // sequence search anyway (no ACGT characters survive `cleanDNA`), so
  // it's routed to a variant-catalog lookup (`/lookup_variant`) instead:
  // the hit is decorated onto the gene block like any `variantMarkers`
  // entry, injected as the single search match (so it gets the active-hit
  // styling and auto-scroll), and summarized in a panel under the search
  // bar. Requires knowing which catalog to ask - see the `species`/
  // `apiSource` props.

  /** Full-string, case-insensitive "rs" + digits. */
  const rsQuery = /^rs\d+$/i.test(searchQuery.trim()) ? searchQuery.trim().toLowerCase() : null;

  type RsLookup =
    | { query: string; status: 'loading' }
    | { query: string; status: 'error'; message: string }
    | { query: string; status: 'found'; variant: VariantHit; foundIn: { species: string; source: string } };
  const [rsLookup, setRsLookup] = useState<RsLookup | null>(null);

  /** Species to try, in order: the loaded sequence's own (only a hit
   * there can be placed on the map below), then the organism selected in
   * the input panel's toggle (`selectedSpecies` - the user's current
   * analysis context), then human (the common case). Deduplicated;
   * empty-string entries (e.g. a blank custom-species field) dropped. */
  const rsSpeciesChain = useMemo(() => {
    const chain = [species, selectedSpecies, 'homo_sapiens'].filter((s): s is string => Boolean(s));
    return [...new Set(chain)];
  }, [species, selectedSpecies]);

  /** Both sources get a chance per species: neither catalog is a superset
   * of the other (EVA-imported variants, for instance, exist only in
   * Ensembl - dbSNP/NCBI has never heard of them). The loaded sequence's
   * own source goes first; Ensembl leads when the source is unknown. */
  const rsSourceChain = useMemo(() => {
    if (apiSource === 'ncbi') return ['ncbi', 'ensembl'] as const;
    return ['ensembl', 'ncbi'] as const;
  }, [apiSource]);

  // Debounced so typing an rsID character-by-character doesn't fire one
  // request per prefix (rs3, rs33, ...); only the query the user settles
  // on is looked up. Every candidate runs to completion - a miss on one
  // species/source just advances to the next - so the result is always
  // either a hit (with where it was found) or "not found anywhere
  // tried". A stale result is never cleared from state here -
  // `rsLookupCurrent` below ignores anything whose query doesn't match
  // the current one (and a cleared query means `rsQuery` is null, so
  // the panel simply stops rendering).
  useEffect(() => {
    if (!rsQuery) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setRsLookup({ query: rsQuery, status: 'loading' });
      for (const sp of rsSpeciesChain) {
        for (const src of rsSourceChain) {
          try {
            const res = await lookupVariant({ variant_id: rsQuery, species: sp, api_source: src });
            if (!cancelled) setRsLookup({ query: rsQuery, status: 'found', variant: res.variant, foundIn: { species: sp, source: src } });
            return;
          } catch {
            // Not found in this species/source - try the next candidate.
          }
        }
      }
      if (!cancelled) setRsLookup({ query: rsQuery, status: 'error', message: `Variant ${rsQuery} not found in any of: ${rsSpeciesChain.join(', ')} (tried both NCBI and Ensembl).` });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rsQuery, rsSpeciesChain, rsSourceChain]);

  const rsLookupCurrent = rsQuery !== null && rsLookup?.query === rsQuery ? rsLookup : null;
  const rsFound = rsLookupCurrent?.status === 'found' ? rsLookupCurrent : null;
  const rsVariant = rsFound?.variant ?? null;
  const rsFoundInSpecies = rsFound?.foundIn.species ?? null;

  /** Where the hit lands in `data.gene_seq` coordinates - `null` when it
   * can't be placed (hit from another species, spliced view, other
   * chromosome, outside this transcript's span), the same guards
   * `ArmsDesignPanel.tsx`'s `localPosForHit`/`hitSelectDisabledReason`
   * apply to a variant-search hit. The species check is not just about
   * correctness of the note: a hit from a different organism could
   * coincidentally land inside this sequence's genomic span (chromosome
   * numbers and positions overlap across organisms), so it must never be
   * allowed to place a false highlight. `include_introns` is what makes
   * the genomic-to-local mapping valid at all (see `localGenePos`), and
   * doubles as the "not a custom pasted sequence" check - those have no
   * genomic coordinates. */

  const rsLocalPos = useMemo(() => {
    if (!rsVariant || rsFoundInSpecies === null || rsFoundInSpecies !== species) return null;
    if (!data.include_introns) return null;
    if (rsVariant.chrom && data.chrom && rsVariant.chrom !== data.chrom) return null;
    return localGenePos(data, rsVariant.start);
  }, [rsVariant, rsFoundInSpecies, species, data]);

  // Scroll the map to the variant the first time one lands (a stable
  // key built from the located position, so re-render storms from a
  // literal query in the other field don't keep re-jumping).
  const prevRsPlacedKey = useRef<string | null>(null);
  if (rsLocalPos !== null) {
    const key = `${data.transcript_id}:${rsLocalPos}`;
    if (prevRsPlacedKey.current !== key) {
      prevRsPlacedKey.current = key;
      scrollToFirstRef.current();
    }
  } else {
    prevRsPlacedKey.current = null;
  }

  // Alleles re-oriented into `gene_seq`'s own strand sense (a minus-strand
  // gene's sequence is reverse-complemented at fetch time, so showing the
  // plus-strand alleles would look like a mismatch at that base) - the
  // same rule `ArmsDesignPanel.tsx`'s `orientedAlleles` applies. Only
  // meaningful for a hit from the loaded sequence's own species; one
  // found in another organism keeps its catalog (plus-strand) alleles.
  const rsOrientedAlleles = useMemo(
    () => (rsVariant && rsFoundInSpecies !== null && rsFoundInSpecies === species && data.strand === '-' ? rsVariant.alleles.map((a) => (a === '-' ? a : reverseComplement(a))) : rsVariant?.alleles ?? []),
    [rsVariant, rsFoundInSpecies, species, data.strand],
  );

  /** The looked-up rsID as a proposed allele-probe SNP (see
   * `RsSnpSuggestion`): the real template base at its position as WT (ground
   * truth from `gene_seq`, never the catalog's allele order - same rule as
   * `ArmsDesignPanel.tsx`'s `refAltCandidates`) and the first other catalog
   * allele as the mutant. Indel `-` placeholders (and any multi-base
   * allele) don't qualify, so a proposed WT/MUT pair can never coincide. */
  const rsSuggestion = useMemo(() => {
    if (!rsVariant || rsLocalPos === null) return undefined;
    const wt = (data.gene_seq[rsLocalPos] || '').toUpperCase();
    const isBase = (b: string) => /^[ACGT]$/.test(b);
    return {
      snpPos: rsLocalPos,
      wtBase: isBase(wt) ? wt : null,
      altBase: rsOrientedAlleles.map((a) => a.toUpperCase()).find((a) => isBase(a) && a !== wt) ?? null,
      rsid: rsVariant.id,
    };
  }, [rsVariant, rsLocalPos, rsOrientedAlleles, data.gene_seq]);

  const rsMarker = useMemo<VariantMarker[]>(() => {
    if (!rsVariant || rsLocalPos === null) return [];
    return [{ rsid: rsVariant.id, start: rsLocalPos, end: rsLocalPos + 1, alleles: rsOrientedAlleles }];
  }, [rsVariant, rsLocalPos, rsOrientedAlleles]);

  /** The prop markers plus the looked-up SNP (deduped by rsid, so a batch
   * modal already marking it doesn't render it twice). */
  const allVariantMarkers = useMemo(() => {
    const base = rsMarker.length === 0 ? variantMarkers : [...variantMarkers.filter((m) => m.rsid !== rsMarker[0].rsid), rsMarker[0]];
    // An allele-detection probe's SNP base, marked like any other variant.
    const probe = selections.geneProbe;
    if (!probe?.allele || probe.region !== 'gene') return base;
    const { snpPos, wtBase, mutBase } = probe.allele;
    return [...base, { rsid: `${probe.name ?? 'Probe'} SNP`, start: snpPos, end: snpPos + 1, alleles: [wtBase, mutBase] }];
  }, [variantMarkers, rsMarker, selections.geneProbe]);

  const segments = useMemo(() => {
    const up = flankSegments(data.upstream_seq || '', 'up', data, selections);
    const gene = geneBlockSegments(data, selections, truncateIntrons, allVariantMarkers);
    const down = flankSegments(data.downstream_seq || '', 'down', data, selections);
    return [...up, ...gene, ...down];
  }, [data, selections, truncateIntrons, allVariantMarkers]);

  // Every selection rendered in its own region is draggable, even when its
  // highlight is split into several pieces - a primer straddling an exon/
  // intron or CDS/UTR boundary is drawn as one piece per chunk. (It used to
  // require exactly one piece, so a primer dragged across such a boundary
  // turned read-only and could never be moved back.) `buildCells` decides
  // resize handles by the primer's real first/last base, so the pieces
  // behave as one span.
  const editableKeys = useMemo(() => {
    if (!interactive) return new Set<keyof Selections>();
    const keys = new Set<keyof Selections>();
    for (const s of segments) if (s.key) keys.add(s.key);
    return keys;
  }, [segments, interactive]);

  const searchMatches = useMemo<SearchMatch[]>(() => {
    // Every active search contributes its own highlighting at once: the
    // alignment hit (if any), the rsID hit, and the literal matches. The
    // located "where is it" spans (alignment first, then rsID) lead the
    // ordering so index 0 - what Enter/Next steps to first - is the
    // alignment's binding site when one is set.
    const hits: SearchMatch[] = [];
    if (alignHit) hits.push({ start: alignHit.start, end: alignHit.end, region: alignHit.region, idx: 0 });
    if (rsLocalPos !== null) hits.push({ start: rsLocalPos, end: rsLocalPos + 1, region: 'gene', idx: 0 });
    hits.push(...literalMatches.map((m) => ({ ...m, idx: 0 })));
    return hits.map((m, idx) => ({ ...m, idx }));
  }, [alignHit, rsLocalPos, literalMatches]);
  const activeSearchIdx = searchMatches.length > 0 ? Math.min(activeMatchIndex, searchMatches.length - 1) : -1;

  // Scrolling the active match into view is a real effect: it reaches out
  // to the DOM (an external system) rather than deriving React state.
  // Driven by `scrollToIdx` - set only by an explicit action (Next/Prev/
  // Enter, clicking the summary's binding-site position, an rsID lookup
  // landing), never by merely typing - otherwise every keystroke in either
  // field would yank the map back to a highlight while the user is still
  // editing the other one.
  useEffect(() => {
    if (scrollToIdx < 0 || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-search-idx="${scrollToIdx}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [scrollToIdx, searchMatches]);

  /** Scroll only explicit, never from the searchKey-typing reset. */
  function scrollToMatch(idx: number) {
    setScrollToIdx(idx);
    setActiveMatchIndex(idx);
  }

  function gotoFirst() {
    if (searchMatches.length > 0) scrollToMatch(0);
  }

  scrollToFirstRef.current = gotoFirst;

  function gotoNextMatch() {
    if (searchMatches.length === 0) return;
    scrollToMatch((activeSearchIdx + 1) % searchMatches.length);
  }

  function gotoPrevMatch() {
    if (searchMatches.length === 0) return;
    scrollToMatch((activeSearchIdx - 1 + searchMatches.length) % searchMatches.length);
  }

  function commitDrag(session: DragSession, finalDeltaChars: number) {
    if (finalDeltaChars === 0) return; // a click with no drag - leave the selection untouched
    const sel = selections[session.selKey];
    if (!sel || !onSelect) return;

    const rawSeq = regionRawSeq(data, session.region);
    const { start, end } = computeDraggedInterval(session, finalDeltaChars, rawSeq.length);
    if (start === sel.start && end === sel.end) return;

    const bindingSeq = rawSeq.substring(start, end);
    // `bindingSeq` is always the sense-strand slice; `primerSeq` matches it
    // for a forward-strand pick and is its reverse complement for a
    // reverse-strand one - inferred from how the pre-drag selection itself
    // relates the two (see `ArmsDesignPanel.tsx`/`ManualDesignPanel.tsx`,
    // which both set this invariant up when a selection is first made).
    const isReverseStrand = selectionStrand(sel) === 'R';
    const primerSeq = isReverseStrand ? reverseComplement(bindingSeq) : bindingSeq;

    const next: Selection = { ...sel, start, end, primerSeq, bindingSeq, source: 'manual', analysis: undefined };
    commitSelection(session.selKey, next);
    // The mutant twin is the same primer but for its 3' base, so it
    // follows the wild-type twin's new 5' end.
    if (session.selKey === 'armsRefPrimer' && next.arms && selections.armsAltPrimer) {
      commitSelection('armsAltPrimer', armsMutantTwin(next, selections.armsAltPrimer.name));
    }
    // Likewise the mutant allele probe, which differs only at the SNP.
    if (session.selKey === 'geneProbe' && next.allele && selections.geneProbeAlt) {
      commitSelection('geneProbeAlt', alleleMutantProbe(next, selections.geneProbeAlt.name));
    }
  }

  // Right-click menu over a selected stretch (primer/probe picks, BLAST,
  // structures) and the set-then-analyze step drag commits share with it.
  const pickMenu = useMapPickMenu({ data, selections, onSelect, pickKinds, rsSuggestion });
  const commitSelection = pickMenu.commitSelection;

  useEffect(() => {
    if (!dragSession) return;
    let lastX = 0;
    let lastY = 0;
    // The base under the pointer, in the dragged selection's own region -
    // off the sequence (a gutter, a gap, another region) keeps the last
    // position rather than snapping back.
    function track() {
      const hit = baseAtPoint(lastX, lastY);
      if (!hit || hit.region !== dragSession!.region) return;
      const next = hit.pos - dragSession!.anchorPos;
      deltaCharsRef.current = next;
      setDeltaChars(next);
    }
    function onMove(e: MouseEvent) {
      lastX = e.clientX;
      lastY = e.clientY;
      track();
    }
    // Wheel-scrolling the map mid-drag moves the sequence under a still
    // pointer - re-read it so a primer can be carried past the visible rows.
    function onScroll() {
      if (lastX || lastY) track();
    }
    function onUp() {
      commitDrag(dragSession!, deltaCharsRef.current);
      deltaCharsRef.current = 0;
      setDeltaChars(0);
      setDragSession(null);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('scroll', onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragSession]);

  function startDrag(e: React.MouseEvent<HTMLSpanElement>, key: keyof Selections, type: 'move' | 'left' | 'right', sel: Selection) {
    // Left button only - any other button must fall through to the
    // container untouched: a right-click opens the pick menu instead of
    // moving the primer.
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setDragSession({ selKey: key, type, anchorPos: Number(e.currentTarget.dataset.pos), initStart: sel.start, initEnd: sel.end, region: sel.region, mustCover: sel.allele?.snpPos });
    setDeltaChars(0);
  }

  const rawCells = buildCells(segments, interactive, dragSession, deltaChars, editableKeys, data, selections, startDrag);
  const variantCells = applyVariantHighlight(rawCells, allVariantMarkers);
  const cells = applySearchHighlight(variantCells, searchMatches, activeSearchIdx);
  const rows = buildRows(cells, lineWidth);

  // Hovering a base shows its position from the start of the gene (and
  // its genomic coordinate when there is one). Flank-local positions are
  // shifted into gene coordinates: negative upstream, past gene_len
  // downstream. A base carrying `data-variant-rsid` (a marked SNP - the
  // batch markers and an rsID "Find in sequence" hit, see
  // `applyVariantHighlight`) also names that SNP and its alleles in the
  // same tooltip, via `describeGenePosition`'s `extra` line, instead of
  // the old native `title` on the marker span (which stacked a second,
  // OS-styled tooltip on top of this one).
  const variantByRsid = useMemo(() => new Map(allVariantMarkers.map((m) => [m.rsid, m])), [allVariantMarkers]);
  const dragSelect = useMapDragSelect({ containerRef });
  const { handlers: hoverHandlers, tooltip } = useBaseHover(({ region, pos, base, variantRsid }) => {
    const local = region === 'up' ? pos - data.upstream_len : region === 'down' ? data.gene_len + pos : pos;
    const m = variantRsid !== undefined ? variantByRsid.get(variantRsid) : undefined;
    return describeGenePosition(data, local, base, m ? `${m.rsid}${m.alleles?.length ? ` (${m.alleles.join('/')})` : ''}` : undefined);
  }, dragSession === null && !pickMenu.busy && !dragSelect.active);

  const modeText = data.include_introns
    ? 'Genomic DNA (with introns; CDS bold, UTR highlighted)'
    : data.include_utr
      ? 'Spliced transcript (UTR highlighted, CDS bold)'
      : 'Spliced CDS only (no UTR)';

  return (
    <div>
      <div className="mb-4 text-sm text-ink-muted">
        <p>
          <strong className="font-medium text-ink">Transcript:</strong> {data.transcript_name} (
          {!isCustomSequence && /^N[MRX]_/.test(data.transcript_id) ? (
            <a
              href={`https://www.ncbi.nlm.nih.gov/nuccore/${encodeURIComponent(data.transcript_id)}`}
              target="_blank"
              rel="noreferrer"
              title="Open this transcript in GenBank"
              className="text-accent hover:text-accent-hover hover:underline"
            >
              {data.transcript_id}
            </a>
          ) : (
            data.transcript_id
          )}
          )
          {!isCustomSequence && (
            <>
              {' · '}
              <strong className="font-medium text-ink">Gene ID:</strong>{' '}
              {apiSource === 'ncbi' && seqIds?.geneId ? (
                <a
                  href={`https://www.ncbi.nlm.nih.gov/gene/${encodeURIComponent(seqIds.geneId)}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open this gene in NCBI Gene"
                  className="text-accent hover:text-accent-hover hover:underline"
                >
                  {seqIds.geneId}
                </a>
              ) : seqIds?.geneId ? (
                seqIds.geneId
              ) : (
                '…'
              )}
              {' · '}
              <strong className="font-medium text-ink">Assembly:</strong>{' '}
              {seqIds?.assembly ? (
                apiSource === 'ncbi' || /GC[AF]_/.test(seqIds.assembly) ? (
                  <a
                    href={`https://www.ncbi.nlm.nih.gov/assembly/${encodeURIComponent(seqIds.assembly)}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Open this assembly in NCBI Assembly"
                    className="text-accent hover:text-accent-hover hover:underline"
                  >
                    {seqIds.assembly}
                  </a>
                ) : (
                  seqIds.assembly
                )
              ) : (
                '…'
              )}
            </>
          )}
        </p>
        <p>
          <strong className="font-medium text-ink">Mode:</strong> {modeText} · <strong className="font-medium text-ink">Length:</strong> {data.gene_len} bp
        </p>
        <p>
          <strong className="font-medium text-ink">Flanking:</strong> {data.upstream_len} bp upstream, {data.downstream_len} bp downstream
        </p>
        <p className="mt-1 text-xs text-ink-faint">
          Numbers on the left mark each row's first position: 0-based from the start of its own region (upstream flank, gene, or downstream flank). Hover a base to see its position from the gene start.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-2 rounded-md border border-line bg-surface-2 p-3">
        <label htmlFor="sequence-search-input" className="text-sm font-medium text-ink-muted">
          Find in sequence:
        </label>
        <input
          id="sequence-search-input"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (e.shiftKey) gotoPrevMatch();
            else gotoNextMatch();
          }}
          placeholder="Paste a primer/sequence or an rsID (rs334) to locate…"
          className="h-8 min-w-[220px] flex-1 rounded-md border border-line-strong bg-surface px-3 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
        />
        <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={includeRevComp}
            onChange={(e) => setIncludeRevComp(e.target.checked)}
            className="h-3.5 w-3.5 rounded accent-accent"
          />
          Include reverse complement
        </label>
        <button
          type="button"
          onClick={gotoPrevMatch}
          title="Previous match"
          className="h-7 rounded-md border border-line-strong bg-surface px-2.5 text-xs font-medium text-ink-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          &#8592; Prev
        </button>
        <button
          type="button"
          onClick={gotoNextMatch}
          title="Next match"
          className="h-7 rounded-md border border-line-strong bg-surface px-2.5 text-xs font-medium text-ink-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          Next &#8594;
        </button>
        <button
          type="button"
          onClick={() => setSearchQuery('')}
          className="h-7 rounded-md px-2.5 text-xs font-medium text-ink-faint hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          Clear
        </button>
        <span className="text-xs text-ink-faint" aria-live="polite">
          {literalMatches.length === 0
            ? rsQuery || searchQuery === ''
              ? ''
              : 'No matches found'
            : `${Math.min(activeMatchIndex, literalMatches.length - 1) + 1} of ${literalMatches.length} match${literalMatches.length === 1 ? '' : 'es'}`}
        </span>
        <span aria-hidden="true" className="mx-1 hidden h-5 w-px bg-line-strong sm:inline-block" />
        <label htmlFor="sequence-align-input" className="text-sm font-medium text-ink-muted">
          Align in sequence:
        </label>
        <input
          id="sequence-align-input"
          type="text"
          value={alignQuery}
          onChange={(e) => setAlignQuery(e.target.value)}
          placeholder="Paste a primer/amplicon - best binding site even with mismatches…"
          className="h-8 min-w-[220px] flex-1 rounded-md border border-line-strong bg-surface px-3 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
        />
        <button
          type="button"
          disabled={cleanDNA(alignQuery).length < 10}
          onClick={() => setAlignHit(findBestAlignment(data, cleanDNA(alignQuery)))}
          title="Locate the best local alignment (Smith-Waterman, both strands) of this sequence on the map - needs at least 10 bases"
          className="h-7 rounded-md border border-transparent bg-accent-solid px-2.5 text-xs font-medium text-white hover:bg-accent-solid-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50"
        >
          Find alignment
        </button>
        {alignQuery !== '' && (
          <button
            type="button"
            onClick={() => {
              setAlignQuery('');
              setAlignHit(null);
            }}
            className="h-7 rounded-md px-2.5 text-xs font-medium text-ink-faint hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            Clear
          </button>
        )}
      </div>

      {/* rsID-search result summary - a small panel under the search bar
       * (see the `rsQuery` machinery above). Kept outside the search bar's
       * flex row so a long consequence/clinical-significance list can wrap
       * without stretching the input row. */}
      {rsQuery && rsLookupCurrent?.status === 'loading' && <p className="-mt-2 mb-3 text-xs text-ink-muted">Looking up {rsQuery}…</p>}
      {rsQuery && rsLookupCurrent?.status === 'error' && <p className="-mt-2 mb-3 text-xs text-ink-muted">{rsLookupCurrent.message}</p>}
      {rsVariant && rsFound && (
        <div className="-mt-2 mb-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-mono font-semibold text-ink">{rsVariant.id}</span>
            <span className="font-mono">
              chr{rsVariant.chrom}:{rsVariant.start.toLocaleString()}
            </span>
            {rsOrientedAlleles.length > 0 && <span className="font-mono">{rsOrientedAlleles.join('/')}</span>}
            {rsVariant.consequence_type && <span>{rsVariant.consequence_type.replace(/_/g, ' ')}</span>}
            {rsVariant.clinical_significance.length > 0 && <span className="font-medium text-warning">{rsVariant.clinical_significance.join(', ')}</span>}
            {rsVariant.minor_allele_freq !== null && (
              <span>
                MAF {rsVariant.minor_allele ? `${rsVariant.minor_allele}: ` : ''}
                {(rsVariant.minor_allele_freq * 100).toFixed(2)}%
              </span>
            )}
          </div>
          <p className="mt-1 text-ink-faint">
            Found in {rsFound.foundIn.species} ({rsFound.foundIn.source}).{' '}
            {rsFoundInSpecies !== species
              ? `The loaded sequence is from ${species ?? 'a custom paste'} - there's nothing to highlight here.`
              : !data.include_introns
                ? "This is a spliced view - an rsID can only be located on the intron-inclusive genomic map (tick 'Include introns' in step 2 and reload the sequence)."
                : rsVariant.chrom && data.chrom && rsVariant.chrom !== data.chrom
                  ? `This SNP is on chromosome ${rsVariant.chrom}, but the loaded sequence is chromosome ${data.chrom}.`
                  : rsLocalPos === null
                    ? `Outside ${data.transcript_name}'s span (${data.chrom}:${data.gene_start_genomic.toLocaleString()}-${data.gene_end_genomic.toLocaleString()}) - it may still be in the gene, under another transcript.`
                    : 'Highlighted in the sequence below.'}
          </p>
        </div>
      )}

      {/* "Align in sequence" result - position/strand/identity on one line,
       * the pairwise rows themselves when the match is imperfect. Sits
       * beside the rsID summary above - both stay visible when both fields
       * are in use, each search highlighting its own span. */}
      {alignHit && (
        <div className="-mt-2 mb-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-semibold text-ink">
              Best binding site:{' '}
              <button
                type="button"
                onClick={() => scrollToMatch(0)}
                title="Scroll the map to this hit"
                className="font-mono text-accent hover:text-accent-hover hover:underline"
              >
                {alignHit.region === 'up' ? 'upstream flank' : alignHit.region === 'down' ? 'downstream flank' : 'gene'} {alignHit.start + 1}–{alignHit.end}
              </button>
            </span>
            <span className="font-mono">strand {alignHit.strand === '+' ? '+' : '−'}</span>
            <span>
              identity{' '}
              <span className="font-mono">
                {alignHit.matches}/{alignHit.alignedColumns} ({alignHit.identityPct.toFixed(1)}%)
              </span>
            </span>
            <span>
              score <span className="font-mono">{alignHit.score}</span>
            </span>
          </div>
          {alignHit.strand === '-' && (
            <p className="mt-1 text-ink-faint">It matched on the reverse complement - the pasted sequence binds the antisense strand at this spot.</p>
          )}
          {alignHit.identityPct < 100 && (
            <pre className="mt-1.5 overflow-x-auto font-mono text-[11px] leading-snug text-ink">{formatAlignmentRows(alignHit)}</pre>
          )}
        </div>
      )}

      <div
        id="sequence-map"
        ref={containerRef}
        className="sequence-viewer relative max-h-[520px] overflow-y-auto overflow-x-hidden overscroll-contain rounded-lg border border-line bg-base p-4 text-sm"
        {...hoverHandlers}
        onMouseDown={dragSelect.onMouseDown}
        onContextMenu={pickMenu.onContextMenu}
      >
        {tooltip}
        {dragSelect.overlay}
        {/* Unrendered (out of flow, invisible) - measured only, to figure
         * out how many characters actually fit in one row of this
         * container at its current width/font, so rows can fill the
         * available space instead of wrapping at an arbitrary fixed
         * count. `relative` on the container above makes it the probes'
         * (and every row's) positioning/containing-block context, so
         * nothing here can ever leak width to an ancestor and cause page-
         * level horizontal scroll; `overflow-x-hidden` (not `-auto`) below
         * makes "never horizontal scroll" a hard guarantee rather than a
         * best-effort of the width math above - if a row's content is
         * ever a hair wider than computed (a rounding edge case), it's
         * silently clipped instead of ever showing a scrollbar. */}
        <span ref={gutterProbeRef} aria-hidden className="select-none pl-1 pr-3 text-right tabular-nums shrink-0 min-w-[5.5ch]" style={{ position: 'absolute', visibility: 'hidden', whiteSpace: 'pre' }}>
          -00000
        </span>
        {/* `fontWeight: 700` deliberately - `seq-cds`/`seq-primer`/`seq-probe`
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
            <span className="select-none pl-1 pr-3 text-right text-ink-faint tabular-nums shrink-0 min-w-[5.5ch]">{row.startPos}</span>
            <span>
              {row.pieces.map((p, pi) => (
                <span
                  key={pi}
                  className={`${p.className}${p.cursorClass ? ` ${p.cursorClass}` : ''}${p.isSearchHit ? ' seq-search-hit' : ''}${p.isActiveSearchHit ? ' seq-search-hit-active' : ''}${p.isVariant ? ' seq-variant-hit' : ''}`}
                  id={p.id}
                  data-search-idx={p.searchIdx}
                  data-variant-rsid={p.variantRsid}
                  data-region={p.region}
                  data-pos={p.region ? p.startPos : undefined}
                  data-pick-key={p.pickKey}
                  onMouseDown={p.onMouseDown}
                >
                  {p.text}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>

      {pickMenu.overlay}
    </div>
  );
}
