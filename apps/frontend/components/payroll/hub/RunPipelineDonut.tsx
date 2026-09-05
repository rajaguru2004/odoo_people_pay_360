'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import {
  DonutChart,
  DonutLegend,
  PanelHeader,
  PanelLink,
  type DonutSlice,
} from '@/components/module-landing/primitives';
import { RUN_STATUSES, runStatusColour, runStatusLabel } from '../RunStatusBadge';
import type { PayrollHubSummary } from '@/types/payrollHub';

/**
 * Where every payroll run is, and what is waiting right now.
 *
 * The ring leads on runs still OPEN rather than on the total, because a paid run
 * is finished business and an open one is the work. All five statuses are drawn:
 * the two at the ends of the pipeline — CANCELLED and PAID — are the two a count
 * of "runs" would quietly merge into everything else.
 *
 * Below the ring is the **queue**, and every line is a link, so a run that is
 * stuck is one click from the screen that unsticks it rather than a number the
 * reader has to go and hunt for.
 */

/** Days a run may sit calculated before the queue stops being routine. */
export const STALE_APPROVAL_DAYS = 3;

/** An instant, not a date-only value — `Date` is the right reader here. */
export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

export default function RunPipelineDonut({
  runs,
  periodLabel,
  staleApprovalDays = STALE_APPROVAL_DAYS,
  loading = false,
  failed = false,
}: {
  runs?: PayrollHubSummary['runs'];
  periodLabel?: string;
  staleApprovalDays?: number;
  loading?: boolean;
  failed?: boolean;
}) {
  const byStatus = runs?.byStatus;
  const oldest = runs?.oldestAwaitingApproval ?? null;
  const oldestDays = daysSince(oldest?.calculatedAt);

  const slices: DonutSlice[] = byStatus
    ? RUN_STATUSES.map((status) => ({
        key: status,
        label: runStatusLabel(status),
        value: byStatus[status] ?? 0,
        color: runStatusColour(status),
      })).filter((slice) => slice.value > 0)
    : [];

  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const open = byStatus
    ? (byStatus.DRAFT ?? 0) + (byStatus.CALCULATED ?? 0) + (byStatus.APPROVED ?? 0)
    : 0;

  /**
   * What is waiting for somebody NOW.
   *
   * Count-gated line by line, so an empty queue is a genuine all-clear rather
   * than three zeros the reader has to scan past.
   */
  const queue = byStatus
    ? [
        {
          key: 'calculated',
          label: 'Waiting for approval',
          value: byStatus.CALCULATED ?? 0,
          href: '/dashboard/payroll/runs?status=CALCULATED',
          tone:
            oldestDays !== null && oldestDays >= staleApprovalDays
              ? 'text-status-error'
              : 'text-status-warning',
          hint:
            oldest === null
              ? undefined
              : oldestDays === null
                ? `Oldest: ${oldest.label}`
                : `${oldest.label}, waiting ${oldestDays} day${oldestDays === 1 ? '' : 's'}`,
        },
        {
          key: 'approved',
          label: 'Approved, not paid',
          value: byStatus.APPROVED ?? 0,
          href: '/dashboard/payroll/runs?status=APPROVED',
          tone: 'text-status-info',
          hint: 'Ready to be marked paid.',
        },
        {
          key: 'draft',
          label: 'Draft',
          value: byStatus.DRAFT ?? 0,
          href: '/dashboard/payroll/runs?status=DRAFT',
          tone: 'text-text-muted',
          hint: 'Opened but not calculated.',
        },
      ].filter((row) => row.value > 0)
    : [];

  return (
    <div className="surface-panel flex h-full flex-col rounded-[20px] p-6">
      <PanelHeader
        title="Run pipeline"
        hint={periodLabel ? `Every run in ${periodLabel}.` : undefined}
        action={<PanelLink href="/dashboard/payroll/runs">See runs</PanelLink>}
      />

      {loading ? (
        <div className="flex flex-1 items-center justify-center py-6">
          <div className="h-[150px] w-[150px] animate-pulse rounded-full bg-surface-page" />
        </div>
      ) : failed ? (
        // Never an all-clear over a question that was never answered.
        <p className="grid flex-1 place-items-center text-[13px] text-text-muted">
          The pipeline could not be read.
        </p>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          {total === 0 ? (
            <p className="grid flex-1 place-items-center py-6 text-[13px] text-text-muted">
              No payroll run has been opened yet.
            </p>
          ) : (
            <>
              <DonutChart
                slices={slices}
                size={150}
                thickness={20}
                caption={String(open)}
                subCaption="still open"
              />
              <div className="w-full">
                <DonutLegend slices={slices} total={total} />
              </div>
            </>
          )}

          <div className="mt-1 w-full border-t border-surface-border pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Waiting now
            </p>
            {queue.length === 0 ? (
              <p className="mt-1.5 text-[12px] text-text-muted">Nothing is waiting on anybody.</p>
            ) : (
              <div className="mt-1.5 space-y-1">
                {queue.map((row) => (
                  <Link
                    key={row.key}
                    href={row.href}
                    data-testid={`payroll-queue-${row.key}`}
                    className="group -mx-1.5 flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-surface-page"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold text-text-heading transition-colors group-hover:text-brand-primary">
                        {row.label}
                      </span>
                      {row.hint && (
                        <span className="block truncate text-[11px] text-text-muted">
                          {row.hint}
                        </span>
                      )}
                    </span>
                    <span className="ms-auto flex shrink-0 items-center gap-1">
                      <span className={`text-[15px] font-extrabold tabular-nums ${row.tone}`}>
                        {row.value}
                      </span>
                      <ChevronRight
                        size={14}
                        aria-hidden
                        className="text-text-muted opacity-0 transition-opacity group-hover:opacity-100 rtl:rotate-180"
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
