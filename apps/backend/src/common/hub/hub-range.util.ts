import { BadRequestException } from '@nestjs/common';

/**
 * The date arithmetic a module hub's period selector rests on.
 *
 * Extracted so the Leave & Overtime hub and any hub that follows it cannot
 * disagree about what "the week before the 1st of March" means. Two panels on
 * one page reporting different windows, with nothing on screen saying which is
 * right, is the failure this file exists to prevent.
 *
 * Everything is UTC. Date-only columns are stored at UTC midnight, and
 * local-midnight arithmetic silently shifts a whole month on the 31st for any
 * server west of Greenwich.
 */

export type HubPeriod = 'today' | 'week' | 'month' | 'year';

export const HUB_PERIODS: readonly HubPeriod[] = [
  'today',
  'week',
  'month',
  'year',
];

/** A UTC-midnight date rendered as `YYYY-MM-DD`. */
export function key(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n),
  );
}

/**
 * Strict `YYYY-MM-DD`.
 *
 * `Date.UTC` rolls out-of-range parts over rather than failing — month 13 is
 * next January and day 45 is a fortnight later — so `2026-13-45` would quietly
 * become 2027-02-14 and the hub would answer confidently for a period nobody
 * asked about. The round-trip is the check.
 */
export function parseDateKey(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) {
    throw new BadRequestException(
      `anchor must be a YYYY-MM-DD date, received "${value}"`,
    );
  }
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`anchor is not a real date: "${value}"`);
  }
  return d;
}

/** Monday-first, because the selector reads "Aug 17 – Aug 23". */
export function startOfWeek(d: Date): Date {
  return addDays(d, -((d.getUTCDay() + 6) % 7));
}

export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** `null` when there was nothing to divide by — never 0%, which is a claim. */
export function rate(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Refuse a period the hub does not understand rather than guessing at one.
 *
 * Guessing means answering confidently for a window nobody asked about, which a
 * page has no way to show its reader.
 */
export function assertPeriod(period: string): asserts period is HubPeriod {
  if (!HUB_PERIODS.includes(period as HubPeriod)) {
    throw new BadRequestException(
      `period must be one of today|week|month|year, received "${period}"`,
    );
  }
}

export interface HubRange {
  start: Date;
  end: Date;
  prevAnchor: Date;
  nextAnchor: Date;
  label: string;
}

/**
 * The window a period + anchor names, and how to step off it.
 *
 * `label` is built on the server so the browser does no calendar arithmetic:
 * `Aug 2026` arrives formatted, and a client that assumed a Monday week would
 * disagree with the numbers beside it.
 */
export function resolveRange(period: HubPeriod, anchor: Date): HubRange {
  if (period === 'today') {
    return {
      start: anchor,
      end: anchor,
      prevAnchor: addDays(anchor, -1),
      nextAnchor: addDays(anchor, 1),
      label: `${MONTHS[anchor.getUTCMonth()]} ${anchor.getUTCDate()}`,
    };
  }
  if (period === 'week') {
    const start = startOfWeek(anchor);
    const end = addDays(start, 6);
    const sameMonth = start.getUTCMonth() === end.getUTCMonth();
    return {
      start,
      end,
      prevAnchor: addDays(start, -7),
      nextAnchor: addDays(start, 7),
      label: sameMonth
        ? `${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()} – ${end.getUTCDate()}`
        : `${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()} – ${MONTHS[end.getUTCMonth()]} ${end.getUTCDate()}`,
    };
  }
  if (period === 'year') {
    const y = anchor.getUTCFullYear();
    return {
      start: new Date(Date.UTC(y, 0, 1)),
      end: new Date(Date.UTC(y, 11, 31)),
      prevAnchor: new Date(Date.UTC(y - 1, 0, 1)),
      nextAnchor: new Date(Date.UTC(y + 1, 0, 1)),
      label: `${y}`,
    };
  }
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1)),
    end: new Date(Date.UTC(y, m + 1, 0)),
    prevAnchor: new Date(Date.UTC(y, m - 1, 1)),
    nextAnchor: new Date(Date.UTC(y, m + 1, 1)),
    label: `${MONTHS[m]} ${y}`,
  };
}

/** What one bar of the trend counts, for a given period. */
export function trendKindFor(period: HubPeriod): 'hour' | 'day' | 'month' {
  if (period === 'today') return 'hour';
  if (period === 'year') return 'month';
  return 'day';
}

/**
 * The key and label one trend bucket wears.
 *
 * A year collapses its days into `2026-08` / `Aug`; every other period keeps the
 * day. The server owns the label so no two hubs can name the same bar two ways.
 */
export function bucketOf(
  period: HubPeriod,
  day: Date,
): { key: string; label: string } {
  if (period === 'year') {
    return {
      key: `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}`,
      label: MONTHS[day.getUTCMonth()],
    };
  }
  return {
    key: key(day),
    label: `${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`,
  };
}

/** Every UTC-midnight date from `start` to `end` inclusive. */
export function eachDay(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    days.push(d);
  }
  return days;
}
