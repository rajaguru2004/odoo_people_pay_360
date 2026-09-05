'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
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
 * What payroll has cost across the window, cumulatively.
 *
 * `cumulativeNet` is **computed on the server**. A `reduce` here would restart
 * the running total at whichever month the window happens to open on, so the
 * same August would read as a different cumulative figure depending on whether
 * the reader had 6M or 12M selected — a chart disagreeing with itself.
 *
 * An area rather than a line because the quantity being shown is an accumulated
 * total, and the filled region under it is the accumulation.
 */
export default function CumulativeCostChart({
  trend,
  currency,
  loading,
  refetching,
}: {
  trend?: DashboardTrendBucket[];
  currency: string;
  loading?: boolean;
  refetching?: boolean;
}) {
  const rows = trend ?? [];
  const { xAxisProps, yAxisProps } = useChartDirection();
  const money = (value: number) => formatCurrency(value, currency);
  const last = rows[rows.length - 1];

  return (
    <ChartFrame
      title="Cumulative payroll cost"
      hint={
        last
          ? `${money(last.cumulativeNet)} paid across the window.`
          : 'Running total of net pay across the window.'
      }
      loading={loading}
      refetching={refetching}
      empty={!last || last.cumulativeNet === 0}
      emptyLabel="Nothing has been paid in this window."
      exportName="payroll-cumulative-cost"
      table={{
        caption: 'Cumulative net pay by month',
        rows,
        rowKey: (row) => row.key,
        columns: [
          { key: 'label', label: 'Period', value: (row) => row.label },
          {
            key: 'net',
            label: 'Net this month',
            value: (row) => money(row.net),
            numeric: true,
          },
          {
            key: 'cumulativeNet',
            label: 'Cumulative',
            value: (row) => money(row.cumulativeNet),
            numeric: true,
          },
        ],
      }}
    >
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
          <defs>
            <linearGradient id="cumulativeFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES_RAMP[0]} stopOpacity={0.28} />
              <stop offset="100%" stopColor={SERIES_RAMP[0]} stopOpacity={0.02} />
            </linearGradient>
          </defs>
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
              <ChartTooltip
                format={money}
                labels={{ cumulativeNet: 'Paid to date' }}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="cumulativeNet"
            name="Paid to date"
            stroke={SERIES_RAMP[0]}
            strokeWidth={2.5}
            fill="url(#cumulativeFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
