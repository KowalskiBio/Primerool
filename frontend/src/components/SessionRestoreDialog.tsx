import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { summarizeSession, type PrimeroolSession } from '../session/session';
import Button from './ui/Button';

interface Props {
  /** The session awaiting confirmation, or `null` when closed. */
  session: PrimeroolSession | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** "Restore session?" - a preview of a loaded session file (or last
 * visit's autosave) before it replaces the current work. Same small
 * centred shape as `ArmsTwinDialog`. */
export default function SessionRestoreDialog({ session, onConfirm, onCancel }: Props) {
  useEffect(() => {
    if (!session) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, onCancel]);

  if (!session) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="session-restore-title" className="w-full max-w-md rounded-lg border border-line bg-surface p-5 text-sm text-ink shadow-2xl">
        <h2 id="session-restore-title" className="mb-1 text-sm font-semibold">
          Restore session?
        </h2>
        <p className="mb-4 text-xs text-ink-muted">This replaces the current gene, sequence, primers and design results.</p>

        <dl className="mb-5 divide-y divide-line rounded-md border border-line">
          {summarizeSession(session).map((r) => (
            <div key={r.label} className="flex justify-between gap-4 px-3 py-2">
              <dt className="text-ink-muted">{r.label}</dt>
              <dd className="text-right font-medium">{r.value}</dd>
            </div>
          ))}
        </dl>

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={onConfirm} autoFocus>
            Restore
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
