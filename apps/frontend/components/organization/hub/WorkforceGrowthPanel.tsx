'use client';

import { useTranslations } from 'next-intl';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import {
  PanelHeader,
  SegmentedTimeFilter,
  SplineTrendChart,
  type SplineSeries,
} from '@/components/module-landing/primitives';
import type { OrganizationHubSummary, TrendMonths } from '@/types/organizationHub';

/**
 * Is the organization growing or shrinking, and by how much.
 *
 * The 6M / 12M switch lives HERE rather than in the page header. Everything
 * else on this hub is a fact about the structure right now — a period selector
 * across the whole page would move nothing but this one card while implying it
 * moved all of them, which is the lie Phase E removed from the Time hub.
 *
 * Two curves: people arriving and people leaving. The gap between them IS the
 * net change, which is why they share an axis rather than being drawn as one
 * pre-subtracted line — a flat net line hides a business that replaced forty
 * people in a quarter.
 */
const MONTH_TABS: Array<{ label: string; value: TrendMonths }> = [
  { label: '6M', value: 6 },
  { label: '12M', value: 12 },
];

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
  onMonthsChange: (m: TrendMonths) => void;
  loading?: boolean;
  busy?: boolean;
  failed?: boolean;
}) {
  const t = useTranslations('organizationHub');

  const buckets = growth?.buckets ?? [];
  const series: SplineSeries[] = buckets.length
    ? [
        {
          key: 'joiners',
          values: buckets.map((b) => b.joiners),
          color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
        },
        {
          key: 'leavers',
          values: buckets.map((b) => b.leavers),
          color: 'color-mix(in srgb, var(--color-brand-accent) 75%, white)',
        },
      ]
    : [];

  // Four labels at most, or a twelve-month axis prints a row of stubs.
  const ticks = buckets.length
    ? [0, Math.floor(buckets.length / 3), Math.floor((buckets.length * 2) / 3), buckets.length - 1]
        .filter((v, i, a) => a.indexOf(v) === i)
        .map((i) => buckets[i].label.split(' ')[0])
    : [];

  const net = growth?.netChange ?? 0;
  const pctValue = growth?.growthPct ?? null;
  const up = net >= 0;

  const activeLabel = MONTH_TABS.find((m) => m.value === months)?.label ?? '6M';

  return (
    <div className="surface-panel p-6 rounded-[20px] flex flex-col justify-between h-full">
      <div>
        <div className="flex items-start justify-between gap-3 mb-1">
          <div className="min-w-0">
            <span className="text-[15px] font-bold text-text-heading">{t('workforceGrowth')}</span>
          </div>
          <SegmentedTimeFilter
            options={MONTH_TABS.map((m) => m.label)}
            value={activeLabel}
            onChange={(label) => {
              const found = MONTH_TABS.find((m) => m.label === label);
              if (found) onMonthsChange(found.value);
            }}
          />
        </div>

        <div className="flex items-baseline gap-2.5 mt-2.5 mb-1">
          {failed || !growth ? (
            <span className="text-[28px] font-extrabold text-text-heading leading-none">—</span>
          ) : (
            <>
              <span className="text-[28px] font-extrabold text-text-heading tracking-tight leading-none tabular-nums">
                {net > 0 ? `+${net}` : net}
              </span>
              <span
                className={`inline-flex items-center gap-1 text-xs font-bold ${
                  up ? 'text-status-success' : 'text-status-error'
                }`}
              >
                {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                {/* An unknown growth rate prints nothing rather than 0.0% —
                    a company with nobody in it has no growth rate, it has no
                    denominator. */}
                {pctValue === null ? t('growthUnknown') : `${Math.abs(pctValue).toFixed(1)}%`}
              </span>
            </>
          )}
        </div>

        <p className="text-[11px] text-text-muted leading-snug">
          {failed
            ? t('growthFailed')
            : growth
            ? t('workforceGrowthHint', {
                joiners: buckets.reduce((a, b) => a + b.joiners, 0),
                leavers: buckets.reduce((a, b) => a + b.leavers, 0),
              })
            : ''}
        </p>
      </div>

      <div className={`mt-3 ${busy ? 'opacity-60 transition-opacity' : ''}`}>
        <SplineTrendChart
          height={120}
          series={loading ? undefined : series}
          timeTicks={ticks}
          emptyLabel={failed ? t('growthFailed') : t('noMovement')}
        />
        <div className="flex items-center gap-3 mt-2 text-[11px] font-medium text-text-muted">
          <span className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-xs"
              style={{ background: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)' }}
            />
            {t('joiners')}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-xs"
              style={{ background: 'color-mix(in srgb, var(--color-brand-accent) 75%, white)' }}
            />
            {t('leavers')}
          </span>
        </div>
      </div>
    </div>
  );
}
