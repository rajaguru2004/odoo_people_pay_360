/**
 * scheduleHours.ts — the shift arithmetic the schedule screens agree on.
 *
 * `app/dashboard/schedules/overview/page.tsx` and
 * `app/dashboard/schedules/shifts/page.tsx` each carried their own copy of
 * `minutesOfDayInTZ`, the lunch-deduction rule and the work-hours calculation,
 * and both copies carried a comment claiming to "mirror the backend rule". Two
 * copies of a rule that must match a third implementation is a divergence
 * waiting to happen, so the rule lives here once and both screens consume it.
 *
 * NOTE ON `toCalendarDate` vs `tzDate.toLocalDateStr`: they are NOT the same
 * operation and neither replaces the other.
 *   - `tzDate.toLocalDateStr(v, tz)` reads `v` as a UTC instant and asks which
 *     calendar day it falls on IN `tz`. That is what an attendance timestamp
 *     needs.
 *   - `toCalendarDate(d)` takes a Date that was CONSTRUCTED from local calendar
 *     parts (`new Date(2026, 7, 1)` — local midnight) and asks which calendar
 *     day it already is. No conversion happens, because none is wanted.
 * Calling `.toISOString().slice(0, 10)` on the second kind is the bug this file
 * exists to stop: at a positive UTC offset local midnight is the PREVIOUS day in
 * UTC, so a month range built that way silently loses its last day.
 */

/** Lunch break as the system settings express it. */
export interface LunchPolicy {
  /** Minutes past local midnight at which lunch starts (13:00 → 780). */
  startMinutes: number;
  /** Length of the break. 0 disables the deduction entirely. */
  durationMinutes: number;
}

/**
 * One shift, in the loosest shape either screen has on hand. The overview reads
 * `WorkSchedule` rows from `/calendar/overview`; the shift screen reads merged
 * calendar EVENTS from `/calendar/my-calendar`, which carry no `isWorkDay`.
 * Both shapes reduce to this.
 */
export interface ShiftHoursInput {
  /** Absent means "a working day" — the events feed does not carry the flag. */
  isWorkDay?: boolean | null;
  shiftType?: string | null;
  /** Set for FLEXIBLE shifts; the target hours ARE the worked hours. */
  requiredHours?: number | string | null;
  start?: string | Date | null;
  end?: string | Date | null;
}

export interface HoursOptions {
  lunch: LunchPolicy;
  /** IANA zone the lunch window is expressed in (the company timezone). */
  timeZone: string;
}

export const DEFAULT_LUNCH: LunchPolicy = {
  startMinutes: 13 * 60,
  durationMinutes: 60,
};

/**
 * Minutes past midnight that `date` represents in `timeZone`.
 *
 * Falls back to the host's own clock reading when the zone is unusable, which
 * keeps a bad `system_timezone` setting from blanking every hours figure on the
 * page. The fallback is deliberately not silent-zero: reporting the host's
 * reading is wrong by an offset, reporting zero is wrong by a whole day.
 */
