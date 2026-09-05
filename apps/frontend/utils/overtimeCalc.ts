/**
 * Client-side overtime arithmetic — for the FORM, and nothing else.
 *
 * ## What this is not
 *
 * It is not a second copy of the pay engine. The server owns the tier split, the
 * day classification and the allowances, because those depend on the employee's
 * overtime policy and on the branch calendar, neither of which the browser has.
 * A page that recomputed them from the global settings would show REGULAR where
 * the server said LATE — on the screen that decides the money. Wherever a real
 * breakdown is needed, read `preview` off the request.
 *
 * What lives here is the one thing the form genuinely needs before it can post:
 * how long the window the user typed actually is, so the `hours` field can be
 * filled in and the "we disagree" 400 avoided.
 *
 * ## Wall clock tagged UTC
 *
 * Overtime times are stored tz-naive tagged UTC: an entered 17:30 goes up as
 * "…T17:30:00Z" and comes back the same. Building them with `new Date(y, m, d,
 * h)` — a LOCAL constructor — shifts the hour by the browser's offset, so an
 * Omani employee filing 17:30 would post 13:30 and be told their hours do not
 * match the window they just typed.
 */

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const WALL_CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" as minutes past midnight, or null when it is not a wall clock. */
export function parseWallClock(value: string | null | undefined): number | null {
  const match = WALL_CLOCK.exec((value ?? '').trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes past midnight as "HH:MM", for putting a server time into an input. */
export function formatWallClock(minutes: number): string {
  const safe = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

/**
 * A date-only key plus a wall clock, as the instant the API stores.
 *
 * Null when either part is unusable, so a half-filled form posts nothing rather
 * than an instant built from a default nobody chose.
 */
export function toOvertimeInstant(
  dayKey: string,
  time: string,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;
  const minutes = parseWallClock(time);
  if (minutes === null) return null;
  return `${dayKey}T${formatWallClock(minutes)}:00.000Z`;
}

/**
 * How long the typed window is, in hours.
 *
 * An end at or before the start is read as CROSSING MIDNIGHT, exactly as the
 * server reads it — a 22:00–02:00 shift is four hours, and the naive
 * subtraction that makes it minus twenty is how a night worker is told their
 * request is nonsense.
 *
 * Rounded to two places because that is the precision the `hours` column holds,
 * and a figure with more of them cannot round-trip.
 */
export function windowHours(
  startTime: string,
  endTime: string,
): number | null {
  const start = parseWallClock(startTime);
  const end = parseWallClock(endTime);
  if (start === null || end === null) return null;

  const minutes = end > start ? end - start : end + 1440 - start;
  return Math.round((minutes / 60) * 100) / 100;
}

/** The same, from two instants — for a request already filed. */
export function hoursBetween(
  startIso: string,
  endIso: string,
): number | null {
  const start = new Date(startIso).getTime();
  let end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) end += MS_PER_DAY;
  return Math.round(((end - start) / MS_PER_HOUR) * 100) / 100;
}

/**
 * The time of day an overtime instant means, read in UTC.
 *
 * Deliberately NOT the browser's zone: these instants are wall clocks tagged
 * UTC, so reading them locally shows an Omani 17:30 as 21:30 to anyone in the
 * Gulf and as 13:30 to anyone in London — three different answers to what one
 * employee typed.
 */
export function overtimeTimeOfDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * A worked window as "17:30 – 23:00", with a marker when it crosses midnight.
 *
 * The "+1" matters: without it a 22:00 – 02:00 shift reads as four hours going
 * backwards.
 */
export function formatOvertimeWindow(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): string {
  if (!startIso || !endIso) return '—';
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '—';

  const crossesMidnight =
    end.getUTCDate() !== start.getUTCDate() ||
    end.getUTCMonth() !== start.getUTCMonth();

  return `${overtimeTimeOfDay(startIso)} – ${overtimeTimeOfDay(endIso)}${
    crossesMidnight ? ' (+1)' : ''
  }`;
}

/** Hours to one decimal, with the unit. `null` prints an em dash, never "0h". */
export function formatHours(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n * 10) / 10}h`;
}

export interface TierRow {
  key: 'regularHours' | 'lateHours' | 'doubleHours' | 'doubleLateHours';
  label: string;
  hours: number;
  rate: number;
}

/**
 * The non-zero tiers of a breakdown, in the order they are worked.
 *
 * Zero buckets are dropped rather than drawn: a weekday request has two empty
 * double-tier rows, and four lines where two are always "0h" trains the reader
 * to stop looking at the column that matters.
 */
export function tierRows(breakdown: {
  regularHours: number | string;
  lateHours: number | string;
  doubleHours: number | string;
  doubleLateHours: number | string;
  regularRate?: number;
  lateRate?: number;
  doubleRate?: number;
  doubleLateRate?: number;
}): TierRow[] {
  const num = (v: number | string) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return Number.isFinite(n) ? n : 0;
  };

  const rows: TierRow[] = [
    {
      key: 'regularHours',
      label: 'Regular',
      hours: num(breakdown.regularHours),
      rate: breakdown.regularRate ?? 0,
    },
    {
      key: 'lateHours',
      label: 'Late',
      hours: num(breakdown.lateHours),
      rate: breakdown.lateRate ?? 0,
    },
    {
      key: 'doubleHours',
      label: 'Rest day',
      hours: num(breakdown.doubleHours),
      rate: breakdown.doubleRate ?? 0,
    },
    {
      key: 'doubleLateHours',
      label: 'Rest day, late',
      hours: num(breakdown.doubleLateHours),
      rate: breakdown.doubleLateRate ?? 0,
    },
  ];

  return rows.filter((row) => row.hours > 0);
}
