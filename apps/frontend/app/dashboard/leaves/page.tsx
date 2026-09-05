'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, Plus, RefreshCw, Search, X } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useCompanyLeaveOverview,
  useLeaveBalance,
  useLeaveRequests,
  useLeaveTypes,
} from '@/hooks/useLeaveRequests';
import { useDebounce } from '@/hooks/useDebounce';
import { useAuthStore } from '@/store/authStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { StatCard } from '@/components/common/StatCard';
import { formatDateOnly } from '@/utils/formatDate';
import type { LeaveRequestListQuery, LeaveStatus } from '@/types/leave';

const PAGE_SIZE = 10;

const STATUS_TONE: Record<LeaveStatus, 'success' | 'warning' | 'error' | 'neutral'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELLED: 'neutral',
};

function statusLabel(status: LeaveStatus) {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

/** "AB" from a joined name the API already put together. */
function initialsOf(name: string | undefined) {
  if (!name) return 'NA';
  return (
    name
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'NA'
  );
}

function LeaveRequestsScreen() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const employeeId = user?.employee?.id ?? user?.employeeId ?? undefined;
  const isHrOrAdmin = user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(1);

  // Typing a name should not fire a request per keystroke; the list still
  // reacts within a beat of the last character.
  const debouncedSearch = useDebounce(search, 300);

  const query = useMemo<LeaveRequestListQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      status: statusFilter || undefined,
      leaveType: typeFilter || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      search: isHrOrAdmin ? debouncedSearch || undefined : undefined,
    }),
    [page, statusFilter, typeFilter, startDate, endDate, debouncedSearch, isHrOrAdmin],
  );

  const { data, isLoading, isError, refetch, isFetching } = useLeaveRequests(query);
  const leaveTypesQuery = useLeaveTypes();

  // The overview is an ADMIN/HR endpoint. Asking for it as a manager would meet
  // a 403 and the shared permission modal on every visit to a screen they are
  // entitled to, so a manager gets their own balance instead.
  const overviewQuery = useCompanyLeaveOverview(undefined, isHrOrAdmin);
  const balanceQuery = useLeaveBalance(isHrOrAdmin ? undefined : employeeId);

  const overview = overviewQuery.data?.data;
  const balance = balanceQuery.data?.data;
  const rows = data?.data ?? [];
  const leaveTypes = leaveTypesQuery.data?.data ?? [];

  usePageHeader('Leave requests', 'Review and decide what the company has asked for');

  const filtersApplied = Boolean(search || statusFilter || typeFilter || startDate || endDate);

  const resetFilters = () => {
    setSearch('');
    setStatusFilter('');
    setTypeFilter('');
    setStartDate('');
    setEndDate('');
    setPage(1);
  };

  // A narrower filter has fewer pages: staying on page 4 lands on an empty
  // table that reads as "nothing matches".
  const onFilterChange = (apply: () => void) => {
    apply();
    setPage(1);
  };

  return (
    <div className="space-y-5" data-testid="leaves">
      {employeeId && !isHrOrAdmin && (
        <div className="flex justify-end">
          <Button onClick={() => router.push('/dashboard/leaves/new')} data-testid="leave-new">
            <Plus className="h-4 w-4" aria-hidden />
            Request leave
          </Button>
        </div>
      )}

      {isHrOrAdmin && overview && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Pending requests" value={overview.requestStats.pending} />
            <StatCard label="Approved this year" value={overview.requestStats.approved} />
            <StatCard label="Rejected" value={overview.requestStats.rejected} />
            <StatCard label="Employees" value={overview.totalEmployees} />
          </div>

          {overview.leaveTypes.length > 0 && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {overview.leaveTypes.map((lt) => {
                const usedPct =
                  lt.totalAllocated > 0 ? Math.round((lt.totalUsed / lt.totalAllocated) * 100) : 0;
                return (
                  <Card
                    key={lt.leaveTypeKey}
                    data-testid="leave-type-card"
                    data-leave-type={lt.leaveTypeKey}
                    className="p-5"
                  >
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] bg-brand-primary/10 text-brand-primary">
                          <Calendar className="h-4 w-4" aria-hidden />
                        </span>
                        <p className="truncate text-xs font-medium text-text-muted">
                          {lt.leaveTypeKey}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-[var(--radius-badge)] bg-surface-border-light px-2 py-0.5 text-xs font-medium text-text-muted">
                        {lt.employeeCount} emp
                      </span>
                    </div>
                    <p className="mb-1 text-2xl font-semibold tabular-nums text-text-heading">
                      {lt.totalUsed} days used
                    </p>
                    <p className="mb-2 text-xs text-text-muted">
                      {lt.totalRemaining} remaining of {lt.totalAllocated} allocated
                    </p>
                    <div
                      className="h-1.5 rounded-[var(--radius-badge)] bg-surface-border-light"
                      role="presentation"
                    >
                      <div
                        className="h-1.5 rounded-[var(--radius-badge)] bg-brand-primary"
                        style={{ width: `${Math.min(usedPct, 100)}%` }}
                      />
                    </div>
                    <p className="mt-1 text-xs text-text-muted">{usedPct}% utilised</p>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {!isHrOrAdmin && balance && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {balance.leaveTypeBalances && balance.leaveTypeBalances.length > 0 ? (
            balance.leaveTypeBalances.map((tb) => (
              <StatCard
                key={tb.id}
                label={tb.leaveTypeKey}
                value={tb.remaining}
                hint={`Remaining of ${tb.allocated + tb.carriedOver} days`}
              />
            ))
          ) : (
            <>
              <StatCard
                label="Annual leave"
                value={
                  balance.remainingAnnual ??
                  balance.annualLeave + balance.carriedOver - balance.usedAnnual
                }
                hint={`Remaining of ${balance.annualLeave + balance.carriedOver} days`}
              />
              <StatCard
                label="Sick leave"
                value={balance.remainingSick ?? balance.sickLeave - balance.usedSick}
                hint={`Remaining of ${balance.sickLeave} days`}
              />
              <StatCard label="Carried over" value={balance.carriedOver} hint="From last year" />
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        {isHrOrAdmin && (
          <div className="min-w-[240px] flex-1">
            <Input
              label="Search"
              placeholder="Search by employee name…"
              value={search}
              onChange={(event) => onFilterChange(() => setSearch(event.target.value))}
              icon={<Search className="h-4 w-4" aria-hidden />}
            />
          </div>
        )}

        <div className="w-48">
          <Select
            label="Leave type"
            value={typeFilter}
            onChange={(event) => onFilterChange(() => setTypeFilter(event.target.value))}
          >
            <option value="">All leave types</option>
            {leaveTypes.map((type) => (
              <option key={type.id} value={type.label}>
                {type.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="w-44">
          <Select
            label="Standing"
            value={statusFilter}
            onChange={(event) => onFilterChange(() => setStatusFilter(event.target.value))}
          >
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>
        </div>

        <div className="w-40">
          <Input
            label="From"
            type="date"
            value={startDate}
            onChange={(event) => onFilterChange(() => setStartDate(event.target.value))}
          />
        </div>

        <div className="w-40">
          <Input
            label="To"
            type="date"
            value={endDate}
            onChange={(event) => onFilterChange(() => setEndDate(event.target.value))}
          />
        </div>

        <div className="flex gap-2">
          {filtersApplied && (
            <Button variant="outline" onClick={resetFilters}>
              <X className="h-4 w-4" aria-hidden />
              Clear
            </Button>
          )}
          <Button
            variant="outline"
            aria-label="Refresh the list"
            isLoading={isFetching}
            onClick={() => void refetch()}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>

      <Card>
        <div className="border-b border-surface-border-light px-5 py-4">
          <h2 className="text-base font-semibold text-text-heading">Requests</h2>
          <p className="mt-0.5 text-sm text-text-muted">Newest first</p>
        </div>

        {isLoading && <p className="p-6 text-sm text-text-muted">Loading requests…</p>}

        {isError && (
          <p className="p-6 text-sm text-status-error">
            Could not load the requests. Is the API running?
          </p>
        )}

        {!isLoading && !isError && rows.length === 0 && (
          <EmptyState
            icon={<Calendar className="h-6 w-6" aria-hidden />}
            title="No leave requests"
            description={
              filtersApplied
                ? 'Nothing matches the filters you have set.'
                : 'Nothing has been filed yet.'
            }
            action={
              filtersApplied ? (
                <Button variant="outline" onClick={resetFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  {isHrOrAdmin && <th className="px-5 py-3 text-start font-medium">Employee</th>}
                  <th className="px-5 py-3 text-start font-medium">Type</th>
                  <th className="px-5 py-3 text-start font-medium">From</th>
                  <th className="px-5 py-3 text-start font-medium">To</th>
                  <th className="px-5 py-3 text-start font-medium">Days</th>
                  <th className="px-5 py-3 text-start font-medium">Reason</th>
                  <th className="px-5 py-3 text-start font-medium">Standing</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {rows.map((request) => (
                  <tr
                    key={request.id}
                    data-testid="leave-row"
                    data-leave-id={request.id}
                    data-status={request.status}
                    onClick={() => router.push(`/dashboard/leaves/${request.id}`)}
                    className="cursor-pointer hover:bg-surface-border-light/60"
                  >
                    {isHrOrAdmin && (
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-xs font-semibold text-brand-primary">
                            {initialsOf(request.employee?.fullName)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-text-heading">
                              {request.employee?.fullName ?? '—'}
                            </p>
                            <p className="truncate text-xs text-text-muted">
                              {request.employee?.employeeCode ?? ''}
                            </p>
                          </div>
                        </div>
                      </td>
                    )}
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pagination meta={data?.meta} onPageChange={setPage} />
      </Card>
    </div>
  );
}

export default function LeavesPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER']}>
      <LeaveRequestsScreen />
    </ProtectedRoute>
  );
}
