'use client';

import { useMemo, useState } from 'react';
import { History, Search } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAttendances } from '@/hooks/useAttendance';
import { useBranches } from '@/hooks/useBranches';
import { useDebounce } from '@/hooks/useDebounce';
import { useDepartments } from '@/hooks/useDepartments';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import {
  STATUS_TONE,
  formatHours,
  formatLateness,
  formatTimeOfDay,
  statusLabel,
} from '@/components/attendance/attendanceFormat';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import type { AttendanceListQuery, AttendanceStatus } from '@/types/attendance';

const PAGE_SIZE = 20;

const STATUS_OPTIONS: Array<{ value: AttendanceStatus; label: string }> = [
  { value: 'PRESENT', label: 'Present' },
  { value: 'LATE', label: 'Late' },
  { value: 'ABSENT', label: 'Absent' },
  { value: 'HALF_DAY', label: 'Half day' },
  { value: 'ON_LEAVE', label: 'On leave' },
  { value: 'HOLIDAY', label: 'Holiday' },
  { value: 'WEEKEND', label: 'Weekend' },
];

/**
 * The raw record, day by day.
 *
 * Unfiltered by date on arrival. A default window would decide for the reader
 * which fortnight matters, and the one thing anybody comes to a log for is the
 * day that is NOT in the obvious range.
 */
interface Filters {
  search: string;
  status: string;
  departmentId: string;
  branchId: string;
  startDate: string;
  endDate: string;
}

const NO_FILTERS: Filters = {
  search: '',
  status: '',
  departmentId: '',
  branchId: '',
  startDate: '',
  endDate: '',
};

function AttendanceLogs() {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebounce(filters.search, 300);

  /**
   * Every filter moves through here, and every filter resets the page.
   *
   * Narrowing the set while staying on page 4 lands the reader on an empty
   * table that reads as "no matches" — which is a different, and wrong, answer.
   */
  const change = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  };

  const query = useMemo<AttendanceListQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      search: debouncedSearch || undefined,
      status: (filters.status || undefined) as AttendanceStatus | undefined,
      departmentId: filters.departmentId || undefined,
      branchId: filters.branchId || undefined,
      startDate: filters.startDate || undefined,
      endDate: filters.endDate || undefined,
    }),
    [page, debouncedSearch, filters],
  );

  const { data, isLoading, isError } = useAttendances(query);
  const departments = useDepartments();
  const branches = useBranches();

  const rows = data?.data ?? [];
  const total = data?.meta?.total;

  usePageHeader(
    'Attendance logs',
    total === undefined ? undefined : `${total} record${total === 1 ? '' : 's'}`,
  );

  const filtered = Boolean(
    debouncedSearch ||
      filters.status ||
      filters.departmentId ||
      filters.branchId ||
      filters.startDate ||
      filters.endDate,
  );

  return (
    <div className="space-y-5">
      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Input
            label="Employee"
            value={filters.search}
            onChange={(event) => change({ search: event.target.value })}
            placeholder="Name or code"
            icon={<Search className="h-4 w-4" aria-hidden />}
          />
          <Select
            label="Status"
            placeholder="Every status"
            value={filters.status}
            onChange={(event) => change({ status: event.target.value })}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Select
            label="Department"
            placeholder="Every department"
            value={filters.departmentId}
            onChange={(event) => change({ departmentId: event.target.value })}
          >
            {(departments.data?.data ?? []).map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
          <Select
            label="Branch"
            placeholder="Every branch"
            value={filters.branchId}
            onChange={(event) => change({ branchId: event.target.value })}
          >
            {(branches.data?.data ?? []).map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </Select>
          <Input
            label="Earliest day"
            type="date"
            value={filters.startDate}
            onChange={(event) => change({ startDate: event.target.value })}
          />
          <Input
            label="Latest day"
            type="date"
            value={filters.endDate}
            onChange={(event) => change({ endDate: event.target.value })}
          />
        </div>
      </Card>

      <Card>
        {isLoading && <p className="p-6 text-sm text-text-muted">Loading the log…</p>}

        {isError && (
          <p className="p-6 text-sm text-status-error">
            Could not load the log. Is the API running?
          </p>
        )}

        {!isLoading && !isError && rows.length === 0 && (
          <EmptyState
            icon={<History className="h-6 w-6" aria-hidden />}
            title={filtered ? 'No matches' : 'Nothing recorded yet'}
            description={
              filtered
                ? 'Nothing matches those filters. Widen the range or clear one of them.'
                : 'Punches and manual entries will appear here as they are made.'
            }
          />
        )}

        {rows.length > 0 && (
          // The wrapper scrolls, not the page.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-5 py-3 text-start font-medium">Day</th>
                  <th className="px-5 py-3 text-start font-medium">Employee</th>
                  <th className="px-5 py-3 text-start font-medium">Department</th>
                  <th className="px-5 py-3 text-start font-medium">In</th>
                  <th className="px-5 py-3 text-start font-medium">Out</th>
                  <th className="px-5 py-3 text-start font-medium">Hours</th>
                  <th className="px-5 py-3 text-start font-medium">Source</th>
                  <th className="px-5 py-3 text-start font-medium">Standing</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {rows.map((row) => {
                  const lateness = formatLateness(row.lateMinutes);
                  return (
                    <tr
                      key={row.id}
                      data-testid="attendance-row"
                      className="hover:bg-surface-border-light/60"
                    >
                      {/* A date-only value: `formatDateOnly` does not zone-convert,
                          because the day the work is attributed to has no time of
                          day to shift. */}
                      <td className="px-5 py-3 font-medium tabular-nums text-text-heading">
                        {formatDateOnly(row.date)}
                      </td>
                      <td className="px-5 py-3">
                        <p className="text-text-body">{fullName(row.employee)}</p>
                        <p className="text-xs text-text-muted">{row.employee?.employeeCode ?? '—'}</p>
                      </td>
                      <td className="px-5 py-3 text-text-body">
                        {row.employee?.department?.name ?? '—'}
                      </td>
                      <td className="px-5 py-3 tabular-nums text-text-body">
                        {formatTimeOfDay(row.checkIn)}
                        {lateness && (
                          <span className="ms-2 text-xs text-status-warning">{lateness}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 tabular-nums text-text-body">
                        {formatTimeOfDay(row.checkOut)}
                      </td>
                      <td className="px-5 py-3 tabular-nums text-text-body">
                        {formatHours(row.workHours)}
                      </td>
                      <td className="px-5 py-3 text-xs uppercase tracking-wide text-text-muted">
                        {row.source.toLowerCase()}
                      </td>
                      <td className="px-5 py-3">
                        <span data-testid="attendance-status">
                          <Badge tone={STATUS_TONE[row.status]}>{statusLabel(row.status)}</Badge>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <Pagination meta={data?.meta} onPageChange={setPage} />
      </Card>
    </div>
  );
}

export default function AttendanceHistoryPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER', 'MANAGER']}>
      <AttendanceLogs />
    </ProtectedRoute>
  );
}
