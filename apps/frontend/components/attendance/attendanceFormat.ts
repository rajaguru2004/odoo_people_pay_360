import { DateTime } from 'luxon';
import { TIME_FORMAT } from '@/utils/constants';
import type { AttendanceStatus } from '@/types/attendance';

/**
 * The vocabulary every attendance screen shares.
 *
 * Pure on purpose: a status colour, a rate and a chart axis are decisions that
 * five screens have to make the same way, and the moment one of them inlines
 * its own `${rate}%` the pages start disagreeing about what an unknown number
 * looks like.
 */

export type StatusTone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

// Keyed to main's `AttendanceStatus` union, not the one this file shipped with.
// A tone map that names a status the type does not have is a compile error the
// day someone adds it back, which is the point: the vocabulary and the union
// have to move together.
export const STATUS_TONE: Record<AttendanceStatus, StatusTone> = {
  PRESENT: 'success',
  ABSENT: 'error',
  LEAVE: 'info',
  HOLIDAY: 'info',
  MISSED_CHECKOUT: 'warning',
  NOT_CHECKED_IN: 'neutral',
};

/** `ON_LEAVE` → "On leave". A column of shouting enums is not a table anyone reads. */
export function statusLabel(status: AttendanceStatus): string {
  const words = status.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A rate, or an em dash.
 *
 * `null` means nobody was expected, so there was nothing to divide by. Printing
 * 0% there is a claim that everybody failed to turn up — on a public holiday
 * that is the difference between "the office was closed" and "nobody came in".
 */
export function formatRate(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '—';
  return `${rate.toFixed(digits)}%`;
}

/**
 * Worked hours. Prisma sends a Decimal as a string, so both arrive here.
 *
 * An unrecorded day is an em dash rather than "0.0h": a shift still in progress
 * has no hours yet, and reporting zero says the person clocked in and did
 * nothing.
 */
export function formatHours(hours: string | number | null | undefined): string {
  if (hours === null || hours === undefined || hours === '') return '—';
  const value = typeof hours === 'string' ? Number(hours) : hours;
  if (Number.isNaN(value)) return '—';
  return `${value.toFixed(1)}h`;
}

/** "1h 25m late", or nothing at all when the arrival was inside the grace window. */
export function formatLateness(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return '';
  if (minutes < 60) return `${minutes}m late`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h late` : `${hours}h ${rest}m late`;
}

/**
 * A wall-clock time from an instant, in a named zone.
 *
 * The zone is explicit because two branches punch on two clocks: an 08:00
 * arrival in Muscat read in the reader's own zone is simply the wrong number,
 * and it is wrong silently.
 */
export function formatTimeOfDay(
  value: string | null | undefined,
  zone = 'Asia/Muscat',
): string {
  if (!value) return '—';
  const dt = DateTime.fromISO(value, { zone });
  return dt.isValid ? dt.toFormat(TIME_FORMAT) : '—';
}

/**
 * Percentage-POINT movement between two rates, or undefined when either side is
 * unknown.
 *
 * Points, never a percentage of a percentage: attendance moving 40% → 44% is
 * "up 4 points", and calling it "up 10%" invites the reader to picture ten
 * people who are not there.
 */
export function pointsChange(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | undefined {
  if (current === null || current === undefined) return undefined;
  if (previous === null || previous === undefined) return undefined;
  return Math.round((current - previous) * 10) / 10;
}

/**
 * Five round ticks that clear the tallest bar without towering over it.
 *
 * `ceil(max / 25) * 25` puts a six-person branch on a 0–25 axis, where every bar
 * sits in the bottom fifth of the panel and the shape of the month is invisible.
 * Walk the 1/2/5 decades instead and take the first step that fits.
 */
export function chartAxis(max: number): { max: number; ticks: string[] } {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const step = steps.find((s) => s * 5 >= max) ?? Math.ceil(max / 5);
  return { max: step * 5, ticks: Array.from({ length: 6 }, (_, i) => String(i * step)) };
}

/**
 * "Aisha, Omar and 4 more".
 *
 * `count` is the truth and `names` is only a sample, so a caller that printed
 * the names alone would quietly under-report the problem — three names beside a
 * figure of nineteen is a list the reader believes is the whole set.
 */
export function describeSample(count: number, names: string[], show = 3): string {
  if (count <= 0) return '';
  const shown = names.slice(0, show);
  if (shown.length === 0) return `${count}`;
  const remaining = count - shown.length;
  const listed = shown.join(', ');
  return remaining > 0 ? `${listed} and ${remaining} more` : listed;
}
