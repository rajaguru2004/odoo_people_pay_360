'use client';

import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CalendarDays, Download, Users } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useMonthlyAttendance } from '@/hooks/useAttendance';
import { useBranches } from '@/hooks/useBranches';
import { useDepartments } from '@/hooks/useDepartments';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { AttendanceStatsBar } from '@/components/attendance/AttendanceStatsBar';
import {
  AttendanceSearchFilterBar,
  type AttendanceFilterSelect,
} from '@/components/attendance/AttendanceSearchFilterBar';
import { MonthStepper } from '@/components/attendance/MonthStepper';
import {
  cellKind,
  cellLabel,
  cellTitle,
  dayColumnLabel,
  isAtLatestMonth,
  matchesSearch,
  monthLabel,
  monthOf,
  stepMonth,
  weekdayLabel,
  type CellKind,
  type MonthCursor,
} from '@/components/attendance/monthGrid';
import {
  formatHours,
  formatRate,
  formatTimeOfDay,
  statusLabel,
} from '@/components/attendance/attendanceFormat';
import { exportWorkbook } from '@/utils/exportSheet';
import { apiErrorMessage } from '@/utils/apiError';
import { fullName, initials } from '@/utils/formatters';
import type {
  AttendanceStatus,
  MonthlyAttendanceCell,
  MonthlyAttendanceEntry,
  MonthlyCalendarDay,
} from '@/types/attendance';

const STATUS_OPTIONS: Array<{ value: AttendanceStatus; label: string }> = [
  { value: 'PRESENT', label: 'Present' },
  { value: 'LATE', label: 'Late' },
  { value: 'ABSENT', label: 'Absent' },
  { value: 'HALF_DAY', label: 'Half day' },
  { value: 'ON_LEAVE', label: 'On leave' },
  { value: 'HOLIDAY', label: 'Holiday' },
  { value: 'WEEKEND', label: 'Weekend' },
];

/** What each kind of cell is painted with. Tones only — never a raw colour. */
const CELL_TONE: Record<CellKind, string> = {
  worked: 'text-text-body',
  leave: 'bg-status-info-bg/60 text-status-info',
  holiday: 'bg-brand-primary/10 text-brand-primary',
  rest: 'bg-surface-border-light/70 text-text-muted',
  absent: 'bg-status-error-bg/50 text-status-error',
  // A day that has not happened is left blank rather than shaded: there is
  // nothing to report about it, and a tone would suggest there was.
  future: 'text-transparent',
  blank: 'text-text-muted',
};

/** The shared metrics of the frozen columns, so header and body cannot drift. */
const EMPLOYEE_COL = 'w-[17rem] min-w-[17rem]';
const SUMMARY_COL = 'w-[13rem] min-w-[13rem]';
const DAY_COL = 'w-[6.5rem] min-w-[6.5rem]';

function DayCell({ cell }: { cell: MonthlyAttendanceCell }) {
  const kind = cellKind(cell);
  const title = cellTitle(cell, kind);

  if (kind === 'future') {
    return <span aria-hidden>·</span>;
  }

  if (kind !== 'worked') {
    return (
      <span
        data-testid="attendance-status"
        data-status={cell.status ?? ''}
        title={title}
        className="block truncate text-[11px] font-medium"
      >
        {cellLabel(cell, kind)}
      </span>
    );
  }

  return (
    <span
      data-testid="attendance-status"
      data-status={cell.status ?? ''}
      title={title}
      className="flex flex-col items-center gap-0.5 tabular-nums"
    >
      {/* The standing is carried by colour above; a screen reader gets it in
          words, because colour on its own is not information. */}
      <span className="sr-only">
        {cell.status ? statusLabel(cell.status) : 'Recorded'}
      </span>
      <span
        className={`text-[12px] font-semibold ${
          cell.isLate
            ? 'text-status-error'
            : cell.isEarlyIn
              ? 'text-status-success'
              : 'text-text-heading'
        }`}
      >
        {/* An instant, rendered in the ROW's zone: two branches punch on two
            clocks, and an 08:00 arrival shown as 05:00 is silently wrong. */}
        {formatTimeOfDay(cell.checkIn, cell.zone)}
      </span>
      <span
        className={`text-[12px] font-medium ${
          cell.isEarlyLeave
            ? 'text-status-warning'
            : cell.isLateOut
              ? 'text-status-info'
              : 'text-text-muted'
        }`}
      >
        {formatTimeOfDay(cell.checkOut, cell.zone)}
      </span>
    </span>
  );
}

