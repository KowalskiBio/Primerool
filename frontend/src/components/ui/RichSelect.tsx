import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { controlClasses } from './TextInput';

export interface RichSelectOption {
  /** Machine value, delivered to onChange on selection. */
  value: string;
  /** Plain-text label — accessible name of the option, also used for type-ahead matching. */
  label: string;
  /** Richly formatted content (e.g. partly italic) rendered in trigger and option rows; falls back to `label`. */
  content?: ReactNode;
}

interface RichSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: RichSelectOption[];
  'aria-label': string;
  className?: string;
  disabled?: boolean;
}

/** Fixed-position popup placement in viewport coordinates. `top` is set
 * when the list opens below the trigger, `bottom` when it flips above -
 * anchoring by `bottom` keeps a short list's edge flush with the trigger
 * while a long one grows upward to its cap. */
interface PopupGeometry {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

/** Listbox<->trigger gap and the list's height ceiling in px: the popup is
 * positioned with inline styles, so these stand in for `mt-1`/`max-h-64`. */
const POPUP_GAP_PX = 4;
const POPUP_MAX_HEIGHT_PX = 256;

function popupGeometry(rect: DOMRect): PopupGeometry {
  const below = window.innerHeight - rect.bottom - POPUP_GAP_PX;
  const above = rect.top - POPUP_GAP_PX;
  // Open upward only when the capped list wouldn't fit below AND there's
  // more room up there - otherwise the tighter side stays the lesser evil.
  if (below < POPUP_MAX_HEIGHT_PX && above > below) {
    return { left: rect.left, bottom: window.innerHeight - rect.top + POPUP_GAP_PX, width: rect.width, maxHeight: Math.max(0, Math.min(POPUP_MAX_HEIGHT_PX, above)) };
  }
  return { left: rect.left, top: rect.bottom + POPUP_GAP_PX, width: rect.width, maxHeight: Math.max(0, Math.min(POPUP_MAX_HEIGHT_PX, below)) };
}

/** A visual twin of the native `Select` whose options can carry rich labels
 * (e.g. an italic species binomial with an upright strain designation) -
 * markup a real `<select><option>` can't render. Follows the WAI-ARIA
 * listbox-button pattern: focus never leaves the trigger; while open, keys
 * move an active row announced via `aria-activedescendant`. */
export default function RichSelect({ value, onChange, options, 'aria-label': ariaLabel, className = '', disabled = false }: RichSelectProps) {
  const [open, setOpen] = useState(false);
  /** Row under the keyboard/hover highlight. Only read while open -
   * `openList` always reseeds it, so a stale value never surfaces. */
  const [activeIndex, setActiveIndex] = useState(-1);
  /** Viewport-fixed popup placement. Null until first opened: the popup
   * renders only once geometry has been measured. */
  const [geometry, setGeometry] = useState<PopupGeometry | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
  /** Type-ahead keystrokes. Each key resets the 500 ms expiry, so quick
   * typing builds one growing prefix instead of separate one-letter jumps. */
  const typeAhead = useRef('');
  const typeAheadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listboxId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  function openList(fallbackIndex = 0) {
    // Park the highlight on the current selection when there is one (APG),
    // else at the caller's end of the list - first for click/ArrowDown,
    // last for ArrowUp.
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : fallbackIndex);
    // Measure alongside the open itself (an event handler, so the batch
    // paints once) - the popup's first frame is already in place, with no
    // effect re-render just to position it.
    const trigger = triggerRef.current;
    if (trigger) setGeometry(popupGeometry(trigger.getBoundingClientRect()));
    setOpen(true);
  }

  function select(index: number) {
    const option = options[index];
    // Guard: Enter/Space on an empty list highlights nothing.
    if (!option) return;
    // No onChange churn when the pick reconfirms the current value.
    if (option.value !== value) onChange(option.value);
    // Focus stayed on the trigger the whole time, so there's nothing to restore.
    setOpen(false);
  }

