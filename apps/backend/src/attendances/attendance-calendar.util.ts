import { DateTime } from 'luxon';
import type { AttendanceStatus } from '@prisma/client';

/**
 * The calendar arithmetic every attendance decision rests on.
 *
 * Deliberately free of Prisma and Nest: these are the rules, and rules that can
 * only be exercised through a database and an injector do not get exercised.
 * Everything zone-aware goes through luxon — `new Date()` arithmetic silently
 * uses the SERVER's offset, which is how an 08:00 shift in Muscat starts being
 * evaluated against a UTC clock four hours earlier.
 */

/** Last resort when neither the employee, the branch nor the company has one. */
export const FALLBACK_TIMEZONE = 'UTC';

/** What a branch that never configured its working day is assumed to run. */
export const DEFAULT_OFFICE_START = '09:00';
export const DEFAULT_OFFICE_END = '17:00';
export const DEFAULT_GRACE_MINUTES = 15;

const MINUTES_PER_DAY = 24 * 60;
const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A date-only value as the API accepts it. Validated, never coerced. */
export const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The bucket employees with no department land in.
 *
 * A literal key rather than a null id: the row is a real bucket on every
 * breakdown and the browser needs something stable to key a list item by.
 */
export const UNASSIGNED_DEPARTMENT = 'unassigned';

export interface ZonedRecord {
  timezone?: string | null;
}

export interface ComputeStatusInput {
  checkIn?: Date | null;
  checkOut?: Date | null;
  /** Hours the roster asked for. Zero or less means "no expectation to test". */
  expected: number;
  graceMinutes: number;
  /** Wall clock, "HH:MM", read in `zone`. */
  officeStart: string;
  zone: string;
}

export interface ComputedStatus {
  status: AttendanceStatus;
  isLate: boolean;
  lateMinutes: number;
  isEarlyLeave: boolean;
  workHours: number | null;
}

/**
 * Employee zone, else branch zone, else company zone.
 *
 * A null on either of the first two means "inherit", not "UTC" — that is the
 * whole reason those columns are nullable rather than defaulted. Blank strings
 * fall through too: a form that submits an empty select is saying the same
 * thing a null says, and reading `''` as a zone throws inside luxon.
 */
export function resolveZone(
  employee?: ZonedRecord | null,
  branch?: ZonedRecord | null,
  companyTimezone?: string | null,
): string {
  const candidates = [employee?.timezone, branch?.timezone, companyTimezone];
  for (const candidate of candidates) {
    const zone = candidate?.trim();
    if (zone) return zone;
  }
  return FALLBACK_TIMEZONE;
}

/** ISO weekday, 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: DateTime | Date): number {
  if (date instanceof Date) {
    // Date-only columns are stored at UTC midnight, so the UTC weekday is the
    // one the row means. Reading the local weekday would shift the whole week
    // for any server west of Greenwich.
    return ((date.getUTCDay() + 6) % 7) + 1;
  }
  return date.weekday;
}

/**
 * Is this date one of the configured weekly rest days?
 *
 * An EMPTY array means "no weekly rest configured", which is not the same claim
 * as "every day is a rest day". Read the other way round it would close every
 * branch that has not filled the field in, and every day would report as a
 * holiday with nobody expected.
 */
export function isWeeklyOff(
  date: DateTime | Date,
  weeklyOffDays: number[] | null | undefined,
): boolean {
  if (!weeklyOffDays?.length) return false;
  return weeklyOffDays.includes(isoWeekday(date));
}

