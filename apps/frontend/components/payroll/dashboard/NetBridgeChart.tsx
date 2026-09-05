'use client';

import { useMemo } from 'react';
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
import { chartColors, COMPOSITION_COLORS, SERIES_OTHER } from '@/theme/chartColors';
import { formatCurrency } from '@/utils/formatters';
import type { DashboardBridge } from '@/types/payrollDashboard';
import { compactMoney } from '@/components/charts/chartFormat';

/**
 * Gross to net, as a waterfall.
 *
 * Recharts has no waterfall, so it is a stacked bar with a **transparent base**:
 * the first series positions the floating bar and is drawn with no fill, the
 * second is the visible step. That is the whole trick, and it is why the base
 * has to be computed here rather than read off a field.
 *
 * The step sequence and its arithmetic are the server's — including
 * `netFloorResidual`, which exists because each payslip floors its own net at
 * zero, so across a run `Σnet ≥ Σgross − Σdeductions`. Without that step the
 * bars would not reach the final column, and a bridge whose bars do not close
 * is worse than no bridge.
 */

interface BridgeBar {
  key: string;
  label: string;
  /** Invisible spacer that lifts a floating step to its running balance. */
  base: number;
  /** The visible height. */
  value: number;
  /** The signed amount, for the tooltip and the label. */
  amount: number;
  kind: 'total' | 'add' | 'subtract';
}

/** Walk the running balance, turning each step into a floating bar. */
function toBars(bridge: DashboardBridge): BridgeBar[] {
  let running = 0;
  return bridge.steps.map((step) => {
    if (step.kind === 'total') {
      running = step.amount;
      return {
        key: step.key,
        label: step.label,
        base: 0,
        value: step.amount,
        amount: step.amount,
        kind: step.kind,
      };
    }

    const delta = step.kind === 'add' ? step.amount : -step.amount;
    const next = running + delta;
    // The bar spans from the old balance to the new one, whichever is lower
    // being the base — so a subtraction hangs DOWN from where the total was.
    const bar: BridgeBar = {
      key: step.key,
      label: step.label,
      base: Math.min(running, next),
      value: Math.abs(delta),
      amount: delta,
      kind: step.kind,
    };
    running = next;
    return bar;
  });
}

export default function NetBridgeChart({
  bridge,
  currency,
  loading,
  refetching,
}: {
  bridge?: DashboardBridge;
  currency: string;
  loading?: boolean;
  refetching?: boolean;
}) {
  const { xAxisProps, yAxisProps } = useChartDirection();
  const money = (value: number) => formatCurrency(value, currency);
  const bars = useMemo(() => (bridge ? toBars(bridge) : []), [bridge]);

  const fillFor = (bar: BridgeBar) => {
    if (bar.key === 'GROSS') return COMPOSITION_COLORS.BASIC;
    if (bar.key === 'NET') return COMPOSITION_COLORS.ALLOWANCES;
    if (bar.key === 'NET_FLOOR') return SERIES_OTHER;
    return COMPOSITION_COLORS.DEDUCTIONS;
  };

  return (
    <ChartFrame
      title="Gross to net"
      hint={
        bridge && bridge.netFloorResidual !== 0
          ? 'Includes the adjustment where a net floored at zero.'
          : 'Employer contributions are outside this bridge — they are never paid to employees.'
      }
      href="/dashboard/payroll/reports"
      loading={loading}
      refetching={refetching}
      empty={!bridge || bridge.gross === 0}
      emptyLabel="No pay was calculated for this period."
      exportName="payroll-gross-to-net"
      table={{
        caption: 'Gross to net bridge',
        rows: bars,
        rowKey: (row) => row.key,
        columns: [
          { key: 'label', label: 'Step', value: (row) => row.label },
          {
            key: 'amount',
            label: 'Amount',
            value: (row) =>
              row.kind === 'total'
                ? money(row.amount)
                : `${row.amount < 0 ? '−' : '+'}${money(Math.abs(row.amount))}`,
            numeric: true,
          },
        ],
      }}
    >
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={bars} margin={{ top: 20, right: 12, bottom: 0, left: 4 }}>
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
            content={
              <ChartTooltip
                format={money}
                labels={{ value: 'Step' }}
                extra={(payload) => [
                  {
                    label: 'Signed',
                    value: money(Number(payload.amount ?? 0)),
                  },
                ]}
              />
            }
          />
          {/* The spacer. Transparent, hidden from the legend and from the
              tooltip — it is a positioning device, not a quantity. */}
          <Bar dataKey="base" stackId="bridge" fill="transparent" legendType="none" />
          <Bar dataKey="value" stackId="bridge" name="Step" radius={[6, 6, 0, 0]}>
            {bars.map((bar) => (
              <Cell key={bar.key} fill={fillFor(bar)} />
            ))}
            {/* The step value IS the reading on a waterfall, so it is the one
                chart here that labels every mark. */}
            <LabelList
              dataKey="amount"
              position="top"
              formatter={(value: unknown) => {
                const amount = Number(value);
                return `${amount < 0 ? '−' : ''}${compactMoney(Math.abs(amount))}`;
              }}
              className="fill-text-muted text-[11px]"
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
