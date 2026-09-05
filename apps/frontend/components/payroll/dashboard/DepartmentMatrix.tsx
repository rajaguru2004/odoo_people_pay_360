'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { PanelHeader, PanelLink } from '@/components/module-landing/primitives';
import { createSeriesScale } from '@/theme/chartColors';
import { formatCurrency, formatPercent } from '@/utils/formatters';
import type {
  DashboardDepartmentRow,
  DashboardFilterOption,
} from '@/types/payrollDashboard';

/**
 * The department breakdown, as a sortable table with a totals row.
 *
 * The matrix visual, and also the table twin for the treemap and the cost bar —
 * which is why it carries the same colour chip each of those uses. A reader who
 * learned Finance is orange on the chart above finds the same orange here.
 *
 * Every row drills through to the payslips behind it, carrying the period, so
 * the figure on this screen and the list it opens are the same set of rows.
 *
 * The totals row sums the columns that ADD UP and prints an em dash for the
 * ones that do not. An average of averages is not the average, and a share
 * column totals to 100% by construction rather than by summing — printing a
 * summed 99.9% there would invite somebody to go looking for the missing
 * tenth.
 */

type SortKey = 'name' | 'headcount' | 'net' | 'totalCost' | 'avgNet';

export default function DepartmentMatrix({
  departments,
  departmentOptions,
  currency,
  period,
  loading,
}: {
  departments?: DashboardDepartmentRow[];
  departmentOptions?: DashboardFilterOption[];
  currency: string;
  period?: string;
  loading?: boolean;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('totalCost');
  const [descending, setDescending] = useState(true);

  const rows = useMemo(() => departments ?? [], [departments]);
  const money = (value: number) => formatCurrency(value, currency);
  const colorOf = createSeriesScale(
    (departmentOptions ?? []).map((option) => option.value),
  );

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name);
      // `avgNet` is nullable — a department that paid nobody. Nulls sort last
      // whichever way the column is pointing, because "unknown" is not a
      // small number and floating it to the top would say it was.
      if (sortKey === 'avgNet') {
        if (a.avgNet === null && b.avgNet === null) return 0;
        if (a.avgNet === null) return 1;
        if (b.avgNet === null) return -1;
        return a.avgNet - b.avgNet;
      }
      return a[sortKey] - b[sortKey];
    });
    return descending ? copy.reverse() : copy;
  }, [rows, sortKey, descending]);

  const totals = rows.reduce(
    (sum, row) => ({
      headcount: sum.headcount + row.headcount,
      net: sum.net + row.net,
      totalCost: sum.totalCost + row.totalCost,
    }),
    { headcount: 0, net: 0, totalCost: 0 },
  );

  const toggle = (key: SortKey) => {
    if (key === sortKey) setDescending((d) => !d);
    else {
      setSortKey(key);
      // Text opens A→Z; a number opens with the biggest first, which is what
      // anybody sorting a cost column is looking for.
      setDescending(key !== 'name');
    }
  };

  const columns: Array<{ key: SortKey; label: string; numeric: boolean }> = [
    { key: 'name', label: 'Department', numeric: false },
    { key: 'headcount', label: 'Paid', numeric: true },
    { key: 'net', label: 'Net', numeric: true },
    { key: 'totalCost', label: 'Total cost', numeric: true },
    { key: 'avgNet', label: 'Average net', numeric: true },
  ];

  return (
    <section className="surface-panel rounded-[20px] p-6">
      <PanelHeader
        title="Department breakdown"
        hint="Headcount and cost for the period. Click a row for its payslips."
        action={<PanelLink href="/dashboard/payroll/reports">Cost report</PanelLink>}
      />

      {loading ? (
        <div className="h-[240px] w-full animate-pulse rounded-xl bg-surface-border/60" />
      ) : rows.length === 0 ? (
        <p className="py-16 text-center text-[13px] text-text-muted">
          No department was paid in this period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-surface-border">
                {columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={
                      sortKey === column.key
                        ? descending
                          ? 'descending'
                          : 'ascending'
                        : 'none'
                    }
                    className={`py-2 font-semibold text-text-muted ${
                      column.numeric ? 'text-end' : 'text-start'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(column.key)}
                      className={`inline-flex items-center gap-1 hover:text-text-heading ${
                        column.numeric ? 'flex-row-reverse' : ''
                      }`}
                    >
                      {column.label}
                      {sortKey === column.key &&
                        (descending ? (
                          <ArrowDown className="h-3 w-3" aria-hidden />
                        ) : (
                          <ArrowUp className="h-3 w-3" aria-hidden />
                        ))}
                    </button>
                  </th>
                ))}
                <th scope="col" className="py-2 text-end font-semibold text-text-muted">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr
                  key={row.id ?? 'unassigned'}
                  className="border-b border-surface-border-light last:border-0 hover:bg-surface-page"
                >
                  <td className="py-2 text-start">
                    <Link
                      href={`/dashboard/payroll/payslips?${new URLSearchParams({
                        ...(row.id ? { departmentId: row.id } : {}),
                        ...(period ? { period } : {}),
                      }).toString()}`}
                      className="inline-flex items-center gap-2 text-text-body hover:text-brand-primary"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: colorOf(row.id) }}
                        aria-hidden
                      />
                      {row.name}
                    </Link>
                  </td>
                  <td className="py-2 text-end tabular-nums text-text-body">
                    {row.headcount}
                  </td>
                  <td className="py-2 text-end tabular-nums text-text-body">
                    {money(row.net)}
                  </td>
                  <td className="py-2 text-end tabular-nums text-text-body">
                    {money(row.totalCost)}
                  </td>
                  <td className="py-2 text-end tabular-nums text-text-body">
                    {row.avgNet === null ? '—' : money(row.avgNet)}
                  </td>
                  <td className="py-2 text-end tabular-nums text-text-body">
                    {formatPercent(row.share)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-surface-border font-bold text-text-heading">
                <td className="py-2 text-start">Total</td>
                <td className="py-2 text-end tabular-nums">{totals.headcount}</td>
                <td className="py-2 text-end tabular-nums">{money(totals.net)}</td>
                <td className="py-2 text-end tabular-nums">
                  {money(totals.totalCost)}
                </td>
                {/* An average of averages is not the average. */}
                <td className="py-2 text-end tabular-nums">—</td>
                <td className="py-2 text-end tabular-nums">100.0%</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
