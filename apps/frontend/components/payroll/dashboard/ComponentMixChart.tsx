'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import ChartFrame from '@/components/charts/ChartFrame';
import { ChartTooltip, markCursor } from '@/components/charts/tooltips';
import { useChartDirection } from '@/hooks/useChartDirection';
import { chartColors, COMPOSITION_COLORS } from '@/theme/chartColors';
import { formatCurrency } from '@/utils/formatters';
import type { DashboardComponentBucket } from '@/types/payrollDashboard';
import { compactMoney } from '@/components/charts/chartFormat';

/**
 * Basic against allowances against deductions.
 *
 * Grouped on the payslip's OWN snapshot — `PayslipLine.code` and `type` — never
 * through `componentId`, which is nullable and whose component may since have
 * been renamed or retired. That is the whole reason the snapshot exists.
 *
 * `EMPLOYER_CONTRIBUTION` is not on this chart. It is recorded and never paid
 * to anybody, so stacking it beside earnings would make the column taller than
 * the gross it claims to decompose. It appears in the department matrix, in its
 * own column, labelled as employer cost.
 *
 * Three bars, so they take direct labels rather than a legend — a legend for
 * three marks that are already named on the axis is furniture.
 */
export default function ComponentMixChart({
  components,
  currency,
  loading,
  refetching,
}: {
  components?: DashboardComponentBucket[];
  currency: string;
  loading?: boolean;
  refetching?: boolean;
}) {
  const rows = components ?? [];
  const { xAxisProps, yAxisProps } = useChartDirection();
  const money = (value: number) => formatCurrency(value, currency);

  return (
    <ChartFrame
      title="Basic, allowances and deductions"
      hint="From the payslip lines as they were snapshotted."
      href="/dashboard/payroll/reports"
      loading={loading}
      refetching={refetching}
      empty={rows.every((row) => row.amount === 0)}
      emptyLabel="No payslip lines were produced for this period."
      exportName="payroll-component-mix"
      table={{
        caption: 'Pay composition',
        rows,
        rowKey: (row) => row.key,
        columns: [
          { key: 'label', label: 'Component', value: (row) => row.label },
          {
            key: 'amount',
            label: 'Amount',
            value: (row) => money(row.amount),
            numeric: true,
          },
        ],
      }}
    >
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={rows} margin={{ top: 20, right: 12, bottom: 0, left: 4 }}>
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
            cursor={markCursor}
            content={<ChartTooltip format={money} labels={{ amount: 'Amount' }} />}
          />
          <Bar dataKey="amount" name="Amount" radius={[6, 6, 0, 0]}>
            {rows.map((row) => (
              <Cell
                key={row.key}
                fill={COMPOSITION_COLORS[row.key] ?? chartColors.primary}
              />
            ))}
            {/* Three marks, so the value goes on the bar. A number on every
                point is noise; a number on three is the reading. */}
            <LabelList
              dataKey="amount"
              position="top"
              formatter={(value: unknown) => compactMoney(Number(value))}
              className="fill-text-muted text-[11px]"
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
