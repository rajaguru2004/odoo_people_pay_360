'use client';

import {
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
} from 'recharts';
import ChartFrame from '@/components/charts/ChartFrame';
import { chartColors, SERIES_RAMP } from '@/theme/chartColors';
import { formatPercent } from '@/utils/formatters';
import type { DashboardCoverage } from '@/types/payrollDashboard';

/**
 * Two meters: how much of the month was worked, and how much of the workforce
 * was paid.
 *
 * A gauge is only honest against a FIXED domain, so `PolarAngleAxis` is pinned
 * to 0–100 explicitly. Recharts otherwise scales the arc to the largest value
 * present, and a lone 62% would then draw as a full ring — a meter that reads
 * "complete" for a figure that is nothing of the sort.
 *
 * `null` is the state that matters here. An attendance rate with no attendance
 * events, or a completion with nobody active to pay, is not zero per cent — it
 * is a question with no denominator. Both render as an empty track and an em
 * dash rather than as an unfilled ring, which would claim total failure.
 */

interface Gauge {
  key: string;
  label: string;
  value: number | null;
  hint: string;
  color: string;
}

function GaugeDial({ gauge }: { gauge: Gauge }) {
  const known = gauge.value !== null;
  const data = [{ name: gauge.label, value: known ? gauge.value : 0 }];

  return (
    <div className="flex flex-1 flex-col items-center">
      <div className="relative h-[150px] w-[150px]">
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart
            data={data}
            innerRadius="72%"
            outerRadius="100%"
            startAngle={90}
            endAngle={-270}
          >
            {/* The fixed domain. Without it the arc scales to its own value
                and every reading looks full. */}
            <PolarAngleAxis
              type="number"
              domain={[0, 100]}
              angleAxisId={0}
              tick={false}
            />
            <RadialBar
              dataKey="value"
              cornerRadius={999}
              angleAxisId={0}
              fill={known ? gauge.color : chartColors.grid}
              background={{ fill: chartColors.grid }}
              isAnimationActive={false}
            />
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="text-[22px] font-bold text-text-heading">
            {formatPercent(gauge.value)}
          </span>
        </div>
      </div>
      <p className="mt-1 text-center text-[13px] font-semibold text-text-heading">
        {gauge.label}
      </p>
      <p className="mt-0.5 text-center text-[11px] text-text-muted">
        {gauge.hint}
      </p>
    </div>
  );
}

export default function CoverageGauges({
  coverage,
  payslipCount,
  loading,
  refetching,
}: {
  coverage?: DashboardCoverage;
  payslipCount?: number;
  loading?: boolean;
  refetching?: boolean;
}) {
  const gauges: Gauge[] = [
    {
      key: 'attendance',
      label: 'Attendance health',
      value: coverage?.attendanceRate ?? null,
      hint: `${coverage?.expected ?? 0} attendance days counted`,
      color: SERIES_RAMP[0],
    },
    {
      key: 'completion',
      label: 'Payroll completion',
      value: coverage?.payrollCompletion ?? null,
      hint: `${payslipCount ?? 0} of ${coverage?.activeEmployees ?? 0} active employees paid`,
      color: SERIES_RAMP[2],
    },
  ];

  return (
    <ChartFrame
      title="Coverage"
      hint="Rates divide by days that were attendance events, never by headcount."
      loading={loading}
      refetching={refetching}
      // Both unknown is the empty case. One known is still worth drawing.
      empty={gauges.every((gauge) => gauge.value === null)}
      emptyLabel="There is nothing to measure for this period."
      exportName="payroll-coverage"
      height={240}
      table={{
        caption: 'Coverage rates',
        rows: gauges,
        rowKey: (row) => row.key,
        columns: [
          { key: 'label', label: 'Measure', value: (row) => row.label },
          {
            key: 'value',
            label: 'Rate',
            value: (row) => formatPercent(row.value),
            numeric: true,
          },
          { key: 'hint', label: 'Basis', value: (row) => row.hint },
        ],
      }}
    >
      <div className="flex flex-wrap items-start justify-around gap-4">
        {gauges.map((gauge) => (
          <GaugeDial key={gauge.key} gauge={gauge} />
        ))}
      </div>
    </ChartFrame>
  );
}
