'use client';

import { useMemo } from 'react';
import {
  BarOverviewChart,
  PanelHeader,
  PanelLink,
  type BarOverviewItem,
} from '@/components/module-landing/primitives';
import { axisFor } from '@/utils/chartAxis';
import type { LeaveHubSummary } from '@/types/leaveHub';

/**
 * Requests over the selected window, one stacked bar per bucket.
 *
 * The granularity is the SERVER'S decision — `trendKind` — because the bucket
 * boundaries have to agree with the figures on the cards above, and a chart that
 * re-bucketed here would draw a different month from the one the KPIs counted.
 *
 * Stacked by status, all four of them. A single-tone bar of "requests" answers
 * how many were filed and hides the only follow-up question anybody has, which
 * is how many are still waiting.
 */
export default function LeaveTrendPanel({
  summary,
  loading = false,
}: {
  summary?: LeaveHubSummary;
  loading?: boolean;
}) {
  const periodLabel = summary?.range.label ?? '';

  const { items, axis } = useMemo(() => {
    const buckets = summary?.trend ?? [];

    // The highlighted bar is the LAST bucket with anything in it, not today:
    // pinning it to today puts a card of zeros on screen every weekend, which
    // reads as a broken panel rather than as a quiet day.
    let highlightKey: string | undefined;
    for (const b of buckets) if (b.total > 0) highlightKey = b.key;

    const rows: BarOverviewItem[] = buckets.map((b) => ({
      key: b.key,
      label: b.label,
      value: b.total,
      highlight: b.key === highlightKey,
      segments: [
        {
          key: 'approved',
          label: 'Approved',
          value: b.approved,
          color: 'var(--color-status-success)',
        },
        {
          key: 'pending',
          label: 'Pending',
          value: b.pending,
          color: 'var(--color-status-warning)',
        },
        {
          key: 'rejected',
          label: 'Rejected',
          value: b.rejected,
          color: 'var(--color-status-error)',
        },
        {
          key: 'cancelled',
          label: 'Withdrawn',
          value: b.cancelled,
          color: 'var(--color-surface-border)',
        },
      ].filter((s) => s.value > 0),
      tooltipTitle: b.label,
      tooltipRows: [
        { label: 'Approved', value: b.approved, color: 'var(--color-status-success)' },
        { label: 'Pending', value: b.pending, color: 'var(--color-status-warning)' },
        { label: 'Rejected', value: b.rejected, color: 'var(--color-status-error)' },
        { label: 'Withdrawn', value: b.cancelled, color: 'var(--color-surface-border)' },
        { label: 'Filed', value: b.total, emphasis: true },
      ],
    }));

    return {
      items: rows,
      axis: axisFor(Math.max(1, ...buckets.map((b) => b.total))),
    };
  }, [summary]);

  const empty = items.length === 0 || items.every((b) => b.value === 0);

  return (
    <div className="surface-panel flex flex-col justify-between rounded-[20px] p-6">
      <PanelHeader
        title="Requests filed"
        hint={
          summary
            ? `${periodLabel} — ${summary.periodStats.requests} filed, ${summary.periodStats.pending} still waiting.`
            : undefined
        }
        action={<PanelLink href="/dashboard/leaves">All requests</PanelLink>}
      />

      <div className="mt-2 flex min-h-[260px] flex-1 pt-2">
        {loading ? (
          <div className="h-[260px] w-full animate-pulse rounded-xl bg-surface-border/60" />
        ) : empty ? (
          <p className="w-full py-16 text-center text-[13px] text-text-muted">
            No leave was filed in this window.
          </p>
        ) : (
          <div className="flex-1">
            <BarOverviewChart
              items={items}
              height="100%"
              maxVal={axis.max}
              yAxisTicks={axis.ticks}
              // The card sits over the bands it describes and clips against the
              // panel edge on the first and last bucket, so hover does the work.
              openHighlightTooltip={false}
              minBarWidth={items.length > 16 ? 26 : undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}
