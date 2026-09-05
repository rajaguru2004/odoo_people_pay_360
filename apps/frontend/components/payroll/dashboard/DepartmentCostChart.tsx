'use client';

import { useRouter } from 'next/navigation';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import ChartFrame from '@/components/charts/ChartFrame';
import { ChartTooltip, markCursor } from '@/components/charts/tooltips';
import { useChartDirection } from '@/hooks/useChartDirection';
import { chartColors, createSeriesScale } from '@/theme/chartColors';
import { formatCurrency, formatPercent } from '@/utils/formatters';
import type {
  DashboardDepartmentRow,
  DashboardFilterOption,
} from '@/types/payrollDashboard';
import { axisLabel, compactMoney } from '@/components/charts/chartFormat';

/**
 * What each department cost this period.
 *
 * The colour scale is seeded from the UNFILTERED department option list, not
 * from these rows. Colouring by row position means filtering one department out
 * shifts every later one a slot along, and the reader who learned Finance is
 * orange watches it turn teal because of a filter that has nothing to do with
 * Finance.
 *
 * Clicking a bar drills through to the payslips behind it, carrying the period
 * and the department — the number on the chart and the list it opens are the
 * same set of rows.
 */
export default function DepartmentCostChart({
  departments,
  departmentOptions,
  currency,
  period,
  loading,
  refetching,
}: {
  departments?: DashboardDepartmentRow[];
  /** The full, unfiltered list — what makes the colours hold still. */
  departmentOptions?: DashboardFilterOption[];
  currency: string;
  period?: string;
  loading?: boolean;
  refetching?: boolean;
}) {
  const router = useRouter();
  const rows = departments ?? [];
  const { xAxisProps, yAxisProps } = useChartDirection();
  const money = (value: number) => formatCurrency(value, currency);

  const colorOf = createSeriesScale(
    (departmentOptions ?? []).map((option) => option.value),
  );

  const drillTo = (row: DashboardDepartmentRow) => {
    const params = new URLSearchParams();
    if (row.id) params.set('departmentId', row.id);
    if (period) params.set('period', period);
    router.push(`/dashboard/payroll/payslips?${params.toString()}`);
  };

  const totals = rows.reduce(
    (sum, row) => ({
      headcount: sum.headcount + row.headcount,
      net: sum.net + row.net,
      totalCost: sum.totalCost + row.totalCost,
    }),
    { headcount: 0, net: 0, totalCost: 0 },
  );

  return (
    <ChartFrame
      title="Salary cost by department"
      hint="Gross plus employer cost. Click a bar for its payslips."
      href="/dashboard/payroll/reports"
      loading={loading}
      refetching={refetching}
      empty={rows.length === 0}
      emptyLabel="No department was paid in this period."
      exportName="payroll-cost-by-department"
      table={{
        caption: 'Cost by department',
        rows,
        rowKey: (row) => row.id ?? 'unassigned',
        columns: [
          { key: 'name', label: 'Department', value: (row) => row.name },
          {
            key: 'headcount',
            label: 'Paid',
            value: (row) => String(row.headcount),
            numeric: true,
          },
          {
            key: 'net',
            label: 'Net',
            value: (row) => money(row.net),
            numeric: true,
          },
          {
            key: 'totalCost',
            label: 'Total cost',
            value: (row) => money(row.totalCost),
            numeric: true,
          },
          {
            key: 'share',
            label: 'Share',
            // `null` prints an em dash: a run that cost nothing is not a
            // department holding none of the cost.
            value: (row) => formatPercent(row.share),
            numeric: true,
          },
        ],
        totals: {
          name: 'Total',
          headcount: String(totals.headcount),
          net: money(totals.net),
          totalCost: money(totals.totalCost),
          share: rows.length > 0 ? '100.0%' : '—',
        },
      }}
    >
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
          <CartesianGrid vertical={false} stroke={chartColors.grid} />
          <XAxis
            dataKey="name"
            tickFormatter={(value: string) => axisLabel(value)}
            tickLine={false}
            axisLine={false}
            tick={{ fill: chartColors.axisText, fontSize: 11 }}
            {...xAxisProps}
          />
          <YAxis
            tickFormatter={compactMoney}
            tickLine={false}
            axisLine={false}
            width={56}
            tick={{ fill: chartColors.axisText, fontSize: 11 }}
            {...yAxisProps}
          />
          <Tooltip
            cursor={markCursor}
            content={
              <ChartTooltip
                format={money}
                labels={{ totalCost: 'Total cost' }}
                extra={(payload) => [
                  { label: 'Paid', value: String(payload.headcount ?? '—') },
                  {
                    label: 'Net',
                    value: money(Number(payload.net ?? 0)),
                  },
                ]}
              />
            }
          />
          <Bar
            dataKey="totalCost"
            name="Total cost"
            radius={[6, 6, 0, 0]}
            onClick={(_, index) => drillTo(rows[index])}
            className="cursor-pointer"
          >
            {rows.map((row) => (
              <Cell
                key={row.id ?? 'unassigned'}
                fill={colorOf(row.id)}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
