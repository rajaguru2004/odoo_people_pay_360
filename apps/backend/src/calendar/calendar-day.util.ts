import { DateTime } from 'luxon';

/**
 * What one day on a personal calendar IS, before anything is drawn.
 *
 * The four lanes a day can fall into contradict each other constantly — a
 * rostered shift on a public holiday, an approved leave over a weekly off — and
 * every screen that draws the calendar has to resolve them the same way or the
 * tiles above the grid stop matching the grid. One function, one order of
 * precedence, exercised without a database.
 */
export type CalendarDayKind =
  | 'work'
  | 'leave'
  | 'holiday'
  | 'weekly-off'
  | 'open';

export interface DayInputs {
  /** `YYYY-MM-DD`. */
  date: string;
  /** True when a WorkSchedule row rosters this employee on this date. */
  hasSchedule: boolean;
  /** A rostered day the roster itself marks as non-working. */
  isWorkDay?: boolean;
  /** True when an approved leave request covers this date. */
  onLeave: boolean;
  /** The holiday observed on this date, if any. */
  holidayName?: string | null;
  /** Weekly rest days as ISO weekday numbers, 1 = Monday … 7 = Sunday. */
  weeklyOffDays?: number[];
}

export interface ResolvedDay {
  date: string;
  kind: CalendarDayKind;
  /** What the cell prints when it is not printing two times. */
  label: string;
  /** Whether the employee is expected at work. */
  isWorkingDay: boolean;
}

/** ISO weekday of a `YYYY-MM-DD` key, read without a zone conversion. */
export function isoWeekdayOf(date: string): number {
  const dt = DateTime.fromISO(date.slice(0, 10), { zone: 'utc' });
  return dt.isValid ? dt.weekday : 0;
}

/**
 * Resolve one day.
 *
 * Ordered by what beats what, and the order is the whole point:
 *
 *  - LEAVE first. An approved absence outranks the roster, because a shift
 *    still on the roster for a day somebody is signed off is a rostering
 *    mistake, not an instruction to turn up.
 *  - A ROSTERED shift next. Somebody explicitly put on a public holiday is
 *    working that holiday; shading them off would hide the one day of the month
 *    a scheduler most needs to see.
 *  - HOLIDAY over the weekly off, because a holiday has a NAME the reader can
 *    act on and "Rest" does not.
 *  - The weekly off last, and a day with none of the four is simply open.
 */
export function resolveCalendarDay(input: DayInputs): ResolvedDay {
  const { date } = input;

  if (input.onLeave) {
    return { date, kind: 'leave', label: 'On leave', isWorkingDay: false };
  }

  if (input.hasSchedule && input.isWorkDay !== false) {
    return { date, kind: 'work', label: 'Scheduled', isWorkingDay: true };
  }

  if (input.holidayName) {
    return {
      date,
      kind: 'holiday',
      label: input.holidayName,
      isWorkingDay: false,
    };
  }

  const offDays = input.weeklyOffDays ?? [];
  if (offDays.includes(isoWeekdayOf(date))) {
    return { date, kind: 'weekly-off', label: 'Weekly off', isWorkingDay: false };
  }

  // A rostered row explicitly marked non-working lands here rather than in
  // `work`: the roster is saying "not today", and it is not a rest day the
  // branch calendar knows about.
  if (input.hasSchedule) {
    return { date, kind: 'weekly-off', label: 'Not working', isWorkingDay: false };
  }

  return { date, kind: 'open', label: '—', isWorkingDay: true };
}

/** Every `YYYY-MM-DD` from `start` to `end`, both ends included. */
export function dayKeysBetween(start: string, end: string): string[] {
  const from = DateTime.fromISO(start.slice(0, 10), { zone: 'utc' });
  const to = DateTime.fromISO(end.slice(0, 10), { zone: 'utc' });
  if (!from.isValid || !to.isValid || to < from) return [];

  const keys: string[] = [];
  for (let cursor = from; cursor <= to; cursor = cursor.plus({ days: 1 })) {
    keys.push(cursor.toFormat('yyyy-MM-dd'));
  }
  return keys;
}
