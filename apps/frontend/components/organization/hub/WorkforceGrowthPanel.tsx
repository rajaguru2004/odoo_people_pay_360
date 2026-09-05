'use client';

import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import {
  SegmentedTimeFilter,
  SplineTrendChart,
  type SplineSeries,
} from '@/components/module-landing/primitives';
import type { OrganizationHubSummary, TrendMonths } from '@/types/organizationHub';

/**
 * Whether the company is growing or shrinking, and by how much.
 *
 * The 6M/12M switch lives here rather than in the page header. Everything else
 * on this hub is a fact about the structure as it stands right now, so a period
 * control across the whole page would move one card while implying it moved all
 * of them.
 *
 * Two curves rather than one pre-subtracted net line: the gap between joiners
 * and leavers IS the net change, and a flat net line hides a business that
 * replaced forty people in a quarter.
 */
const MONTH_TABS: Array<{ label: string; value: TrendMonths }> = [
  { label: '6M', value: 6 },
  { label: '12M', value: 12 },
];

const JOINERS_COLOR = 'color-mix(in srgb, var(--color-brand-primary) 90%, white)';
const LEAVERS_COLOR = 'color-mix(in srgb, var(--color-brand-accent) 75%, white)';

export default function WorkforceGrowthPanel({
  growth,
  months,
  onMonthsChange,
  loading = false,
  busy = false,
  failed = false,
}: {
  growth?: OrganizationHubSummary['growth'];
  months: TrendMonths;
  onMonthsChange: (months: TrendMonths) => void;
  loading?: boolean;
  busy?: boolean;
  failed?: boolean;
}) {
  const buckets = growth?.buckets ?? [];

  const series: SplineSeries[] = buckets.length
    ? [
        { key: 'joiners', values: buckets.map((b) => b.joiners), color: JOINERS_COLOR },
        { key: 'leavers', values: buckets.map((b) => b.leavers), color: LEAVERS_COLOR },
      ]
    : [];

  // Four ticks at most, or a twelve-month axis prints a row of stubs.
  const ticks = buckets.length
    ? [0, Math.floor(buckets.length / 3), Math.floor((buckets.length * 2) / 3), buckets.length - 1]
        .filter((value, i, all) => all.indexOf(value) === i)
        .map((i) => buckets[i].label.split(' ')[0])
    : [];

  const net = growth?.netChange ?? 0;
  const growthPct = growth?.growthPct ?? null;
  const rising = net >= 0;
  const activeLabel = MONTH_TABS.find((tab) => tab.value === months)?.label ?? '6M';
  const joiners = buckets.reduce((sum, b) => sum + b.joiners, 0);
  const leavers = buckets.reduce((sum, b) => sum + b.leavers, 0);

  return (
    <div className="surface-panel flex h-full flex-col justify-between rounded-[20px] p-6">
      <div>
        <div className="mb-1 flex items-start justify-between gap-3">
          <span className="min-w-0 text-[15px] font-bold text-text-heading">Workforce growth</span>
          <SegmentedTimeFilter
            options={MONTH_TABS.map((tab) => tab.label)}
            value={activeLabel}
            onChange={(label) => {
              const tab = MONTH_TABS.find((candidate) => candidate.label === label);
              if (tab) onMonthsChange(tab.value);
            }}
          />
        </div>

        <div className="mt-2.5 mb-1 flex items-baseline gap-2.5">
          {failed || !growth ? (
            <span className="text-[28px] font-extrabold leading-none text-text-heading">—</span>
          ) : (
            <>
              <span className="text-[28px] font-extrabold leading-none tracking-tight tabular-nums text-text-heading">
                {net > 0 ? `+${net}` : net}
              </span>
              <span
                className={`inline-flex items-center gap-1 text-xs font-bold ${
                  rising ? 'text-status-success' : 'text-status-error'
                }`}
              >
                {rising ? (
                  <ArrowUpRight size={13} aria-hidden />
                ) : (
                  <ArrowDownRight size={13} aria-hidden />
                )}
                {/* An unknown rate prints a dash rather than 0.0%: a company
                    with nobody in it has no growth rate, it has no denominator. */}
                {growthPct === null ? '—' : `${Math.abs(growthPct).toFixed(1)}%`}
              </span>
            </>
          )}
        </div>

        <p className="text-[11px] leading-snug text-text-muted">
          {failed
            ? 'The movement history could not be read.'
            : growth
              ? `${joiners} joined, ${leavers} left over ${months} months.`
              : ''}
        </p>
      </div>

      <div className={`mt-3 ${busy ? 'opacity-60 transition-opacity' : ''}`}>
        <SplineTrendChart
          height={120}
          series={loading ? undefined : series}
          timeTicks={ticks}
          emptyLabel={
            failed ? 'The movement history could not be read.' : 'Nobody joined or left.'
          }
        />
        <div className="mt-2 flex items-center gap-3 text-[11px] font-medium text-text-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-xs" style={{ background: JOINERS_COLOR }} />
            Joiners
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-xs" style={{ background: LEAVERS_COLOR }} />
            Leavers
          </span>
        </div>
      </div>
    </div>
  );
}
