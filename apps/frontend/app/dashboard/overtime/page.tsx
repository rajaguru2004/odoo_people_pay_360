'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle, Clock, Filter, Plus, Search, XCircle } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useOvertimeRequests } from '@/hooks/useOvertime';
import { useBrandingStore } from '@/store/brandingStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { StatCard } from '@/components/common/StatCard';
import {
  OT_TYPE_LABEL,
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
import type { OtType, Overtime, OvertimeStatus } from '@/types/overtime';

/**
 * One wide read, then every refinement in the browser.
 *
 * The queue is a working set an approver sorts through in one sitting — a few
 * hundred rows at most — and the status counts on the pills have to describe
 * the whole set, not the page in front of them. Re-fetching per keystroke would
 * buy nothing and cost the counts their meaning.
 */
const FETCH_LIMIT = 1000;
const PAGE_SIZE = 20;

type StatusFilter = 'all' | OvertimeStatus;
type TypeFilter = 'all' | OtType;

const STATUS_FILTERS: StatusFilter[] = [
  'all',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
];

function summarise(rows: Overtime[]) {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();

  const monthHours = rows
    .filter((row) => {
      if (row.status !== 'APPROVED') return false;
      // Date-only, so sliced rather than parsed — an instant parse moves the
      // first of the month into the previous one west of Greenwich.
      const [rowYear, rowMonth] = row.date.slice(0, 10).split('-').map(Number);
      return rowMonth - 1 === month && rowYear === year;
    })
    .reduce((sum, row) => sum + (Number(row.hours) || 0), 0);

  return {
    total: rows.length,
    pending: rows.filter((row) => row.status === 'PENDING').length,
    approved: rows.filter((row) => row.status === 'APPROVED').length,
    rejected: rows.filter((row) => row.status === 'REJECTED').length,
    monthHours,
  };
}

function OvertimeQueue() {
  const currency = useBrandingStore((state) => state.branding.default_currency);

  const [status, setStatus] = useState<StatusFilter>('all');
  const [otType, setOtType] = useState<TypeFilter>('all');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, error } = useOvertimeRequests({
    page: 1,
    limit: FETCH_LIMIT,
  });
  const rows = useMemo(() => data?.data ?? [], [data]);
  const stats = useMemo(() => summarise(rows), [rows]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();

    return rows.filter((row) => {
      if (status !== 'all' && row.status !== status) return false;
      if (otType !== 'all' && (row.otType ?? 'REGULAR') !== otType) return false;

      const day = row.date.slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;

      if (!query) return true;
      const haystack = [
        row.employee?.fullName,
        row.employee?.employeeCode,
        row.employee?.department?.name,
        row.reason,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [rows, status, otType, from, to, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // A narrower filter has fewer pages: left on page 4, the reader would be
  // looking at an empty table that reads as "nothing matched".
  const current = Math.min(page, totalPages);
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const filtersActive =
    status !== 'all' || otType !== 'all' || search !== '' || from !== '' || to !== '';

  const clearFilters = () => {
    setStatus('all');
    setOtType('all');
    setSearch('');
    setFrom('');
    setTo('');
    setPage(1);
  };

  usePageHeader('Overtime', `${stats.pending} waiting on a decision`);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Link
          href="/dashboard/overtime/new"
          data-testid="ot-new"
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

      <Card className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_FILTERS.map((key) => {
            const active = status === key;
            const count =
              key === 'all' ? rows.length : rows.filter((row) => row.status === key).length;
            return (
              <button
                key={key}
                type="button"
                data-testid="ot-filter"
                data-key={key}
                aria-pressed={active}
                onClick={() => {
                  setStatus(key);
                  setPage(1);
                }}
                className={`inline-flex items-center gap-2 rounded-[var(--radius-button)] border px-3 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? 'border-brand-primary bg-brand-primary text-text-on-brand'
                    : 'border-surface-border bg-surface-card text-text-body hover:bg-surface-border-light'
                }`}
              >
                {key === 'all' ? 'All' : overtimeStatusLabel(key)}
                <span className="tabular-nums text-xs opacity-80">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Input
            label="Search"
            placeholder="Name, code, department or reason"
            icon={<Search className="h-4 w-4" aria-hidden />}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
          <Select
            label="Overtime type"
            value={otType}
            onChange={(event) => {
              setOtType(event.target.value as TypeFilter);
              setPage(1);
            }}
          >
            <option value="all">All types</option>
            {(Object.keys(OT_TYPE_LABEL) as OtType[]).map((key) => (
              <option key={key} value={key}>
                {OT_TYPE_LABEL[key]}
              </option>
            ))}
          </Select>
          <Input
            label="From"
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setPage(1);
            }}
          />
          <Input
            label="To"
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setPage(1);
            }}
          />
        </div>

        {filtersActive && (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          </div>
        )}
      </Card>

      <Card>
        {isLoading && <p className="p-6 text-sm text-text-muted">Loading the queue…</p>}

        {isError && (
          <p className="p-6 text-sm text-status-error">
            {apiErrorMessage(error, 'Could not load overtime requests.')}
          </p>
        )}

        {!isLoading && !isError && filtered.length === 0 && (
          <div data-testid="ot-empty">
            <EmptyState
              icon={<Filter className="h-6 w-6" aria-hidden />}
              title={filtersActive ? 'Nothing matched' : 'No overtime filed yet'}
              description={
                filtersActive
                  ? 'Try widening the search or the date range.'
                  : 'Requests appear here as soon as they are filed.'
              }
              action={
                filtersActive ? (
                  <Button variant="outline" onClick={clearFilters}>
                    Reset filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        )}

        {filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-5 py-3 text-start font-medium">Employee</th>
                  <th className="px-5 py-3 text-start font-medium">Day</th>
                  <th className="px-5 py-3 text-start font-medium">Window</th>
                  <th className="px-5 py-3 text-end font-medium">Hours</th>
                  <th className="px-5 py-3 text-start font-medium">Type</th>
                  <th className="px-5 py-3 text-end font-medium">Food allowance</th>
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
                      title={row.reason || undefined}
                    >
                      <td className="px-5 py-3">
                        <p className="font-medium text-text-heading">
                          {row.employee?.fullName ?? '—'}
                        </p>
                        <p className="text-xs text-text-muted">
                          {row.employee?.employeeCode ?? '—'}
                          {row.employee?.department?.name
                            ? ` · ${row.employee.department.name}`
                            : ''}
                        </p>
                      </td>
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
                      <td className="px-5 py-3">
                        <Badge tone={OVERTIME_STATUS_TONE[row.status] ?? 'neutral'}>
                          {overtimeStatusLabel(row.status)}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 text-end">
                        <Link
                          href={`/dashboard/overtime/${row.id}`}
                          data-testid="overtime-details"
                          aria-label={`Open ${row.employee?.fullName ?? 'the'} claim for ${formatDateOnly(row.date)}`}
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

        <Pagination
          meta={{
            total: filtered.length,
            page: current,
            limit: PAGE_SIZE,
            totalPages,
          }}
          onPageChange={setPage}
        />
      </Card>
    </div>
  );
}

export default function OvertimePage() {
  return (
    // The three roles `GET /overtime` serves. Anyone else has `my-overtime`,
    // which the server narrows to their own rows.
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER']}>
      <OvertimeQueue />
    </ProtectedRoute>
  );
}
