import type { ReactNode } from 'react';

export interface Column<T> {
  header: string;
  render: (row: T, index: number) => ReactNode;
  className?: string;
  /** A CSS width (e.g. `'8%'`, `'6rem'`) for this column's `<col>`, under
   * `table-fixed` layout. Columns that omit it split whatever space is left
   * over evenly - `<col>`'s own default behavior - so only the columns
   * that need to be narrower or wider than that default need to set one. */
  width?: string;
  /** When present, this column's header becomes clickable and the caller
   * can sort `rows` by the value this returns (asc/desc, via `sort` +
   * `onSortChange`). Omit it to leave a column unsortable - the default,
   * unchanged for every caller that doesn't opt in. */
  sortValue?: (row: T) => string | number | null;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  keyOf: (row: T, index: number) => string;
  /** Which column is currently sorted and in which direction, or `null` for
   * "no explicit sort" (the caller's own default order). Only meaningful
   * together with `onSortChange`; `rows` must already be in the desired
   * order - this component never reorders rows itself. */
  sort?: { columnIndex: number; direction: 'asc' | 'desc' } | null;
  /** Called with the clicked column's index when a sortable header is
   * clicked. The caller owns the asc → desc → none cycle and re-sorting
   * `rows` accordingly. */
  onSortChange?: (columnIndex: number) => void;
}

/** One shared, parameterized table for every primer/probe results list
 * (forward/reverse primers, junction pairs, best-pair combos, TaqMan
 * probes) - the legacy app hand-rolled four near-identical HTML-table-
 * string builders for these; collapsed into one component here since the
 * columns (index, sequence, Tm, GC%, hairpin/homodimer, an action button)
 * are the only thing that actually varies between them. */
export default function ResultsTable<T>({ columns, rows, keyOf, sort = null, onSortChange }: Props<T>) {
  return (
    <div className="rounded-lg border border-line">
      {/* `table-fixed` + `break-words` (not `overflow-x-auto` + natural
       * column widths): with many columns, letting the browser size each
       * column to its widest unwrapped content reliably overflows the
       * container and forces horizontal scrolling. Fixed layout gives every
       * column an equal share of the available width instead, and
       * `break-words` lets long unbroken tokens (sequences, ids) wrap
       * within that share rather than pushing it wider. */}
      <table className="w-full table-fixed text-left text-sm text-ink-muted">
        <colgroup>
          {columns.map((c, i) => (
            <col key={i} style={c.width ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <thead className="text-xs uppercase text-ink-muted bg-surface-2">
          <tr>
            {columns.map((c, i) => {
              const sortable = Boolean(c.sortValue && onSortChange);
              const active = sort?.columnIndex === i;
              return (
                <th
                  key={i}
                  className={`border-b border-line px-2 py-2 font-medium ${sortable ? 'cursor-pointer select-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent' : ''}`}
                  onClick={sortable ? () => onSortChange!(i) : undefined}
                >
                  {c.header}
                  {active && <span className="ml-1" aria-label={sort!.direction === 'asc' ? 'sorted ascending' : 'sorted descending'}>{sort!.direction === 'asc' ? '▲' : '▼'}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={keyOf(row, i)} className="border-b border-line bg-surface text-xs text-ink-muted last:border-0 hover:bg-surface-2">
              {columns.map((c, ci) => (
                <td key={ci} className={`break-words px-2 py-2 ${c.className || ''}`}>
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