  // Close when a press lands anywhere outside the component. pointerdown
  // (rather than click) so the list is already gone before the control that
  // received the press reacts. The listbox is portaled to <body>, so
  // "inside" spans both the wrapper and the portal node.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || popupRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Re-sync the popup's geometry as the page moves: window resize, plus
  // capture-phase scroll because the trigger sits inside nested scrolling
  // containers whose scroll events never bubble to window. Re-syncing
  // rather than closing on scroll: an open listbox should track its
  // trigger the way a native select's popup does, and closing would
  // collapse a capped, wheel-scrolled list mid-gesture.
  useEffect(() => {
    if (!open) return;
    function sync() {
      const trigger = triggerRef.current;
      if (trigger) setGeometry(popupGeometry(trigger.getBoundingClientRect()));
    }
    function onScroll(e: Event) {
      // Scrolling the listbox's own overflow doesn't move the trigger.
      if (popupRef.current?.contains(e.target as Node)) return;
      sync();
    }
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // Keep the active row in view as keyboard/hover moves the highlight; also
  // scrolls the selected row into view on open.
  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  useEffect(() => {
    return () => {
      if (typeAheadTimer.current !== null) clearTimeout(typeAheadTimer.current);
    };
  }, []);

  /** Jump to the option whose label starts with the buffered prefix.
   * Search wraps around the list (standard type-ahead, unlike the clamped
   * arrow keys). */
  function handleTypeAhead(char: string) {
    if (options.length === 0) return;
    if (typeAheadTimer.current !== null) clearTimeout(typeAheadTimer.current);
    typeAheadTimer.current = setTimeout(() => {
      typeAhead.current = '';
    }, 500);
    // Repeating one key cycles through that letter's matches ("rrr" -> next
    // "r..." each time) instead of growing a prefix that can never match.
    const repeated = typeAhead.current.length > 0 && typeAhead.current.split('').every((c) => c === char);
    typeAhead.current = repeated ? char : typeAhead.current + char;
    const query = typeAhead.current.toLowerCase();
    // A growing prefix re-matches starting at the current row (so it stays
    // put while it still matches); a repeated key starts just after it.
    const start = repeated ? activeIndex + 1 : Math.max(activeIndex, 0);
    for (let i = 0; i < options.length; i++) {
      const idx = (start + i) % options.length;
      if (options[idx].label.toLowerCase().startsWith(query)) {
        setActiveIndex(idx);
        return;
      }
    }
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    // Leave chords (Ctrl+S etc.) to global handlers.
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (!open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        openList();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        openList(options.length - 1);
      } else if (e.key.length === 1) {
        // Type-ahead only acts on an open list, but the keypress is still
        // "typing in a form control" - keep it from reaching App's global
        // single-key shortcuts (e.g. "," opening the settings modal).
        e.stopPropagation();
      }
      // Enter/Space on a closed trigger open the list via the button's
      // native click activation.
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        // Clamped, not wrapping (the common listbox-button behavior).
        e.preventDefault();
        setActiveIndex(Math.min(activeIndex + 1, options.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex(Math.max(activeIndex - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        select(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        // Consumed here - an enclosing layer (e.g. a modal) must not also
        // react to the same Escape.
        e.stopPropagation();
        setOpen(false);
        break;
      case 'Tab':
        // Let focus move on naturally; just close without changing the selection.
        setOpen(false);
        break;
      default:
        if (e.key.length === 1) {
          // Same containment as the closed state: this is form-control
          // typing, not a global shortcut (e.g. App's "," settings modal).
          e.stopPropagation();
          handleTypeAhead(e.key);
        }
    }
  }

  return (
    // [&_em]:italic pins the component's core job (italic binomials) so a
    // future global reset can't silently revert it - today it's only the
    // browser UA stylesheet that italicizes <em> (Tailwind's preflight
    // doesn't touch font-style).
    <div ref={rootRef} className={`relative [&_em]:italic ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onTriggerKeyDown}
        className={`${controlClasses} flex h-9 cursor-pointer items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <span className="min-w-0 flex-1 truncate">
          {/* Fallback to the raw value keeps an unmatched value readable. */}
          {selected ? (selected.content ?? selected.label) : value}
        </span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 text-ink-muted motion-safe:transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open &&
        geometry &&
        createPortal(
          <ul
            ref={popupRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            // Rendered at body level with viewport-fixed geometry from the
            // trigger's rect: a `relative`/`absolute` popup gets clipped by
            // the Section card (its overflow-hidden rounds the corners),
            // which cut a long list off at the card's bottom edge. z-50
            // beats the app chrome at body level (sticky header z-20,
            // mascot z-10). [&_em]:italic is repeated here because portal
            // content isn't a DOM descendant of the wrapper that pins it.
            className="fixed z-50 overflow-y-auto rounded-md border border-line-strong bg-surface py-1 text-sm shadow-lg [&_em]:italic"
            style={{ left: geometry.left, top: geometry.top, bottom: geometry.bottom, width: geometry.width, maxHeight: geometry.maxHeight }}
          >
            {options.length === 0 ? (
              <li aria-hidden="true" className="px-3 py-1.5 text-ink-faint">
                No options
              </li>
            ) : (
              options.map((option, i) => (
                <li
                  key={option.value}
                  id={`${listboxId}-option-${i}`}
                  role="option"
                  aria-selected={i === selectedIndex}
                  ref={(el) => {
                    optionRefs.current[i] = el;
                  }}
                  // Keep the press from moving focus off the trigger, so the
                  // keyboard contract (Escape, type-ahead) still works after a
                  // click-select. Click still fires; text selection is disabled
                  // (a popup behaves like a native listbox, not selectable text).
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => select(i)}
                  className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-ink hover:bg-surface-2 ${i === activeIndex ? 'bg-surface-2' : ''}`}
                >
                  <span className="min-w-0 truncate">{option.content ?? option.label}</span>
                  {i === selectedIndex && (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-accent"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </li>
              ))
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}
