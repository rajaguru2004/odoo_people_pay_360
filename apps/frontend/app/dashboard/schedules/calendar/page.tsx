'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Clock,
  Search,
  Sun,
  Users,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import EmployeeChip from '@/components/schedules/EmployeeChip';
import ScheduleLegend from '@/components/schedules/ScheduleLegend';
import ScheduleModal from '@/components/schedules/ScheduleModal';
import ShiftCalendar from '@/components/schedules/ShiftCalendar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuthStore } from '@/store/authStore';
import { useEmployees } from '@/hooks/useEmployees';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useEmployeeCalendar, useScheduleStats } from '@/hooks/useSchedules';
import { apiErrorMessage } from '@/utils/apiError';
import { hasPermission } from '@/utils/permissions';
import { monthBounds, monthLabel, todayKey } from '@/utils/scheduleHours';
import type { ScheduleEvent } from '@/types/schedules';
import type { WorkSchedule } from '@/types/attendance';

/**
 * One person's shifts, month by month.
 *
 * The counterpart to the working-schedule grid: that screen is the whole
 * workforce at a glance and this one is a single roster in detail, with the
 * lanes the grid has no room for — which holiday closed the day, which weekly
 * off, what the shift's window actually was.
 *
 * The employee list is on the side rather than in a dropdown because picking a
 * person is the primary action here, and a select that has to be opened to see
 * who is in it makes a forty-person roster a forty-step search.
 */
