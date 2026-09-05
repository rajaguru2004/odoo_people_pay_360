'use client';

import { useRouter } from 'next/navigation';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import ChartFrame from '@/components/charts/ChartFrame';
import { ChartTooltip } from '@/components/charts/tooltips';
import { RUN_STATUS_COLORS } from '@/theme/chartColors';
import type { PayrollRunStatus } from '@/types/payrollDashboard';
import { shareOf } from '@/components/charts/chartFormat';

/**
 * Where the runs in this window currently sit.
 *
 * **A payslip has no status column.** Status lives on `PayrollRun`, so a
 * payslip's status is its run's — which is why this counts runs and says so
 * rather than claiming to split payslips.
 *
 * The lifecycle words differ from the enum: `Computed` is `CALCULATED` and
 * `Validated` is `APPROVED`. The enum is not renamed for a chart; the chart is
 * labelled for its reader.
 *
 * `CANCELLED` is shown, because unlike in the funnel these are current states
 * and a withdrawn run is genuinely one of them. Leaving it out would make the
 * slices sum to less than the run count printed beside them.
 *
 * A donut rather than a pie: the hole is where the total goes, and a total is
 * the first thing anybody asks of a proportion.
 */

const ORDER: PayrollRunStatus[] = [
  'DRAFT',
  'CALCULATED',
  'APPROVED',
  'PAID',
  'CANCELLED',
];

const LABELS: Record<PayrollRunStatus, string> = {
  DRAFT: 'Draft',
  CALCULATED: 'Computed',
  APPROVED: 'Validated',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
};

export default function StatusDonut({
  byStatus,
  loading,
  refetching,
}: {
  byStatus?: Record<PayrollRunStatus, number>;
  loading?: boolean;
  refetching?: boolean;
}) {
  const router = useRouter();

  // Zero-count statuses are dropped from the arcs but kept in the table: an
  // arc of nothing is not drawable, while "Cancelled: 0" is a fact worth being
  // able to read.
  const all = ORDER.map((status) => ({
    status,
    label: LABELS[status],
    count: byStatus?.[status] ?? 0,
  }));
  const slices = all.filter((row) => row.count > 0);
  const total = all.reduce((sum, row) => sum + row.count, 0);

  return (
    <ChartFrame
      title="Runs by status"
      hint="A payslip's status is its run's — status lives on the run."
      href="/dashboard/payroll/runs"
      hrefLabel="All runs"
      loading={loading}
      refetching={refetching}
      empty={total === 0}
      emptyLabel="No payroll run falls in this window."
      exportName="payroll-run-status"
      table={{
        caption: 'Payroll runs by status',
        rows: all,
        rowKey: (row) => row.status,
        columns: [
          { key: 'label', label: 'Status', value: (row) => row.label },
          {
            key: 'count',
            label: 'Runs',
            value: (row) => String(row.count),
            numeric: true,
          },
          {
            key: 'share',
            label: 'Share',
            value: (row) => {
              const share = shareOf(row.count, total);
              return share === null ? '—' : `${share}%`;
            },
            numeric: true,
          },
        ],
        totals: { label: 'Total', count: String(total), share: '100%' },
      }}
    >
      <div className="flex flex-wrap items-center gap-6">
        <div className="relative h-[220px] w-[220px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Tooltip
                content={
                  <ChartTooltip
                    format={(value) => String(value)}
                    labels={{ count: 'Runs' }}
                  />
                }
              />
              <Pie
                data={slices}
                dataKey="count"
                nameKey="label"
                innerRadius={62}
                outerRadius={100}
                paddingAngle={2}
                stroke="none"
                onClick={(entry) => {
                  // Recharts hands a sector, not the datum; ours is on
                  // `payload`, which its own types leave open.
                  const status = (
                    entry as unknown as {
                      payload?: { status?: PayrollRunStatus };
                      status?: PayrollRunStatus;
                    }
                  );
                  const value = status.payload?.status ?? status.status;
                  if (value) {
                    router.push(`/dashboard/payroll/runs?status=${value}`);
                  }
                }}
                className="cursor-pointer"
              >
                {slices.map((row) => (
                  <Cell key={row.status} fill={RUN_STATUS_COLORS[row.status]} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          {/* The hole carries the total — the first thing anybody asks of a
              proportion. `pointer-events-none` so it does not eat the hover. */}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[26px] font-bold leading-none text-text-heading">
              {total}
            </span>
            <span className="mt-1 text-[11px] text-text-muted">
              {total === 1 ? 'run' : 'runs'}
            </span>
          </div>
        </div>

        {/* Five series, so a legend rather than direct labels — arcs this thin
            cannot carry a word without overlapping their neighbours. */}
        <ul className="min-w-[150px] flex-1 space-y-2">
          {all.map((row) => (
            <li key={row.status} className="flex items-center gap-2.5">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: RUN_STATUS_COLORS[row.status] }}
                aria-hidden
              />
              <span className="text-[12px] text-text-body">{row.label}</span>
              <span className="ms-auto text-[12px] font-bold tabular-nums text-text-heading">
                {row.count}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </ChartFrame>
  );
}
