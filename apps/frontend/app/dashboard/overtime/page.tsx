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
import { StatCard } from '@/components/common/StatCard';
import OvertimeTable from '@/components/leave/OvertimeTable';
import { useDebounce } from '@/hooks/useDebounce';
import { useOvertimeRequests, useOvertimeStats } from '@/hooks/useOvertime';
import { apiErrorMessage } from '@/utils/apiError';
import { formatHours } from '@/utils/overtimeCalc';
import type { OvertimeListQuery, OvertimeType } from '@/types/overtime';
import type { RequestStatus } from '@/types/common';

const PAGE_SIZE = 20;

const TABS: Array<{ key: 'ALL' | RequestStatus; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'CANCELLED', label: 'Withdrawn' },
];

const TIERS: Array<{ key: OvertimeType; label: string }> = [
  { key: 'REGULAR', label: 'Regular' },
  { key: 'LATE', label: 'Late' },
  { key: 'DOUBLE', label: 'Double' },
  { key: 'DOUBLE_LATE', label: 'Double, late' },
];

/**
 * Every overtime request, filtered.
 *
 * The hours column is the PAYABLE total after the attendance day boundary has
 * clamped the window, which is why it can be less than the times beside it
 * suggest. That is the number payroll reads, so it is the number the list shows.
 */
function OvertimeListContent() {
  const [tab, setTab] = useState<'ALL' | RequestStatus>('ALL');
  const [otType, setOtType] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebounce(search, 300);

  const query = useMemo<OvertimeListQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      status: tab === 'ALL' ? undefined : tab,
      otType: (otType || undefined) as OvertimeType | undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      search: debouncedSearch || undefined,
    }),
    [page, tab, otType, startDate, endDate, debouncedSearch],
  );

  const { data, isLoading, isError, error } = useOvertimeRequests(query);
  const stats = useOvertimeStats();

  const rows = data?.data ?? [];

  usePageHeader(
    'Overtime',
    data?.meta ? `${data.meta.total} in this view` : undefined,
  );

  const change = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPage(1);
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Awaiting a decision"
          value={stats.isError ? '—' : (stats.data?.data.pending ?? '—')}
          hint={
            stats.data?.data.avgDecisionHours == null
              ? 'None have been decided yet.'
              : `Usually answered in ${stats.data.data.avgDecisionHours.toFixed(1)}h.`
          }
        />
        <StatCard
          label="Approved"
          value={stats.isError ? '—' : (stats.data?.data.approved ?? '—')}
        />
        <StatCard
          label="Approved hours"
          value={formatHours(stats.data?.data.approvedHours ?? null)}
          hint="The payable total, after the day boundary."
        />
        <StatCard
          label="Rejected"
          value={stats.isError ? '—' : (stats.data?.data.rejected ?? '—')}
        />
      </div>

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

        <Link href="/dashboard/overtime/new">
          <Button>
            <Plus className="h-4 w-4" aria-hidden />
            Log overtime
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
            label="Tier"
            placeholder="Any tier"
            value={otType}
            onChange={(e) => change(setOtType)(e.target.value)}
          >
            {TIERS.map((tier) => (
              <option key={tier.key} value={tier.key}>
                {tier.label}
              </option>
            ))}
          </Select>
          <Input
            type="date"
            label="From"
            value={startDate}
            onChange={(e) => change(setStartDate)(e.target.value)}
          />
          <Input
            type="date"
            label="To"
            value={endDate}
            onChange={(e) => change(setEndDate)(e.target.value)}
          />
        </div>

        {isError ? (
          <p className="p-6 text-sm text-status-error">
            {apiErrorMessage(error, 'The overtime list could not be loaded.')}
          </p>
        ) : (
          <>
            <OvertimeTable
              rows={rows}
              loading={isLoading}
              emptyTitle="No overtime matches these filters"
              emptyDescription="Widen the dates, or clear the search."
            />
            <Pagination meta={data?.meta} onPageChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}

export default function OvertimeListPage() {
  return (
    // Payroll is admitted here and not on the leave list: overtime hours ARE a
    // payroll fact, and a payroll officer has to reconcile them.
    <ProtectedRoute
      requiredRoles={['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER', 'MANAGER']}
    >
      <OvertimeListContent />
    </ProtectedRoute>
  );
}
