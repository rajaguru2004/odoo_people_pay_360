import { DateTime } from 'luxon';
import type { Attendance } from '@/types/attendance';
import type { MonthCursor } from './monthGrid';

/**
 * One person's own day, as their self-service screen has to reason about it.
 *
 * Pure, so the punch state machine can be exercised without a clock or a
 * network. The check-in screen and anything that later shows the same state on
 * a dashboard tile have to agree about what "still working" means, and the
 * cheapest way to guarantee that is to have one function say so.
 */

/**
 * What the person can do next.
 *
 * `OFF` is deliberately distinct from `NOT_STARTED`. A rest day with no punch
 * is not somebody who has failed to arrive, and offering a check-in button on
 * one invites a punch the server will file against a day nobody was expected.
 */
export type PunchState = 'OFF' | 'NOT_STARTED' | 'WORKING' | 'DONE';

const NON_WORKING = new Set(['WEEKEND', 'HOLIDAY', 'ON_LEAVE']);

export function punchState(record: Attendance | null | undefined): PunchState {
  if (!record) return 'NOT_STARTED';
  if (NON_WORKING.has(record.status)) return 'OFF';
  if (record.checkIn && !record.checkOut) return 'WORKING';
  if (record.checkIn && record.checkOut) return 'DONE';
  return 'NOT_STARTED';
}

/** What the primary button on the today card says, and whether there is one. */
export function punchAction(
  state: PunchState,
): { action: 'CHECK_IN' | 'CHECK_OUT'; label: string } | null {
  if (state === 'NOT_STARTED') return { action: 'CHECK_IN', label: 'Check in' };
  if (state === 'WORKING') return { action: 'CHECK_OUT', label: 'Check out' };
  return null;
}

/**
 * "2h 14m" between two instants.
 *
 * Minutes, never seconds. A running total that ticks every second is a moving
 * target on a screen people leave open, and the number nobody can read is the
 * one that changes while they are reading it. An interval that has gone
 * backwards — a clock correction while somebody was checked in — reads as an em
 * dash rather than as a negative duration.
 */
export function elapsedLabel(
  from: string | Date | null | undefined,
  to: string | Date = new Date(),
): string {
  if (!from) return '—';
  const start = from instanceof Date ? from.getTime() : Date.parse(from);
  const end = to instanceof Date ? to.getTime() : Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—';

  const minutes = Math.floor((end - start) / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

/** The `YYYY-MM-DD` bounds of a month, for the history query. */
export function monthRange(cursor: MonthCursor): {
  startDate: string;
  endDate: string;
} {
  const start = DateTime.fromObject(
    { year: cursor.year, month: cursor.month, day: 1 },
    { zone: 'utc' },
  );
  return {
    startDate: start.toFormat('yyyy-MM-dd'),
    endDate: start.endOf('month').toFormat('yyyy-MM-dd'),
  };
}

/** Today's `YYYY-MM-DD` in the company's zone, not the browser's. */
export function todayKey(zone = 'Asia/Muscat', now: Date = new Date()): string {
  return DateTime.fromJSDate(now, { zone }).toFormat('yyyy-MM-dd');
}

/**
 * The browser's position, or nothing.
 *
 * Resolves rather than rejects when the person refuses or the device cannot
 * answer: a branch without a geofence accepts a punch with no coordinates at
 * all, so a denied permission must not stop somebody clocking in. Where a
 * geofence IS configured the server refuses the punch and says so, which is the
 * right place for that conversation.
 */
export function currentPosition(
  timeoutMs = 8000,
): Promise<{ latitude: number; longitude: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }),
      () => resolve(null),
      { timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}
