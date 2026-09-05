'use client';

import { useTranslations } from 'next-intl';
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
 * Drawn as one bar of two parts rather than a second line chart: the main panel
 * on this hub already draws the trend over time, and repeating the same shape
 * in a third of the width would say nothing new. What this adds is the RATIO —
 * eighteen in against six out reads very differently from eighteen against
 * seventeen, and a net of +1 hides both.
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
  const t = useTranslations('peopleHub');

  const buckets = summary?.trend.buckets ?? [];
  const joiners = buckets.reduce((a, b) => a + b.joiners, 0);
  const leavers = buckets.reduce((a, b) => a + b.leavers, 0);
  const net = summary?.trend.netChange ?? 0;
  const turnover = summary?.trend.turnoverRate ?? null;
  const up = net >= 0;

  const segments: BarSegment[] = [
    {
      key: 'joiners',
      label: t('joiners'),
      value: joiners,
      color: 'var(--color-status-success)',
    },
    {
      key: 'leavers',
      label: t('leavers'),
      value: leavers,
      color: 'var(--color-status-warning)',
    },
  ];

  return (
    <div className="surface-panel p-6 rounded-[20px] flex flex-col justify-between h-full">
      <div>
        <PanelHeader
          title={t('headcountMovement')}
          hint={
            summary
              ? t('headcountMovementHint', { months: summary.trend.months })
              : undefined
          }
          action={
            <PanelLink href="/dashboard/contracts/terminations">{t('seeTerminations')}</PanelLink>
          }
        />

        <div className="flex items-baseline gap-2.5 my-2">
          {failed || !summary ? (
            <span className="text-[28px] font-extrabold text-text-heading leading-none">—</span>
          ) : (
            <>
              <span className="text-[28px] font-extrabold text-text-heading tracking-tight leading-none tabular-nums">
                {net > 0 ? `+${net}` : net}
              </span>
              {/* The arrow belongs to the NET, and has to sit against it. Put
                  next to the turnover figure it read as "turnover up 0.0%",
                  which is a claim about a direction nothing here measured. */}
              <span
                className={`inline-flex items-center gap-0.5 text-xs font-bold ${
                  up ? 'text-status-success' : 'text-status-error'
                }`}
              >
                {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                {t('netChange')}
              </span>
              <span className="text-xs font-semibold text-text-muted">
                {/* An unknown turnover rate prints nothing rather than 0.0%:
                    a company with no opening headcount has no rate, it has no
                    denominator. */}
                {turnover === null
                  ? t('turnoverUnknown')
                  : t('turnoverRate', { rate: turnover.toFixed(1) })}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="h-4 rounded-full bg-surface-page animate-pulse" />
        ) : joiners + leavers === 0 ? (
          <p className="text-[13px] text-text-muted">{t('noMovement')}</p>
        ) : (
          <SegmentedBar segments={segments} height={14} />
        )}
      </div>
    </div>
  );
}
