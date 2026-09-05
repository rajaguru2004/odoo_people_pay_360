'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, CheckCircle, Clock, Eye, Plus, XCircle } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useLeaveBalance, useMyLeaveRequests } from '@/hooks/useLeaveRequests';
import { useAuthStore } from '@/store/authStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import { formatDateOnly } from '@/utils/formatDate';
import type { LeaveBalance, LeaveRequest, LeaveStatus } from '@/types/leave';

const STATUS_TONE: Record<LeaveStatus, 'success' | 'warning' | 'error' | 'neutral'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELLED: 'neutral',
};

const FILTERS: Array<{ key: 'all' | LeaveStatus; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
];

function statusLabel(status: LeaveStatus) {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

/** Remaining days beside the yearly entitlement they came out of. */
function BalanceTile({
  label,
  remaining,
  total,
  hint,
  leaveType,
}: {
  label: string;
  remaining: number;
  total: number;
  hint: string;
  leaveType?: string;
}) {
  return (
    <div
      data-testid="my-leave-balance-card"
      data-leave-type={leaveType ?? label}
      data-remaining={remaining}
      data-total={total}
      className="rounded-[var(--radius-card)] border border-surface-border bg-surface-card p-3"
    >
      <div className="mb-1.5 flex items-center justify-between gap-1">
        <p className="truncate text-[11px] font-medium uppercase tracking-wide text-text-muted" title={label}>
          {label}
        </p>
        <Calendar className="h-3.5 w-3.5 text-text-muted" aria-hidden />
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-xl font-semibold tabular-nums text-text-heading">{remaining}</span>
        <span className="text-xs text-text-muted">/ {total}d</span>
      </div>
      <p className="mt-0.5 truncate text-[10px] text-text-muted">{hint}</p>
    </div>
  );
}

/**
 * The entitlement strip.
 *
 * Prints the stored yearly figures — allocation plus anything carried over, and
 * what is left of it — rather than prorating to the month. HR's screens read the
 * same stored numbers, and two views of one employee that disagree are worse
 * than one view that is only annual.
 */
function BalanceStrip({ balance }: { balance: LeaveBalance }) {
  const typed = balance.leaveTypeBalances ?? [];

  if (typed.length > 0) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {typed.map((tb) => (
          <BalanceTile
            key={tb.id}
            label={tb.leaveTypeKey}
            leaveType={tb.leaveTypeKey}
            remaining={tb.remaining}
            total={tb.allocated + tb.carriedOver}
            hint="Remaining / allocated"
          />
        ))}
      </div>
    );
  }

  // Nothing configured beyond the two statutory buckets, so print those.
  const annualTotal = balance.annualLeave + balance.carriedOver;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      <BalanceTile
        label="Annual leave"
        remaining={balance.remainingAnnual ?? annualTotal - balance.usedAnnual}
        total={annualTotal}
        hint="Remaining / allocated"
      />
      <BalanceTile
        label="Sick leave"
        remaining={balance.remainingSick ?? balance.sickLeave - balance.usedSick}
        total={balance.sickLeave}
        hint="Remaining / allocated"
      />
      <BalanceTile
        label="Carried over"
        remaining={balance.carriedOver}
        total={balance.carriedOver}
        hint="From last year"
      />
    </div>
  );
}

