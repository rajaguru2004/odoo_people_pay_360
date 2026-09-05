'use client';

import { useState, type ReactNode } from 'react';
import { BarChart3, Download, Table2 } from 'lucide-react';
import { PanelHeader, PanelLink } from '@/components/module-landing/primitives';
import { downloadCsv } from '@/utils/chartAxis';
import ChartTable, { type ChartTableColumn } from './ChartTable';

/**
 * The panel every visual on the analytics page sits in.
 *
 * Nothing draws a chart without going through this, which is how eleven rules
 * get enforced once instead of once per chart:
 *
 *  - **A skeleton on first load, the previous render held at reduced opacity on
 *    a refetch.** Re-skeletoning the whole grid every time somebody moves a
 *    filter makes the page jump, and the reader loses the comparison they were
 *    in the middle of making.
 *  - **"No data for this period" is a written sentence**, never a blank box and
 *    never a chart of zeros. A chart of zeros is a claim that the values were
 *    nought, which is a different statement from having nothing to show.
 *  - **Every chart has a table twin and an export**, both built from the SAME
 *    rows the chart was given, so the three can never disagree.
 *
 * The frame owns no colour and no scale. It is the box, the header, the states
 * and the two affordances; what goes inside is the caller's.
 */

export interface ChartFrameProps<Row> {
  title: string;
  hint?: string;
  /** "Full report" — the escape hatch to the screen that owns the detail. */
  href?: string;
  hrefLabel?: string;
  loading?: boolean;
  /** True while a filter change is in flight and stale marks are still up. */
  refetching?: boolean;
  /** Nothing to draw. Distinct from `loading` and from a failed read. */
  empty?: boolean;
  /** Names the period, so the reader knows the page is not broken. */
  emptyLabel?: string;
  /** Plot height. A floor, so a short panel in a tall row stays readable. */
  height?: number;
  /** The rows behind the chart — they become the table and the CSV. */
  table: {
    caption: string;
    rows: readonly Row[];
    columns: ReadonlyArray<ChartTableColumn<Row>>;
    rowKey: (row: Row, index: number) => string;
    totals?: Record<string, string>;
  };
  /** Stem for the downloaded file; the period is appended by the caller. */
  exportName: string;
  children: ReactNode;
}

export default function ChartFrame<Row>({
  title,
  hint,
  href,
  hrefLabel = 'Full report',
  loading = false,
  refetching = false,
  empty = false,
  emptyLabel = 'No data for this period.',
  height = 280,
  table,
  exportName,
  children,
}: ChartFrameProps<Row>) {
  const [asTable, setAsTable] = useState(false);

  // One source for the chart, the table and the file. A CSV assembled
  // separately drifts from the panel it claims to export the moment either
  // side gains a column.
  const exportRows = () =>
    downloadCsv(
      `${exportName}.csv`,
      table.columns.map((column) => column.label),
      table.rows.map((row) => table.columns.map((column) => column.value(row))),
    );

  return (
    <section className="surface-panel flex flex-col rounded-[20px] p-6">
      <PanelHeader
        title={title}
        hint={hint}
        action={
          <div className="flex items-center gap-1">
            {href && <PanelLink href={href}>{hrefLabel}</PanelLink>}
            <button
              type="button"
              onClick={() => setAsTable((shown) => !shown)}
              disabled={loading || empty}
              aria-pressed={asTable}
              className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface-page hover:text-text-heading disabled:pointer-events-none disabled:opacity-40"
              title={asTable ? `${title} as a chart` : `${title} as a table`}
            >
              {asTable ? (
                <BarChart3 className="h-4 w-4" aria-hidden />
              ) : (
                <Table2 className="h-4 w-4" aria-hidden />
              )}
              <span className="sr-only">
                {asTable ? `Show ${title} as a chart` : `Show ${title} as a table`}
              </span>
            </button>
            <button
              type="button"
              onClick={exportRows}
              disabled={loading || empty}
              className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface-page hover:text-text-heading disabled:pointer-events-none disabled:opacity-40"
              title={`Download ${title} as CSV`}
            >
              <Download className="h-4 w-4" aria-hidden />
              <span className="sr-only">Download {title} as CSV</span>
            </button>
          </div>
        }
      />

      <div className="mt-2 flex flex-1 flex-col justify-center" style={{ minHeight: height }}>
        {loading ? (
          <div
            className="w-full animate-pulse rounded-xl bg-surface-border/60"
            style={{ height }}
            aria-hidden
          />
        ) : empty ? (
          <p className="w-full py-16 text-center text-[13px] text-text-muted">
            {emptyLabel}
          </p>
        ) : (
          <div
            // Held rather than replaced while a filter change is in flight, so
            // the reader keeps the shape they were looking at.
            className={
              refetching ? 'opacity-50 transition-opacity' : 'transition-opacity'
            }
            aria-busy={refetching || undefined}
          >
            {asTable ? (
              <ChartTable
                caption={table.caption}
                rows={table.rows}
                columns={table.columns}
                rowKey={table.rowKey}
                totals={table.totals}
              />
            ) : (
              children
            )}
          </div>
        )}
      </div>
    </section>
  );
}
