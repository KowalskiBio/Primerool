import { LIMITS } from './mapPickMenu';

/** The geometry of one primer/probe drag on a sequence map - shared by the
 * genomic map (`SequenceViewer`) and the Exon map (`SplicedSequenceViewer`)
 * so a pick moves and resizes the same way in both. Positions are 0-based,
 * end-exclusive, in whichever coordinate space the map drags in. */
export interface DragGeometry {
  type: 'move' | 'left' | 'right';
  /** Position of the base the drag grabbed - the drag distance is the base
   * now under the pointer minus this one, so it follows the pointer across
   * row wraps, not just along one row. */
  anchorPos: number;
  initStart: number;
  initEnd: number;
  /** A base the span must keep covering - an allele probe's SNP. */
  mustCover?: number;
}

/** Applies `deltaChars` to a drag's original bounds, clamping to the
 * primer/probe length limits (the same as a right-click pick's, so a longer
 * pick is never snapped shorter on its first edge drag) and to `[lo, hi)`.
 * Used for both the live preview (every mousemove) and the final commit
 * (mouseup), so they always agree. */
export function computeDraggedInterval(session: DragGeometry, deltaChars: number, lo: number, hi: number): { start: number; end: number } {
  const [minLen, maxLen] = LIMITS.primer;
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

  if (start < lo) {
    if (session.type === 'move') end += lo - start;
    start = lo;
  }
  if (end > hi) {
    if (session.type === 'move') start -= end - hi;
    end = hi;
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

  start = Math.max(lo, start);
  end = Math.min(hi, end);
  if (end - start < minLen) end = Math.min(hi, start + minLen);

  return { start, end };
}
