import { DateTime } from 'luxon';
import type { EmployeeCalendar, ScheduleEvent } from '@/types/schedules';

/**
 * The next day this person is due at work, and what time it starts.
 *
 * Pure, so the tile can be checked without a clock or a network — the same
 * reason `myDay.ts` is pure beside it.
 *
 * `/schedules/my` answers with EXCEPTIONS rather than with a row per day: a
 * roster entry where somebody is off the standard pattern, and an all-day
 * marker for a weekly off, a holiday or approved leave. An ordinary working day
 * on the branch calendar carries no event at all, so a tile that only read
 * `events` would tell most of the workforce they are never scheduled. The rule
 * is the other way round: walk forward day by day, skip anything an all-day
 * marker has closed, and take the first day left standing — with the roster's
 * own times where there is a row, and the branch office hours where there is
 * not.
 */
export interface NextShift {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Wall clock "HH:MM", or null when neither the roster nor the branch says. */
  startTime: string | null;
  endTime: string | null;
  /** The roster row's title where one exists — "Night shift" rather than "Shift". */
  title: string;
  /** True when a roster row set this day apart from the branch's usual hours. */
  rostered: boolean;
}

/** A marker that closes a whole day: a weekly off, a holiday, or approved leave. */
function closesTheDay(event: ScheduleEvent): boolean {
  return event.allDay && !event.isWorkDay;
}

export function nextShift(
  calendar: EmployeeCalendar | undefined,
  fromDayKey: string,
  horizonDays = 30,
): NextShift | null {
  if (!calendar) return null;

  const start = DateTime.fromISO(fromDayKey, { zone: 'utc' });
  if (!start.isValid) return null;

  // The window the server actually answered for. Walking past it would report a
  // shift from a stretch of calendar nobody asked about, where an unseen
  // holiday could make the claim false.
  const last = DateTime.fromISO(calendar.range?.endDate ?? fromDayKey, { zone: 'utc' });

  const byDay = new Map<string, ScheduleEvent[]>();
  for (const event of calendar.events ?? []) {
    const key = event.date.slice(0, 10);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(event);
    else byDay.set(key, [event]);
  }

  for (let offset = 0; offset < horizonDays; offset += 1) {
    const day = start.plus({ days: offset });
    if (last.isValid && day > last) return null;

    const key = day.toFormat('yyyy-MM-dd');
    const events = byDay.get(key) ?? [];
    if (events.some(closesTheDay)) continue;

    const rostered = events.find((event) => event.isWorkDay);
    if (rostered) {
      return {
        date: key,
        startTime: rostered.startTime,
        endTime: rostered.endTime,
        title: rostered.title,
        rostered: true,
      };
    }

    // No row and nothing closing the day: the branch calendar is the schedule.
    // Without one there is nothing to claim, so the day is skipped rather than
    // reported with blank times.
    if (!calendar.calendar) continue;

    return {
      date: key,
      startTime: calendar.calendar.officeStart,
      endTime: calendar.calendar.officeEnd,
      title: 'Standard hours',
      rostered: false,
    };
  }

  return null;
}
