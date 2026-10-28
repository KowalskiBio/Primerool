import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Button from './ui/Button';
import Field from './ui/Field';
import TextInput, { controlClasses } from './ui/TextInput';
import SegmentedControl from './ui/SegmentedControl';
import Checkbox from './ui/Checkbox';

const ISSUES_URL = 'https://github.com/KowalskiBio/Primerool/issues/new';
/** GitHub rejects very long new-issue URLs; leave room for the title. */
const MAX_BODY_CHARS = 6000;

type Kind = 'bug' | 'idea' | 'question';

const KIND_LABELS: Record<Kind, string> = {
  bug: 'Something is wrong',
  idea: 'Idea',
  question: 'Question',
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** What the user is working on, attached (optionally) for context. */
  context: { label: string; value: string }[];
}

/** "Report an issue" - the user writes what went wrong (or an idea), and
 * it becomes a prefilled GitHub issue, with a copy-to-clipboard fallback
 * for anyone without a GitHub account. Same small centred shape as
 * `SessionRestoreDialog`. */
export default function ReportIssueDialog({ open, onClose, context }: Props) {
  const [kind, setKind] = useState<Kind>('bug');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [includeDetails, setIncludeDetails] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const details = [
    ...context.filter((c) => c.value),
    { label: 'App', value: `Primerool ${'__TAURI_INTERNALS__' in window ? 'desktop' : `web (${window.location.host})`}` },
    { label: 'Browser', value: navigator.userAgent },
    { label: 'Window', value: `${window.innerWidth}×${window.innerHeight}` },
  ];
  const body = [message.trim() || '_(no description)_', ...(includeDetails ? ['', '---', '**Details**', ...details.map((d) => `- ${d.label}: ${d.value}`)] : [])].join('\n');
  const fullTitle = `${kind === 'bug' ? '' : `[${KIND_LABELS[kind]}] `}${title.trim() || message.trim().split('\n')[0].slice(0, 80) || 'Report from Primerool'}`;
  const labels = kind === 'bug' ? 'bug' : kind === 'idea' ? 'enhancement' : 'question';
  const githubUrl = `${ISSUES_URL}?${new URLSearchParams({ title: fullTitle, body: body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n…(truncated)` : body, labels })}`;
  const canSend = message.trim().length > 0 || title.trim().length > 0;

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(`${fullTitle}\n\n${body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable - nothing to do
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="report-issue-title" className="w-full max-w-lg rounded-lg border border-line bg-surface p-5 text-sm text-ink shadow-2xl">
        <h2 id="report-issue-title" className="mb-1 text-sm font-semibold">
          Report an issue
        </h2>
        <p className="mb-4 text-xs text-ink-muted">Something wrong, or an idea? Write it here - it opens as a GitHub issue for the Primerool developers.</p>

        <SegmentedControl
          ariaLabel="Report type"
          value={kind}
          onChange={setKind}
          options={(Object.keys(KIND_LABELS) as Kind[]).map((k) => ({ value: k, label: KIND_LABELS[k] }))}
        />

        <Field label="Title" htmlFor="report-issue-summary" className="mt-3">
          <TextInput id="report-issue-summary" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary" className="h-9" autoFocus />
        </Field>
        <Field label="What happened?" htmlFor="report-issue-message" className="mt-3">
          <textarea
            id="report-issue-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={6}
            placeholder="What you did, what you expected, and what happened instead"
            className={`${controlClasses} resize-y py-2`}
          />
        </Field>

        <Checkbox
          className="mt-3"
          label={<span className="text-xs text-ink-muted">Include details (current gene/organism, app, browser)</span>}
          checked={includeDetails}
          onChange={(e) => setIncludeDetails(e.target.checked)}
        />

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" className="mr-auto" disabled={!canSend} onClick={() => void copyReport()} title="Copy the report, to send it some other way">
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <a
            href={canSend ? githubUrl : undefined}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!canSend}
            onClick={(e) => {
              if (!canSend) {
                e.preventDefault();
                return;
              }
              // Sent: start the next report from a clean form.
              setTitle('');
              setMessage('');
              onClose();
            }}
            className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-transparent bg-accent-solid px-3.5 text-sm font-medium text-white hover:bg-accent-solid-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${canSend ? '' : 'pointer-events-none opacity-50'}`}
          >
            Open on GitHub
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}
