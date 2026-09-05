'use client';

/**
 * The table twin every chart on the analytics page carries.
 *
 * Not a fallback and not an accessibility afterthought: a chart shows a shape
 * and a table answers "what exactly was Finance". Both are the same rows, so
 * the toggle above the plot swaps between them rather than opening a second
 * screen with a second query behind it.
 *
 * It is also what makes the two low-contrast slots in `SERIES_RAMP`
 * defensible — colour is never the only thing carrying a mark's identity when
 * the reader can read the number instead.
 */

export interface ChartTableColumn<Row> {
  key: string;
  label: string;
  /** Already formatted — `formatCurrency`, `formatPercent`, an em dash. */
  value: (row: Row) => string;
  /** Right-aligns and tabular-nums the column. Money and counts want this. */
  numeric?: boolean;
}

export interface ChartTableProps<Row> {
  caption: string;
  rows: readonly Row[];
  columns: ReadonlyArray<ChartTableColumn<Row>>;
  rowKey: (row: Row, index: number) => string;
  /** One footer row of totals. Omitted where a total would be meaningless. */
  totals?: Record<string, string>;
}

export default function ChartTable<Row>({
  caption,
  rows,
  columns,
  rowKey,
  totals,
}: ChartTableProps<Row>) {
  return (
    // Wide tables scroll inside their own box. A table that widened the panel
    // would put a horizontal scrollbar on the whole page.
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-[12px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-surface-border">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`py-2 font-semibold text-text-muted ${
                  column.numeric ? 'text-end' : 'text-start'
                }`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              className="border-b border-surface-border-light last:border-0"
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`py-2 text-text-body ${
                    column.numeric
                      ? 'text-end tabular-nums'
                      : 'text-start'
                  }`}
                >
                  {column.value(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {totals && (
          <tfoot>
            <tr className="border-t-2 border-surface-border font-bold text-text-heading">
              {columns.map((column, index) => (
                <td
                  key={column.key}
                  className={`py-2 ${
                    column.numeric ? 'text-end tabular-nums' : 'text-start'
                  }`}
                >
                  {totals[column.key] ?? (index === 0 ? 'Total' : '')}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
