'use client';

import { useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { Award, Briefcase, CalendarDays, Clock, Umbrella } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Card } from '@/components/ui/Card';
import { StatCard } from '@/components/common/StatCard';
import { MonthStepper } from '@/components/attendance/MonthStepper';
import { monthOf, stepMonth, type MonthCursor } from '@/components/attendance/monthGrid';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useCalendarStats, useMyCalendar } from '@/hooks/useCalendar';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import { cn } from '@/utils/cn';
import type { CalendarEvent, CalendarEventType } from '@/types/calendar';

/**
 * The four lanes, and how each one paints.
 *
 * Colour carries meaning here, so every lane also carries its label in the
 * legend and in the day panel — a reader who cannot separate the hues still
 * gets the same answer.
 */
const LANES: Record<
  CalendarEventType,
  { label: string; dot: string; chip: string }
> = {
  work: {
    label: 'Work',
    dot: 'bg-brand-primary',
    chip: 'bg-brand-primary/10 text-brand-primary',
  },
  leave: {
    label: 'Leave',
    dot: 'bg-brand-accent',
    chip: 'bg-status-warning-bg text-status-warning',
  },
  overtime: {
    label: 'Overtime',
    dot: 'bg-status-info',
    chip: 'bg-status-info-bg text-status-info',
  },
  holiday: {
    label: 'Holiday',
    dot: 'bg-status-error',
    chip: 'bg-status-error-bg text-status-error',
  },
};

const LANE_ORDER = Object.keys(LANES) as CalendarEventType[];

/** Monday-first, matching the ISO weekday the branch calendar stores. */
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The `YYYY-MM-DD` a day cell is keyed by, never an instant. */
function dayKey(dt: DateTime): string {
  return dt.toFormat('yyyy-MM-dd');
}

/**
 * The days the grid draws: the whole month, padded to whole weeks.
 *
 * Built in UTC on purpose. A month grid is a page of date-only values, and
 * putting them through the viewer's zone is what moves the first of the month
 * onto the previous row for anyone west of Greenwich.
 */
function gridDays(cursor: MonthCursor) {
  const first = DateTime.fromObject(
    { year: cursor.year, month: cursor.month, day: 1 },
    { zone: 'utc' },
  );
  const start = first.minus({ days: first.weekday - 1 });
  const last = first.endOf('month');
  const end = last.plus({ days: 7 - last.weekday });

  const days: Array<{ key: string; day: number; inMonth: boolean; isToday: boolean }> =
    [];
  const todayKey = dayKey(DateTime.utc());
  for (let cursorDt = start; cursorDt <= end; cursorDt = cursorDt.plus({ days: 1 })) {
    const key = dayKey(cursorDt);
    days.push({
      key,
      day: cursorDt.day,
      inMonth: cursorDt.month === cursor.month,
      isToday: key === todayKey,
    });
  }
  return days;
}

/** Does an event cover this day? Leave spans a range; the rest sit on one date. */
function coversDay(event: CalendarEvent, key: string): boolean {
  const from = event.startDate.slice(0, 10);
  const to = event.endDate.slice(0, 10);
  return key >= from && key <= to;
}

/** "08:00 – 17:00", from the wall clock the roster stores. */
function windowLabel(event: CalendarEvent): string | null {
  if (event.allDay) return null;
  if (event.startTime && event.endTime) {
    return `${event.startTime} – ${event.endTime}`;
  }
  const from = event.startDate.slice(11, 16);
  const to = event.endDate.slice(11, 16);
  return from && to ? `${from} – ${to}` : null;
}

