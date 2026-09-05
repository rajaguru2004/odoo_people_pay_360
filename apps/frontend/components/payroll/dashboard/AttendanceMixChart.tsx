'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import ChartFrame from '@/components/charts/ChartFrame';
import { ChartTooltip, markCursor } from '@/components/charts/tooltips';
import { useChartDirection } from '@/hooks/useChartDirection';
import { ATTENDANCE_COLORS, chartColors } from '@/theme/chartColors';
import { formatPercent } from '@/utils/formatters';
import type { DashboardAttendanceRow } from '@/types/payrollDashboard';
import { axisLabel, percentTick, shareOf } from '@/components/charts/chartFormat';

/**
 * How each department's attendance days were made up.
 *
 * **Normalised to 100%**, which is what makes it comparable: a department of
 * four and a department of ninety produce bars of wildly different heights on
 * an absolute axis, and the reader ends up comparing headcount while believing
 * they are comparing attendance.
 *
 * **Overtime is not a segment here.** Present, late, absent, half-day and leave
 * are DAY counts; overtime is `Decimal(5,2)` HOURS on a different model with no
 * link to a payslip line. Stacking hours into a bar of days is the dual-axis
 * mistake wearing a different hat. Overtime gets its own figure on the page.
 *
 * `HOLIDAY` and `WEEKEND` are excluded upstream — they are calendar facts, not
 * things anybody did, and leaving them in shrinks every real rate by however
 * many days the branch was shut.
 *
 * Five series, so it takes a legend. This is the one chart on the page where
 * status colour is correct for a series, because the segments ARE the status.
 */

const SEGMENTS = [
  { key: 'present', label: 'Present', color: () => ATTENDANCE_COLORS.present },
  { key: 'late', label: 'Late', color: () => ATTENDANCE_COLORS.late },
  { key: 'halfDay', label: 'Half day', color: () => ATTENDANCE_COLORS.halfDay },
  { key: 'onLeave', label: 'On leave', color: () => ATTENDANCE_COLORS.onLeave },
  { key: 'absent', label: 'Absent', color: () => ATTENDANCE_COLORS.absent },
] as const;

export default function AttendanceMixChart({
  attendance,
  loading,
  refetching,
}: {
  attendance?: DashboardAttendanceRow[];
  loading?: boolean;
  refetching?: boolean;
}) {
  const rows = attendance ?? [];
  const { xAxisProps, yAxisProps } = useChartDirection();

  // Normalised here rather than with Recharts' `stackOffset="expand"`, because
  // that would leave the tooltip showing fractions of one. The reader wants the
  // percentage AND the underlying day count, so both are carried.
  const plotted = rows.map((row) => {
    const normalised: Record<string, number | string | null> = {
      name: row.name,
      total: row.total,
    };
    for (const segment of SEGMENTS) {
      normalised[segment.key] = shareOf(row[segment.key], row.total) ?? 0;
      normalised[`${segment.key}Days`] = row[segment.key];
    }
    return normalised;
  });

  return (
    <ChartFrame
      title="Attendance composition"
      hint="Share of each department's attendance days. Holidays and weekends are not attendance."
      href="/dashboard/attendance/reports"
      loading={loading}
      refetching={refetching}
      empty={rows.every((row) => row.total === 0)}
      emptyLabel="No attendance was recorded for this period."
      exportName="payroll-attendance-composition"
      height={300}
      table={{
        caption: 'Attendance composition by department',
        rows,
        rowKey: (row) => row.departmentId ?? 'unassigned',
        columns: [
          { key: 'name', label: 'Department', value: (row) => row.name },
          {
            key: 'present',
            label: 'Present',
            value: (row) => String(row.present),
            numeric: true,
          },
          {
            key: 'late',
            label: 'Late',
            value: (row) => String(row.late),
            numeric: true,
          },
          {
            key: 'halfDay',
            label: 'Half day',
            value: (row) => String(row.halfDay),
            numeric: true,
          },
          {
            key: 'onLeave',
            label: 'On leave',
            value: (row) => String(row.onLeave),
            numeric: true,
          },
          {
            key: 'absent',
            label: 'Absent',
            value: (row) => String(row.absent),
            numeric: true,
          },
          {
            key: 'healthPct',
            label: 'Health',
            // `null` prints an em dash: no days to measure is not 0% health.
            value: (row) => formatPercent(row.healthPct),
            numeric: true,
          },
        ],
      }}
    >
      <ResponsiveContainer width="100%" height={300}>
        <BarChart
          data={plotted}
          margin={{ top: 8, right: 12, bottom: 0, left: 4 }}
        >
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
            domain={[0, 100]}
            tickFormatter={percentTick}
            tickLine={false}
            axisLine={false}
            width={44}
            tick={{ fill: chartColors.axisText, fontSize: 11 }}
            {...yAxisProps}
          />
          <Tooltip
            cursor={markCursor}
            content={
              <ChartTooltip
                format={(value) => `${value}%`}
                labels={Object.fromEntries(
                  SEGMENTS.map((s) => [s.key, s.label]),
                )}
                extra={(payload) => [
                  { label: 'Days counted', value: String(payload.total ?? 0) },
                ]}
              />
            }
          />
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          />
          {SEGMENTS.map((segment, index) => (
            <Bar
              key={segment.key}
              dataKey={segment.key}
              name={segment.label}
              stackId="attendance"
              fill={segment.color()}
              // Only the topmost segment is rounded, or every band in the
              // stack gets its own corners and the bar looks like a stack of
              // separate pills rather than one column.
              radius={
                index === SEGMENTS.length - 1 ? [6, 6, 0, 0] : [0, 0, 0, 0]
              }
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
