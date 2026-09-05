'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import ChartFrame from '@/components/charts/ChartFrame';
import { ChartTooltip, crosshairCursor } from '@/components/charts/tooltips';
import { useChartDirection } from '@/hooks/useChartDirection';
import { chartColors, SERIES_RAMP } from '@/theme/chartColors';
import { formatCurrency } from '@/utils/formatters';
import type { DashboardTrendBucket } from '@/types/payrollDashboard';
import { compactMoney } from '@/components/charts/chartFormat';

/**
 * Net salary across the window.
 *
 * A line, because the question is about movement over time rather than about
 * comparing months to each other — and a crosshair tooltip, because on a
 * continuous series the reader is locating a point in time, not a mark.
 *
 * Every month in the window gets a point whether or not a run was locked for
 * it. Omitting the empty ones would draw a continuous line straight through a
 * period nobody was paid in, which is a claim the data does not make.
 */
export default function NetSalaryTrendChart({
  trend,
  currency,
  loading,
  refetching,
  periodLabel,
}: {
  trend?: DashboardTrendBucket[];
  currency: string;
  loading?: boolean;
  refetching?: boolean;
  periodLabel?: string;
}) {
  const rows = trend ?? [];
  const { xAxisProps, yAxisProps } = useChartDirection();
  const money = (value: number) => formatCurrency(value, currency);

  return (
    <ChartFrame
      title="Monthly net salary"
      hint="Approved and paid runs, one point per month."
      href="/dashboard/payroll/runs"
      hrefLabel="All runs"
      loading={loading}
      refetching={refetching}
      // Not "no rows": a window of months that all paid nothing is still an
      // empty chart, and drawing a flat line along zero claims the company paid
      // nought rather than that no run was locked.
      empty={rows.every((bucket) => bucket.net === 0)}
      emptyLabel={`No payroll has been approved in the ${rows.length} months to ${periodLabel ?? 'this period'}.`}
      exportName="payroll-net-trend"
      table={{
        caption: 'Net salary by month',
        rows,
        rowKey: (row) => row.key,
        columns: [
          { key: 'label', label: 'Period', value: (row) => row.label },
          {
            key: 'gross',
            label: 'Gross',
            value: (row) => money(row.gross),
            numeric: true,
          },
          {
            key: 'net',
            label: 'Net',
            value: (row) => money(row.net),
            numeric: true,
          },
          {
            key: 'employeeCount',
            label: 'Employees',
            value: (row) => String(row.employeeCount),
            numeric: true,
          },
        ],
      }}
    >
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
          {/* Horizontal only, and in the border colour: gridlines are for
              reading a value off, not for looking at. */}
          <CartesianGrid vertical={false} stroke={chartColors.grid} />
          <XAxis
            dataKey="label"
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
            cursor={crosshairCursor}
            content={
              <ChartTooltip format={money} labels={{ net: 'Net', gross: 'Gross' }} />
            }
          />
          <Line
            type="monotone"
            dataKey="net"
            name="Net"
            stroke={SERIES_RAMP[0]}
            strokeWidth={2.5}
            // A dot per month is a reading the reader can hover; a label per
            // month would be twelve numbers nobody asked for.
            dot={{ r: 3, fill: SERIES_RAMP[0], strokeWidth: 0 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