/** One figure of the trailing summary column. */
function SummaryChip({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string | number;
  tone: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`flex items-center justify-between gap-1 rounded-[var(--radius-badge)] px-1.5 py-1 text-[10px] font-medium ${tone}`}
    >
      <span className="truncate">{label}</span>
      <span className="font-bold tabular-nums">{value}</span>
    </span>
  );
}

/**
 * The company attendance log.
 *
 * A month at a time, everyone down the side and every day across the top. It is
 * built on `GET /attendances/monthly-report` rather than on the paginated list
 * because the two answer different questions: the list reports the rows that
 * exist, and the log has to report the days that DIDN'T produce one. Somebody
 * who never clocked in all month has no rows to be listed by, and they are
 * exactly the person the log is opened to find.
 *
 * Weekly rest and declared holidays come down with the report — resolved from
 * the branch calendar and the holiday table — so nothing here assumes which
 * days of the week an office is shut.
 */
function AttendanceLogs() {
  /**
   * Anchored on yesterday rather than on today.
   *
   * A log is a record of days that have finished. On the first of a month the
   * only column in it is today's, still half-written, and opening on a grid of
   * one unfinished day hides the month everybody actually came to read. The ›
   * arrow reaches the current month from here in one press.
   */
  const [cursor, setCursor] = useState<MonthCursor>(() =>
    monthOf(new Date(Date.now() - 86_400_000)),
  );
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [exporting, setExporting] = useState(false);

  const departments = useDepartments();
  const branches = useBranches();

  const query = useMemo(
    () => ({
      month: cursor.month,
      year: cursor.year,
      departmentId: departmentId || undefined,
      branchId: branchId || undefined,
    }),
    [cursor, departmentId, branchId],
  );

  const { data, isLoading, isFetching, isError } = useMonthlyAttendance(query);
  const report = data?.data;

  usePageHeader(
    'Attendance logs',
    report
      ? `${monthLabel(cursor)} · ${report.totals.employees} ${
          report.totals.employees === 1 ? 'person' : 'people'
        }`
      : monthLabel(cursor),
  );

  const days: MonthlyCalendarDay[] = useMemo(() => report?.days ?? [], [report]);

  /**
   * The rows on screen.
   *
   * The status filter narrows to people who had such a day, and it narrows the
   * CELLS as well — a month grid filtered only by row would still print every
   * other day, which is not what "show me the late ones" asks for.
   */
  const rows: MonthlyAttendanceEntry[] = useMemo(() => {
    const entries = (report?.entries ?? []).filter((entry) =>
      matchesSearch(entry, search),
    );
    if (!status) return entries;
    return entries.filter((entry) =>
      entry.days.some((cell) => cell.status === status),
    );
  }, [report, search, status]);

  const clearFilters = useCallback(() => {
    setSearch('');
    setStatus('');
    setDepartmentId('');
    setBranchId('');
  }, []);

  const filters: AttendanceFilterSelect[] = [
    {
      key: 'status',
      label: 'Status',
      value: status,
      onChange: setStatus,
      placeholder: 'Every status',
      options: STATUS_OPTIONS,
    },
    {
      key: 'department',
      label: 'Department',
      value: departmentId,
      onChange: setDepartmentId,
      placeholder: 'Every department',
      options: (departments.data?.data ?? []).map((department) => ({
        value: department.id,
        label: department.name,
      })),
    },
    {
      key: 'branch',
      label: 'Branch',
      value: branchId,
      onChange: setBranchId,
      placeholder: 'Every branch',
      options: (branches.data?.data ?? []).map((branch) => ({
        value: branch.id,
        label: branch.name,
      })),
    },
  ];

  /** The grid as it stands, one sheet, one column per day. */
  const handleExport = useCallback(async () => {
    if (!report) return;
    setExporting(true);
    try {
      const sheet = rows.map((entry) => {
        const row: Record<string, string | number | null> = {
          Employee: fullName(entry.employee),
          Code: entry.employee.employeeCode,
          Department: entry.employee.department?.name ?? null,
        };

        entry.days.forEach((cell, index) => {
          const day = days[index];
          const header = day ? dayColumnLabel(day) : cell.date;
          const kind = cellKind(cell);
          row[header] =
            kind === 'worked'
              ? `${formatTimeOfDay(cell.checkIn, cell.zone)} – ${formatTimeOfDay(cell.checkOut, cell.zone)}`
              : kind === 'future'
                ? null
                : cellLabel(cell, kind);
        });

        row.Present = entry.summary.present;
        row.Absent = entry.summary.absent;
        row['Late/Early'] = entry.summary.lateOrEarly;
        row.Hours = entry.summary.workHours;
        row['Early in'] = entry.summary.earlyIn;
        row['Late out'] = entry.summary.lateOut;
        // Blank rather than 0: a month nobody was expected in has no rate, and
        // a zero in a spreadsheet is a figure somebody will later average.
        row['Turnout %'] = entry.summary.attendanceRate;
        return row;
      });

      await exportWorkbook(
        `attendance-log-${report.year}-${String(report.month).padStart(2, '0')}`,
        [{ name: monthLabel(cursor), rows: sheet }],
      );
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The export could not be written'));
    } finally {
      setExporting(false);
    }
  }, [report, rows, days, cursor]);

  const totals = report?.totals;

  return (
    <div className="space-y-5">
      <AttendanceStatsBar
        loading={isLoading}
        stats={[
          {
            key: 'people',
            label: 'People',
            value: totals ? totals.employees : '—',
            hint: 'Everyone still on the books',
            icon: <Users className="h-5 w-5" aria-hidden />,
          },
          {
            key: 'present',
            label: 'Days worked',
            value: totals ? totals.present : '—',
            hint: totals ? `${totals.late} of them late` : undefined,
          },
          {
            key: 'absent',
            label: 'Days absent',
            value: totals ? totals.absent : '—',
            hint: 'Working days with no punch',
          },
          {
            key: 'turnout',
            label: 'Turnout',
            // An em dash, never 0%: `null` means nothing was expected in the
            // month, which is not the same as nobody turning up.
            value: formatRate(totals?.attendanceRate),
            hint: totals ? `${formatHours(totals.workHours)} worked in all` : undefined,
          },
        ]}
      />

      <AttendanceSearchFilterBar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Name, code or department"
        filters={filters}
        onClear={clearFilters}
        leading={
          <MonthStepper
            cursor={cursor}
            onChange={(delta) => setCursor((current) => stepMonth(current, delta))}
            canGoNext={!isAtLatestMonth(cursor)}
            busy={isFetching}
          />
        }
        trailing={
          <Button
            variant="outline"
            disabled={!report || exporting || rows.length === 0}
            onClick={() => void handleExport()}
          >
            <Download className="h-4 w-4" aria-hidden />
            Export
          </Button>
        }
      />

      <Card className="overflow-hidden">
        {isError && (
          <p className="p-6 text-sm text-status-error">
            Could not build the log. Is the API running?
          </p>
        )}

        {isLoading && <p className="p-6 text-sm text-text-muted">Loading the log…</p>}

        {!isLoading && !isError && rows.length === 0 && (
          <EmptyState
            icon={<CalendarDays className="h-6 w-6" aria-hidden />}
            title="Nobody to show"
            description={
              report?.entries.length
                ? 'Nothing matches those filters. Clear one of them, or step to another month.'
                : 'No active employees in this branch or department.'
            }
          />
        )}

        {!isLoading && !isError && rows.length > 0 && (
          // The grid is wider than any screen. It scrolls INSIDE this box, with
          // the employee and summary columns pinned to the edges — the page
          // body must never scroll sideways.
          // `dvh`, not `vh`, for the same reason the shell is `h-dvh`: on a
          // phone `100vh` is the tallest the viewport ever gets, so a pane sized
          // off it stays taller than the space actually on screen while the
          // toolbar is up, and the page grows a second vertical scrollbar
          // beside `<main>`'s.
          <div className="max-h-[calc(100dvh-22rem)] min-h-[18rem] overflow-auto">
            <table className="border-collapse text-sm">
              <thead>
                <tr>
                  <th
                    scope="col"
                    className={`sticky start-0 top-0 z-30 border-b border-e border-surface-border bg-surface-page px-4 py-3 text-start ${EMPLOYEE_COL}`}
                  >
                    <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                      Employee
                    </span>
                  </th>

                  {days.map((day) => (
                    <th
                      key={day.date}
                      scope="col"
                      title={day.holiday?.name}
                      className={`sticky top-0 z-20 border-b border-e border-surface-border px-1 py-2 text-center ${DAY_COL} ${
                        day.holiday
                          ? 'bg-brand-primary/10'
                          : day.isWeeklyOff
                            ? 'bg-surface-border-light'
                            : 'bg-surface-page'
                      }`}
                    >
                      <span
                        className={`block text-[11px] font-bold ${
                          day.isToday ? 'text-brand-primary' : 'text-text-heading'
                        }`}
                      >
                        {dayColumnLabel(day)}
                      </span>
                      {/* The holiday's NAME, not the word "holiday": the reader
                          can already see the shading, and the name is the part
                          that explains an empty column. */}
                      <span
                        className={`block truncate text-[10px] font-medium ${
                          day.holiday ? 'text-brand-primary' : 'text-text-muted'
                        }`}
                      >
                        {day.holiday ? day.holiday.name : weekdayLabel(day.weekday)}
                      </span>
                    </th>
                  ))}

                  <th
                    scope="col"
                    className={`sticky end-0 top-0 z-30 border-b border-s border-surface-border bg-surface-page px-3 py-3 text-start ${SUMMARY_COL}`}
                  >
                    <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                      Summary
                    </span>
                  </th>
                </tr>
              </thead>

              <tbody>
                {rows.map((entry) => (
                  <tr
                    key={entry.employee.id}
                    data-testid="attendance-row"
                    className="group"
                  >
                    <th
                      scope="row"
                      className={`sticky start-0 z-10 border-b border-e border-surface-border bg-surface-card px-4 py-2.5 text-start font-normal group-hover:bg-surface-border-light/60 ${EMPLOYEE_COL}`}
                    >
                      <span className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-primary text-xs font-bold text-text-on-brand">
                          {initials(entry.employee)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-text-heading">
                            {fullName(entry.employee)}
                          </span>
                          <span className="block truncate text-xs text-text-muted">
                            {entry.employee.employeeCode}
                            {entry.employee.department
                              ? ` · ${entry.employee.department.name}`
                              : ''}
                          </span>
                        </span>
                      </span>
                    </th>

                    {entry.days.map((cell) => {
                      const dimmed = Boolean(status) && cell.status !== status;
                      return (
                        <td
                          key={cell.date}
                          className={`border-b border-e border-surface-border px-1 py-2 text-center align-middle ${DAY_COL} ${
                            CELL_TONE[cellKind(cell)]
                          } ${dimmed ? 'opacity-25' : ''}`}
                        >
                          {dimmed ? (
                            <span aria-hidden>·</span>
                          ) : (
                            <DayCell cell={cell} />
                          )}
                        </td>
                      );
                    })}

                    <td
                      data-testid="attendance-summary"
                      className={`sticky end-0 z-10 border-b border-s border-surface-border bg-surface-card px-3 py-2.5 group-hover:bg-surface-border-light/60 ${SUMMARY_COL}`}
                    >
                      <span className="grid grid-cols-2 gap-1">
                        <SummaryChip
                          label="Present"
                          value={entry.summary.present}
                          tone="bg-status-success-bg text-status-success"
                        />
                        <SummaryChip
                          label="Absent"
                          value={entry.summary.absent}
                          tone="bg-status-error-bg text-status-error"
                        />
                        <SummaryChip
                          label="Late/Early"
                          value={entry.summary.lateOrEarly}
                          tone="bg-status-warning-bg text-status-warning"
                          title="Late arrivals plus days left short of the hours owed"
                        />
                        <SummaryChip
                          label="Hours"
                          value={entry.summary.workHours.toFixed(1)}
                          tone="bg-brand-primary/10 text-brand-primary"
                        />
                        <SummaryChip
                          label="Early in"
                          value={entry.summary.earlyIn}
                          tone="bg-status-success-bg/60 text-status-success"
                          title="Arrived before the shift began"
                        />
                        <SummaryChip
                          label="Late out"
                          value={entry.summary.lateOut}
                          tone="bg-status-info-bg text-status-info"
                          title="Stayed past the end of the shift"
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