function ShiftCalendarScreen() {
  const t = useTranslations('schedules');
  usePageHeader(t('calendarTitle'), t('calendarSubtitle'));

  const role = useAuthStore((s) => s.user?.role);
  const canManage = hasPermission(role, 'MANAGE_SCHEDULES');

  const [search, setSearch] = useState('');
  // Null until the reader picks somebody, which is NOT the same as "nobody".
  // The default below falls back to the first person in the roster; storing that
  // fallback in state instead would fight the reader on every list change.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState(todayKey());
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WorkSchedule | null>(null);
  const [pickedDate, setPickedDate] = useState<string | undefined>();

  const employees = useEmployees({ status: 'ACTIVE', limit: 200 });
  const roster = useMemo(() => employees.data?.data ?? [], [employees.data]);

  // Land on somebody rather than on an empty frame — derived, not synchronised.
  // An effect that wrote the first id into state rendered the page twice on
  // load and left a stale id behind whenever the roster came back narrower.
  const selectedId = pickedId ?? roster[0]?.id ?? '';

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return roster;
    return roster.filter(
      (employee) =>
        `${employee.firstName} ${employee.lastName}`.toLowerCase().includes(needle) ||
        employee.employeeCode.toLowerCase().includes(needle),
    );
  }, [roster, search]);

  const selected = roster.find((employee) => employee.id === selectedId);
  const { start, end } = useMemo(() => monthBounds(anchor), [anchor]);

  const calendar = useEmployeeCalendar({
    startDate: start,
    endDate: end,
    employeeId: selectedId || undefined,
    enabled: Boolean(selectedId),
  });

  const stats = useScheduleStats({
    month: Number(anchor.slice(5, 7)),
    year: Number(anchor.slice(0, 4)),
    employeeId: selectedId || undefined,
    enabled: Boolean(selectedId),
  });

  const events = calendar.data?.events ?? [];
  const shifts = events.filter((event) => event.type === 'shift');

  const error = calendar.isError
    ? apiErrorMessage(calendar.error, t('loadFailed'))
    : employees.isError
      ? apiErrorMessage(employees.error, t('staffLoadFailed'))
      : null;

  const stepMonth = (direction: -1 | 1) => {
    const [year, month] = anchor.slice(0, 7).split('-').map(Number);
    setAnchor(new Date(Date.UTC(year, month - 1 + direction, 1)).toISOString().slice(0, 10));
  };

  /**
   * The calendar hands back an EVENT; the modal edits a ROW.
   *
   * They are close but not the same shape — an event carries a rendered title
   * and no employee id — so the crossing is made explicit here rather than by
   * casting. `date` comes from the event because that is the day the reader
   * clicked, whatever month the picker is on.
   */
  const openEvent = (event: ScheduleEvent) => {
    if (!canManage || event.type !== 'shift') return;
    setEditing({
      id: event.id,
      employeeId: selectedId,
      date: event.date,
      shiftType: event.shiftType ?? 'FULL_DAY',
      startTime: event.startTime,
      endTime: event.endTime,
      requiredHours: event.hours != null ? String(event.hours) : null,
      isWorkDay: event.isWorkDay,
      notes: event.notes,
      createdAt: '',
      updatedAt: '',
    });
    setPickedDate(event.date);
    setModalOpen(true);
  };

  const openDay = (dayKey: string) => {
    if (!canManage) return;
    setEditing(null);
    setPickedDate(dayKey);
    setModalOpen(true);
  };

  const today = todayKey();
  const monthStats = stats.data;

  return (
    <div className="space-y-6">
      {error && (
        <p
          role="alert"
          data-testid="calendar-error"
          className="rounded-[var(--radius-card)] border border-status-error/30 bg-status-error-bg/40 px-4 py-3 text-sm font-medium text-status-error"
        >
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <aside className="lg:col-span-3">
          <div className="rounded-[var(--radius-card)] border border-surface-border bg-surface-card">
            <div className="border-b border-surface-border p-4">
              <h2 className="mb-3 flex items-center gap-2 text-base font-bold text-text-heading">
                <Users size={18} className="text-brand-primary" aria-hidden />
                {t('bulkEmployees')}
              </h2>
              <Input
                placeholder={t('searchStaff')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                icon={<Search size={16} aria-hidden />}
                data-testid="calendar-employee-search"
                aria-label={t('searchStaff')}
              />
            </div>

            <div className="max-h-[560px] space-y-1.5 overflow-y-auto p-3">
              {employees.isLoading ? (
                <div
                  data-testid="calendar-employee-loading"
                  className="py-10 text-center"
                >
                  <span className="mx-auto block h-7 w-7 animate-spin rounded-full border-4 border-brand-primary border-t-transparent" />
                </div>
              ) : filtered.length === 0 ? (
                <p
                  data-testid="calendar-employee-empty"
                  className="py-10 text-center text-sm text-text-muted"
                >
                  {t('noStaff')}
                </p>
              ) : (
                filtered.map((employee) => (
                  <button
                    key={employee.id}
                    type="button"
                    onClick={() => setPickedId(employee.id)}
                    aria-pressed={employee.id === selectedId}
                    data-testid={`calendar-employee-${employee.employeeCode}`}
                    className={`w-full rounded-[var(--radius-card)] border-2 p-2.5 text-start transition-colors ${
                      employee.id === selectedId
                        ? 'border-brand-primary bg-brand-primary-light/25'
                        : 'border-transparent hover:border-surface-border hover:bg-surface-page'
                    }`}
                  >
                    <EmployeeChip
                      name={`${employee.firstName} ${employee.lastName}`}
                      code={employee.employeeCode}
                      detail={employee.department?.name ?? null}
                      avatarUrl={employee.avatarUrl}
                      size="sm"
                    />
                  </button>
                ))
              )}
            </div>
          </div>
        </aside>

        <section className="lg:col-span-9">
          {!selected ? (
            <div
              data-testid="calendar-no-selection"
              className="rounded-[var(--radius-card)] border border-surface-border bg-surface-card py-24 text-center"
            >
              <span className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-surface-page">
                <Users size={40} className="text-text-muted" aria-hidden />
              </span>
              <h3 className="mb-2 text-lg font-semibold text-text-heading">
                {t('selectEmployee')}
              </h3>
              <p className="text-sm text-text-muted">{t('selectEmployeeHint')}</p>
            </div>
          ) : (
            <div className="space-y-5 rounded-[var(--radius-card)] border border-surface-border bg-surface-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <EmployeeChip
                  name={`${selected.firstName} ${selected.lastName}`}
                  code={selected.employeeCode}
                  detail={selected.department?.name ?? null}
                  avatarUrl={selected.avatarUrl}
                />
                {canManage && (
                  <Button
                    onClick={() => openDay(today)}
                    data-testid="calendar-add-shift"
                  >
                    {t('addShift')}
                  </Button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[
                  {
                    key: 'shifts',
                    icon: CalendarDays,
                    label: t('statShifts'),
                    value: String(monthStats?.workDays ?? shifts.length),
                    testId: 'calendar-stat-shifts',
                  },
                  {
                    key: 'hours',
                    icon: Clock,
                    label: t('statHours'),
                    value: `${monthStats?.scheduledHours ?? 0}h`,
                    testId: 'calendar-stat-hours',
                  },
                  {
                    key: 'leave',
                    icon: CalendarRange,
                    label: t('statLeave'),
                    value: String(monthStats?.leaveDays ?? 0),
                    testId: 'calendar-stat-leave',
                  },
                  {
                    key: 'holidays',
                    icon: Sun,
                    label: t('statHolidays'),
                    value: String(monthStats?.holidays ?? 0),
                    testId: 'calendar-stat-holidays',
                  },
                ].map((tile) => (
                  <div
                    key={tile.key}
                    className="flex items-center gap-3 rounded-[var(--radius-card)] border border-surface-border bg-surface-page p-3"
                  >
                    <tile.icon size={18} className="text-brand-primary" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-[10px] font-bold tracking-wide text-text-muted uppercase">
                        {tile.label}
                      </span>
                      <span
                        data-testid={tile.testId}
                        className="block truncate text-lg font-extrabold text-text-heading tabular-nums"
                      >
                        {tile.value}
                      </span>
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => stepMonth(-1)}
                  data-testid="calendar-prev-month"
                  aria-label={t('previousMonth')}
                >
                  <ChevronLeft size={18} aria-hidden />
                </Button>
                <span className="flex items-center gap-3">
                  <h3
                    data-testid="calendar-current-month"
                    className="text-base font-bold text-text-heading"
                  >
                    {monthLabel(anchor)}
                  </h3>
                  {anchor.slice(0, 7) !== today.slice(0, 7) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAnchor(today)}
                      data-testid="calendar-this-month"
                    >
                      {t('thisMonth')}
                    </Button>
                  )}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => stepMonth(1)}
                  data-testid="calendar-next-month"
                  aria-label={t('nextMonth')}
                >
                  <ChevronRight size={18} aria-hidden />
                </Button>
              </div>

              {calendar.isLoading ? (
                <div
                  data-testid="calendar-loading"
                  className="flex h-80 items-center justify-center"
                >
                  <span className="h-8 w-8 animate-spin rounded-full border-4 border-brand-primary border-t-transparent" />
                </div>
              ) : (
                <ShiftCalendar
                  monthKey={anchor}
                  events={events}
                  onSelectDay={canManage ? openDay : undefined}
                  onSelectEvent={canManage ? openEvent : undefined}
                  readOnly={!canManage}
                />
              )}

              <ScheduleLegend />
            </div>
          )}
        </section>
      </div>

      <ScheduleModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        schedule={editing}
        employeeId={selectedId}
        employeeName={selected ? `${selected.firstName} ${selected.lastName}` : undefined}
        date={pickedDate}
      />
    </div>
  );
}

export default function ShiftCalendarPage() {
  return (
    <ProtectedRoute
      requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER']}
      requiredPermission="VIEW_SCHEDULES"
    >
      <ShiftCalendarScreen />
    </ProtectedRoute>
  );
}
