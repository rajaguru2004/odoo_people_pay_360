'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/common/EmptyState';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import { cn } from '@/utils/cn';
import { STATUS_TONE, daysWaiting, statusLabel } from './leaveFormat';
import type { LeaveRequest } from '@/types/leave';

/**
 * The one table every leave list draws.
 *
 * Four screens show leave requests — all of them, the queue, one employee's, and
 * the caller's own — and the difference between them is which rows arrive, not
 * how a row looks. Four copies of this markup is four chances for the status
 * column to mean something different on one of them.
 *
 * Dates go through `formatDateOnly`. A leave date has no time of day, and an
 * instant parse lands `2026-01-15` on the 14th anywhere west of Greenwich.
 */
export default function LeaveRequestTable({
  rows,
  loading = false,
  /** Off on a personal list, where every row is the reader. */
  showEmployee = true,
  emptyTitle = 'No leave requests',
  emptyDescription,
  emptyAction,
}: {
  rows: LeaveRequest[];
  loading?: boolean;
  showEmployee?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
}) {
  if (loading) {
    return (
      <div className="space-y-2 p-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-border/60" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
      />
    );
  }

  return (
    // Scrolls INSIDE its own container: a wide table that widens the page pushes
    // the sidebar off screen on a laptop.
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-surface-border-light text-start">
            {showEmployee && <Th>Employee</Th>}
            <Th>Type</Th>
            <Th>Dates</Th>
            <Th align="end">Days</Th>
            <Th>Reason</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const waiting = row.status === 'PENDING' ? daysWaiting(row.createdAt) : 0;
            return (
              <tr
                key={row.id}
                className="border-b border-surface-border-light last:border-0 hover:bg-surface-page/60"
              >
                {showEmployee && (
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/leaves/${row.id}`}
                      className="font-medium text-text-heading hover:text-brand-primary"
                    >
                      {row.employee ? fullName(row.employee) : '—'}
                    </Link>
                    <p className="text-xs text-text-muted">
                      {row.employee?.employeeCode ?? ''}
                      {row.employee?.department ? ` · ${row.employee.department.name}` : ''}
                    </p>
                  </td>
                )}
                <td className="px-4 py-3 text-text-body">{row.leaveType}</td>
                <td className="px-4 py-3 text-text-body">
                  <Link
                    href={`/dashboard/leaves/${row.id}`}
                    className="hover:text-brand-primary"
                  >
                    {formatDateOnly(row.startDate)} – {formatDateOnly(row.endDate)}
                  </Link>
                </td>
                <td className="px-4 py-3 text-end font-medium tabular-nums text-text-heading">
                  {row.totalDays}
                </td>
                <td className="max-w-[280px] truncate px-4 py-3 text-text-muted" title={row.reason}>
                  {row.reason}
                </td>
                <td className="px-4 py-3">
                  <Badge tone={STATUS_TONE[row.status]}>{statusLabel(row.status)}</Badge>
                  {/* Two days is the point at which an approval stops being
                      "not yet" and starts being "forgotten". */}
                  {waiting >= 2 && (
                    <p className="mt-1 text-xs text-status-warning">
                      waiting {waiting} days
                    </p>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  align = 'start',
}: {
  children: React.ReactNode;
  align?: 'start' | 'end';
}) {
  return (
    // Written out rather than interpolated: Tailwind scans source text, so a
    // class built from a variable is never generated and the column silently
    // keeps the default alignment.
    <th
      scope="col"
      className={cn(
        'px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted',
        align === 'end' ? 'text-end' : 'text-start',
      )}
    >
      {children}
    </th>
  );
}
