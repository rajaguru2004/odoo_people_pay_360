'use client';

import { useTranslations } from 'next-intl';
import {
  MeterList,
  PanelHeader,
  PanelLink,
  type MeterRow,
} from '@/components/module-landing/primitives';
import type { PeopleHubSummary } from '@/types/peopleHub';
import { daysUntil } from '@/hooks/usePeopleHub';

/**
 * What is about to happen to somebody, soonest first.
 *
 * The bar length is **time remaining**, not a quantity. A start date four days
 * out is a different job from one four weeks out, and a bar drawn from a count
 * would say nothing at all here — every row is exactly one person.
 *
 * Joiners, contract expiries, probation endings and terminations share one
 * list because a reader chasing paperwork does not care which table a date came
 * out of; they care which one is closest.
 */
const WINDOW_DAYS = 30;

type Kind = 'joining' | 'contract' | 'probation';

const KIND_COLOR: Record<Kind, string> = {
  joining: 'var(--color-brand-primary)',
  contract: 'var(--color-status-warning)',
  probation: 'var(--color-status-error)',
};

export default function LifecyclePanel({
  summary,
  loading = false,
  failed = false,
  limit = 7,
}: {
  summary?: PeopleHubSummary;
  loading?: boolean;
  failed?: boolean;
  limit?: number;
}) {
  const t = useTranslations('peopleHub');

  type Event = { key: string; name: string; days: number; kind: Kind };
  const events: Event[] = [];

  for (const e of summary?.lifecycle.startingSoon ?? []) {
    const days = daysUntil(e.startDate);
    if (days === null) continue;
    events.push({
      key: `join-${e.id}`,
      name: e.department ? `${e.fullName} · ${e.department}` : e.fullName,
      days,
      kind: 'joining',
    });
  }
  for (const c of summary?.contracts.expiring ?? []) {
    events.push({
      key: `contract-${c.id}`,
      name: c.fullName ?? t('unnamedEmployee'),
      days: c.daysUntilExpiry,
      kind: 'contract',
    });
  }
  for (const p of summary?.lifecycle.probationEndingSoon ?? []) {
    const days = daysUntil(p.endDate);
    if (days === null) continue;
    events.push({
      key: `probation-${p.contractId}`,
      name: p.fullName ?? t('unnamedEmployee'),
      days,
      kind: 'probation',
    });
  }

  events.sort((a, b) => a.days - b.days);

  const rows: MeterRow[] = events.slice(0, limit).map((e) => ({
    key: e.key,
    label: `${t(`lifecycleKind.${e.kind}`)} · ${e.name}`,
    // Full track = due now, empty = the far edge of the window. Clamped, so a
    // date beyond the window still draws something rather than a negative bar.
    percent: Math.max(4, Math.min(100, ((WINDOW_DAYS - e.days) / WINDOW_DAYS) * 100)),
    valueLabel:
      e.days < 0
        ? t('overdueDays', { days: Math.abs(e.days) })
        : e.days === 0
        ? t('dueToday')
        : t('inDays', { days: e.days }),
    color: e.days <= 7 ? 'var(--color-status-error)' : KIND_COLOR[e.kind],
  }));

  return (
    <div className="surface-panel p-6 rounded-[20px] flex flex-col h-full">
      <PanelHeader
        title={t('employeeLifecycle')}
        hint={
          summary && summary.terminations.awaitingApproval > 0
            ? t('lifecycleHintWithTerminations', {
                count: summary.terminations.awaitingApproval,
              })
            : t('lifecycleHint')
        }
        action={<PanelLink href="/dashboard/contracts">{t('seeContracts')}</PanelLink>}
      />

      {loading ? (
        <div className="flex-1 space-y-3 pt-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-8 rounded-lg bg-surface-page animate-pulse" />
          ))}
        </div>
      ) : failed ? (
        <p className="text-[13px] text-text-muted py-8">{t('chartUnavailable')}</p>
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-text-muted py-8">{t('nothingDue')}</p>
      ) : (
        <div className="flex-1 flex flex-col justify-center">
          <MeterList rows={rows} trackHeight={12} />
          {events.length > rows.length && (
            <p className="mt-3 text-[11px] text-text-muted">
              {t('andMoreDue', { count: events.length - rows.length })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
