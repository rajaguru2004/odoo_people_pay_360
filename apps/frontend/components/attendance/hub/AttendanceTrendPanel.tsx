'use client';

import { useMemo } from 'react';
import {
  BarOverviewChart,
  PanelHeader,
  PanelLink,
  type BarOverviewItem,
} from '@/components/module-landing/primitives';
import { chartAxis, formatRate } from '../attendanceFormat';
import type { AttendanceHubSummary, HubTrendBucket } from '@/types/attendanceHub';

/**
 * The shape of the selected window: one bar per hour, day or month.
 *
 * The granularity is the server's decision — `trendKind` — because the bucket
 * boundaries have to agree with the figures on the cards above, and a chart that
 * re-bucketed here would draw a different week from the one the KPIs counted.
 *
 * A day's bars are sized by ARRIVALS and a longer window's by who was EXPECTED.
 * An hour expects nobody in particular (people arrive when their shift starts),
 * so an "expected" bar against 03:00 would be a column of noise; over a week the
 * expectation is exactly what the absences sit inside.
 */
export default function AttendanceTrendPanel({
  summary,
  loading = false,
}: {
  summary?: AttendanceHubSummary;
  loading?: boolean;
}) {
  const byHour = summary?.trendKind === 'hour';
  const periodLabel = summary?.range.label ?? '';

  const { items, axis } = useMemo(() => {
    const buckets: HubTrendBucket[] = summary?.trend ?? [];
    const heightOf = (b: HubTrendBucket) => (byHour ? b.present : b.expected);

    /**
     * Which bar opens with its card showing.
     *
     * On a day that is the BUSIEST hour, because "most people arrive at 08:00"
     * is the sentence the chart is drawing. Over a longer window it is the last
     * bucket that has anything in it — pinning it to today puts a card of zeros
     * on screen every weekend, which reads as a broken panel rather than a day
     * off.
     */
    let highlightKey: string | undefined;
    if (byHour) {
      let best = 0;
      for (const b of buckets) {
        if (heightOf(b) > best) {
          best = heightOf(b);
          highlightKey = b.key;
        }
      }
    } else {
      for (const b of buckets) if (heightOf(b) > 0) highlightKey = b.key;
    }

    const rows: BarOverviewItem[] = buckets.map((b) => ({
      key: b.key,
      label: b.label,
      value: heightOf(b),
      highlight: b.key === highlightKey,
      tooltipTitle: b.label,
      tooltipRows: byHour
        ? [
            {
              label: 'On time',
              value: b.onTime,
              color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
            },
            { label: 'Late', value: b.late, color: 'var(--color-status-warning)' },
            { label: 'Arrivals', value: b.present, emphasis: true },
          ]
        : [
            { label: 'Expected', value: b.expected },
            {
              label: 'Present',
              value: b.present,
              color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
            },
            { label: 'Late', value: b.late, color: 'var(--color-status-warning)' },
            { label: 'Absent', value: b.absent, color: 'var(--color-status-error)' },
            { label: 'Attendance', value: formatRate(b.attendanceRate), emphasis: true },
          ],
    }));

    return { items: rows, axis: chartAxis(Math.max(1, ...buckets.map(heightOf))) };
  }, [summary, byHour]);

  const empty = items.length === 0 || items.every((b) => b.value === 0);

  return (
    <div className="surface-panel flex flex-col justify-between rounded-[20px] p-6">
      <PanelHeader
        title={byHour ? 'Arrivals through the day' : 'Turnout over the period'}
        hint={
          !summary
            ? undefined
            : byHour
              ? `When people clocked in on ${periodLabel}.`
              : `${periodLabel} — ${formatRate(summary.periodStats.attendanceRate)} of expected days worked.`
        }
        action={<PanelLink href="/dashboard/attendance/reports">Full report</PanelLink>}
      />

      {/* A floor on the plot keeps the bars readable when this panel is the
          short one in the row; flex-1 lets it grow when the ranking beside it
          is taller. */}
      <div className="mt-2 flex min-h-[260px] flex-1 pt-2">
        {loading ? (
          <div className="h-[260px] w-full animate-pulse rounded-xl bg-surface-border/60" />
        ) : empty ? (
          <p className="w-full py-16 text-center text-[13px] text-text-muted">
            {byHour ? 'Nobody has clocked in yet.' : 'No attendance was recorded in this window.'}
          </p>
        ) : (
          <div className="flex-1">
            <BarOverviewChart
              items={items}
              height="100%"
              maxVal={axis.max}
              yAxisTicks={axis.ticks}
              // A long month scrolls inside the plot rather than squeezing forty
              // bars into a panel where none of them can be hovered.
              minBarWidth={items.length > 16 ? 26 : undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}
