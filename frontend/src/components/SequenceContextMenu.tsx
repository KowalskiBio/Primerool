import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** What a right-click on a selected stretch of the sequence map can do. */
export type MapAction = 'F' | 'R' | 'P' | 'B' | 'S';

/** Length limits per action (inclusive, bp) - loose on purpose: they only
 * rule out selections an action can't sensibly handle. */
const LIMITS: Record<'primer' | 'structure' | 'blast', [number, number]> = {
  primer: [10, 60],
  structure: [5, 100],
  blast: [20, 10_000],
};

interface MenuItem {
  action: MapAction;
  label: string;
  /** Why it can't run, or `null` when it can. */
  disabledReason: string | null;
}

function lengthReason(len: number, [min, max]: [number, number]): string | null {
  if (len < min) return `Select at least ${min} bp (${len} selected)`;
  if (len > max) return `Select at most ${max.toLocaleString('en-US')} bp (${len.toLocaleString('en-US')} selected)`;
  return null;
}

interface Props {
  /** Viewport coordinates of the right-click. */
  x: number;
  y: number;
  /** A resolved selection, or `{ error }` to show only that message. */
  target: { length: number; heading: string; inGene: boolean } | { error: string };
  /** False when the map can't take primer/probe picks (no `onSelect`). */
  canPick: boolean;
  onAction: (a: MapAction) => void;
  onClose: () => void;
}

/** The sequence map's right-click menu: primer F/R, probe, BLAST and
 * secondary structures for the selected stretch. Each item's letter is
 * also its keyboard shortcut while the menu is open; arrow keys + Enter
 * work too, and Escape, a click elsewhere, scrolling or resizing close it. */
export default function SequenceContextMenu({ x, y, target, canPick, onAction, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [active, setActive] = useState(0);

  const items: MenuItem[] =
    'error' in target
      ? []
      : [
          { action: 'F', label: 'Select as forward primer', disabledReason: canPick ? lengthReason(target.length, LIMITS.primer) : 'Primer picks are not available in this view' },
          { action: 'R', label: 'Select as reverse primer', disabledReason: canPick ? lengthReason(target.length, LIMITS.primer) : 'Primer picks are not available in this view' },
          {
            action: 'P',
            label: 'Select as probe',
            disabledReason: !canPick ? 'Probe picks are not available in this view' : !target.inGene ? 'A probe must lie within the gene, not a flank' : lengthReason(target.length, LIMITS.primer),
          },
          { action: 'B', label: 'BLAST', disabledReason: lengthReason(target.length, LIMITS.blast) },
          { action: 'S', label: 'Secondary structures', disabledReason: lengthReason(target.length, LIMITS.structure) },
        ];

  // Keep the menu on-screen: flip it left/up when it would overflow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: x + r.width > window.innerWidth - 8 ? Math.max(8, x - r.width) : x,
      top: y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height) : y,
    });
    el.focus();
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);

  function run(item: MenuItem | undefined) {
    if (!item || item.disabledReason) return;
    onAction(item.action);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (items.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      run(items[active]);
      return;
    }
    const byKey = items.find((it) => it.action === e.key.toUpperCase());
    if (byKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      run(byKey);
    }
  }

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      aria-label="Selection actions"
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[70] min-w-[15rem] rounded-md border border-line bg-surface py-1 text-sm text-ink shadow-lg outline-none"
      style={{ left: pos.left, top: pos.top }}
    >
      {'error' in target ? (
        <p className="max-w-xs px-3 py-2 text-xs text-warning">{target.error}</p>
      ) : (
        <>
          <p className="border-b border-line px-3 pb-1.5 pt-1 font-mono text-xs text-ink-muted">{target.heading}</p>
          {items.map((it, i) => (
            <button
              key={it.action}
              type="button"
              role="menuitem"
              aria-disabled={it.disabledReason !== null}
              title={it.disabledReason ?? undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(it)}
              className={`flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left ${
                it.disabledReason ? 'cursor-not-allowed text-ink-faint' : `cursor-pointer ${i === active ? 'bg-surface-2' : ''} hover:bg-surface-2`
              }`}
            >
              <span>{it.label}</span>
              <kbd className="rounded border border-line px-1.5 font-mono text-[11px] text-ink-muted">{it.action}</kbd>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
