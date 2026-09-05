import { DateTime } from 'luxon';
import { SCHEDULE_PERIODS, type SchedulePeriod } from './dto/hub-summary.dto';

/**
 * The window a period and an anchor describe, plus the anchors either side.
 *
 * Separate from the attendance hub's resolver rather than shared with it,
 * because the two hubs disagree about time in a way that is not cosmetic:
 *
 *  - Attendance has a `today` period; this one does not. "Who is on today" is a
 *    calendar question, and a scheduler opens this module to ask whether the
 *    coming WEEK is covered. Week leads and is the default.
 *  - Attendance never aggregates past today — a day that has not happened cannot
 *    be an absence. A roster is a PLAN, so reading ahead is the point of it, and
 *    every window here spans its full range whether or not it has arrived.
 *
 * The client hands `prevAnchor`/`nextAnchor` straight back on the ‹ › stepper
 * and never does calendar arithmetic of its own, which is also why every label
 * below is built here rather than in the browser.
 */

export interface ScheduleRange {
  start: string;
  end: string;
  label: string;
  prevAnchor: string;
  nextAnchor: string;
}

/** What one bar of the trend counts. */
export type TrendKind = 'day' | 'month';

/**
 * How far ahead the stepper may walk.
 *
 * A roster three years out is empty by definition, and paging into a wall of
 * zeros reads as a broken dashboard rather than as an unrostered future.
 */
export const MAX_FORWARD_DAYS = 366;

const key = (d: DateTime) => d.toFormat('yyyy-MM-dd');

function rangeLabel(start: DateTime, end: DateTime): string {
  if (start.hasSame(end, 'day')) return start.toFormat('ccc, d LLL yyyy');
  if (start.hasSame(end, 'month')) {
    return `${start.toFormat('d')} – ${end.toFormat('d LLL yyyy')}`;
  }
  if (start.hasSame(end, 'year')) {
    return `${start.toFormat('d LLL')} – ${end.toFormat('d LLL yyyy')}`;
  }
  return `${start.toFormat('d LLL yyyy')} – ${end.toFormat('d LLL yyyy')}`;
}

export function isSchedulePeriod(value: unknown): value is SchedulePeriod {
  return SCHEDULE_PERIODS.includes(value as SchedulePeriod);
}

export function resolveScheduleRange(
  period: SchedulePeriod,
  anchor: DateTime,
): ScheduleRange {
  switch (period) {
    case 'month': {
      const start = anchor.startOf('month');
      const end = anchor.endOf('month').startOf('day');
      return {
        start: key(start),
        end: key(end),
        label: start.toFormat('LLLL yyyy'),
        prevAnchor: key(anchor.minus({ months: 1 })),
        nextAnchor: key(anchor.plus({ months: 1 })),
      };
    }
    case 'year': {
      const start = anchor.startOf('year');
      const end = anchor.endOf('year').startOf('day');
      return {
        start: key(start),
        end: key(end),
        label: start.toFormat('yyyy'),
        prevAnchor: key(anchor.minus({ years: 1 })),
        nextAnchor: key(anchor.plus({ years: 1 })),
      };
    }
    default: {
      // ISO weeks, Monday-first. The branch working week varies across the
      // region, but the CHART's week has to be one thing or two branches would
      // draw bars for different seven-day windows on the same axis.
      const start = anchor.startOf('week');
      const end = start.plus({ days: 6 });
      return {
        start: key(start),
        end: key(end),
        label: rangeLabel(start, end),
        prevAnchor: key(anchor.minus({ weeks: 1 })),
        nextAnchor: key(anchor.plus({ weeks: 1 })),
      };
    }
  }
}

/** A week or a month draws one bar per day; a year draws one per month. */
export function trendKindFor(period: SchedulePeriod): TrendKind {
  return period === 'year' ? 'month' : 'day';
}

/** Which bucket a date falls in, and what the axis calls it. */
export function bucketOf(
  period: SchedulePeriod,
  date: DateTime,
): { key: string; label: string } {
  if (period === 'year') {
    return { key: date.toFormat('yyyy-MM'), label: date.toFormat('LLL') };
  }
  return { key: date.toFormat('yyyy-MM-dd'), label: date.toFormat('d LLL') };
}

/** "12 Mar" for a day key — the label an action item names a date by. */
export function labelForDayKey(dayKey: string): string {
  const parsed = DateTime.fromFormat(dayKey, 'yyyy-MM-dd', { zone: 'utc' });
  return parsed.isValid ? parsed.toFormat('d LLL') : dayKey;
}
