'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Pagination } from '@/components/common/Pagination';
import LeaveRequestTable from '@/components/leave/LeaveRequestTable';
import { useMyLeaveRequests } from '@/hooks/useLeaveRequests';
import { useEmployeeLeaveBalance } from '@/hooks/useLeaveBalances';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDays, formatRate } from '@/components/leave/leaveFormat';
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
 * The employee's own leave: what they have left, and what they have filed.
 *
 * A separate screen from the company list rather than a filter on it. That list
 * answers by name and by reason across the whole workforce, and the server
 * refuses it to this role — so a filtered view would be a page that renders
 * empty for exactly the people it is for.
 */
function MyLeaveContent() {
  const user = useAuthStore((s) => s.user);
  const employeeId = user?.employee?.id ?? user?.employeeId ?? undefined;

  const [tab, setTab] = useState<'ALL' | RequestStatus>('ALL');
  const [page, setPage] = useState(1);

  const query = useMemo(
    () => ({
      page,
      limit: PAGE_SIZE,
      status: tab === 'ALL' ? undefined : tab,
    }),
    [page, tab],
  );

  const { data, isLoading, isError, error } = useMyLeaveRequests(query);
  const balance = useEmployeeLeaveBalance(employeeId);

  const rows = data?.data ?? [];
  const typeBalances = balance.data?.data.leaveTypeBalances ?? [];

  usePageHeader(
    'My leave',
    balance.data
      ? `${formatDays(balance.data.data.totals.remaining)} left this year`
      : undefined,
  );

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="What is left"
          subtitle={
            balance.data ? `Your ${balance.data.data.year} entitlement.` : undefined
          }
          action={
            <Link href="/dashboard/leaves/new">
              <Button size="sm">
                <Plus className="h-4 w-4" aria-hidden />
                File leave
              </Button>
            </Link>
          }
        />
        <CardBody>
          {balance.isLoading ? (
            <div className="h-20 animate-pulse rounded-lg bg-surface-border/60" />
          ) : balance.isError ? (
            <p className="text-sm text-text-muted">
              {apiErrorMessage(balance.error, 'Your balance could not be read.')}
            </p>
          ) : typeBalances.length === 0 ? (
            <p className="text-sm text-text-muted">
              No entitlement has been set up for you this year yet. Ask HR.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {typeBalances.map((row) => (
                <div
                  key={row.id}
                  className="rounded-[var(--radius-card)] border border-surface-border-light bg-surface-page p-4"
                >
                  <p className="text-sm font-medium text-text-muted">
                    {row.leaveTypeKey}
                  </p>
                  <p className="mt-2 text-2xl font-semibold tabular-nums text-text-heading">
                    {row.remaining}
                  </p>
                  <p className="mt-1 text-xs text-text-muted">
                    of {row.allocated + row.carriedOver} ·{' '}
                    {formatRate(
                      row.allocated + row.carriedOver > 0
                        ? (row.used / (row.allocated + row.carriedOver)) * 100
                        : null,
                    )}{' '}
                    used
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <div className="flex flex-wrap gap-1">
        {TABS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => {
              setTab(option.key);
              setPage(1);
            }}
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
      </div>

      <Card>
        {isError ? (
          <p className="p-6 text-sm text-status-error">
            {apiErrorMessage(error, 'Your leave could not be loaded.')}
          </p>
        ) : (
          <>
            <LeaveRequestTable
              rows={rows}
              loading={isLoading}
              showEmployee={false}
              emptyTitle="You have not filed any leave"
              emptyDescription="File a request and it goes to your approver."
              emptyAction={
                <Link href="/dashboard/leaves/new">
                  <Button>File leave</Button>
                </Link>
              }
            />
            <Pagination meta={data?.meta} onPageChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}

export default function MyLeavePage() {
  return (
    <ProtectedRoute
      requiredRoles={['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER', 'MANAGER', 'EMPLOYEE']}
    >
      <MyLeaveContent />
    </ProtectedRoute>
  );
}
