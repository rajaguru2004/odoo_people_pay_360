'use client';

import { useTranslations } from 'next-intl';
import {
  PanelHeader,
  PanelLink,
  SegmentedBar,
  type BarSegment,
} from '@/components/module-landing/primitives';
import type { VisaRecord, VisaSummary } from '@/types/visa';

interface VisaRunwayBarProps {
  summary?: VisaSummary;
  /** Documents inside the alert window, used for the sub-week bucket. */
  expiring?: VisaRecord[];
  loading?: boolean;
  unavailable?: boolean;
}

/**
 * The whole permit position as one bar.
 *
 * Compliance is a runway, not a count: what matters is how much time is left
 * on each document, and a table of dates makes the reader do that subtraction
 * themselves. The bands run worst-first so the eye lands on the red end.
 *
 * Every band keeps a minimum width even at one document, because zero is the
 * only acceptable number in the expired band and a band that shrinks below a
 * pixel reads as zero when it is not.
 */
export default function VisaRunwayBar({ summary, expiring, loading, unavailable }: VisaRunwayBarProps) {
  const t = useTranslations('peopleHub');

  if (unavailable) return null;

  if (loading) {
    return (
      <div className="surface-panel p-5 animate-pulse">
        <div className="h-3.5 w-40 rounded bg-surface-border" />
        <div className="mt-8 h-3 w-full rounded-full bg-surface-border/70" />
        <div className="mt-6 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-2.5 w-2/3 rounded bg-surface-border/70" />
          ))}
        </div>
      </div>
    );
  }

  if (!summary) return null;

  // The summary counts "expiring soon" as one bucket; the expiring list carries
  // the days, so the urgent end can be split without another request.
  const critical = (expiring ?? []).filter((v) => v.daysUntilExpiry <= 7).length;
  const soon = Math.max(0, summary.expiringSoon - critical);

  const segments: BarSegment[] = [
    { key: 'expired', label: t('runwayExpired'), value: summary.expired, color: 'var(--color-status-error)' },
    {
      key: 'critical',
      label: t('runwayCritical'),
      value: critical,
      color: 'color-mix(in srgb, var(--color-status-error) 55%, white)',
    },
    {
      key: 'soon',
      label: t('runwaySoon', { days: summary.alertDays }),
      value: soon,
      color: 'var(--color-status-warning)',
    },
    { key: 'valid', label: t('runwayValid'), value: summary.active, color: 'var(--color-status-success)' },
  ];

  const total = segments.reduce((a, s) => a + s.value, 0);
  const withShares = segments.map((s) => ({
    ...s,
    shareLabel: total > 0 ? `${Math.round((s.value / total) * 100)}%` : '—',
  }));

  return (
    <div className="surface-panel p-5 flex flex-col">
      <PanelHeader
        title={t('visaRunway')}
        hint={t('visaRunwayHint')}
        action={<PanelLink href="/dashboard/visa-reports">{t('seeVisaReports')}</PanelLink>}
      />

      {total === 0 ? (
        <p className="text-[13px] text-text-muted">{t('noVisaRecords')}</p>
      ) : (
        <>
          {/* Centred for the same reason the turnout ring is: the list beside
              it sets the row height. */}
          <div className="flex-1 flex flex-col justify-center">
            <SegmentedBar segments={withShares} height={12} legendColumns={2} />
          </div>
          {summary.renewedThisYear > 0 && (
            <p className="mt-5 pt-4 border-t border-surface-border text-[12px] text-text-muted">
              {t('renewedThisYear', { count: summary.renewedThisYear })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
