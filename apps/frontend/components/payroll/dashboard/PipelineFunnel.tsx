'use client';

import { useRouter } from 'next/navigation';
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
import { chartColors, RUN_STATUS_COLORS } from '@/theme/chartColors';
import type { DashboardFunnelStage } from '@/types/payrollDashboard';

/**
 * The payrun pipeline: started → computed → validated → paid.
 *
 * Drawn as a horizontal stepped bar rather than with Recharts' `FunnelChart`.
 * A real funnel scales each band's WIDTH by its value, which reads as a
 * proportion of area and makes a four-to-three drop look like a collapse; a bar
 * against a shared axis is the same information without the exaggeration, and
 * it can carry the axis a funnel cannot.
 *
 * `reached` is cumulative and comes from the server — see `buildFunnel`. The
 * drop between two bars is the count stuck at that gate, which is the sentence
 * this chart exists to say.
 *
 * `CANCELLED` is not a stage. It sits beside the chart as a plain count,
 * because a withdrawal is neither a step forward nor a failure.
 */
export default function PipelineFunnel({
  funnel,
  cancelled,
  loading,
  refetching,
}: {
  funnel?: DashboardFunnelStage[];
  cancelled?: number;
  loading?: boolean;
  refetching?: boolean;
}) {
  const router = useRouter();
  const rows = funnel ?? [];
  const { yAxisProps } = useChartDirection();

  return (
    <ChartFrame
      title="Payrun pipeline"
      hint={
        cancelled
          ? `${cancelled} cancelled run${cancelled === 1 ? '' : 's'} are not counted in any stage.`
          : 'Runs that reached at least each stage.'
      }
      href="/dashboard/payroll/runs"
      hrefLabel="All runs"
      loading={loading}
      refetching={refetching}
      empty={rows.length === 0 || rows[0].reached === 0}
      emptyLabel="No payroll run has been started in this window."
      exportName="payroll-pipeline"
      table={{
        caption: 'Runs reaching each pipeline stage',
        rows,
        rowKey: (row) => row.stage,
        columns: [
          { key: 'label', label: 'Stage', value: (row) => row.label },
          {
            key: 'reached',
            label: 'Runs reached',
            value: (row) => String(row.reached),
            numeric: true,
          },
        ],
      }}
    >
      <ResponsiveContainer width="100%" height={280}>
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 8, right: 40, bottom: 0, left: 8 }}
        >
          <XAxis type="number" hide allowDecimals={false} />
          <YAxis
            type="category"
            dataKey="label"
            tickLine={false}
            axisLine={false}
            width={84}
            tick={{ fill: chartColors.axisText, fontSize: 12 }}
            {...yAxisProps}
          />
          <Tooltip
            cursor={markCursor}
            content={
              <ChartTooltip
                format={(value) => String(value)}
                labels={{ reached: 'Runs reached' }}
              />
            }
          />
          <Bar
            dataKey="reached"
            name="Runs reached"
            radius={[0, 6, 6, 0]}
            barSize={30}
            onClick={(_, index) =>
              router.push(
                `/dashboard/payroll/runs?status=${rows[index].stage}`,
              )
            }
            className="cursor-pointer"
          >
            {rows.map((row) => (
              <Cell key={row.stage} fill={RUN_STATUS_COLORS[row.stage]} />
            ))}
            {/* Four bars, and the count IS the reading — so each is labelled
                rather than left to a hover the reader may never try. */}
            <LabelList
              dataKey="reached"
              position="right"
              className="fill-text-heading text-[12px] font-bold"
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
