'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pagination } from '@/components/common/Pagination';
import { StatCard } from '@/components/common/StatCard';
import OvertimeTable from '@/components/leave/OvertimeTable';
import { useMyOvertimeRequests } from '@/hooks/useOvertime';
import { apiErrorMessage } from '@/utils/apiError';
import { formatHours } from '@/utils/overtimeCalc';
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
 * The employee's own overtime.
 *
 * The totals are computed from the page on screen and say so, because they ARE
 * the page: an employee looking at their pending requests wants the hours in
 * front of them, not a company-wide aggregate they are not entitled to.
 */
function MyOvertimeContent() {
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

  const { data, isLoading, isError, error } = useMyOvertimeRequests(query);
  const rows = data?.data ?? [];

  const approvedHours = rows
    .filter((r) => r.status === 'APPROVED')
    .reduce((sum, r) => sum + (Number(r.hours) || 0), 0);
  const pendingCount = rows.filter((r) => r.status === 'PENDING').length;

  usePageHeader(
    'My overtime',
    data?.meta ? `${data.meta.total} logged` : undefined,
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Approved hours"
          value={formatHours(approvedHours)}
          hint="On this page."
        />
        <StatCard label="Awaiting a decision" value={pendingCount} />
        <StatCard
          label="Logged in total"
          value={data?.meta?.total ?? '—'}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1" aria-label="Filter by status">
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
        </nav>

        <Link href="/dashboard/overtime/new">
          <Button>
            <Plus className="h-4 w-4" aria-hidden />
            Log overtime
          </Button>
        </Link>
      </div>

      <Card>
        {isError ? (
          <p className="p-6 text-sm text-status-error">
            {apiErrorMessage(error, 'Your overtime could not be loaded.')}
          </p>
        ) : (
          <>
            <OvertimeTable
              rows={rows}
              loading={isLoading}
              showEmployee={false}
              emptyTitle="You have not logged any overtime"
              emptyDescription="Log a window and it goes to your approver."
              emptyAction={
                <Link href="/dashboard/overtime/new">
                  <Button>Log overtime</Button>
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

export default function MyOvertimePage() {
  return (
    <ProtectedRoute
      requiredRoles={['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER', 'MANAGER', 'EMPLOYEE']}
    >
      <MyOvertimeContent />
    </ProtectedRoute>
  );
}
