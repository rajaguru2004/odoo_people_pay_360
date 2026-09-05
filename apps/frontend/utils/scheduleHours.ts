import { DateTime } from 'luxon';
import type { ShiftType } from '@/types/attendance';

/**
 * The calendar and clock arithmetic the Schedules screens share.
 *
 * It lives here rather than inside a page because three screens need the same
 * answers — the grid, the shift manager and the dashboard's export — and a rule
 * copied into three components is a rule that will eventually disagree with
 * itself and with the server.
 *
 * Shift times are WALL CLOCK, "22:00", never an instant. That is what the column
 * stores, and putting one through a zone conversion is how a night shift starts
 * being drawn four hours early for a reader in another country.
 */

const MINUTES_PER_DAY = 24 * 60;
const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const SHIFT_LABELS: Record<ShiftType, string> = {
  MORNING: 'Morning',
  AFTERNOON: 'Afternoon',
  FULL_DAY: 'Full day',
  NIGHT: 'Night',
  FLEXIBLE: 'Flexible',
};

/** The order a scheduler reads the shift types in — earliest start first. */
export const SHIFT_ORDER: ShiftType[] = [
  'MORNING',
  'AFTERNOON',
  'FULL_DAY',
  'NIGHT',
  'FLEXIBLE',
];

/** "HH:MM" → minutes past midnight, or null if it is not a wall clock. */
export function parseWallClock(value?: string | null): number | null {
  const match = WALL_CLOCK.exec(value?.trim() ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** "08:00" → "8:00 AM". Empty string for anything that is not a wall clock. */
export function formatWallClock(value?: string | null): string {
  const minutes = parseWallClock(value);
  if (minutes === null) return '';
  const hour = Math.floor(minutes / 60);
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minutes % 60).padStart(2, '0')} ${suffix}`;
}

/** "08:00 – 5:00 PM" for a shift, or a hours figure for a flexible one. */
export function shiftWindowLabel(shift: {
  shiftType: ShiftType;
  startTime?: string | null;
  endTime?: string | null;
  hours?: number | null;
}): string {
  if (shift.shiftType === 'FLEXIBLE') {
    return shift.hours ? `${roundHours(shift.hours)}h flexible` : 'Flexible';
  }
  const start = formatWallClock(shift.startTime);
  const end = formatWallClock(shift.endTime);
  if (!start || !end) return SHIFT_LABELS[shift.shiftType];
  return `${start} – ${end}`;
}

/**
 * How long a shift runs, in hours.
 *
 * An end at or before the start has crossed MIDNIGHT — a night shift of
 * "22:00"–"06:00" is eight hours, and the naive subtraction that makes it minus
 * sixteen turns every night worker into a payroll anomaly. Equal clocks are a
 * zero-length window rather than a full 24 hours: an unconfigured pair is far
 * likelier than a genuine round-the-clock shift.
 *
 * A FLEXIBLE shift is measured by the hours it states, because that is the only
 * thing it stores.
 */
export function shiftHours(shift: {
  shiftType: ShiftType;
  startTime?: string | null;
  endTime?: string | null;
  requiredHours?: number | string | null;
}): number {
  const stated =
    shift.requiredHours === null || shift.requiredHours === undefined
      ? null
      : Number(shift.requiredHours);

  if (shift.shiftType === 'FLEXIBLE') return roundHours(stated ?? 0);

  const start = parseWallClock(shift.startTime);
  const end = parseWallClock(shift.endTime);
  if (start === null || end === null) return roundHours(stated ?? 0);
  if (start === end) return 0;

  const minutes = end > start ? end - start : end + MINUTES_PER_DAY - start;
  return roundHours(minutes / 60);
}

/** True when the window runs past midnight into the following day. */
export function crossesMidnight(
  startTime?: string | null,
  endTime?: string | null,
): boolean {
  const start = parseWallClock(startTime);
  const end = parseWallClock(endTime);
  if (start === null || end === null) return false;
  return end < start;
}

/** One decimal. The tiles sum these, so rounding once per value keeps them honest. */
export function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

// ── Date-only arithmetic ─────────────────────────────────────────────────────
// Everything below works on "YYYY-MM-DD" day keys, in UTC, and never converts a
// date-only value through a zone. `new Date('2026-01-15')` read with local
// getters is the 14th anywhere west of Greenwich, and a grid built on that draws
// the whole month one column out.

/** Today, as a day key. */
export function todayKey(): string {
  return DateTime.utc().toFormat('yyyy-MM-dd');
}

/** A JS Date, or a day key, as a day key. */
export function toDayKey(value: Date | DateTime | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const dt =
    value instanceof Date
      ? DateTime.fromObject(
          {
            year: value.getFullYear(),
            month: value.getMonth() + 1,
            day: value.getDate(),
          },
          { zone: 'utc' },
        )
      : value;
  return dt.toFormat('yyyy-MM-dd');
}

export function parseDayKey(key: string): DateTime {
  return DateTime.fromFormat(key.slice(0, 10), 'yyyy-MM-dd', { zone: 'utc' });
}

/** The first and last day of the month a day key falls in. */
export function monthBounds(key: string): { start: string; end: string } {
  const dt = parseDayKey(key);
  return {
    start: dt.startOf('month').toFormat('yyyy-MM-dd'),
    end: dt.endOf('month').toFormat('yyyy-MM-dd'),
  };
}

/** The Monday-first ISO week a day key falls in. */
export function weekBounds(key: string): { start: string; end: string } {
  const dt = parseDayKey(key);
  return {
    start: dt.startOf('week').toFormat('yyyy-MM-dd'),
    end: dt.startOf('week').plus({ days: 6 }).toFormat('yyyy-MM-dd'),
  };
}

/** Every day key in a closed range. */
export function dayKeysBetween(startKey: string, endKey: string): string[] {
  const keys: string[] = [];
  let cursor = parseDayKey(startKey);
  const last = parseDayKey(endKey);
  if (!cursor.isValid || !last.isValid) return keys;
  while (cursor <= last) {
    keys.push(cursor.toFormat('yyyy-MM-dd'));
    cursor = cursor.plus({ days: 1 });
  }
  return keys;
}

/** N days from a day key, as a day key. */
export function shiftDays(key: string, days: number): string {
  return parseDayKey(key).plus({ days }).toFormat('yyyy-MM-dd');
}

/** ISO weekday, 1 = Monday … 7 = Sunday. */
export function isoWeekday(key: string): number {
  return parseDayKey(key).weekday;
}

/**
 * Is this day one of a branch's weekly rest days?
 *
 * An EMPTY array means "no weekly rest configured", which is not the same claim
 * as "every day is a rest day". Read the other way round it would shade every
 * column in the grid and report a workforce that never works.
 */
export function isWeeklyOff(
  key: string,
  weeklyOffDays: number[] | null | undefined,
): boolean {
  if (!weeklyOffDays?.length) return false;
  return weeklyOffDays.includes(isoWeekday(key));
}

/** "Mon", "Tue" — the three-letter head of a grid column. */
export function weekdayLabel(key: string): string {
  return parseDayKey(key).toFormat('ccc');
}

/** "12 Mar" — a date named in a sentence rather than in a column head. */
export function dayLabel(key: string): string {
  return parseDayKey(key).toFormat('d LLL');
}

/** "March 2026". */
export function monthLabel(key: string): string {
  return parseDayKey(key).toFormat('LLLL yyyy');
}
