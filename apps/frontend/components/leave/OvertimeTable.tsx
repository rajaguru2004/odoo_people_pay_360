'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/common/EmptyState';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import { cn } from '@/utils/cn';
import { formatHours, formatOvertimeWindow } from '@/utils/overtimeCalc';
import {
  DAY_TYPE_LABEL,
  DAY_TYPE_TONE,
  OT_TYPE_LABEL,
  STATUS_TONE,
  statusLabel,
} from './leaveFormat';
import type { OvertimeRequest } from '@/types/overtime';

/**
 * The one table every overtime list draws.
 *
 * The window is rendered through `formatOvertimeWindow`, which reads the stored
 * instants in UTC. They are wall clocks tagged UTC, so a browser reading them in
 * its own zone would show an Omani 17:30 as 21:30 in Muscat and 13:30 in London
 * — three answers to what one employee typed.
 *
 * The hours column shows the PAYABLE total, which can be less than the window:
 * the attendance day boundary clamps a shift somebody forgot to close.
 */
export default function OvertimeTable({
  rows,
  loading = false,
  showEmployee = true,
  emptyTitle = 'No overtime recorded',
  emptyDescription,
  emptyAction,
}: {
  rows: OvertimeRequest[];
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
      <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-surface-border-light">
            {showEmployee && <Th>Employee</Th>}
            <Th>Date</Th>
            <Th>Worked</Th>
            <Th align="end">Payable</Th>
            <Th>Tier</Th>
            <Th>Reason</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-surface-border-light last:border-0 hover:bg-surface-page/60"
            >
              {showEmployee && (
                <td className="px-4 py-3">
                  <Link
                    href={`/dashboard/overtime/${row.id}`}
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
              <td className="px-4 py-3 text-text-body">
                <Link
                  href={`/dashboard/overtime/${row.id}`}
                  className="hover:text-brand-primary"
                >
                  {formatDateOnly(row.date)}
                </Link>
              </td>
              <td className="px-4 py-3 tabular-nums text-text-body">
                {formatOvertimeWindow(row.startTime, row.endTime)}
              </td>
              <td className="px-4 py-3 text-end font-medium tabular-nums text-text-heading">
                {formatHours(row.hours)}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={DAY_TYPE_TONE[row.dayType]}>
                    {DAY_TYPE_LABEL[row.dayType]}
                  </Badge>
                  <span className="text-xs text-text-muted">
                    {OT_TYPE_LABEL[row.otType]}
                  </span>
                </div>
              </td>
              <td className="max-w-[240px] truncate px-4 py-3 text-text-muted" title={row.reason}>
                {row.reason}
              </td>
              <td className="px-4 py-3">
                <Badge tone={STATUS_TONE[row.status]}>{statusLabel(row.status)}</Badge>
                {/* An edited request says so in the list, not only on the detail
                    page: the hours here are the approver's, not the employee's. */}
                {row.editedAt && (
                  <p className="mt-1 text-xs text-text-muted">edited by the approver</p>
                )}
              </td>
            </tr>
          ))}
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
