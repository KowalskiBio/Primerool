import type { ReactNode } from 'react';

export interface Column<T> {
  header: string;
  render: (row: T, index: number) => ReactNode;
  className?: string;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  keyOf: (row: T, index: number) => string;
  accent?: 'green' | 'blue';
}

/** One shared, parameterized table for every primer/probe results list
 * (forward/reverse primers, junction pairs, best-pair combos, TaqMan
 * probes) — the legacy app hand-rolled four near-identical HTML-table-
 * string builders for these; collapsed into one component here since the
 * columns (index, sequence, Tm, GC%, hairpin/homodimer, an action button)
 * are the only thing that actually varies between them. */
export default function ResultsTable<T>({ columns, rows, keyOf, accent = 'green' }: Props<T>) {
  const headBg = accent === 'blue' ? 'from-blue-50 to-blue-100/30 dark:from-blue-950/40 dark:to-blue-950/20' : 'from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900';
  const rowHover = accent === 'blue' ? 'hover:bg-blue-50/50 dark:hover:bg-blue-950/20' : 'hover:bg-green-50/50 dark:hover:bg-slate-700/40';

  return (
    <div className="overflow-x-auto border border-slate-200 dark:border-slate-700 rounded-lg">
      <table className="w-full text-sm text-left text-slate-600 dark:text-slate-300">
        <thead className={`text-xs text-slate-700 dark:text-slate-300 uppercase bg-gradient-to-br ${headBg}`}>
          <tr>
            {columns.map((c, i) => (
              <th key={i} className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={keyOf(row, i)} className={`bg-white dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700 last:border-0 text-xs text-slate-600 dark:text-slate-300 ${rowHover}`}>
              {columns.map((c, ci) => (
                <td key={ci} className={`px-4 py-3 ${c.className || ''}`}>
                  {c.render(row, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
