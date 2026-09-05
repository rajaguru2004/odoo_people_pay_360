'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  dayKeysBetween,
  formatWallClock,
  parseDayKey,
  roundHours,
  todayKey,
} from '@/utils/scheduleHours';
import type { ScheduleEvent } from '@/types/schedules';
import { DAY_PALETTE, SHIFT_PALETTE } from './shiftStyles';

/**
 * A month of one person's roster, drawn as a calendar.
 *
 * Hand-built rather than a calendar library. Three reasons, in order of weight:
 *
 *  1. Every one of them wants an INSTANT. The shift columns here are wall clock
 *     — "22:00" in the branch's own zone — and feeding a library a synthesised
 *     `Date` re-introduces exactly the timezone drift the column type exists to
 *     avoid.
 *  2. The portal is right-to-left in Arabic, and a grid built from logical CSS
 *     properties flips for nothing, where a library's own stylesheet does not.
 *  3. The interactions this screen needs are "click a day" and "click a shift".
 *     A drag-and-drop scheduler is a large dependency for two click handlers.
 *
 * The weeks are Monday-first to match every other window in this app. A branch's
 * REST days are shaded from the events themselves rather than from a weekday
 * rule here — the server already resolved which days that person's branch is
 * closed, and re-deriving it would give two answers to one question.
 */
export default function ShiftCalendar({
  monthKey,
  events,
  onSelectDay,
  onSelectEvent,
  readOnly = false,
}: {
  /** Any day key inside the month being drawn. */
  monthKey: string;
  events: ScheduleEvent[];
  onSelectDay?: (dayKey: string) => void;
  onSelectEvent?: (event: ScheduleEvent) => void;
  readOnly?: boolean;
}) {
  const t = useTranslations('schedules');

  /**
   * The visible grid: whole weeks, so the month starts and ends on a boundary.
   *
   * Trailing days from the neighbouring months are drawn dimmed rather than
   * left blank — a calendar that stops mid-row reads as broken, and the 1st of
   * next month is genuinely useful when the reader is planning a rota.
   */
  const { weeks, month } = useMemo(() => {
    const anchor = parseDayKey(monthKey);
    const first = anchor.startOf('month');
    const gridStart = first.startOf('week');
    const gridEnd = anchor.endOf('month').startOf('week').plus({ days: 6 });
    const days = dayKeysBetween(
      gridStart.toFormat('yyyy-MM-dd'),
      gridEnd.toFormat('yyyy-MM-dd'),
    );

    const rows: string[][] = [];
    for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));
    return { weeks: rows, month: anchor.toFormat('yyyy-MM') };
  }, [monthKey]);

  const byDay = useMemo(() => {
    const map = new Map<string, ScheduleEvent[]>();
    for (const event of events) {
      const bucket = map.get(event.date);
      if (bucket) bucket.push(event);
      else map.set(event.date, [event]);
    }
    return map;
  }, [events]);

  const today = todayKey();
  const headers = weeks[0] ?? [];

  return (
    <div
      data-testid="shift-calendar"
      className="overflow-hidden rounded-[var(--radius-card)] border border-surface-border"
    >
      <div className="grid grid-cols-7 bg-surface-page">
        {headers.map((day) => (
          <div
            key={`head-${day}`}
            className="border-b border-surface-border px-2 py-2 text-center text-[11px] font-bold tracking-wide text-text-muted uppercase"
          >
            {t(`weekday.${parseDayKey(day).weekday}`)}
          </div>
        ))}
      </div>

      {weeks.map((week) => (
        <div key={week[0]} className="grid grid-cols-7">
          {week.map((day) => {
            const dayEvents = byDay.get(day) ?? [];
            const outsideMonth = !day.startsWith(month);
            const holiday = dayEvents.find((e) => e.type === 'holiday');
            const restDay = dayEvents.find((e) => e.type === 'weekly-off');

            const background = holiday
              ? DAY_PALETTE.holiday.background
              : restDay
                ? DAY_PALETTE.weeklyOff.background
                : undefined;

            const Cell = readOnly || !onSelectDay ? 'div' : 'button';

            return (
              <Cell
                key={day}
                {...(Cell === 'button'
                  ? {
                      type: 'button' as const,
                      onClick: () => onSelectDay?.(day),
                      'aria-label': day,
                    }
                  : {})}
                data-testid={`calendar-day-${day}`}
                data-today={day === today ? 'true' : 'false'}
                data-holiday={holiday ? 'true' : 'false'}
                data-weekly-off={restDay ? 'true' : 'false'}
                title={holiday?.title ?? undefined}
                className={`min-h-[104px] border-b border-e border-surface-border p-1.5 text-start align-top last:border-e-0 ${
                  outsideMonth ? 'opacity-45' : ''
                } ${Cell === 'button' ? 'cursor-pointer hover:bg-surface-page/70' : ''}`}
                style={background ? { background } : undefined}
              >
                <span className="mb-1 flex items-center justify-between">
                  <span
                    className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold tabular-nums ${
                      day === today
                        ? 'bg-brand-primary text-text-on-brand'
                        : 'text-text-heading'
                    }`}
                  >
                    {Number(day.slice(8))}
                  </span>
                  {holiday && (
                    <span
                      className="truncate ps-1 text-[9px] font-semibold"
                      style={{ color: DAY_PALETTE.holiday.text }}
                    >
                      {holiday.title}
                    </span>
                  )}
                </span>

                <span className="flex flex-col gap-1">
                  {dayEvents
                    .filter((e) => e.type === 'shift' || e.type === 'leave')
                    .map((event) => {
                      const palette =
                        event.type === 'leave'
                          ? DAY_PALETTE.leave
                          : SHIFT_PALETTE[event.shiftType ?? 'FULL_DAY'];

                      const clickable = event.type === 'shift' && Boolean(onSelectEvent);
                      const Chip = clickable ? 'button' : 'span';

                      return (
                        <Chip
                          key={event.id}
                          {...(clickable
                            ? {
                                type: 'button' as const,
                                onClick: (e: React.MouseEvent) => {
                                  // The cell behind this also opens a form. Without
                                  // stopping here, clicking a shift opens the CREATE
                                  // form over the edit one.
                                  e.stopPropagation();
                                  onSelectEvent?.(event);
                                },
                              }
                            : {})}
                          data-testid={`calendar-event-${event.id}`}
                          data-event-type={event.type}
                          data-shift-type={event.shiftType ?? ''}
                          title={event.notes ?? event.title}
                          className={`block w-full truncate rounded-[6px] border px-1.5 py-1 text-start text-[10px] leading-tight font-semibold ${
                            clickable ? 'cursor-pointer hover:brightness-95' : ''
                          }`}
                          style={{
                            background: palette.background,
                            borderColor: palette.border,
                            color: palette.text,
                          }}
                        >
                          {event.type === 'leave'
                            ? t('legendLeave')
                            : event.allDay
                              ? `${roundHours(event.hours ?? 0)}h`
                              : `${formatWallClock(event.startTime)} · ${roundHours(event.hours ?? 0)}h`}
                        </Chip>
                      );
                    })}
                </span>
              </Cell>
            );
          })}
        </div>
      ))}
    </div>
  );
}
