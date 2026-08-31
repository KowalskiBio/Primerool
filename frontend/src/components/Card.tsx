import { useState, type ReactNode } from 'react';

interface Props {
  title: ReactNode;
  children: ReactNode;
  defaultCollapsed?: boolean;
}

/** Ports the legacy app's `.card`/`.card-header`/`.card-content` collapsible
 * section, used for every numbered step ("1. Input Sequence", etc). */
export default function Card({ title, children, defaultCollapsed = false }: Props) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm mb-6 overflow-hidden">
      <div
        className="px-[var(--spacing-container)] py-[var(--spacing-container)] border-b border-slate-200 dark:border-slate-700 flex justify-between items-center cursor-pointer select-none hover:bg-slate-50 dark:hover:bg-slate-700/50"
        style={collapsed ? { borderBottom: 'none' } : undefined}
        onClick={() => setCollapsed((c) => !c)}
      >
        <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-2">{title}</h2>
        <svg xmlns="http://www.w3.org/2000/svg" className={`h-5 w-5 text-slate-400 transition-transform ${collapsed ? '-rotate-90' : ''}`} viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </div>
      {!collapsed && <div className="p-[var(--spacing-container)]">{children}</div>}
    </div>
  );
}
