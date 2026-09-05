'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  Search,
  Users,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import EmployeeChip from '@/components/schedules/EmployeeChip';
import ScheduleLegend from '@/components/schedules/ScheduleLegend';
import { DAY_PALETTE, SHIFT_PALETTE } from '@/components/schedules/shiftStyles';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useBranches } from '@/hooks/useBranches';
import { useDepartments } from '@/hooks/useDepartments';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useScheduleOverview } from '@/hooks/useSchedules';
import { apiErrorMessage } from '@/utils/apiError';
import {
  dayKeysBetween,
  isWeeklyOff,
  monthBounds,
  monthLabel,
  roundHours,
  shiftWindowLabel,
  todayKey,
  weekdayLabel,
} from '@/utils/scheduleHours';
import type { BranchCalendar, OverviewShift } from '@/types/schedules';

/** Where a branch with no id of its own is filed. */
const NO_BRANCH = '';

/**
 * The working schedule: the whole workforce against a month, one row each.
 *
 * A grid rather than a list because the question it answers is spatial — "is
 * Thursday thin", "who is on nights this fortnight" — and a list of five hundred
 * rows sorted by date answers neither.
 *
 * ## What decides a cell
 *
 * Four lanes, resolved in the order a reader resolves a day:
 *
 *   1. a rostered SHIFT, which beats everything: a row exists precisely because
 *      the person deviates from their branch calendar that day;
 *   2. LEAVE already recorded against the day;
 *   3. the branch's HOLIDAY, company-wide or its own;
 *   4. the branch's WEEKLY OFF.
 *
 * Nothing left is a plain working day the branch calendar already describes, and
 * it gets an empty cell — a badge on every ordinary day would be four hundred
 * badges saying nothing.
 *
 * The shading is per BRANCH, never one company calendar. Head Office rests
 * Friday and Saturday, the Sohar plant rests Friday only, and a shared weekend
 * would shade the plant's Saturday as closed and report a coverage hole that
 * does not exist.
 */
