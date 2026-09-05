import { DateTime } from 'luxon';
import { DAY_KEY_PATTERN } from '../attendances/attendance-calendar.util';

/**
 * A payroll period and the working days inside it.
 *
 * Pure: no Prisma, no Nest, no injected clock. Layer 0.
 *
 * Date-only throughout, and deliberately so. A period boundary put through an
 * instant parse is the previous day anywhere west of Greenwich, which is how a
 * September run starts paying against August's last day.
 */

/** A calendar period, as two date-only day keys. */
export interface PayrollPeriod {
  /** `YYYY-MM-DD`, the first day of the month. */
  periodStart: string;
  /** `YYYY-MM-DD`, the last day of the month. */
  periodEnd: string;
}

/** Predicate the caller supplies — normally `AttendanceCalendarService.isBranchWorkingDay`. */
export type WorkingDayPredicate = (dayKey: string) => boolean;

export const MIN_PAYROLL_YEAR = 2000;
export const MAX_PAYROLL_YEAR = 2100;

/**
 * Is this a month a run may be started for?
 *
 * Returned rather than thrown: this file has no idea which exception type the
 * caller wants, and a util that throws HTTP errors cannot be unit tested
 * without the framework that defines them.
 */
export function isValidPeriod(month: number, year: number): boolean {
  return (
    Number.isInteger(month) &&
    Number.isInteger(year) &&
    month >= 1 &&
    month <= 12 &&
    year >= MIN_PAYROLL_YEAR &&
    year <= MAX_PAYROLL_YEAR
  );
}

/**
 * The first and last day of a month, as day keys.
 *
 * Built in UTC because a day key has no zone: `2026-02-28` is the same three
 * numbers in Muscat and in Los Angeles, and the moment a zone is applied one of
 * them starts reading the day before.
 */
export function periodFor(month: number, year: number): PayrollPeriod {
  if (!isValidPeriod(month, year)) {
    throw new RangeError(`Not a payroll period: month ${month}, year ${year}`);
  }
  const start = DateTime.fromObject({ year, month, day: 1 }, { zone: 'utc' });
  return {
    periodStart: start.toFormat('yyyy-MM-dd'),
    periodEnd: start.endOf('month').toFormat('yyyy-MM-dd'),
  };
}

/** Every day key from `start` to `end` inclusive, ascending. */
export function eachDayKey(start: string, end: string): string[] {
  if (!DAY_KEY_PATTERN.test(start) || !DAY_KEY_PATTERN.test(end)) return [];
  const from = DateTime.fromFormat(start, 'yyyy-MM-dd', { zone: 'utc' });
  const to = DateTime.fromFormat(end, 'yyyy-MM-dd', { zone: 'utc' });
  if (!from.isValid || !to.isValid || to < from) return [];

  const keys: string[] = [];
  for (let d = from; d <= to; d = d.plus({ days: 1 })) {
    keys.push(d.toFormat('yyyy-MM-dd'));
  }
  return keys;
}

/**
 * How many of these days the branch calendar calls working days.
 *
 * The predicate is injected rather than imported so this stays pure and the
 * caller keeps supplying the one calendar the rest of the app already uses —
 * two definitions of "working day" is how a payslip and an attendance report
 * start disagreeing about the same month.
 */
export function countWorkingDays(
  dayKeys: string[],
  isWorking: WorkingDayPredicate,
): number {
  return dayKeys.reduce(
    (total, key) => (isWorking(key) ? total + 1 : total),
    0,
  );
}

/** The month before this one, wrapping the year. */
export function previousPeriod(
  month: number,
  year: number,
): { month: number; year: number } {
  return month === 1
    ? { month: 12, year: year - 1 }
    : { month: month - 1, year };
}

/** `2026-08-01` → `Aug 2026`. The server owns every bucket label. */
export function periodLabel(periodStart: string | Date): string {
  const dt =
    periodStart instanceof Date
      ? DateTime.fromJSDate(periodStart, { zone: 'utc' })
      : DateTime.fromFormat(periodStart, 'yyyy-MM-dd', { zone: 'utc' });
  return dt.isValid ? dt.toFormat('LLL yyyy') : String(periodStart);
}
