'use client';

import { useTranslations } from 'next-intl';
import { DonutChart, DonutLegend, PanelHeader, type DonutSlice } from '@/components/module-landing/primitives';

interface PresenceRingProps {
  /** Everyone who clocked in — the late ones are a SUBSET of this. */
  present: number;
  late: number;
  absent: number;
  /** Expected today but nothing heard yet, and the day has not closed. */
  notCheckedIn: number;
  onLeave?: number;
  /** Which window these numbers cover — shown in the panel title. */
  title?: string;
  /** True while the ring is reporting a day still in progress. */
  live?: boolean;
  /**
   * The denominator: employees the calendar expected today, not headcount.
   * Dividing by headcount would report mass absence every weekend.
   */
  total: number;
  loading?: boolean;
}

/**
 * The whole workforce as one ring.
 *
 * A stacked bar would answer the same question and be read more slowly: the
 * question here is "how much of the company turned up", which is a proportion
 * of a whole, and a ring is a whole. The arcs run in the order a day produces
 * them — on time, late, on leave, absent, still nothing heard.
 *
 * It follows the period selector like everything else on the page, so over a
 * month the counts are employee-DAYS. The caption says which window it is
 * reading, because "82%" with no window attached is not an answer.
 */
export default function PresenceRing({
  present,
  late,
  absent,
  notCheckedIn,
  onLeave = 0,
  total,
  title,
  live = true,
  loading = false,
}: PresenceRingProps) {
  const t = useTranslations('timeHub');

  if (loading) {
    return (
      <div className="surface-panel p-5 h-[320px] animate-pulse rounded-[20px]">
        <div className="h-3.5 w-32 rounded bg-surface-border" />
        <div className="mt-8 mx-auto h-[180px] w-[180px] rounded-full bg-surface-border/70" />
      </div>
    );
  }

  const safeTotal = Math.max(total, 1);

  // On-time is derived, not fetched: `present` counts everyone who clocked in,
  // and the late ones are a subset of it. Drawing both raw would double-count.
  const onTime = Math.max(0, present - late);

  const slices: DonutSlice[] = [
    { key: 'onTime', label: t('onTime'), value: onTime, color: 'var(--color-status-success)' },
    // Title-case legend keys, not the sentence fragments the attention strip
    // uses ("late", "absent") — a legend is a label, not the end of a phrase.
    { key: 'late', label: t('legendLate'), value: late, color: 'var(--color-status-warning)' },
    { key: 'absent', label: t('legendAbsent'), value: absent, color: 'var(--color-status-error)' },
    {
      key: 'onLeave',
      label: t('onLeave'),
      value: Math.max(0, onLeave),
      color: 'var(--color-status-info)',
    },
    {
      key: 'notCheckedIn',
      label: t('noShow'),
      value: Math.max(0, notCheckedIn),
      color: 'color-mix(in srgb, var(--color-text-muted) 40%, white)',
    },
  ];

  // Turnout against what the calendar EXPECTED, which is the same denominator
  // every other rate on this page uses. `total` of 0 means nobody was expected
  // (a company-wide holiday) — the ring then reads 0%, not a divide by zero.
  const turnout = total > 0 ? Math.round((present / safeTotal) * 100) : 0;

  return (
    <div className="surface-panel p-6 rounded-[20px] flex flex-col justify-between">
      <PanelHeader
        title={title ?? t('turnout')}
        action={
          // The pulsing dot is a claim that the number is moving. It only
          // appears while the window actually contains a day in progress —
          // last July is not live, and saying so would be theatre.
          live ? (
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-text-muted">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-success opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-status-success" />
              </span>
              {t('live')}
            </span>
          ) : undefined
        }
      />

      <div className="flex-1 flex flex-col sm:flex-row items-center gap-6 my-auto pt-2">
        <DonutChart
          slices={slices}
          size={175}
          thickness={22}
          caption={`${turnout}%`}
          subCaption={t('ofHeadcount', { present, total })}
        />
        <div className="flex-1 w-full min-w-0">
          <DonutLegend slices={slices} total={safeTotal} />
        </div>
      </div>
    </div>
  );
}
