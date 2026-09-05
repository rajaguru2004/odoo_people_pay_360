'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle, Clock, Plus, XCircle } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useMyOvertimeRequests } from '@/hooks/useOvertime';
import { useBrandingStore } from '@/store/brandingStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import {
  OVERTIME_STATUS_TONE,
  formatOvertimeHours,
  formatWallClockRange,
  otTypeLabel,
  otTypeTone,
  overtimeStatusLabel,
} from '@/components/overtime/overtimeFormat';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import { formatCurrency } from '@/utils/formatters';
import type { Overtime, OvertimeStatus } from '@/types/overtime';

/**
 * One wide read rather than a paged one.
 *
 * The counters above the table describe the whole history — "8 approved" has to
 * mean eight, not eight on this page — and one person's own claims are a short
 * list. Paging here would make every figure on the screen a per-page figure.
 */
const FETCH_LIMIT = 1000;

type Filter = 'all' | OvertimeStatus;

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
];

/**
 * What the employee has claimed, and what has been settled.
 *
 * The month's approved hours count only APPROVED rows: a pending claim is a
 * request, not an entitlement, and adding it here would have people budgeting
 * against hours nobody has agreed to pay.
 */
function summarise(rows: Overtime[]) {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();

  const thisMonth = rows.filter((row) => {
    // The overtime date is date-only, so it is sliced rather than parsed: an
    // instant parse puts the 1st of a month into the previous one west of
    // Greenwich, and the month's total would quietly lose a day's claims.
    const [rowYear, rowMonth] = row.date.slice(0, 10).split('-').map(Number);
    return rowMonth - 1 === month && rowYear === year;
  });

  return {
    total: rows.length,
    pending: rows.filter((row) => row.status === 'PENDING').length,
    approved: rows.filter((row) => row.status === 'APPROVED').length,
    rejected: rows.filter((row) => row.status === 'REJECTED').length,
    monthHours: thisMonth
      .filter((row) => row.status === 'APPROVED')
      .reduce((sum, row) => sum + (Number(row.hours) || 0), 0),
  };
}

function MyOvertime() {
  const [filter, setFilter] = useState<Filter>('all');
  const currency = useBrandingStore((state) => state.branding.default_currency);

  const { data, isLoading, isError, error } = useMyOvertimeRequests({
    page: 1,
    limit: FETCH_LIMIT,
  });
  const rows = useMemo(() => data?.data ?? [], [data]);

  const stats = useMemo(() => summarise(rows), [rows]);
  const visible = useMemo(
    () => (filter === 'all' ? rows : rows.filter((row) => row.status === filter)),
    [rows, filter],
  );

  usePageHeader('My overtime', `${stats.pending} waiting on a decision`);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-3">
        {/* A link rather than a Button: this navigates, and a control that
            navigates has to be openable in a new tab and readable as a link. */}
        <Link
          href="/dashboard/overtime/new"
          data-testid="my-ot-new"
          className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-button)] bg-brand-primary px-4 text-sm font-medium text-text-on-brand transition-colors hover:bg-brand-primary-dark"
        >
          <Plus className="h-4 w-4" aria-hidden />
          File overtime
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Requests" value={stats.total} hint="All time" />
        <StatCard
          label="Pending"
          value={stats.pending}
          icon={<AlertCircle className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Approved"
          value={stats.approved}
          icon={<CheckCircle className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Rejected"
          value={stats.rejected}
          icon={<XCircle className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Approved hours"
          value={formatOvertimeHours(stats.monthHours)}
          hint="This month"
          icon={<Clock className="h-5 w-5" aria-hidden />}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((entry) => {
          const active = filter === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              data-testid="my-ot-filter"
              data-key={entry.key}
              aria-pressed={active}
              onClick={() => setFilter(entry.key)}
              className={`rounded-[var(--radius-button)] border px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? 'border-brand-primary bg-brand-primary text-text-on-brand'
                  : 'border-surface-border bg-surface-card text-text-body hover:bg-surface-border-light'
              }`}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      <Card>
        {isLoading && <p className="p-6 text-sm text-text-muted">Loading your claims…</p>}

        {isError && (
          <p className="p-6 text-sm text-status-error">
            {apiErrorMessage(error, 'Could not load your overtime.')}
          </p>
        )}

        {!isLoading && !isError && visible.length === 0 && (
          <div data-testid="my-ot-empty">
            <EmptyState
              icon={<Clock className="h-6 w-6" aria-hidden />}
              title={filter === 'all' ? 'No overtime filed yet' : 'Nothing with that standing'}
              description={
                filter === 'all'
                  ? 'File a claim for the hours you worked past your shift.'
                  : 'Try another filter.'
              }
              action={
                filter === 'all' ? (
                  <Link
                    href="/dashboard/overtime/new"
                    className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-button)] bg-brand-primary px-4 text-sm font-medium text-text-on-brand transition-colors hover:bg-brand-primary-dark"
                  >
                    <Plus className="h-4 w-4" aria-hidden />
                    File overtime
                  </Link>
                ) : (
                  <Button variant="outline" onClick={() => setFilter('all')}>
                    Show all
                  </Button>
                )
              }
            />
          </div>
        )}

        {visible.length > 0 && (
          // The table scrolls inside its own box; the page body never does.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-5 py-3 text-start font-medium">Day</th>
                  <th className="px-5 py-3 text-start font-medium">Window</th>
                  <th className="px-5 py-3 text-end font-medium">Hours</th>
                  <th className="px-5 py-3 text-start font-medium">Type</th>
                  <th className="px-5 py-3 text-end font-medium">Food allowance</th>
                  <th className="px-5 py-3 text-start font-medium">Why</th>
                  <th className="px-5 py-3 text-start font-medium">Standing</th>
                  <th className="px-5 py-3 text-end font-medium">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {visible.map((row) => {
                  const allowance = Number(row.foodAllowance ?? 0);
                  return (
                    <tr
                      key={row.id}
                      data-testid="overtime-row"
                      data-overtime-id={row.id}
                      data-status={row.status}
                      className="hover:bg-surface-border-light/60"
                    >
                      <td className="whitespace-nowrap px-5 py-3 font-medium text-text-heading">
                        {formatDateOnly(row.date)}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 tabular-nums text-text-body">
                        {formatWallClockRange(row.startTime, row.endTime)}
                      </td>
                      <td className="px-5 py-3 text-end font-medium tabular-nums text-text-heading">
                        {formatOvertimeHours(row.hours)}
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={otTypeTone(row.otType)}>{otTypeLabel(row.otType)}</Badge>
                      </td>
                      <td className="px-5 py-3 text-end tabular-nums text-text-body">
                        {allowance > 0 ? formatCurrency(allowance, currency) : '—'}
                      </td>
                      <td className="max-w-xs px-5 py-3">
                        <p className="truncate text-text-body">{row.reason}</p>
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={OVERTIME_STATUS_TONE[row.status] ?? 'neutral'}>
                          {overtimeStatusLabel(row.status)}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 text-end">
                        <Link
                          href={`/dashboard/overtime/${row.id}`}
                          data-testid="my-ot-details"
                          aria-label={`Open the claim for ${formatDateOnly(row.date)}`}
                          className="text-sm font-medium text-brand-primary hover:underline"
                        >
                          Details
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function MyOvertimePage() {
  return (
    // Ungated by role: `my-requests` narrows to the caller's own rows from the
    // principal, so every signed-in employee is entitled to this screen.
    <ProtectedRoute>
      <MyOvertime />
    </ProtectedRoute>
  );
}
