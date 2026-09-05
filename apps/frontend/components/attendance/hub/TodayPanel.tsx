'use client';

import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { PanelHeader, PanelLink } from '@/components/module-landing/primitives';
import { formatHours, formatRate } from '../attendanceFormat';
import { formatDateOnly } from '@/utils/formatDate';
import type { HubDaySnapshot } from '@/types/attendanceHub';

function Figure({
  label,
  value,
  tone = 'text-text-heading',
}: {
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </p>
      <p className={`truncate text-[18px] font-bold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

/**
 * Right now, whatever window the rest of the page is reporting.
 *
 * Deliberately not period-scoped: the cards above answer "how did August go",
 * and this answers "who is in the building", which is the question somebody
 * standing at a desk is actually asking.
 *
 * An unsettled day says so. Before the branch's office day has ended an absence
 * count is a PREDICTION — the person may still be on their way — and printing
 * it as a fact is how a dashboard gets someone marked absent at 09:05.
 */
export default function TodayPanel({
  today,
  yesterday,
}: {
  today?: HubDaySnapshot;
  yesterday?: HubDaySnapshot;
}) {
  if (!today) {
    return (
      <div className="surface-panel h-full animate-pulse rounded-[20px] p-6">
        <div className="h-4 w-32 rounded bg-surface-border" />
      </div>
    );
  }

  const provisional = !today.settled;

  return (
    <div className="surface-panel flex h-full flex-col justify-between rounded-[20px] p-6">
      <div>
        <PanelHeader
          title="On the floor today"
          hint={`${formatDateOnly(today.date)} · ${today.present} of ${today.expected} expected`}
          action={<PanelLink href="/dashboard/attendance">Board</PanelLink>}
        />

        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Figure label="Present" value={today.present} tone="text-status-success" />
          <Figure label="Late" value={today.late} tone="text-status-warning" />
          <Figure
            label={provisional ? 'Absent so far' : 'Absent'}
            value={today.absent}
            tone="text-status-error"
          />
          <Figure label="On leave" value={today.onLeave} tone="text-status-info" />
          <Figure label="Still in" value={today.notCheckedOut} />
          <Figure label="Avg hours" value={formatHours(today.avgWorkHours)} />
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {provisional && (
          <p className="flex items-start gap-2 rounded-xl border border-status-warning/30 bg-status-warning-bg px-3 py-2 text-[11px] font-semibold leading-snug text-status-warning">
            <AlertCircle size={14} className="mt-px shrink-0" aria-hidden />
            <span>
              Provisional — the office day has not ended, so {today.notCheckedIn} of these are
              people who have not arrived yet rather than people who are absent.
            </span>
          </p>
        )}

        <p className="text-[11px] leading-snug text-text-muted">
          Turnout {formatRate(today.presentRate)}
          {yesterday ? ` · yesterday ${formatRate(yesterday.presentRate)}` : ''}
        </p>

        <Link
          href="/dashboard/attendance"
          className="inline-block text-[12px] font-semibold text-brand-primary hover:underline"
        >
          Who is in, and who is not
        </Link>
      </div>
    </div>
  );
}