export function minutesOfDayInTZ(date: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return h * 60 + m;
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

/**
 * Whether a shift spanning `startMins`..`endMins` (minutes past midnight) is
 * open at `lunchStart`.
 *
 * The end is EXCLUSIVE and the start INCLUSIVE, so a shift that begins exactly
 * at lunch loses the break and one that ends exactly at it does not — the rule
 * `calendar.service.ts` applies. When the end is at or before the start the
 * shift ran past midnight, and the window is the union of the two halves.
 */
export function spanCoversLunch(
  startMins: number,
  endMins: number,
  lunchStart: number,
): boolean {
  return endMins > startMins
    ? startMins <= lunchStart && lunchStart < endMins
    : lunchStart >= startMins || lunchStart < endMins;
}

/** One decimal place — every hours figure on these screens is shown that way. */
export function roundHours(hours: number): number {
  return Math.round(hours * 10) / 10;
}

/**
 * Hours a single shift is worth, UNROUNDED.
 *
 * Rounding is left to the caller on purpose: the overview rounds per cell and
 * sums the rounded values so its tiles reconcile with the grid, while the shift
 * screen sums raw and rounds once. Baking either choice in here would silently
 * change the other screen's totals.
 *
 * Precedence, matching the server:
 *   1. A non-working day is worth nothing.
 *   2. A FLEXIBLE shift is worth its target hours, and never loses a lunch
 *      break — there is no window for the break to fall inside.
 *   3. A fixed-window shift is `end - start`, less the lunch break when the
 *      window is open across lunch.
 */
export function workHoursOf(shift: ShiftHoursInput, opts: HoursOptions): number {
  if (shift.isWorkDay === false) return 0;

  const flexible =
    shift.shiftType === 'FLEXIBLE' ||
    (shift.requiredHours !== null && shift.requiredHours !== undefined);
  if (flexible) {
    const target = Number(shift.requiredHours);
    return Number.isFinite(target) && target > 0 ? target : 0;
  }

  if (!shift.start || !shift.end) return 0;
  const start = new Date(shift.start);
  const end = new Date(shift.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;

  const rawHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
  if (rawHours <= 0) return 0;
  if (opts.lunch.durationMinutes <= 0) return rawHours;

  const covers = spanCoversLunch(
    minutesOfDayInTZ(start, opts.timeZone),
    minutesOfDayInTZ(end, opts.timeZone),
    opts.lunch.startMinutes,
  );
  return covers
    ? Math.max(0, rawHours - opts.lunch.durationMinutes / 60)
    : rawHours;
}

/**
 * Overtime a scheduled shift implies: whatever it is worth beyond the standard
 * working day. Never negative — a short shift is short, not negative overtime.
 */
export function scheduledOvertimeOf(
  shift: ShiftHoursInput,
  opts: HoursOptions & { standardHoursPerDay: number },
): number {
  const worked = workHoursOf(shift, opts);
  const over = worked - opts.standardHoursPerDay;
  return over > 0 ? over : 0;
}

/**
 * The calendar day `date` already represents, as `YYYY-MM-DD`.
 *
 * Use this for any Date built from local calendar parts. `toISOString()` is the
 * wrong tool there and loses a day at one end of the month or the other,
 * depending on the sign of the host's UTC offset.
 */
export function toCalendarDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Today, in the host's own zone, as `YYYY-MM-DD`.
 *
 * The correct replacement for `new Date().toISOString().split('T')[0]`, which
 * is a subtler trap than the same call on a locally-built midnight: `new Date()`
 * is a real instant, so it only slides while the local time of day is EARLIER
 * than the UTC offset. At Asia/Kolkata that is 00:00–05:29 local and nothing
 * else — a default date filter that silently reads "yesterday" for five and a
 * half hours a day and is correct for the other eighteen and a half.
 *
 * Ask yourself WHOSE day you mean before reaching for this. It answers "the
 * viewer's day". If the screen means the COMPANY's day — an attendance
 * register, a payroll cutoff — use `todayStr()` from `@/utils/tzDate`, which
 * resolves the configured timezone instead of the browser's.
 */
export function nowCalendarDate(now: Date = new Date()): string {
  return toCalendarDate(now);
}

/**
 * First and last calendar day of the month `anchor` falls in, as the
 * `YYYY-MM-DD` strings `/calendar/*` expects.
 *
 * Both schedule screens asked for their month this way and both lost a day
 * doing it, which is why the range is built here rather than at each call site.
 */
export function monthBounds(anchor: Date): { start: string; end: string } {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  return {
    start: toCalendarDate(new Date(year, month, 1)),
    end: toCalendarDate(new Date(year, month + 1, 0)),
  };
}

/**
 * A `YYYY-MM-DD` string as a LOCAL-midnight Date.
 *
 * The inverse of `toCalendarDate`, and the missing half of the pair. `new
 * Date('2026-03-01')` parses a bare date string as UTC midnight, so at a
 * NEGATIVE offset the resulting Date is already the previous day locally — and
 * any code that then reads `getDay()` or `getDate()` off it is reasoning about
 * the wrong day. That is not the same bug as `toISOString()` on a local
 * midnight; it is its mirror image, and it bites at the opposite sign of offset.
 */
export function parseCalendarDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/**
 * Every calendar day from `start` to `end` inclusive, as local Dates.
 *
 * Written as an explicit day counter rather than by mutating one Date with
 * `setDate(getDate() + 1)`: that idiom mixes a UTC-parsed instant with
 * local-calendar mutation, and at a negative UTC offset it silently skips the
 * first day of the range and shifts every weekday by one — which is exactly how
 * a bulk roster came to apply its skip-days to the wrong days of the week.
 */
export function datesBetween(start: string, end: string): Date[] {
  const from = parseCalendarDate(start);
  const to = parseCalendarDate(end);
  const days: Date[] = [];
  for (
    let cursor = new Date(from);
    cursor <= to;
    cursor = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate() + 1,
    )
  ) {
    days.push(cursor);
  }
  return days;
}

/** Every calendar day of the month `anchor` falls in, as local Dates. */
export function daysOfMonth(anchor: Date): Date[] {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const count = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: count }, (_, i) => new Date(year, month, i + 1));
}

/**
 * Parse `calendar_weekly_holidays` / `Branch.weeklyOffDays` — a CSV of day
 * numbers where 0 is Sunday.
 *
 * A blank or unparseable value falls back to Sunday rather than to "no rest
 * day": a branch with no configured week-end still has one, and rendering none
 * would state something the business never said. Out-of-range entries are
 * dropped rather than wrapped, so `'7'` cannot silently become Sunday.
 */
export function parseWeeklyOffDays(
  csv: string | null | undefined,
  fallback: number[] = [0],
): number[] {
  if (typeof csv !== 'string' || csv.trim() === '') return fallback;
  const days = csv
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return days.length > 0 ? days : fallback;
}
