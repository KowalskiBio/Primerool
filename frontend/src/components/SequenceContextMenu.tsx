import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** One menu row. Either runs `onRun` or, with `submenu`, opens a nested
 * list (on hover, → / Enter, or its letter). `shortcut` is the key that
 * activates it while its list is open. */
export interface MenuEntry {
  shortcut: string;
  label: string;
  /** Why it can't run, or `null` when it can. A disabled entry with a
   * submenu doesn't open. */
  disabledReason: string | null;
  /** Secondary text under the label (e.g. what the pick will replace). */
  hint?: string;
  onRun?: () => void;
  submenu?: MenuEntry[];
}

interface Props {
  /** Viewport coordinates of the right-click. */
  x: number;
  y: number;
  /** Line above the entries (e.g. "22 bp · 6–27"), or an error to show
   * instead of any entries. */
  heading: string;
  error?: string;
  entries: MenuEntry[];
  onClose: () => void;
}

function keepOnScreen(el: HTMLElement, x: number, y: number, flipX?: number) {
  const r = el.getBoundingClientRect();
  return {
    left: x + r.width > window.innerWidth - 8 ? Math.max(8, (flipX ?? x) - r.width) : x,
    top: y + r.height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - 8 - r.height) : y,
  };
}

function MenuList({
  entries,
  active,
  setActive,
  openSub,
  onRun,
}: {
  entries: MenuEntry[];
  active: number;
  setActive: (i: number) => void;
  openSub: number | null;
  onRun: (e: MenuEntry, i: number) => void;
}) {
  return (
    <>
      {entries.map((it, i) => {
        const disabled = it.disabledReason !== null;
        return (
          <button
            key={it.shortcut}
            type="button"
            role="menuitem"
            aria-disabled={disabled}
            aria-haspopup={it.submenu ? 'menu' : undefined}
            aria-expanded={it.submenu ? openSub === i : undefined}
            title={it.disabledReason ?? undefined}
            onMouseEnter={() => setActive(i)}
            onClick={() => onRun(it, i)}
            className={`flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left ${
              disabled ? 'cursor-not-allowed text-ink-faint' : `cursor-pointer hover:bg-surface-2 ${i === active || openSub === i ? 'bg-surface-2' : ''}`
            }`}
          >
            <span className="min-w-0">
              <span className="block">{it.label}</span>
              {it.hint && !disabled && <span className="block text-[11px] text-ink-faint">{it.hint}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <kbd className="rounded border border-line px-1.5 font-mono text-[11px] text-ink-muted">{it.shortcut}</kbd>
              {it.submenu && <span aria-hidden="true" className="text-ink-faint">›</span>}
            </span>
          </button>
        );
      })}
    </>
  );
}

/** The sequence map's right-click menu (see `utils/mapPickMenu.ts` for
 * what goes in it). Keyboard: letters activate, ↑/↓ move, → or Enter
 * opens a submenu, ← closes it, Escape closes the submenu first, then the
 * menu. A click elsewhere, scrolling or resizing closes it too. */
export default function SequenceContextMenu({ x, y, heading, error, entries, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [active, setActive] = useState(0);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [subActive, setSubActive] = useState(0);
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(keepOnScreen(el, x, y));
    el.focus();
  }, [x, y]);

  // Place an open submenu beside its row (flipping left near the edge).
  useLayoutEffect(() => {
    if (openSub === null || !ref.current || !subRef.current) {
      setSubPos(null);
      return;
    }
    const row = ref.current.querySelectorAll('[role=menuitem]')[openSub] as HTMLElement | undefined;
    if (!row) return;
    const r = row.getBoundingClientRect();
    setSubPos(keepOnScreen(subRef.current, r.right + 2, r.top - 4, r.left - 2));
  }, [openSub, pos]);

  useEffect(() => {
    const close = () => onClose();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !subRef.current?.contains(t)) onClose();
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

  function runEntry(it: MenuEntry | undefined, i: number, inSub: boolean) {
    if (!it || it.disabledReason) return;
    if (it.submenu && !inSub) {
      setOpenSub(i);
      setSubActive(0);
      return;
    }
    it.onRun?.();
  }

  const sub = openSub !== null ? entries[openSub]?.submenu : undefined;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const inSub = sub !== undefined;
    const list = inSub ? sub : entries;
    const cur = inSub ? subActive : active;
    const setCur = inSub ? setSubActive : setActive;
    if (e.key === 'Escape' || (e.key === 'ArrowLeft' && inSub)) {
      e.preventDefault();
      if (inSub) setOpenSub(null);
      else onClose();
      return;
    }
    if (list.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCur((cur + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length);
      return;
    }
    if (e.key === 'Enter' || (e.key === 'ArrowRight' && !inSub)) {
      e.preventDefault();
      runEntry(list[cur], cur, inSub);
      return;
    }
    const i = list.findIndex((it) => it.shortcut === e.key.toUpperCase());
    if (i !== -1) {
      e.preventDefault();
      runEntry(list[i], i, inSub);
    }
  }

  const panel = 'rounded-md border border-line bg-surface py-1 text-sm text-ink shadow-lg outline-none';

  return (
    <>
      <div
        ref={ref}
        role="menu"
        tabIndex={-1}
        aria-label="Selection actions"
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        className={`fixed z-[70] min-w-[15rem] ${panel}`}
        style={{ left: pos.left, top: pos.top }}
      >
        {error ? (
          <p className="max-w-xs px-3 py-2 text-xs text-warning">{error}</p>
        ) : (
          <>
            <p className="border-b border-line px-3 pb-1.5 pt-1 font-mono text-xs text-ink-muted">{heading}</p>
            <MenuList
              entries={entries}
              active={active}
              setActive={(i) => {
                setActive(i);
                // Hovering a row opens its submenu (or closes another's).
                setOpenSub(entries[i]?.submenu && !entries[i].disabledReason ? i : null);
                setSubActive(0);
              }}
              openSub={openSub}
              onRun={(it, i) => runEntry(it, i, false)}
            />
          </>
        )}
      </div>
      {sub && (
        <div
          ref={subRef}
          role="menu"
          aria-label={entries[openSub!].label}
          onContextMenu={(e) => e.preventDefault()}
          className={`fixed z-[71] min-w-[16rem] ${panel}`}
          // Rendered invisibly for one layout pass so it can be measured
          // and placed beside its row.
          style={subPos ? { left: subPos.left, top: subPos.top } : { left: -9999, top: 0, visibility: 'hidden' }}
        >
          <MenuList entries={sub} active={subActive} setActive={setSubActive} openSub={null} onRun={(it, i) => runEntry(it, i, true)} />
        </div>
      )}
    </>
  );
}