function MyLeaves() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const employeeId = user?.employee?.id ?? user?.employeeId ?? undefined;

  const [filter, setFilter] = useState<'all' | LeaveStatus>('all');

  const { data, isLoading, isError } = useMyLeaveRequests();
  const balanceQuery = useLeaveBalance(employeeId);

  const requests = useMemo<LeaveRequest[]>(
    () => (Array.isArray(data?.data) ? data.data : []),
    [data],
  );
  const balance = balanceQuery.data?.data;

  const stats = useMemo(
    () => ({
      total: requests.length,
      pending: requests.filter((r) => r.status === 'PENDING').length,
      approved: requests.filter((r) => r.status === 'APPROVED').length,
      rejected: requests.filter((r) => r.status === 'REJECTED').length,
    }),
    [requests],
  );

  usePageHeader('My leaves', `${stats.pending} awaiting a decision`);

  const visible = filter === 'all' ? requests : requests.filter((r) => r.status === filter);

  const openRequest = (id: string) => router.push(`/dashboard/leaves/${id}`);

  return (
    <div className="space-y-5" data-testid="my-leaves">
      <div className="flex justify-end">
        <Button
          className="w-full md:w-auto"
          data-testid="my-leaves-new"
          onClick={() => router.push('/dashboard/leaves/new')}
        >
          <Plus className="h-4 w-4" aria-hidden />
          Request leave
        </Button>
      </div>

      {balance && <BalanceStrip balance={balance} />}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Requests" value={stats.total} icon={<Calendar className="h-5 w-5" aria-hidden />} />
        <StatCard label="Pending" value={stats.pending} icon={<Clock className="h-5 w-5" aria-hidden />} />
        <StatCard
          label="Approved"
          value={stats.approved}
          icon={<CheckCircle className="h-5 w-5" aria-hidden />}
        />
        <StatCard label="Rejected" value={stats.rejected} icon={<XCircle className="h-5 w-5" aria-hidden />} />
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map(({ key, label }) => {
          const active = filter === key;
          return (
            <button
              key={key}
              type="button"
              data-testid="my-leave-filter"
              aria-pressed={active}
              onClick={() => setFilter(key)}
              className={`inline-flex items-center rounded-[var(--radius-button)] border px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? 'border-brand-primary bg-brand-primary text-text-on-brand'
                  : 'border-surface-border bg-surface-card text-text-body hover:bg-surface-border-light'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <Card>
        <div className="border-b border-surface-border-light px-5 py-4">
          <h2 className="text-base font-semibold text-text-heading">My leave requests</h2>
        </div>

        {isLoading && <p className="p-6 text-sm text-text-muted">Loading your requests…</p>}

        {isError && (
          <p className="p-6 text-sm text-status-error">
            Could not load your requests. Is the API running?
          </p>
        )}

        {!isLoading && !isError && visible.length === 0 && (
          <EmptyState
            icon={<Calendar className="h-6 w-6" aria-hidden />}
            title={filter === 'all' ? 'No leave requests yet' : 'Nothing with that standing'}
            description={
              filter === 'all'
                ? 'Anything you apply for will be listed here.'
                : 'Try a different filter, or clear it to see everything.'
            }
            action={
              filter === 'all' ? (
                <Button onClick={() => router.push('/dashboard/leaves/new')}>Request leave</Button>
              ) : (
                <Button variant="outline" onClick={() => setFilter('all')}>
                  Show all
                </Button>
              )
            }
          />
        )}

        {visible.length > 0 && (
          <>
            {/* Desktop: the full table, scrolling inside its own wrapper so the
                page body never moves sideways. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                  <tr>
                    <th className="px-5 py-3 text-start font-medium">Type</th>
                    <th className="px-5 py-3 text-start font-medium">From</th>
                    <th className="px-5 py-3 text-start font-medium">To</th>
                    <th className="px-5 py-3 text-start font-medium">Days</th>
                    <th className="px-5 py-3 text-start font-medium">Reason</th>
                    <th className="px-5 py-3 text-start font-medium">Standing</th>
                    <th className="px-5 py-3 text-end font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border-light">
                  {visible.map((request) => (
                    <tr
                      key={request.id}
                      data-testid="my-leave-row"
                      data-leave-id={request.id}
                      data-leave-status={request.status}
                      onClick={() => openRequest(request.id)}
                      className="cursor-pointer hover:bg-surface-border-light/60"
                    >
                      <td className="px-5 py-3 font-medium text-text-heading">{request.leaveType}</td>
                      <td className="px-5 py-3 tabular-nums text-text-body">
                        {formatDateOnly(request.startDate)}
                      </td>
                      <td className="px-5 py-3 tabular-nums text-text-body">
                        {formatDateOnly(request.endDate)}
                      </td>
                      <td className="px-5 py-3 font-semibold tabular-nums text-brand-primary">
                        {request.totalDays}
                      </td>
                      <td className="max-w-xs px-5 py-3">
                        <p className="truncate text-text-muted">{request.reason}</p>
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={STATUS_TONE[request.status]}>{statusLabel(request.status)}</Badge>
                      </td>
                      <td className="px-5 py-3 text-end">
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Open the ${request.leaveType} request from ${formatDateOnly(request.startDate)}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            openRequest(request.id);
                          }}
                        >
                          <Eye className="h-4 w-4" aria-hidden />
                          Open
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Phone: one card per request. A table narrowed to 360px is a
                horizontal scroll nobody discovers. */}
            <ul className="space-y-3 p-4 md:hidden">
              {visible.map((request) => (
                <li key={request.id}>
                  <button
                    type="button"
                    data-testid="my-leave-card"
                    onClick={() => openRequest(request.id)}
                    className="w-full rounded-[var(--radius-card)] border border-surface-border bg-surface-card p-4 text-start transition-colors hover:bg-surface-border-light/60"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-medium text-text-heading">{request.leaveType}</p>
                      <Badge tone={STATUS_TONE[request.status]}>{statusLabel(request.status)}</Badge>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <dt className="text-xs text-text-muted">From</dt>
                        <dd className="tabular-nums text-text-body">
                          {formatDateOnly(request.startDate)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-text-muted">To</dt>
                        <dd className="tabular-nums text-text-body">{formatDateOnly(request.endDate)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-text-muted">Days</dt>
                        <dd className="font-semibold tabular-nums text-brand-primary">
                          {request.totalDays}
                        </dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-xs text-text-muted">Reason</dt>
                        <dd className="text-text-body">{request.reason || '—'}</dd>
                      </div>
                    </dl>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

export default function MyLeavesPage() {
  return (
    // Ungated by role: /my-requests is narrowed to the caller, so every signed-in
    // person with an employee record has exactly their own rows here.
    <ProtectedRoute>
      <MyLeaves />
    </ProtectedRoute>
  );
}
