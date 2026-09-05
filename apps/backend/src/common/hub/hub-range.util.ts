import { BadRequestException } from '@nestjs/common';

/**
 * The date arithmetic every module hub shares.
 *
 * Extracted verbatim from `attendances/attendance-hub.service.ts`, which was the
 * only hub with a period selector when it was written. The Schedules and
 * Leave & Overtime hubs now draw the same Week / Month / Year control, and three
 * copies of "what does the week before March 1st mean" is three chances to
 * disagree — the kind of disagreement that shows up as two panels on one page
 * reporting different windows and no way for the reader to tell which is right.
 *
 * Everything here is UTC. `playwright.config.ts` pins `timezoneId: 'UTC'` and
 * `TZ=UTC` for the server precisely because local-midnight arithmetic hides a
 * shift on the 31st of the month (T18 in `docs/TEST-PLAN-TIME-SCHEDULES.md`).
 */

/**
 * `today` is a period like any other, not a separate mode: the same ‹ › arrows
 * step back through yesterday, last week, last month or last year, so the
 * reader learns one control rather than two.
 *
 * A hub is free to offer only a subset of tabs — Schedules and Leave open on
 * Week and Month respectively and neither shows `today`, because "the roster
 * for today" and "leave filed today" are not questions anybody opens a module
 * hub with. The type stays whole so the ‹ › arrows keep working either way.
 */
export type HubPeriod = 'today' | 'week' | 'month' | 'year';

export const HUB_PERIODS: readonly HubPeriod[] = ['today', 'week', 'month', 'year'];

/** A UTC-midnight date key rendered as `YYYY-MM-DD`. */
export function key(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n),
  );
}

export function parseDateKey(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) {
    throw new BadRequestException(
      `anchor must be a YYYY-MM-DD date, received "${value}"`,
    );
  }
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // `Date.UTC` rolls out-of-range parts over rather than failing: month 13 is
  // next January and day 45 is a fortnight later, so "2026-13-45" would quietly
  // become 2027-02-14 and the hub would answer for a period nobody asked about.
  // The round-trip is the check.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`anchor is not a real date: "${value}"`);
  }
  return d;
}

/** Monday-first, because the hub's week selector reads "Aug 17 – Aug 23". */
export function startOfWeek(d: Date): Date {
  return addDays(d, -((d.getUTCDay() + 6) % 7));
}

export const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** `null` when there was nothing to divide by — never 0%, which is a claim. */
export function rate(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Refuse a period the hub does not understand rather than guessing at one.
 *
 * Guessing means answering confidently for a window nobody asked about, which
 * is the failure mode this whole file exists to prevent.
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
 * `label` is built here rather than in the browser because what "this week"
 * means depends on the branch working week — a client that assumed Monday
 * would disagree with the numbers beside it every Sunday in Muscat.
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

/**
 * What one bar of the trend counts, for a given period.
 *
 * A day draws hours, a year draws months, everything between draws days. The
 * attendance hub owns the `hour` case (a single day is its arrival curve); the
 * hubs that offer no `today` tab never see it.
 */
export function trendKindFor(period: HubPeriod): 'hour' | 'day' | 'month' {
  if (period === 'today') return 'hour';
  if (period === 'year') return 'month';
  return 'day';
}

/**
 * The key and label one trend bucket wears.
 *
 * A year collapses its days into `2026-08` / `Aug`; every other period keeps
 * the day, `2026-08-23` / `Aug 23`. Pulled out of the attendance hub's day-loop
 * so three hubs cannot label the same bar three ways.
 */
export function bucketOf(period: HubPeriod, day: Date): { key: string; label: string } {
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
