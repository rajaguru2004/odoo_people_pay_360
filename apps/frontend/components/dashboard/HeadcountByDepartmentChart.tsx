'use client';

import {
  Bar,
  BarChart,
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
import { chartColors, createSeriesScale } from '@/theme/chartColors';
import { axisLabel, shareOf } from '@/components/charts/chartFormat';
import type { DashboardWorkforce } from '@/types/dashboardOverview';

/**
 * How the active headcount is distributed across departments.
 *
 * **Horizontal, and not by preference.** Department names are words — "Facilities
 * & Maintenance", "Learning and Development" — and a vertical bar chart has only
 * the bar's own width to write them in. Recharts answers that by rotating the
 * ticks, which turns the axis into a row of diagonal text nobody reads and eats
 * a third of the plot. Laid on its side, every name sits on its own baseline in
 * ordinary horizontal type and gets as much room as it needs.
 *
 * **Colour keys on the department, never on the row's position.** `createSeriesScale`
 * is seeded from the full list as delivered, so a department keeps its hue when
 * the list is re-sorted or a filter is applied elsewhere on the page. Colouring
 * by index means dropping one department shifts every later one a slot along,
 * and the reader who learned Finance is orange watches it turn teal because of
 * something that had nothing to do with Finance.
 *
 * **`id: null` is Unassigned, and it is drawn.** It is people with no department
 * on their record — a real group whose size is usually the point of looking, and
 * dropping it would make the bars sum to less than the headcount printed beside
 * them. It takes the neutral rather than a categorical hue, because "no
 * department" is the absence of an identity, not one more of them.
 *
 * The count is written on each bar rather than left to a hover: the number IS
 * the reading here, and a hover is an affordance many readers never try.
 */
export default function HeadcountByDepartmentChart({
  byDepartment,
  loading,
  refetching,
}: {
  /** Ordered by headcount, descending. `id` is `null` for Unassigned. */
  byDepartment?: DashboardWorkforce['byDepartment'];
  loading?: boolean;
  refetching?: boolean;
}) {
  const rows = byDepartment ?? [];
  const { rtl, xAxisProps, yAxisProps } = useChartDirection();

  // Seeded from every department in the payload, so the mapping does not move
  // when the rows do. Unassigned is deliberately not a key: `createSeriesScale`
  // answers the neutral for a null, which is what it should wear.
  const colorOf = createSeriesScale(
    rows.map((row) => row.id).filter((id): id is string => id !== null),
  );

  const total = rows.reduce((sum, row) => sum + row.headcount, 0);

  // A structure with departments in it but nobody assigned to any of them is
  // still nothing to draw — and it gets a sentence, because a row of zero-width
  // bars claims the departments were measured and found empty.
  const empty = rows.length === 0 || total === 0;

  // Bars need a fixed band each or they thin out to hairlines on a long list.
  // The frame's height is a floor, so the panel grows with the department list
  // rather than compressing it.
  const height = Math.max(240, rows.length * 34 + 24);

  return (
    <ChartFrame
      title="Headcount by department"
      hint="Active employees only. Unassigned is people with no department on their record."
      href="/dashboard/departments"
      hrefLabel="All departments"
      loading={loading}
      refetching={refetching}
      empty={empty}
      emptyLabel="No department has an active employee in it."
      exportName="workforce-headcount-by-department"
      height={height}
      table={{
        caption: 'Active headcount by department',
        rows,
        rowKey: (row) => row.id ?? 'unassigned',
        columns: [
          { key: 'name', label: 'Department', value: (row) => row.name },
          {
            key: 'headcount',
            label: 'People',
            value: (row) => String(row.headcount),
            numeric: true,
          },
          {
            key: 'share',
            label: 'Share',
            value: (row) => {
              // `null` prints an em dash: a company with nobody in it did not
              // give every department nought per cent, it gave them no
              // denominator to be a share of.
              const share = shareOf(row.headcount, total);
              return share === null ? '—' : `${share}%`;
            },
            numeric: true,
          },
        ],
        totals: {
          name: 'Total',
          headcount: String(total),
          share: total > 0 ? '100%' : '—',
        },
      }}
    >
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 4, right: 44, bottom: 4, left: 4 }}
        >
          {/* Hidden: the value is written on every bar, so an axis of the same
              numbers would be the reading printed twice. It still carries the
              direction, which is what makes the bars grow from the reading
              edge under `dir="rtl"`. */}
          <XAxis type="number" hide allowDecimals={false} {...xAxisProps} />
          <YAxis
            type="category"
            dataKey="name"
            tickFormatter={(value: string) => axisLabel(value, 18)}
            tickLine={false}
            axisLine={false}
            width={124}
            tick={{ fill: chartColors.axisText, fontSize: 12 }}
            {...yAxisProps}
          />
          <Tooltip
            cursor={markCursor}
            content={
              <ChartTooltip
                format={(value) => String(Math.round(value))}
                labels={{ headcount: 'People' }}
              />
            }
          />
          <Bar dataKey="headcount" name="People" radius={[0, 6, 6, 0]} barSize={20}>
            {rows.map((row) => (
              <Cell key={row.id ?? 'unassigned'} fill={colorOf(row.id)} />
            ))}
            <LabelList
              dataKey="headcount"
              // The label follows the reading edge; pinned to `right` it would
              // sit under the bar it labels once the plot is mirrored.
              position={rtl ? 'left' : 'right'}
              // Recharts v3 hands a formatter `unknown`. Cast at the boundary
              // rather than widening anything downstream of it.
              formatter={(value: unknown) => String(Math.round(Number(value)))}
              className="fill-text-heading text-[12px] font-bold"
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
