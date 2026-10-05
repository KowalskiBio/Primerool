import { useState } from 'react';

interface Props {
  sequence: string;
  /** What the copy button announces to screen readers, e.g. "forward primer". */
  label?: string;
}

/** A small button that copies one oligo, so a pair's forward and reverse
 * primers can each be pasted into an external checker on their own. */
export function CopyButton({ text, label = 'sequence' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Copied' : `Copy ${label}`}
      aria-label={copied ? 'Copied' : `Copy ${label}`}
      className="shrink-0 rounded px-1 py-0.5 font-sans text-[11px] font-medium text-ink-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** A primer sequence inside a results-table cell, with its copy button. */
export default function CopyableSequence({ sequence, label }: Props) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="min-w-0 flex-1 break-all">{sequence}</span>
      <CopyButton text={sequence} label={label} />
    </div>
  );
}
