'use client';

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import ChartFrame from '@/components/charts/ChartFrame';
import { ChartTooltip, markCursor } from '@/components/charts/tooltips';
import { useChartDirection } from '@/hooks/useChartDirection';
import { chartColors, SERIES_RAMP } from '@/theme/chartColors';
import { formatPercent } from '@/utils/formatters';
import type { DashboardWorkforceBucket } from '@/types/dashboardOverview';

/**
 * Who joined, who left, and what the company was left holding.
 *
 * The one chart on this page that legitimately carries two mark types. Joiners
 * and leavers are FLOWS — what moved during the month — and headcount at close
 * is the STOCK those flows act on. Bars for the movement and a line for the
 * level is the standard way of saying that, and it is the reason the two are
 * allowed to share a plot at all.
 *
 * **One y-axis, always.** Both series count PEOPLE, so a second axis would be
 * inventing a scale: the reader would see a bar of six leavers rising to meet a
 * line of two hundred staff and read a crisis that is not there. The cost is
 * real — against a headcount axis the monthly bars are short — and it is the
 * correct cost. The table twin carries the exact figures for anybody who needs
 * to compare six against seven.
 *
 * **`headcountEnd: null` is drawn as a GAP** (`connectNulls={false}`). The
 * server reconstructs the level by walking backwards from today's active
 * headcount, and where that walk cannot reach it says so. Substituting a zero
 * would claim the company emptied that month and refilled the next; joining the
 * line across the hole would invent a slope nobody measured.
 *
 * **Neither flow takes a status colour.** A leaver is not an error and a joiner
 * is not a success — a shrinking team may be a planned wind-down. Status hues
 * mean good / warning / serious / critical and are reserved for that, so the
 * two flows take the diverging pair `COMPOSITION_COLORS` already uses for money
 * in against money out: one hue arriving, the opposing hue departing. The stock
 * line takes a third categorical slot because it is a different KIND of
 * quantity, not a third direction.
 */

/** Arriving. The same deep blue that means "in" on the money composition. */
const JOINERS_COLOR = SERIES_RAMP[0];
/** Leaving. The opposing hue — direction, not judgement. */
const LEAVERS_COLOR = SERIES_RAMP[1];
/** The level. A separate identity, because a stock is not a flow. */
const HEADCOUNT_COLOR = SERIES_RAMP[3];

export default function WorkforceTrendChart({
  trend,
  growthPct,
  loading,
  refetching,
}: {
  trend?: DashboardWorkforceBucket[];
  /** `null` when the window opened with nobody to measure against. */
  growthPct?: number | null;
  loading?: boolean;
  refetching?: boolean;
}) {
  const rows = trend ?? [];
  const { xAxisProps, yAxisProps } = useChartDirection();
  const count = (value: number) => String(Math.round(value));

  // A month of no movement is still a reading — the line is what is being
  // shown. Only a window with no movement AND no reconstructable level has
  // nothing to draw, and that gets a sentence rather than a flat chart of
  // zeros, which would claim the company had nobody in it.
  const empty =
    rows.length === 0 ||
    rows.every(
      (row) =>
        row.joiners === 0 && row.leavers === 0 && row.headcountEnd === null,
    );

  const totals = rows.reduce(
    (sum, row) => ({
      joiners: sum.joiners + row.joiners,
      leavers: sum.leavers + row.leavers,
    }),
    { joiners: 0, leavers: 0 },
  );

  const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

  // `null` growth is not flat growth. An em dash says the window had no
  // opening headcount to measure against; "0.0%" would say it had one and
  // nothing changed.
  const hint =
    growthPct === null || growthPct === undefined
      ? 'Joiners and leavers each month, against headcount at the close.'
      : `Headcount ${growthPct < 0 ? 'down' : 'up'} ${formatPercent(
          Math.abs(growthPct),
        )} across the window.`;

  return (
    <ChartFrame
      title="Workforce movement"
      hint={hint}
      href="/dashboard/people"
      hrefLabel="The directory"
      loading={loading}
      refetching={refetching}
      empty={empty}
      emptyLabel="Nobody joined or left in this window, and no headcount could be reconstructed for it."
      exportName="workforce-movement"
      height={300}
      table={{
        caption: 'Joiners, leavers and headcount by month',
        rows,
        rowKey: (row) => row.key,
        columns: [
          { key: 'label', label: 'Month', value: (row) => row.label },
          {
            key: 'joiners',
            label: 'Joined',
            value: (row) => String(row.joiners),
            numeric: true,
          },
          {
            key: 'leavers',
            label: 'Left',
            value: (row) => String(row.leavers),
            numeric: true,
          },
          {
            key: 'net',
            label: 'Net change',
            value: (row) => signed(row.joiners - row.leavers),
            numeric: true,
          },
          {
            key: 'headcountEnd',
            label: 'Headcount at close',
            // The same gap the line draws. A reader exporting this must be
            // able to tell "not reconstructable" from "nobody employed".
            value: (row) =>
              row.headcountEnd === null ? '—' : String(row.headcountEnd),
            numeric: true,
          },
        ],
        totals: {
          label: 'Total',
          joiners: String(totals.joiners),
          leavers: String(totals.leavers),
          net: signed(totals.joiners - totals.leavers),
          // Headcount is a level, not something that sums down a column.
          // Adding twelve monthly snapshots together would count the same
          // people twelve times.
          headcountEnd: '—',
        },
      }}
    >
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart
          data={rows}
          margin={{ top: 8, right: 12, bottom: 0, left: 4 }}
        >
          <CartesianGrid vertical={false} stroke={chartColors.grid} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fill: chartColors.axisText, fontSize: 11 }}
            {...xAxisProps}
          />
          <YAxis
            // People are whole. A tick reading 2.5 staff is not a headcount.
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={44}
            tick={{ fill: chartColors.axisText, fontSize: 11 }}
            {...yAxisProps}
          />
          <Tooltip
            // The mark highlight rather than the crosshair: bars carry this
            // chart, and on a bar the mark IS what the reader is asking about.
            cursor={markCursor}
            content={
              <ChartTooltip
                format={count}
                labels={{
                  joiners: 'Joined',
                  leavers: 'Left',
                  headcountEnd: 'Headcount at close',
                }}
              />
            }
          />
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          />
          <Bar
            dataKey="joiners"
            name="Joined"
            fill={JOINERS_COLOR}
            radius={[4, 4, 0, 0]}
            maxBarSize={22}
          />
          <Bar
            dataKey="leavers"
            name="Left"
            fill={LEAVERS_COLOR}
            radius={[4, 4, 0, 0]}
            maxBarSize={22}
          />
          <Line
            type="monotone"
            dataKey="headcountEnd"
            name="Headcount at close"
            stroke={HEADCOUNT_COLOR}
            strokeWidth={2.5}
            // The whole point. A month the backwards walk could not reach is a
            // hole in the record, and the line has to show the hole.
            connectNulls={false}
            dot={{ r: 3, fill: HEADCOUNT_COLOR, strokeWidth: 0 }}
            activeDot={{ r: 5 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
