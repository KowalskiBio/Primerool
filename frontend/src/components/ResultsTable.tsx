import type { ReactNode } from 'react';

export interface Column<T> {
  header: string;
  render: (row: T, index: number) => ReactNode;
  className?: string;
  /** A CSS width (e.g. `'8%'`, `'6rem'`) for this column's `<col>`, under
   * `table-fixed` layout. Columns that omit it split whatever space is left
   * over evenly — `<col>`'s own default behavior — so only the columns
   * that need to be narrower or wider than that default need to set one. */
  width?: string;
  /** When present, this column's header becomes clickable and the caller
   * can sort `rows` by the value this returns (asc/desc, via `sort` +
   * `onSortChange`). Omit it to leave a column unsortable — the default,
   * unchanged for every caller that doesn't opt in. */
  sortValue?: (row: T) => string | number | null;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  keyOf: (row: T, index: number) => string;
  accent?: 'green' | 'blue';
  /** Which column is currently sorted and in which direction, or `null` for
   * "no explicit sort" (the caller's own default order). Only meaningful
   * together with `onSortChange`; `rows` must already be in the desired
   * order — this component never reorders rows itself. */
  sort?: { columnIndex: number; direction: 'asc' | 'desc' } | null;
  /** Called with the clicked column's index when a sortable header is
   * clicked. The caller owns the asc → desc → none cycle and re-sorting
   * `rows` accordingly. */
  onSortChange?: (columnIndex: number) => void;
}

/** One shared, parameterized table for every primer/probe results list
 * (forward/reverse primers, junction pairs, best-pair combos, TaqMan
 * probes) — the legacy app hand-rolled four near-identical HTML-table-
 * string builders for these; collapsed into one component here since the
 * columns (index, sequence, Tm, GC%, hairpin/homodimer, an action button)
 * are the only thing that actually varies between them. */
export default function ResultsTable<T>({ columns, rows, keyOf, accent = 'green', sort = null, onSortChange }: Props<T>) {
  const headBg = accent === 'blue' ? 'from-blue-50 to-blue-100/30 dark:from-blue-950/40 dark:to-blue-950/20' : 'from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900';
  const rowHover = accent === 'blue' ? 'hover:bg-blue-50/50 dark:hover:bg-blue-950/20' : 'hover:bg-green-50/50 dark:hover:bg-slate-700/40';

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg">
      {/* `table-fixed` + `break-words` (not `overflow-x-auto` + natural
       * column widths): with many columns, letting the browser size each
       * column to its widest unwrapped content reliably overflows the
       * container and forces horizontal scrolling. Fixed layout gives every
       * column an equal share of the available width instead, and
       * `break-words` lets long unbroken tokens (sequences, ids) wrap
       * within that share rather than pushing it wider. */}
      <table className="w-full table-fixed text-sm text-left text-slate-600 dark:text-slate-300">
        <colgroup>
          {columns.map((c, i) => (
            <col key={i} style={c.width ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <thead className={`text-xs text-slate-700 dark:text-slate-300 uppercase bg-gradient-to-br ${headBg}`}>
          <tr>
            {columns.map((c, i) => {
              const sortable = Boolean(c.sortValue && onSortChange);
              const active = sort?.columnIndex === i;
              return (
                <th
                  key={i}
                  className={`px-2 py-2 border-b border-slate-200 dark:border-slate-700 ${sortable ? 'cursor-pointer select-none hover:text-slate-900 dark:hover:text-white' : ''}`}
                  onClick={sortable ? () => onSortChange!(i) : undefined}
                >
                  {c.header}
                  {active && <span className="ml-1">{sort!.direction === 'asc' ? '▲' : '▼'}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={keyOf(row, i)} className={`bg-white dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700 last:border-0 text-xs text-slate-600 dark:text-slate-300 ${rowHover}`}>
              {columns.map((c, ci) => (
                <td key={ci} className={`px-2 py-2 break-words ${c.className || ''}`}>
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
