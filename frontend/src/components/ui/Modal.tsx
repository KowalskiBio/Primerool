import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  open: boolean;
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

/** A big centered dialog over a blurred backdrop - dismissed by Escape or
 * by clicking outside the dialog itself. Portaled to `document.body` so it
 * always stacks above the page regardless of where it's mounted. */
export default function Modal({ open, title, onClose, children }: Props) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Locks the page underneath from scrolling while the modal is open - a
  // scroll gesture inside the dialog's own scroll containers still works
  // (they're unaffected by the body's overflow), but once it runs out of
  // room there's nothing left underneath for the gesture to fall through
  // to. Restores whatever the body's own `overflow` was before this modal
  // touched it, not a hardcoded `''`, so nesting (or another piece of the
  // app that also sets it) can't get clobbered.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain bg-black/50 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} className="flex h-[88vh] w-[92vw] max-w-6xl flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="text-sm font-semibold text-ink">{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
