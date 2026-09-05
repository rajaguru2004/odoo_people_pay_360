'use client';

import { useRouter } from 'next/navigation';
import { ResponsiveContainer, Tooltip, Treemap } from 'recharts';
import ChartFrame from '@/components/charts/ChartFrame';
import { ChartTooltip } from '@/components/charts/tooltips';
import { sequentialFill } from '@/theme/chartColors';
import { formatCurrency } from '@/utils/formatters';
import type { DashboardDepartmentRow } from '@/types/payrollDashboard';

/**
 * Headcount against salary, by department.
 *
 * Two measures on one mark, which a bar chart cannot do without a second axis —
 * and a second axis is the single most common way a dashboard invents a
 * correlation that is not in the data. So: **area is total cost**, **fill is
 * average pay per head**, and headcount is written into the cell.
 *
 * The fill is a SEQUENTIAL ramp — one hue, light to dark — because average pay
 * is a quantity on a scale. A categorical ramp there would say the departments
 * are unrelated identities, when the whole point of the colour is that they sit
 * on one measure. The categorical ramp is used on the cost bar instead, where
 * identity IS the question.
 *
 * A department paying nothing is left out rather than drawn at zero area: a
 * rectangle of no size is not a rectangle, and Recharts lays out the remainder
 * around it in a way that misleads.
 */

interface TreemapDatum {
  /**
   * Recharts types a treemap datum as an open record, so the shape has to
   * admit one. Kept as an index signature rather than casting at the call
   * site, so the fields below stay checked.
   */
  [key: string]: unknown;
  name: string;
  size: number;
  id: string | null;
  headcount: number;
  net: number;
  avgNet: number | null;
  fill: string;
}

export default function DepartmentTreemap({
  departments,
  currency,
  period,
  loading,
  refetching,
}: {
  departments?: DashboardDepartmentRow[];
  currency: string;
  period?: string;
  loading?: boolean;
  refetching?: boolean;
}) {
  const router = useRouter();
  const rows = departments ?? [];
  const money = (value: number) => formatCurrency(value, currency);

  const paying = rows.filter((row) => row.totalCost > 0);
  const averages = paying
    .map((row) => row.avgNet ?? 0)
    .filter((value) => value > 0);
  const min = averages.length > 0 ? Math.min(...averages) : 0;
  const max = averages.length > 0 ? Math.max(...averages) : 0;

  const data: TreemapDatum[] = paying.map((row) => ({
    name: row.name,
    size: row.totalCost,
    id: row.id,
    headcount: row.headcount,
    net: row.net,
    avgNet: row.avgNet,
    // A single department, or several paying the same average, would divide by
    // a zero range; the mid-tone is the honest answer to "where on a scale
    // that has no spread".
    fill: sequentialFill(
      max > min && row.avgNet !== null ? (row.avgNet - min) / (max - min) : 0.5,
    ),
  }));

  return (
    <ChartFrame
      title="Headcount against salary"
      hint="Area is total cost; shade is average pay per head."
      href="/dashboard/payroll/reports"
      loading={loading}
      refetching={refetching}
      empty={data.length === 0}
      emptyLabel="No department was paid in this period."
      exportName="payroll-department-treemap"
      height={300}
      table={{
        caption: 'Cost and headcount by department',
        rows: paying,
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
            key: 'totalCost',
            label: 'Total cost',
            value: (row) => money(row.totalCost),
            numeric: true,
          },
          {
            key: 'avgNet',
            label: 'Average net',
            value: (row) => (row.avgNet === null ? '—' : money(row.avgNet)),
            numeric: true,
          },
        ],
      }}
    >
      <div className="space-y-3">
        <ResponsiveContainer width="100%" height={260}>
          <Treemap
            data={data}
            dataKey="size"
            nameKey="name"
            stroke="var(--color-surface-card)"
            isAnimationActive={false}
            content={<TreemapCell />}
            onClick={(node) => {
              const id = (node as unknown as { id?: string | null })?.id;
              const params = new URLSearchParams();
              if (id) params.set('departmentId', id);
              if (period) params.set('period', period);
              router.push(`/dashboard/payroll/payslips?${params.toString()}`);
            }}
          >
            <Tooltip
              content={
                <ChartTooltip
                  format={money}
                  labels={{ size: 'Total cost' }}
                  extra={(payload) => [
                    { label: 'Paid', value: String(payload.headcount ?? 0) },
                    {
                      label: 'Average net',
                      value:
                        payload.avgNet === null || payload.avgNet === undefined
                          ? '—'
                          : money(Number(payload.avgNet)),
                    },
                  ]}
                />
              }
            />
          </Treemap>
        </ResponsiveContainer>

        {/* A sequential fill is unreadable without the scale it sits on. */}
        {averages.length > 1 && (
          <div className="flex items-center gap-2 text-[11px] text-text-muted">
            <span>{money(min)}</span>
            <span
              className="h-2 flex-1 rounded-full"
              style={{
                background: `linear-gradient(to right, ${sequentialFill(0)}, ${sequentialFill(1)})`,
              }}
              aria-hidden
            />
            <span>{money(max)}</span>
            <span className="ms-1">average net</span>
          </div>
        )}
      </div>
    </ChartFrame>
  );
}

/**
 * One cell, with its own label.
 *
 * Recharts' default cell prints the name at any size, so a small department
 * gets a word wider than its own rectangle overlapping two neighbours. The text
 * is drawn only where it fits.
 */
function TreemapCell(props: unknown) {
  const node = props as Partial<TreemapDatum> & {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  const { x = 0, y = 0, width = 0, height = 0, name, headcount, fill } = node;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={6}
        style={{ fill, stroke: 'var(--color-surface-card)', strokeWidth: 2 }}
        className="cursor-pointer"
      />
      {width > 74 && height > 34 && (
        <>
          <text
            x={x + 10}
            y={y + 20}
            className="fill-white text-[12px] font-semibold"
          >
            {name}
          </text>
          {height > 52 && (
            <text x={x + 10} y={y + 36} className="fill-white/80 text-[11px]">
              {headcount} paid
            </text>
          )}
        </>
      )}
    </g>
  );
}
