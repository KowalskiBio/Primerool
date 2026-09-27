/** A text selection inside a sequence map, resolved to sequence
 * coordinates: 0-based, end-exclusive, local to one region's raw sequence
 * (the same space as `Selection.start`/`end`). */
export interface MapSelection {
  region: 'up' | 'gene' | 'down';
  start: number;
  end: number;
}

/** Resolves the browser's current text selection inside `container` (a
 * sequence map whose base spans carry `data-region`/`data-pos` - see
 * `SequenceViewer.tsx`) to sequence coordinates.
 *
 * Returns `null` when there's no selection in the map (the caller should
 * then leave the native context menu alone), or `{ error }` when there is
 * one but it can't stand for a single stretch of sequence: it crosses a
 * flank/gene boundary, or it spans a collapsed intron (whose bases aren't
 * on screen to select). Positions come from the spans' `data-pos`, never
 * from the selected text itself, so gutter numbers (no `data-pos`) are
 * simply skipped. */
export function resolveMapSelection(container: HTMLElement): MapSelection | { error: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;

  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  // A selection inside a single text node has that node as its common
  // ancestor, which the walker (rooted there) would never visit itself.
  const nodes: Text[] = range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? [range.commonAncestorContainer as Text] : [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (range.intersectsNode(n)) nodes.push(n as Text);
  }

  let region: MapSelection['region'] | null = null;
  let start = Infinity;
  let end = -Infinity;
  let chars = 0;
  for (const node of nodes) {
    const span = node.parentElement;
    if (span?.classList.contains('seq-intron-placeholder')) {
      return { error: 'Selection spans a collapsed intron - untick "Truncate introns" to select across it.' };
    }
    const r = span?.dataset.region;
    const posAttr = span?.dataset.pos;
    if (!span || !r || posAttr === undefined) continue; // gutter numbers etc.
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : (node.textContent ?? '').length;
    if (to <= from) continue;
    if (region !== null && r !== region) {
      return { error: 'Selection spans the flank/gene boundary - select within one region.' };
    }
    region = r as MapSelection['region'];
    const pos = Number(posAttr);
    start = Math.min(start, pos + from);
    end = Math.max(end, pos + to);
    chars += to - from;
  }

  if (region === null) return null;
  // Contiguous on screen but not in the sequence means something between
  // the ends isn't rendered as bases.
  if (end - start !== chars) {
    return { error: 'Selection spans a collapsed intron - untick "Truncate introns" to select across it.' };
  }
  return { region, start, end };
}