function WorkingSchedule() {
  const t = useTranslations('schedules');
  usePageHeader(t('overviewTitle'), t('overviewSubtitle'));

  const [anchor, setAnchor] = useState(todayKey());
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [branchId, setBranchId] = useState('');

  const { start, end } = useMemo(() => monthBounds(anchor), [anchor]);
  const days = useMemo(() => dayKeysBetween(start, end), [start, end]);

  const overview = useScheduleOverview({
    startDate: start,
    endDate: end,
    branchId: branchId || undefined,
    departmentId: departmentId || undefined,
  });
  const departments = useDepartments();
  const branches = useBranches();

  const data = overview.data;

  /** Each branch's working week, so a cell can ask about its OWN branch. */
  const calendarOf = useMemo(() => {
    const map = new Map<string, BranchCalendar>();
    for (const calendar of data?.branchCalendars ?? []) {
      map.set(calendar.branchId ?? NO_BRANCH, calendar);
    }
    return map;
  }, [data]);

  /** `branchId|date` → holiday name, with the branch row winning a shared date. */
  const holidayFor = useMemo(() => {
    const companyWide = new Map<string, string>();
    const perBranch = new Map<string, string>();
    for (const holiday of data?.holidays ?? []) {
      if (holiday.branchId) perBranch.set(`${holiday.branchId}|${holiday.date}`, holiday.name);
      else companyWide.set(holiday.date, holiday.name);
    }
    return (employeeBranchId: string | null, date: string): string | null =>
      (employeeBranchId ? perBranch.get(`${employeeBranchId}|${date}`) : undefined) ??
      companyWide.get(date) ??
      null;
  }, [data]);

  const shiftAt = useMemo(() => {
    const map = new Map<string, OverviewShift>();
    for (const shift of data?.schedules ?? []) {
      map.set(`${shift.employeeId}|${shift.date}`, shift);
    }
    return map;
  }, [data]);

  const leaveAt = useMemo(() => {
    const set = new Set<string>();
    for (const leave of data?.leaves ?? []) set.add(`${leave.employeeId}|${leave.date}`);
    return set;
  }, [data]);

  /**
   * Search is client-side; branch and department are not.
   *
   * The two filters narrow the QUERY because they change which rows the server
   * has to read at all, and a department of six should not cost a full-workforce
   * grid. A name search over the rows already on screen costs one render and
   * stays responsive between keystrokes.
   */
  const employees = useMemo(() => {
    const rows = data?.employees ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.fullName.toLowerCase().includes(needle) ||
        row.employeeCode.toLowerCase().includes(needle),
    );
  }, [data, search]);

  /** The tiles above the grid, summed from exactly what the grid draws. */
  const stats = useMemo(() => {
    const visible = new Set(employees.map((e) => e.id));
    let shifts = 0;
    let hours = 0;
    const rostered = new Set<string>();

    for (const shift of data?.schedules ?? []) {
      if (!visible.has(shift.employeeId)) continue;
      shifts += 1;
      // Rounded per cell, because these tiles are checked against the grid and a
      // total that sums raw values disagrees with the cells by a few tenths.
      hours += roundHours(shift.hours);
      rostered.add(shift.employeeId);
    }

    const leaveDays = (data?.leaves ?? []).filter((l) => visible.has(l.employeeId)).length;

    return {
      rostered: rostered.size,
      shifts,
      hours: roundHours(hours),
      leaveDays,
    };
  }, [data, employees]);

  const error = overview.isError
    ? apiErrorMessage(overview.error, t('loadFailed'))
    : null;

  const stepMonth = (direction: -1 | 1) => {
    const [year, month] = anchor.slice(0, 7).split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1 + direction, 1));
    setAnchor(next.toISOString().slice(0, 10));
  };

  const today = todayKey();

  return (
    <div className="space-y-6">
      {error && (
        <p
          role="alert"
          data-testid="schedule-error"
          className="rounded-[var(--radius-card)] border border-status-error/30 bg-status-error-bg/40 px-4 py-3 text-sm font-medium text-status-error"
        >
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            key: 'staff',
            icon: Users,
            label: t('statStaff'),
            value: `${stats.rostered} / ${employees.length}`,
            testId: 'schedule-stat-staff',
          },
          {
            key: 'shifts',
            icon: CalendarDays,
            label: t('statShifts'),
            value: String(stats.shifts),
            testId: 'schedule-stat-shifts',
          },
          {
            key: 'hours',
            icon: Clock,
            label: t('statHours'),
            value: `${stats.hours}h`,
            testId: 'schedule-stat-hours',
          },
          {
            key: 'leave',
            icon: CalendarRange,
            label: t('statLeave'),
            value: String(stats.leaveDays),
            testId: 'schedule-stat-leave',
          },
        ].map((tile) => (
          <div
            key={tile.key}
            className="flex items-center gap-3.5 rounded-[var(--radius-card)] border border-surface-border bg-surface-card p-4"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-button)] bg-brand-primary text-text-on-brand">
              <tile.icon size={20} aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-bold tracking-wide text-text-muted uppercase">
                {tile.label}
              </span>
              <span
                data-testid={tile.testId}
                className="mt-0.5 block truncate text-xl font-extrabold text-text-heading tabular-nums"
              >
                {tile.value}
              </span>
            </span>
          </div>
        ))}
      </div>

      <div className="rounded-[var(--radius-card)] border border-surface-border bg-surface-card p-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="flex flex-1 flex-wrap items-end gap-3">
            <span className="flex h-10 items-center gap-2 text-sm font-semibold text-text-body">
              <Filter size={18} className="text-text-muted" aria-hidden />
              {t('filterBy')}
            </span>
            <div className="min-w-[220px]">
              <Input
                placeholder={t('searchStaff')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                icon={<Search size={16} aria-hidden />}
                data-testid="schedule-search"
                aria-label={t('searchStaff')}
              />
            </div>
            <div className="min-w-[180px]">
              <Select
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
                data-testid="schedule-department-filter"
                aria-label={t('allDepartments')}
              >
                <option value="">{t('allDepartments')}</option>
                {(departments.data?.data ?? []).map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="min-w-[160px]">
              <Select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                data-testid="schedule-branch-filter"
                aria-label={t('allBranches')}
              >
                <option value="">{t('allBranches')}</option>
                {(branches.data?.data ?? []).map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <p className="text-sm font-medium text-text-muted">
            {t('showingStaff', {
              count: employees.length,
              total: data?.employees.length ?? 0,
            })}
          </p>
        </div>
      </div>

      <div className="rounded-[var(--radius-card)] border border-surface-border bg-surface-card p-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            onClick={() => stepMonth(-1)}
            data-testid="schedule-prev-month"
          >
            <ChevronLeft size={18} aria-hidden />
            {t('previousMonth')}
          </Button>
          <div className="flex items-center gap-3">
            <h2
              data-testid="schedule-current-month"
              className="text-lg font-bold text-text-heading"
            >
              {monthLabel(anchor)}
            </h2>
            {anchor.slice(0, 7) !== today.slice(0, 7) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAnchor(today)}
                data-testid="schedule-this-month"
              >
                {t('thisMonth')}
              </Button>
            )}
          </div>
          <Button
            variant="ghost"
            onClick={() => stepMonth(1)}
            data-testid="schedule-next-month"
          >
            {t('nextMonth')}
            <ChevronRight size={18} aria-hidden />
          </Button>
        </div>

        {overview.isLoading ? (
          <div
            data-testid="schedule-loading"
            className="flex h-96 items-center justify-center"
          >
            <span className="h-8 w-8 animate-spin rounded-full border-4 border-brand-primary border-t-transparent" />
          </div>
        ) : employees.length === 0 ? (
          <div data-testid="schedule-empty" className="py-20 text-center">
            <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-surface-page">
              <Users size={32} className="text-text-muted" aria-hidden />
            </span>
            <h3 className="mb-1 text-lg font-semibold text-text-heading">
              {t('noStaff')}
            </h3>
            <p className="text-sm text-text-muted">
              {(data?.employees.length ?? 0) === 0
                ? t('noStaffEmpty')
                : t('noStaffHint')}
            </p>
          </div>
        ) : (
          // The grid scrolls INSIDE its own box. Letting it widen the page puts
          // the sidebar and the header off screen on a 31-column month.
          <div className="max-h-[600px] overflow-auto rounded-[var(--radius-card)] border border-surface-border">
            <table className="w-full border-collapse">
              <caption className="sr-only">
                {t('overviewTitle')} — {monthLabel(anchor)}
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="sticky top-0 start-0 z-30 min-w-[220px] border border-surface-border bg-surface-page p-3 text-start text-sm font-semibold text-text-heading"
                  >
                    {t('employee')}
                  </th>
                  {days.map((day) => (
                    <th
                      key={day}
                      scope="col"
                      data-testid={`schedule-day-header-${Number(day.slice(8))}`}
                      data-today={day === today ? 'true' : 'false'}
                      className={`sticky top-0 z-20 min-w-[58px] border border-surface-border p-2 text-center ${
                        day === today
                          ? 'bg-brand-primary-light/30'
                          : 'bg-surface-page'
                      }`}
                    >
                      <span className="block text-[11px] text-text-muted">
                        {weekdayLabel(day)}
                      </span>
                      <span className="block text-sm font-bold text-text-heading tabular-nums">
                        {Number(day.slice(8))}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {employees.map((employee) => {
                  const calendar = calendarOf.get(employee.branchId ?? NO_BRANCH);
                  return (
                    <tr
                      key={employee.id}
                      data-testid={`schedule-employee-row-${employee.employeeCode}`}
                      className="hover:bg-surface-page/50"
                    >
                      <th
                        scope="row"
                        className="sticky start-0 z-10 border border-surface-border bg-surface-card p-3 text-start font-normal"
                      >
                        <EmployeeChip
                          name={employee.fullName}
                          code={employee.employeeCode}
                          detail={employee.departmentName}
                          avatarUrl={employee.avatarUrl}
                        />
                      </th>

                      {days.map((day) => {
                        const shift = shiftAt.get(`${employee.id}|${day}`);
                        const onLeave = leaveAt.has(`${employee.id}|${day}`);
                        const holiday = holidayFor(employee.branchId, day);
                        const restDay = isWeeklyOff(day, calendar?.weeklyOffDays);

                        const shaded = holiday
                          ? DAY_PALETTE.holiday.background
                          : restDay
                            ? DAY_PALETTE.weeklyOff.background
                            : undefined;

                        return (
                          <td
                            key={day}
                            data-testid={`schedule-cell-${employee.employeeCode}-${day}`}
                            data-shift-type={shift?.shiftType ?? ''}
                            data-holiday={holiday ? 'true' : 'false'}
                            data-weekly-off={restDay ? 'true' : 'false'}
                            title={holiday ?? undefined}
                            className="border border-surface-border p-1 text-center align-middle"
                            style={shaded ? { background: shaded } : undefined}
                          >
                            {shift ? (
                              <span
                                data-testid="schedule-shift-cell"
                                title={`${shiftWindowLabel(shift)} · ${roundHours(shift.hours)}h${
                                  shift.notes ? ` — ${shift.notes}` : ''
                                }`}
                                className="flex h-8 w-full flex-col items-center justify-center rounded-[var(--radius-button)] border text-[11px] leading-tight font-bold"
                                style={{
                                  background: SHIFT_PALETTE[shift.shiftType].background,
                                  borderColor: SHIFT_PALETTE[shift.shiftType].border,
                                  color: SHIFT_PALETTE[shift.shiftType].text,
                                }}
                              >
                                {/* A day rostered OFF for one person carries no
                                    hours — printing "0h" reads as a data error
                                    rather than as a deliberate day off. */}
                                {shift.isWorkDay ? `${roundHours(shift.hours)}h` : '—'}
                              </span>
                            ) : onLeave ? (
                              <span
                                data-testid="schedule-leave-cell"
                                className="flex h-8 w-full items-center justify-center rounded-[var(--radius-button)] border text-[10px] font-semibold"
                                style={{
                                  background: DAY_PALETTE.leave.background,
                                  borderColor: DAY_PALETTE.leave.border,
                                  color: DAY_PALETTE.leave.text,
                                }}
                              >
                                {t('legendLeave')}
                              </span>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ScheduleLegend />
    </div>
  );
}

export default function WorkingSchedulePage() {
  return (
    <ProtectedRoute
      requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER']}
      requiredPermission="VIEW_SCHEDULES"
    >
      <WorkingSchedule />
    </ProtectedRoute>
  );
}
