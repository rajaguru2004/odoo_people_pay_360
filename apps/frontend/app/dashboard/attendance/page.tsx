'use client';

import { useMemo, useState } from 'react';
import { AlertCircle, CalendarClock, Clock } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useTodayAttendance } from '@/hooks/useAttendance';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import {
  STATUS_TONE,
  formatHours,
  formatLateness,
  formatTimeOfDay,
  statusLabel,
} from '@/components/attendance/attendanceFormat';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import type { AttendanceStatus, TodayRecord } from '@/types/attendance';

const STATUS_OPTIONS: Array<{ value: 'ALL' | AttendanceStatus; label: string }> = [
  { value: 'ALL', label: 'Every status' },
  { value: 'PRESENT', label: 'Present' },
  { value: 'LATE', label: 'Late' },
  { value: 'ABSENT', label: 'Absent' },
  { value: 'HALF_DAY', label: 'Half day' },
  { value: 'ON_LEAVE', label: 'On leave' },
  { value: 'HOLIDAY', label: 'Holiday' },
  { value: 'WEEKEND', label: 'Weekend' },
];

function BoardRow({ record }: { record: TodayRecord }) {
  const lateness = formatLateness(record.lateMinutes);

  return (
    <tr data-testid="attendance-row" className="hover:bg-surface-border-light/60">
      <td className="px-5 py-3">
        <p className="font-medium text-text-heading">{fullName(record.employee)}</p>
        <p className="text-xs text-text-muted">{record.employee.employeeCode}</p>
      </td>
      <td className="px-5 py-3 text-text-body">{record.employee.department?.name ?? '—'}</td>
      <td className="px-5 py-3 text-text-body">{record.employee.branch?.name ?? '—'}</td>
      <td className="px-5 py-3 tabular-nums text-text-body">
        {/* In the BRANCH's zone, not the reader's: two offices punch on two
            clocks, and an 08:00 arrival shown as 05:00 is silently wrong. */}
        {formatTimeOfDay(record.checkIn, record.zone)}
        {lateness && <span className="ms-2 text-xs text-status-warning">{lateness}</span>}
      </td>
      <td className="px-5 py-3 tabular-nums text-text-body">
        {formatTimeOfDay(record.checkOut, record.zone)}
        {record.isEarlyLeave && <span className="ms-2 text-xs text-status-warning">early</span>}
      </td>
      <td className="px-5 py-3 tabular-nums text-text-body">{formatHours(record.workHours)}</td>
      <td className="px-5 py-3">
        <Badge tone={STATUS_TONE[record.status]}>{statusLabel(record.status)}</Badge>
        {record.holiday && <p className="mt-1 text-xs text-text-muted">{record.holiday.name}</p>}
      </td>
    </tr>
  );
}

/**
 * Today's board.
 *
 * Everyone still employed appears, whether or not they punched. A board built
 * from attendance rows alone lists arrivals and nothing else — the person who
 * did not come in has no row to be missing from, so their absence is invisible
 * until payroll finds it a fortnight later.
 */
function AttendanceBoard() {
  const { data, isLoading, isError } = useTodayAttendance();
  const board = data?.data;

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'ALL' | AttendanceStatus>('ALL');

  const records = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (board?.records ?? []).filter((r) => {
      if (status !== 'ALL' && r.status !== status) return false;
      if (!term) return true;
      return (
        fullName(r.employee).toLowerCase().includes(term) ||
        r.employee.employeeCode.toLowerCase().includes(term)
      );
    });
  }, [board, search, status]);

  // Before the office day ends an absence is a prediction: the person may still
  // be on their way. The board says so rather than reporting the figure flat.
  const provisional = (board?.records ?? []).some((r) => !r.settled);
  const totals = board?.totals;

  usePageHeader(
    'Attendance',
    board ? `${formatDateOnly(board.date)} · ${totals?.headcount ?? 0} people` : 'Loading…',
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="In today"
          value={totals ? totals.present : '—'}
          hint={totals ? `of ${totals.expected} expected` : undefined}
          icon={<Clock className="h-5 w-5" aria-hidden />}
        />
        <StatCard label="Late" value={totals ? totals.late : '—'} hint="Arrived after the grace window" />
        <StatCard
          label={provisional ? 'Not in yet' : 'Absent'}
          value={totals ? (provisional ? totals.notCheckedIn : totals.absent) : '—'}
          hint={provisional ? 'The day is still open' : 'No punch and no leave'}
        />
        <StatCard
          label="On leave"
          value={totals ? totals.onLeave : '—'}
          hint="Approved, so not counted as absence"
          icon={<CalendarClock className="h-5 w-5" aria-hidden />}
        />
      </div>

      {provisional && (
        <p className="flex items-start gap-2 rounded-[var(--radius-card)] border border-status-warning/30 bg-status-warning-bg px-4 py-3 text-sm font-medium text-status-warning">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Provisional. The office day has not ended, so anyone without a punch has not arrived
            yet rather than failed to arrive.
          </span>
        </p>
      )}

      <Card>
        <CardHeader
          title="Who is in"
          subtitle="Everyone still employed, including the people with no punch today."
          action={
            <div className="flex flex-wrap items-end justify-end gap-3">
              <div className="w-48">
                <Input
                  label="Find someone"
                  placeholder="Name or code"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="w-44">
                <Select
                  label="Status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as 'ALL' | AttendanceStatus)}
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          }
        />

        {isLoading && <CardBody className="text-sm text-text-muted">Loading the board…</CardBody>}

        {isError && (
          <CardBody className="text-sm text-status-error">
            Could not read today&apos;s board. Is the API running?
          </CardBody>
        )}

        {!isLoading && !isError && records.length === 0 && (
          <EmptyState
            icon={<Clock className="h-6 w-6" aria-hidden />}
            title="Nobody matches"
            description={
              board?.records.length
                ? 'Widen the search or clear the status filter.'
                : 'No active employees to show — add someone under People.'
            }
          />
        )}

        {records.length > 0 && (
          // The wrapper scrolls, not the page: a wide table must never force the
          // whole document sideways on a phone.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-5 py-3 text-start font-medium">Employee</th>
                  <th className="px-5 py-3 text-start font-medium">Department</th>
                  <th className="px-5 py-3 text-start font-medium">Branch</th>
                  <th className="px-5 py-3 text-start font-medium">In</th>
                  <th className="px-5 py-3 text-start font-medium">Out</th>
                  <th className="px-5 py-3 text-start font-medium">Hours</th>
                  <th className="px-5 py-3 text-start font-medium">Standing</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {records.map((record) => (
                  <BoardRow key={record.employee.id} record={record} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function AttendanceOverviewPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER', 'MANAGER']}>
      <AttendanceBoard />
    </ProtectedRoute>
  );
}
