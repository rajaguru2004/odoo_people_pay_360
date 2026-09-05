'use client';

import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import {
  PanelHeader,
  PanelLink,
  SegmentedBar,
  type BarSegment,
} from '@/components/module-landing/primitives';
import type { PeopleHubSummary } from '@/types/peopleHub';

/**
 * Who arrived, who left, and which way that leaves the business.
 *
 * One bar of two parts rather than a second line chart: the panel above already
 * draws the trend over time, and repeating that shape in a third of the width
 * would say nothing new. What this adds is the RATIO — eighteen in against six
 * out reads very differently from eighteen against seventeen, and a net of +1
 * hides both.
 */
export default function HeadcountMovement({
  summary,
  loading = false,
  failed = false,
}: {
  summary?: PeopleHubSummary;
  loading?: boolean;
  failed?: boolean;
}) {
  const buckets = summary?.trend.buckets ?? [];
  const joiners = buckets.reduce((a, b) => a + b.joiners, 0);
  const leavers = buckets.reduce((a, b) => a + b.leavers, 0);
  const net = summary?.trend.netChange ?? 0;
  const turnover = summary?.trend.turnoverRate ?? null;
  const growing = net >= 0;

  const segments: BarSegment[] = [
    { key: 'joiners', label: 'Joined', value: joiners, color: 'var(--color-status-success)' },
    { key: 'leavers', label: 'Left', value: leavers, color: 'var(--color-status-warning)' },
  ];

  return (
    <div className="surface-panel flex h-full flex-col justify-between rounded-[20px] p-6">
      <div>
        <PanelHeader
          title="Headcount movement"
          hint={
            summary
              ? `Arrivals against departures over the last ${summary.trend.months} months.`
              : undefined
          }
          action={
            <PanelLink href="/dashboard/contracts/terminations">Terminations</PanelLink>
          }
        />

        <div className="my-2 flex flex-wrap items-baseline gap-2.5">
          {failed || !summary ? (
            <span className="text-[28px] font-extrabold leading-none text-text-heading">—</span>
          ) : (
            <>
              <span className="text-[28px] font-extrabold leading-none tracking-tight tabular-nums text-text-heading">
                {net > 0 ? `+${net}` : net}
              </span>
              {/* The arrow belongs to the NET and has to sit against it. Beside
                  the turnover figure it reads as "turnover up", which is a
                  direction nothing here measured. */}
              <span
                className={`inline-flex items-center gap-0.5 text-xs font-bold ${
                  growing ? 'text-status-success' : 'text-status-error'
                }`}
              >
                {growing ? (
                  <ArrowUpRight size={13} aria-hidden />
                ) : (
                  <ArrowDownRight size={13} aria-hidden />
                )}
                net
              </span>
              <span className="text-xs font-semibold text-text-muted">
                {/* No denominator, no rate. A company with no opening headcount
                    does not have a turnover of 0.0%; it has no turnover figure. */}
                {turnover === null
                  ? 'turnover not measurable'
                  : `${turnover.toFixed(1)}% turnover`}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="h-4 animate-pulse rounded-full bg-surface-page" />
        ) : joiners + leavers === 0 ? (
          <p className="text-[13px] text-text-muted">Nobody joined or left in this window.</p>
        ) : (
          <SegmentedBar segments={segments} height={14} />
        )}
      </div>
    </div>
  );
}
