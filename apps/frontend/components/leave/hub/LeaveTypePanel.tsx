'use client';

import {
  MeterList,
  PanelHeader,
  PanelLink,
  type MeterRow,
} from '@/components/module-landing/primitives';
import { formatDays, formatRate } from '../leaveFormat';
import type { LeaveHubSummary } from '@/types/leaveHub';

/**
 * What kinds of leave people are actually consuming.
 *
 * Ranked by DAYS rather than by request count: five one-day sick notes and one
 * three-week holiday are not the same fact about a month, and a chart that
 * counted requests would put the sick notes on top.
 */
export default function LeaveTypePanel({
  summary,
  loading = false,
}: {
  summary?: LeaveHubSummary;
  loading?: boolean;
}) {
  const rows = summary?.leaveTypes ?? [];
  const total = summary?.periodStats.leaveDays ?? 0;

  const meters: MeterRow[] = rows.slice(0, 6).map((row) => ({
    key: row.key,
    label: row.name,
    // Against the busiest type rather than against the total: with six types the
    // bars would all be stubs, and the panel exists to be compared across.
    percent: rows[0]?.days ? (row.days / rows[0].days) * 100 : 0,
    valueLabel: formatDays(row.days),
    hint: `${row.requests} request${row.requests === 1 ? '' : 's'} · ${formatRate(row.share)} of the days taken`,
    href: `/dashboard/leaves?leaveType=${encodeURIComponent(row.key)}`,
  }));

  return (
    <div className="surface-panel flex flex-col rounded-[20px] p-6">
      <PanelHeader
        title="Leave taken, by type"
        hint={
          summary
            ? `${formatDays(total)} approved in ${summary.range.label}.`
            : undefined
        }
        action={<PanelLink href="/dashboard/leaves/balances">Balances</PanelLink>}
      />

      <div className="mt-5 flex-1">
        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded-lg bg-surface-border/60" />
            ))}
          </div>
        ) : meters.length === 0 ? (
          <p className="py-14 text-center text-[13px] text-text-muted">
            No leave was approved in this window.
          </p>
        ) : (
          <MeterList rows={meters} />
        )}
      </div>
    </div>
  );
}