/** "HH:MM" → minutes past local midnight, or null if it is not a wall clock. */
export function parseWallClock(value?: string | null): number | null {
  const match = WALL_CLOCK.exec(value?.trim() ?? '');
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Length of a shift window given as two wall clocks.
 *
 * An end at or before the start crosses midnight — a night shift of
 * "22:00"–"06:00" is eight hours, and the naive subtraction that makes it minus
 * sixteen turns every night worker into a payroll anomaly. Equal clocks are a
 * zero-length window rather than a full 24 hours: an unconfigured pair is far
 * likelier than a genuine round-the-clock shift, and zero is the answer callers
 * can detect and fall back from.
 */
export function expectedHours(officeStart: string, officeEnd: string): number {
  const start = parseWallClock(officeStart);
  const end = parseWallClock(officeEnd);
  if (start === null || end === null) return 0;
  if (start === end) return 0;
  const minutes = end > start ? end - start : end + MINUTES_PER_DAY - start;
  return round2(minutes / 60);
}

/**
 * Hours between two punches.
 *
 * Null when either is missing — an open shift has no length yet — and null
 * again when the check-out precedes the check-in, which is a data error rather
 * than negative work. Returning the negative would let it sum into a month's
 * total and quietly reduce it.
 */
export function workHoursBetween(
  checkIn?: Date | null,
  checkOut?: Date | null,
): number | null {
  if (!checkIn || !checkOut) return null;
  const ms = checkOut.getTime() - checkIn.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return round2(ms / 3_600_000);
}

/**
 * Minutes between the shift start and the punch — negative when early.
 *
 * The shift start is the nearest occurrence of `officeStart` to the punch, not
 * the one on the punch's own calendar date. For a night shift starting at 22:00
 * a 00:10 arrival belongs to YESTERDAY's start; measuring it against today's
 * would report it as twenty-two hours early rather than ten minutes late.
 */
export function minutesFromShiftStart(
  checkIn: Date,
  officeStart: string,
  zone: string,
): number | null {
  const start = parseWallClock(officeStart);
  if (start === null) return null;

  const local = DateTime.fromJSDate(checkIn, { zone });
  if (!local.isValid) return null;

  let shiftStart = local.set({
    hour: Math.floor(start / 60),
    minute: start % 60,
    second: 0,
    millisecond: 0,
  });

  const delta = local.diff(shiftStart, 'minutes').minutes;
  if (delta > MINUTES_PER_DAY / 2) shiftStart = shiftStart.plus({ days: 1 });
  else if (delta < -MINUTES_PER_DAY / 2)
    shiftStart = shiftStart.minus({ days: 1 });

  // Re-diffed rather than adjusted by a flat 1440: across a DST boundary the
  // day that was added is not 24 hours long.
  return local.diff(shiftStart, 'minutes').minutes;
}

/**
 * The verdict for one day's punches.
 *
 * `lateMinutes` is measured from the START of the shift, never from the end of
 * the grace window: grace forgives a late arrival, it does not move the shift.
 * Reporting it from the end of grace understates every late arrival by exactly
 * the grace period, which is the number an employee would notice first.
 *
 * It is 0 rather than null for an on-time arrival so a month's report can sum
 * the column without a null check.
 */
export function computeStatus(input: ComputeStatusInput): ComputedStatus {
  const { checkIn, checkOut, expected, graceMinutes, officeStart, zone } =
    input;

  if (!checkIn) {
    return {
      status: 'ABSENT',
      isLate: false,
      lateMinutes: 0,
      isEarlyLeave: false,
      workHours: null,
    };
  }

  const workHours = workHoursBetween(checkIn, checkOut);
  const delta = minutesFromShiftStart(checkIn, officeStart, zone);
  const grace = Math.max(0, graceMinutes || 0);
  const isLate = delta !== null && delta > grace;
  const lateMinutes = isLate ? Math.round(delta) : 0;

  // Early leave is measured against the hours owed, not against a clock time:
  // `officeEnd` is already baked into `expected`, and a shift that ends at
  // midnight has no "end time" a comparison would survive. Only a CLOSED day
  // can be short — an open shift has simply not finished yet.
  const isEarlyLeave =
    workHours !== null && expected > 0 && workHours < expected;

  // Half-day beats late when both apply. Late is a fact about the arrival;
  // half-day is a fact about the day's pay, and the pay fact is the one the
  // payroll run has to see in the status column.
  const isHalfDay =
    workHours !== null && expected > 0 && workHours < expected / 2;

  const status: AttendanceStatus = isHalfDay
    ? 'HALF_DAY'
    : isLate
      ? 'LATE'
      : 'PRESENT';

  return { status, isLate, lateMinutes, isEarlyLeave, workHours };
}

/**
 * Great-circle distance in metres.
 *
 * Used by the geofence, where the distances involved are a few hundred metres
 * and the earth is close enough to a sphere that the ellipsoidal correction is
 * far below the accuracy of a phone's GPS fix.
 */
export function haversineMetres(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const EARTH_RADIUS_M = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  return round2(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a))));
}

/** "YYYY-MM-DD" for a date-only column or a zoned instant. */
export function toDayKey(date: DateTime | Date): string {
  if (date instanceof Date) {
    return DateTime.fromJSDate(date, { zone: 'utc' }).toFormat('yyyy-MM-dd');
  }
  return date.toFormat('yyyy-MM-dd');
}

/**
 * "YYYY-MM-DD" → the UTC midnight Prisma stores in a `@db.Date` column.
 *
 * Never `new Date('2026-01-15')` plus a local-time constructor: a date-only
 * value put through a zone conversion lands on the 14th anywhere west of
 * Greenwich, and the row then joins to the wrong day for ever.
 */
export function dayKeyToDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/** Strict "YYYY-MM-DD" parse. Null for anything else — never a silent today. */
export function parseDayKey(value?: string | null): DateTime | null {
  if (!value) return null;
  const parsed = DateTime.fromFormat(value.trim(), 'yyyy-MM-dd', {
    zone: 'utc',
  });
  return parsed.isValid ? parsed : null;
}

/** Percentage to one decimal, or null when there is nothing to divide by. */
export function rate(numerator: number, denominator: number): number | null {
  if (!denominator || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
