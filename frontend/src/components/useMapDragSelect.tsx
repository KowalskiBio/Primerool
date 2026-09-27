import { useEffect, useRef, useState, type ReactNode } from 'react';
import { caretAtPoint } from './BaseHoverTooltip';
import { resolveMapSelection, type MapPick } from '../utils/mapSelection';

/** A caret position over a real base span (`data-region`/`data-pos`
 * present) - gutter numbers, exon labels and collapsed-intron
 * placeholders don't count. */
function baseCaretAt(x: number, y: number): { node: Node; offset: number } | null {
  const caret = caretAtPoint(x, y);
  const el = caret && caret.node.nodeType === Node.TEXT_NODE ? caret.node.parentElement : null;
  if (!caret || !el || el.dataset.region === undefined || el.dataset.pos === undefined) return null;
  return caret;
}

/** How many bases a resolved selection covers - a gapped one (across
 * collapsed introns) sums its visible pieces, the bases actually
 * selected. */
function pickLength(pick: MapPick): number {
  return pick.kind === 'contiguous' ? pick.end - pick.start : pick.pieces.reduce((n, p) => n + p.end - p.start, 0);
}

/** Arm threshold in px - below this the gesture is a right-click, not a
 * drag, and must not disturb the selection at all. */
const ARM_PX = 3;

interface Options {
  /** The map's scroll container - the same element the hover handlers
   * and `useMapPickMenu`'s `onContextMenu` live on. */
  containerRef: React.RefObject<HTMLElement | null>;
}

/** Right-button drag-select for a sequence map: pressing the right
 * button over a base anchors a selection, and once the pointer has
 * actually moved it drives the browser's own text selection
 * (`setBaseAndExtent`/`extend`) from that anchor to the pointer, with a
 * live "N bp" badge at the cursor. The gesture never swallows a plain
 * right-click - without movement past `ARM_PX` nothing changes, so
 * right-clicking an existing selection still opens its action menu
 * untouched. On release the selection stays put, and the `contextmenu`
 * event (which the browser fires right after the mouseup) opens the
 * map's action menu on it, its heading repeating the length.
 *
 * Spread `onMouseDown` onto the map's scroll container, render
 * `overlay`, and fold `active` into whatever the map disables while the
 * user is mid-gesture (e.g. the hover tooltip) - shared by
 * `SequenceViewer` and `SplicedSequenceViewer`, mirroring
 * `useMapPickMenu`. */
export function useMapDragSelect({ containerRef }: Options) {
  const [drag, setDrag] = useState<{ x: number; y: number; anchor: { node: Node; offset: number } } | null>(null);
  const [badge, setBadge] = useState<{ x: number; y: number; text: string } | null>(null);
  // Whether the pointer has moved past `ARM_PX` since the press. A ref,
  // not state: only the live window-level mousemove handlers read it.
  const armedRef = useRef(false);

  function onMouseDown(e: React.MouseEvent<HTMLElement>) {
    if (e.button !== 2) return;
    const caret = baseCaretAt(e.clientX, e.clientY);
    if (!caret) return; // not over a base - leave the browser's own behavior alone
    armedRef.current = false;
    setDrag({ x: e.clientX, y: e.clientY, anchor: caret });
  }

  useEffect(() => {
    if (!drag) return;
    const container = containerRef.current;
    // Destructured once: the window-level closures below must not re-read
    // `drag` (whose type includes `null`).
    const { x, y, anchor } = drag;

    function onMove(e: MouseEvent) {
      const caret = baseCaretAt(e.clientX, e.clientY);
      const sel = window.getSelection();
      if (!caret || !container || !sel) return; // pointer off the bases - keep the selection where it was
      if (!armedRef.current) {
        if (Math.abs(e.clientX - x) < ARM_PX && Math.abs(e.clientY - y) < ARM_PX) return;
        armedRef.current = true;
        sel.setBaseAndExtent(anchor.node, anchor.offset, caret.node, caret.offset);
      } else {
        sel.extend(caret.node, caret.offset);
      }
      const res = resolveMapSelection(container);
      setBadge(
        res
          ? 'error' in res
            ? { x: e.clientX, y: e.clientY, text: res.error }
            : { x: e.clientX, y: e.clientY, text: `${pickLength(res).toLocaleString('en-US')} bp` }
          : null,
      );
    }

    function onUp() {
      setDrag(null);
      setBadge(null);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  const overlay: ReactNode = badge ? (
    <div
      role="status"
      className="pointer-events-none fixed z-[60] max-w-xs rounded-md border border-line bg-surface px-2 py-1 font-mono text-xs font-semibold text-ink shadow-lg"
      style={{ left: badge.x + 14, top: badge.y + 16 }}
    >
      {badge.text}
    </div>
  ) : null;

  return { onMouseDown, overlay, active: drag !== null };
}
