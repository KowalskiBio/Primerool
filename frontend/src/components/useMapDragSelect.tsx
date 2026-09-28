import { useEffect, useRef, useState, type ReactNode } from 'react';
import { resolveMapSelection, type MapPick } from '../utils/mapSelection';

/** How many bases a resolved selection covers - a gapped one (across
 * collapsed introns) sums its visible pieces, the bases actually
 * selected. */
function pickLength(pick: MapPick): number {
  return pick.kind === 'contiguous' ? pick.end - pick.start : pick.pieces.reduce((n, p) => n + p.end - p.start, 0);
}

/** Movement threshold in px - below this the gesture is a click, not a
 * drag, and no badge is shown. */
const ARM_PX = 3;

interface Options {
  /** The map's scroll container - the same element the hover handlers
   * and the container-level mousedown live on. */
  containerRef: React.RefObject<HTMLElement | null>;
}

/** Live length readout for a sequence map's left-drag selection: the
 * browser's own text selection already owns the gesture, so this hook
 * only watches - once a left-press inside the map has actually moved
 * (past `ARM_PX`), every mousemove resolves the current selection to
 * sequence coordinates and floats an "N bp" (or error) badge at the
 * cursor, until the button is released.
 *
 * Spread `onMouseDown` onto the map's scroll container, render
 * `overlay`, and fold `active` into whatever the map disables while
 * the user is mid-gesture (e.g. the hover tooltip) - shared by
 * `SequenceViewer` and `SplicedSequenceViewer`, mirroring
 * `useMapPickMenu`. */
export function useMapDragSelect({ containerRef }: Options) {
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [badge, setBadge] = useState<{ x: number; y: number; text: string } | null>(null);
  // Whether the pointer has moved past `ARM_PX` since the press. A ref,
  // not state: only the live window-level mousemove handlers read it.
  const armedRef = useRef(false);

  function onMouseDown(e: React.MouseEvent<HTMLElement>) {
    if (e.button !== 0) return;
    armedRef.current = false;
    setDrag({ x: e.clientX, y: e.clientY });
  }

  useEffect(() => {
    if (!drag) return;
    const container = containerRef.current;
    // Destructured once: the window-level closures below must not re-read
    // `drag` (whose type includes `null`).
    const { x, y } = drag;

    function onMove(e: MouseEvent) {
      if (!armedRef.current) {
        if (Math.abs(e.clientX - x) < ARM_PX && Math.abs(e.clientY - y) < ARM_PX) return;
        armedRef.current = true;
      }
      const res = container ? resolveMapSelection(container) : null;
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
