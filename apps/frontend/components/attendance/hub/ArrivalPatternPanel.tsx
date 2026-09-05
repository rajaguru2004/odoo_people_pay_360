'use client';

import { useMemo } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { SplineTrendChart } from '@/components/module-landing/primitives';
import type { AttendanceHubSummary } from '@/types/attendanceHub';

const ON_TIME_COLOR = 'color-mix(in srgb, var(--color-brand-primary) 90%, white)';
const LATE_COLOR = 'color-mix(in srgb, var(--color-brand-accent) 75%, white)';

/**
 * When people actually arrive, on time against late, hour by hour.
 *
 * A curve rather than a single "n were late" figure, because the two say
 * different things: a spike at 09:30 against a 09:00 start is a commute
 * problem, and the same count spread flat across the morning is not.
 */
export default function ArrivalPatternPanel({
  summary,
  isDay,
}: {
  summary?: AttendanceHubSummary;
  isDay: boolean;
}) {
  const pattern = useMemo(() => summary?.arrivalPattern ?? [], [summary]);

  const series = useMemo(
    () => [
      { key: 'onTime', values: pattern.map((a) => a.onTime), color: ON_TIME_COLOR },
      { key: 'late', values: pattern.map((a) => a.late), color: LATE_COLOR },
    ],
    [pattern],
  );

  // Every third hour, so twenty-four ticks do not overprint each other.
  const ticks = useMemo(() => pattern.filter((_, i) => i % 3 === 0).map((a) => a.label), [pattern]);

  const peak = useMemo(() => {
    let best: (typeof pattern)[number] | null = null;
    for (const a of pattern) if (!best || a.onTime + a.late > best.onTime + best.late) best = a;
    return best && best.onTime + best.late > 0 ? best : null;
  }, [pattern]);

  /**
   * On-time arrivals as a share of everyone who turned up.
   *
   * Of ARRIVALS, not of expected: this figure sits beside a curve of arrivals,
   * and mixing the two denominators in one panel is how a reader ends up
   * believing a number nobody computed.
   */
  const stats = summary?.periodStats;
  const onTimeShare =
    stats && stats.present > 0 ? ((stats.present - stats.late) / stats.present) * 100 : undefined;

  return (
    <div className="surface-panel flex flex-col justify-between rounded-[20px] p-6">
      <div>
        <div className="mb-1 flex items-center justify-between gap-3">
          <h3 className="text-[15px] font-bold text-text-heading">Arrival pattern</h3>
          <div className="flex items-center gap-3 text-[11px] font-medium text-text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-xs" style={{ background: ON_TIME_COLOR }} />
              On time
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-xs" style={{ background: LATE_COLOR }} />
              Late
            </span>
          </div>
        </div>

        <div className="my-2 flex flex-wrap items-baseline gap-2.5">
          <span className="text-[28px] font-extrabold leading-none tracking-tight tabular-nums text-text-heading">
            {peak ? peak.label : '—'}
          </span>
          {peak && (
            <span className="text-xs font-semibold text-text-muted">
              busiest hour · {peak.onTime + peak.late} arrivals
            </span>
          )}
          {onTimeShare !== undefined && (
            <span
              className={`inline-flex items-center gap-0.5 text-xs font-semibold ${
                onTimeShare >= 80 ? 'text-status-success' : 'text-status-warning'
              }`}
            >
              {onTimeShare >= 80 ? (
                <ArrowUpRight size={13} strokeWidth={2.5} aria-hidden />
              ) : (
                <ArrowDownRight size={13} strokeWidth={2.5} aria-hidden />
              )}
              {onTimeShare.toFixed(0)}% on time
            </span>
          )}
        </div>
      </div>

      <div className="mt-2">
        <SplineTrendChart
          height={140}
          series={series}
          timeTicks={ticks.length ? ticks : undefined}
          emptyLabel={isDay ? 'Nobody has clocked in yet.' : 'No arrivals in this window.'}
        />
      </div>
    </div>
  );
}