function MyCalendarScreen() {
  const [cursor, setCursor] = useState<MonthCursor>(() => monthOf(new Date()));
  const [selected, setSelected] = useState<string | null>(null);

  const range = useMemo(() => {
    const first = DateTime.fromObject(
      { year: cursor.year, month: cursor.month, day: 1 },
      { zone: 'utc' },
    );
    return {
      startDate: dayKey(first),
      endDate: dayKey(first.endOf('month')),
    };
  }, [cursor]);

  const calendar = useMyCalendar(range.startDate, range.endDate);
  const stats = useCalendarStats(cursor.month, cursor.year);

  const events = useMemo(() => calendar.data?.data ?? [], [calendar.data]);
  const figures = stats.data?.data;
  const days = useMemo(() => gridDays(cursor), [cursor]);

  usePageHeader('My calendar', 'Your shifts, leave, overtime and public holidays');

  const eventsOn = (key: string) =>
    events.filter((event) => coversDay(event, key));

  const selectedEvents = selected ? eventsOn(selected) : [];
  const error = calendar.error ?? stats.error;

  return (
    <div className="space-y-5" data-testid="ess-my-calendar">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Work days"
          value={figures?.workDays ?? 0}
          icon={<Briefcase className="h-5 w-5" aria-hidden />}
          hint="Days the roster claims"
        />
        <StatCard
          label="Leave days"
          value={figures?.leaveDays ?? 0}
          icon={<Umbrella className="h-5 w-5" aria-hidden />}
          hint="Approved absence"
        />
        <StatCard
          label="Overtime hours"
          value={figures?.overtimeHours ?? 0}
          icon={<Clock className="h-5 w-5" aria-hidden />}
          hint="Approved only"
        />
        <StatCard
          label="Holidays"
          value={figures?.holidays ?? 0}
          icon={<Award className="h-5 w-5" aria-hidden />}
          hint="Observed by your branch"
        />
      </div>

      {(calendar.isError || stats.isError) && (
        <Card className="p-6">
          <p role="alert" className="text-sm text-status-error">
            {apiErrorMessage(error, 'Could not load your calendar.')}
          </p>
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border-light px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-text-heading">
            <CalendarDays className="h-4 w-4 text-brand-primary" aria-hidden />
            Your month
          </h2>
          <MonthStepper
            cursor={cursor}
            onChange={(delta) => {
              setCursor((current) => stepMonth(current, delta));
              setSelected(null);
            }}
            // Unlike the attendance log, a calendar looks FORWARD: next month's
            // roster is the half an employee most wants to see.
            canGoNext
            busy={calendar.isFetching}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
          {LANE_ORDER.map((lane) => (
            <span
              key={lane}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-[var(--radius-badge)] px-2 py-0.5 text-xs font-medium',
                LANES[lane].chip,
              )}
            >
              <span className={cn('h-2 w-2 rounded-full', LANES[lane].dot)} aria-hidden />
              {LANES[lane].label}
            </span>
          ))}
        </div>

        <div className="p-5">
          <div className="overflow-x-auto">
            <div className="min-w-[42rem]">
              <div className="grid grid-cols-7 gap-1 pb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                {WEEKDAY_LABELS.map((label) => (
                  <div key={label} className="px-2 text-center">
                    {label}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-1">
                {days.map((day) => {
                  const dayEvents = eventsOn(day.key);
                  const lanes = [...new Set(dayEvents.map((event) => event.type))];
                  const isSelected = selected === day.key;
                  return (
                    <button
                      key={day.key}
                      type="button"
                      onClick={() => setSelected(isSelected ? null : day.key)}
                      aria-pressed={isSelected}
                      aria-label={`${formatDateOnly(day.key)}${
                        dayEvents.length
                          ? `, ${dayEvents.length} entr${dayEvents.length === 1 ? 'y' : 'ies'}`
                          : ', nothing scheduled'
                      }`}
                      data-testid={`mycal-day-${day.key}`}
                      className={cn(
                        'flex min-h-[4.5rem] flex-col items-start gap-1 rounded-[var(--radius-input)] border p-2 text-start transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40',
                        day.inMonth
                          ? 'border-surface-border-light bg-surface-card hover:bg-surface-border-light/60'
                          : 'border-transparent bg-surface-page text-text-muted',
                        isSelected && 'border-brand-primary bg-brand-primary/5',
                      )}
                    >
                      <span
                        className={cn(
                          'text-xs font-semibold tabular-nums',
                          day.isToday
                            ? 'flex h-5 w-5 items-center justify-center rounded-full bg-brand-primary text-text-on-brand'
                            : day.inMonth
                              ? 'text-text-heading'
                              : 'text-text-muted',
                        )}
                      >
                        {day.day}
                      </span>
                      <span className="flex flex-wrap gap-1">
                        {lanes.map((lane) => (
                          <span
                            key={lane}
                            className={cn('h-2 w-2 rounded-full', LANES[lane].dot)}
                            aria-hidden
                          />
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </Card>

      {selected && (
        <Card>
          <div className="border-b border-surface-border-light px-5 py-4">
            <h2 className="text-base font-semibold text-text-heading">
              {formatDateOnly(selected, 'cccc d LLLL yyyy')}
            </h2>
          </div>
          <div className="p-5">
            {selectedEvents.length === 0 ? (
              <p className="text-sm text-text-muted" data-testid="mycal-empty">
                Nothing scheduled on this day.
              </p>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {selectedEvents.map((event) => {
                  const window = windowLabel(event);
                  return (
                    <li
                      key={`${event.type}-${event.id}`}
                      data-testid={`mycal-event-${event.id}`}
                      className="flex items-start gap-3 rounded-[var(--radius-input)] border border-surface-border-light p-3"
                    >
                      <span
                        className={cn(
                          'mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full',
                          LANES[event.type].dot,
                        )}
                        aria-hidden
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-text-heading">
                          {event.title}
                        </p>
                        {event.description && (
                          <p className="mt-1 text-xs text-text-body">
                            {event.description}
                          </p>
                        )}
                        <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-text-muted">
                          <Clock className="h-3 w-3" aria-hidden />
                          {window ?? 'All day'}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

export default function MyCalendarPage() {
  return (
    <ProtectedRoute>
      <MyCalendarScreen />
    </ProtectedRoute>
  );
}
