import { useState, type ReactNode } from 'react';

interface Props {
  title: ReactNode;
  step?: number;
  children: ReactNode;
  defaultCollapsed?: boolean;
}

export default function Section({ title, step, children, defaultCollapsed = false }: Props) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <section className="mb-5 overflow-hidden rounded-lg border border-line bg-surface">
      <h2 className="m-0">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {step !== undefined && <span className="font-mono text-xs tabular-nums text-ink-faint">{String(step).padStart(2, '0')}</span>}
          <span className="flex-1 text-sm font-semibold text-ink">{title}</span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={`h-4 w-4 shrink-0 text-ink-faint motion-safe:transition-transform ${collapsed ? '-rotate-90' : ''}`}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </h2>
      {!collapsed && <div className="border-t border-line px-5 py-5">{children}</div>}
    </section>
  );
}
