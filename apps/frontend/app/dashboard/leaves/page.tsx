'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Pagination } from '@/components/common/Pagination';
import LeaveRequestTable from '@/components/leave/LeaveRequestTable';
import { useDebounce } from '@/hooks/useDebounce';
import { useLeaveRequests, useLeaveTypes } from '@/hooks/useLeaveRequests';
import { apiErrorMessage } from '@/utils/apiError';
import type { LeaveListQuery } from '@/types/leave';
import type { RequestStatus } from '@/types/common';

const PAGE_SIZE = 20;

const TABS: Array<{ key: 'ALL' | RequestStatus; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'CANCELLED', label: 'Withdrawn' },
];

/**
 * Every leave request in the company, filtered.
 *
 * The date filter asks for OVERLAP rather than containment — a request running
 * 28 August to 6 September belongs to both months, and a filter on the start
 * date alone would lose it from September entirely.
 */
function LeaveRequestsContent() {
  const [tab, setTab] = useState<'ALL' | RequestStatus>('ALL');
  const [leaveType, setLeaveType] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebounce(search, 300);
  const types = useLeaveTypes();

  const query = useMemo<LeaveListQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      status: tab === 'ALL' ? undefined : tab,
      leaveType: leaveType || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      search: debouncedSearch || undefined,
    }),
    [page, tab, leaveType, startDate, endDate, debouncedSearch],
  );

  const { data, isLoading, isError, error } = useLeaveRequests(query);
  const rows = data?.data ?? [];

  usePageHeader(
    'Leave requests',
    data?.meta ? `${data.meta.total} in this view` : undefined,
  );

  /** Any filter change starts again at page one, or page 4 of 2 shows nothing. */
  const change = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPage(1);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1" aria-label="Filter by status">
          {TABS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => change(setTab)(option.key)}
              aria-pressed={tab === option.key}
              className={
                tab === option.key
                  ? 'rounded-[var(--radius-button)] bg-brand-primary px-3 py-1.5 text-sm font-medium text-text-on-brand'
                  : 'rounded-[var(--radius-button)] px-3 py-1.5 text-sm font-medium text-text-muted hover:bg-surface-border-light'
              }
            >
              {option.label}
            </button>
          ))}
        </nav>

        <Link href="/dashboard/leaves/new">
          <Button>
            <Plus className="h-4 w-4" aria-hidden />
            File leave
          </Button>
        </Link>
      </div>

      <Card>
        <div className="grid gap-3 border-b border-surface-border-light p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            label="Search"
            placeholder="Name, code or reason"
            value={search}
            onChange={(e) => change(setSearch)(e.target.value)}
          />
          <Select
            label="Leave type"
            placeholder="Any type"
            value={leaveType}
            onChange={(e) => change(setLeaveType)(e.target.value)}
          >
            {(types.data?.data ?? []).map((type) => (
              <option key={type.id} value={type.label}>
                {type.label}
              </option>
            ))}
          </Select>
          <Input
            type="date"
            label="Overlapping from"
            value={startDate}
            onChange={(e) => change(setStartDate)(e.target.value)}
          />
          <Input
            type="date"
            label="Overlapping to"
            value={endDate}
            onChange={(e) => change(setEndDate)(e.target.value)}
          />
        </div>

        {isError ? (
          <p className="p-6 text-sm text-status-error">
            {apiErrorMessage(error, 'The leave list could not be loaded.')}
          </p>
        ) : (
          <>
            <LeaveRequestTable
              rows={rows}
              loading={isLoading}
              emptyTitle="No leave requests match these filters"
              emptyDescription="Widen the dates, or clear the search."
            />
            <Pagination meta={data?.meta} onPageChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}

export default function LeaveRequestsPage() {
  return (
    // The list answers BY NAME and by REASON — a medical certificate is behind
    // half these rows — so it is a management view. An employee reads their own
    // at /dashboard/my-leaves instead.
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER']}>
      <LeaveRequestsContent />
    </ProtectedRoute>
  );
}
