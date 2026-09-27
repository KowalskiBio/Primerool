/** A text selection inside a sequence map, resolved to sequence
 * coordinates: 0-based, end-exclusive, local to one region's raw sequence
 * (the same space as `Selection.start`/`end`). `'spliced'` is the Exon
 * map's coordinate space (`data.spliced_exons_seq`). */
export interface MapSelection {
  kind: 'contiguous';
  region: 'up' | 'gene' | 'down' | 'spliced';
  start: number;
  end: number;
}

/** A gene-region selection that crosses one or more collapsed introns:
 * the visible pieces either side, in order. Only usable where the hidden
 * bases don't matter - joined up as an exon-exon junction primer. */
export interface GappedMapSelection {
  kind: 'gapped';
  pieces: { start: number; end: number }[];
}

export type MapPick = MapSelection | GappedMapSelection;

/** Resolves the browser's current text selection inside `container` (a
 * sequence map whose base spans carry `data-region`/`data-pos` - see
 * `SequenceViewer.tsx` and `SplicedSequenceViewer.tsx`) to sequence
 * coordinates.
 *
 * Returns `null` when there's no selection in the map (the caller should
 * then leave the native context menu alone), or `{ error }` when there is
 * one but it can't stand for any stretch of sequence (it crosses a flank/
 * gene boundary). Positions come from the spans' `data-pos`, never from
 * the selected text itself, so gutter numbers and exon labels (no
 * `data-pos`) are simply skipped. */
export function resolveMapSelection(container: HTMLElement): MapPick | { error: string } | null {
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
  let crossedPlaceholder = false;
  const pieces: { start: number; end: number }[] = [];
  for (const node of nodes) {
    const span = node.parentElement;
    if (span?.classList.contains('seq-intron-placeholder')) {
      crossedPlaceholder = true;
      continue;
    }
    const r = span?.dataset.region;
    const posAttr = span?.dataset.pos;
    if (!span || !r || posAttr === undefined) continue; // gutter numbers, exon labels, ...
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : (node.textContent ?? '').length;
    if (to <= from) continue;
    if (region !== null && r !== region) {
      return { error: 'Selection spans the flank/gene boundary - select within one region.' };
    }
    region = r as MapSelection['region'];
    const pos = Number(posAttr);
    const last = pieces[pieces.length - 1];
    // Adjacent on screen and in the sequence: extend the current piece.
    if (last && last.end === pos + from) last.end = pos + to;
    else pieces.push({ start: pos + from, end: pos + to });
  }

  if (region === null || pieces.length === 0) return null;
  if (pieces.length === 1 && !crossedPlaceholder) return { kind: 'contiguous', region, start: pieces[0].start, end: pieces[0].end };
  if (region !== 'gene') return { error: 'Selection is not one continuous stretch of sequence.' };
  return { kind: 'gapped', pieces };
}
