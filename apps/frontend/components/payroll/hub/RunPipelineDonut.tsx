'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRight } from 'lucide-react';
import {
  DonutChart,
  DonutLegend,
  PanelHeader,
  PanelLink,
  type DonutSlice,
} from '@/components/module-landing/primitives';
import { PAYROLL_RUN_STATUSES, type PayrollHubSummary } from '@/types/payrollHub';

/**
 * Where every payroll run in the window is stuck, and what is waiting right now.
 *
 * The ring leads on runs still IN PROGRESS rather than on the total, because a
 * locked run is finished business and an open one is the work.
 *
 * All five `PayrollStatus` values are drawn. The two the old hub had no label
 * for, REJECTED and LOCKED, are the two that matter most at the ends of the
 * pipeline: one is work that came back, the other is money that has moved.
 *
 * Below the ring is the **queue**, which the KPI row used to carry. Two things
 * make it a different figure from the ring above it and the panel says both:
 * the queue is UNWINDOWED — an open run from four months ago is exactly the one
 * somebody needs to be told about, and a six-month window would eventually hide
 * it — and every line is a link, so a run that is stuck is one click from the
 * screen that unsticks it rather than a number the reader has to go and hunt.
 */

const TONES: Record<string, string> = {
  DRAFT: 'var(--color-text-muted)',
  PENDING_APPROVAL: 'var(--color-status-warning)',
  APPROVED: 'var(--color-status-info)',
  REJECTED: 'var(--color-status-error)',
  LOCKED: 'var(--color-status-success)',
};

export default function RunPipelineDonut({
  runs,
  periodLabel,
  /** Days a run may sit unapproved before the queue stops being routine. */
  staleApprovalDays = 3,
  oldestPendingDays = null,
  loading = false,
  failed = false,
}: {
  runs?: PayrollHubSummary['runs'];
  /** The window the counts cover, so the panel never implies "all time". */
  periodLabel?: string;
  staleApprovalDays?: number;
  oldestPendingDays?: number | null;
  loading?: boolean;
  failed?: boolean;
}) {
  const t = useTranslations('payrollHub');

  /**
   * The unwindowed queue: what is waiting for somebody NOW.
   *
   * Count-gated line by line, so an empty queue is a genuine all-clear rather
   * than four zeros the reader has to scan past. Each line links to the screen
   * that clears it — approvals for a decision, manage for a draft or a lock.
   */
  const queue = runs
    ? [
        {
          key: 'pendingApproval',
          label: t('status.PENDING_APPROVAL'),
          value: runs.pendingApproval,
          href: '/dashboard/payroll/approvals',
          tone:
            oldestPendingDays !== null && oldestPendingDays >= staleApprovalDays
              ? 'text-status-error'
              : 'text-status-warning',
          hint:
            oldestPendingDays === null
              ? undefined
              : t('kpiPendingApprovalOldest', { days: oldestPendingDays }),
        },
        {
          key: 'approvedNotLocked',
          label: t('status.APPROVED'),
          value: runs.approvedNotLocked,
          href: '/dashboard/payroll/manage',
          tone: 'text-status-info',
          hint: t('queueToLock'),
        },
        {
          key: 'draft',
          label: t('status.DRAFT'),
          value: runs.draft,
          href: '/dashboard/payroll/manage',
          tone: 'text-text-muted',
          hint:
            runs.draftForClosedPeriod > 0
              ? t('queueDraftClosed', { count: runs.draftForClosedPeriod })
              : undefined,
        },
        {
          key: 'rejected',
          label: t('status.REJECTED'),
          value: runs.rejected,
          href: '/dashboard/payroll/manage',
          tone: 'text-status-error',
          hint: t('attnNeedsCorrection'),
        },
      ].filter((r) => r.value > 0)
    : [];

  const slices: DonutSlice[] = runs
    ? PAYROLL_RUN_STATUSES.map((status) => ({
        key: status,
        label: t(`status.${status}` as never),
        value: runs.windowByStatus[status] ?? 0,
        color: TONES[status],
      })).filter((s) => s.value > 0)
    : [];

  const total = slices.reduce((a, s) => a + s.value, 0);
  const open = runs
    ? (runs.windowByStatus.DRAFT ?? 0) +
      (runs.windowByStatus.PENDING_APPROVAL ?? 0) +
      (runs.windowByStatus.APPROVED ?? 0)
    : 0;

  return (
    <div className="surface-panel p-6 rounded-[20px] flex flex-col h-full">
      <PanelHeader
        title={t('pipeline')}
        hint={periodLabel ? t('pipelineHint', { period: periodLabel }) : undefined}
        action={<PanelLink href="/dashboard/payroll/manage">{t('seeRuns')}</PanelLink>}
      />

      {loading ? (
        <div className="flex-1 flex items-center justify-center py-6">
          <div className="h-[150px] w-[150px] rounded-full bg-surface-page animate-pulse" />
        </div>
      ) : failed ? (
        // Never an all-clear over a question that was never answered.
        <p className="flex-1 grid place-items-center text-[13px] text-text-muted">
          {t('pipelineUnknown')}
        </p>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          {total === 0 ? (
            // No run in the WINDOW. The queue below can still be non-empty — an
            // open run older than the window is the whole reason it exists.
            <p className="flex-1 grid place-items-center text-[13px] text-text-muted py-6">
              {t('pipelineEmpty')}
            </p>
          ) : (
            <>
              <DonutChart
                slices={slices}
                size={150}
                thickness={20}
                caption={String(open)}
                subCaption={t('pipelineOpen')}
              />
              <div className="w-full">
                <DonutLegend slices={slices} total={total} />
              </div>
            </>
          )}

          {/* The queue — unwindowed, and said so, because it is a different
              question from the ring above it. */}
          <div className="w-full pt-3 mt-1 border-t border-surface-border">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              {t('queueNow')}
            </p>
            {queue.length === 0 ? (
              <p className="mt-1.5 text-[12px] text-text-muted">{t('queueClear')}</p>
            ) : (
              <div className="mt-1.5 space-y-1">
                {queue.map((row) => (
                  <Link
                    key={row.key}
                    href={row.href}
                    data-testid={`payroll-queue-${row.key}`}
                    className="group flex items-center gap-2 rounded-lg -mx-1.5 px-1.5 py-1 hover:bg-surface-page transition-colors"
                  >
                    <span className="min-w-0">
                      <span className="block text-[13px] font-semibold text-text-heading group-hover:text-brand-primary transition-colors truncate">
                        {row.label}
                      </span>
                      {row.hint && (
                        <span className="block text-[11px] text-text-muted truncate">
                          {row.hint}
                        </span>
                      )}
                    </span>
                    <span className="ms-auto flex items-center gap-1 shrink-0">
                      <span className={`text-[15px] font-extrabold tabular-nums ${row.tone}`}>
                        {row.value}
                      </span>
                      <ChevronRight
                        size={14}
                        className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity rtl:rotate-180"
                      />
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
