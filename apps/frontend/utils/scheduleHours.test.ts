import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LUNCH,
  datesBetween,
  daysOfMonth,
  minutesOfDayInTZ,
  monthBounds,
  nowCalendarDate,
  parseCalendarDate,
  parseWeeklyOffDays,
  roundHours,
  scheduledOvertimeOf,
  spanCoversLunch,
  toCalendarDate,
  workHoursOf,
} from './scheduleHours';

/**
 * The shift arithmetic both schedule screens read from, and the date helper
 * that replaces `toISOString()` on locally-constructed Dates.
 *
 * Two properties are worth stating before the cases, because they are what make
 * these tests meaningful rather than tautological:
 *
 *   1. The hours rules are a MIRROR of `calendar.service.ts`. A mirror is only
 *      useful while the two agree, so each boundary here (lunch open/closed at
 *      the exact minute, flexible never deducted) names the server rule it
 *      copies. The backend suite asserts the same boundaries against the DB.
 *
 *   2. The date cases are deliberately written so they hold in EVERY host
 *      timezone. `toCalendarDate(new Date(2026, 7, 1))` is '2026-08-01' whether
 *      the runner sits at UTC, +05:30 or -05:00 — which is exactly the property
 *      `.toISOString().slice(0, 10)` fails. That means these cases cannot, on
 *      their own, prove the screens were fixed: under the Playwright default of
 *      `timezoneId: 'UTC'` the old code passes too. The browser regression that
 *      does prove it pins a non-UTC zone; see `time-schedule-overview.spec.ts`.
 */

/** The company timezone every fixed-window case is expressed against. */
const TZ = 'Asia/Kolkata';

/** A shift's UTC window, as the API returns it. */
const utc = (date: string, time: string) => `${date}T${time}:00.000Z`;

const opts = (
  over: Partial<{ startMinutes: number; durationMinutes: number }> = {},
  timeZone = 'UTC',
) => ({
  lunch: { ...DEFAULT_LUNCH, ...over },
  timeZone,
});

// ── Lunch window ────────────────────────────────────────────────────────────
describe('spanCoversLunch', () => {
  const LUNCH = 13 * 60; // 13:00

  it('is open when lunch falls strictly inside the window', () => {
    expect(spanCoversLunch(9 * 60, 18 * 60, LUNCH)).toBe(true);
  });

  it('is open when the shift begins exactly at lunch', () => {
    // Start is inclusive: a shift starting at 13:00 loses the break, which is
    // the rule the server applies (`startMins <= lunchStart`).
    expect(spanCoversLunch(13 * 60, 18 * 60, LUNCH)).toBe(true);
  });

  it('is closed when the shift ends exactly at lunch', () => {
    // End is exclusive, so 09:00-13:00 keeps its full four hours.
    expect(spanCoversLunch(9 * 60, 13 * 60, LUNCH)).toBe(false);
  });

  it('is closed for a shift entirely after lunch', () => {
    expect(spanCoversLunch(14 * 60, 18 * 60, LUNCH)).toBe(false);
  });

  it('is closed for a shift entirely before lunch', () => {
    expect(spanCoversLunch(6 * 60, 12 * 60, LUNCH)).toBe(false);
  });

  it('treats an end at or before the start as running past midnight', () => {
    // 18:00 → 02:00. Lunch at 13:00 is outside it; lunch at 20:00 is inside.
    expect(spanCoversLunch(18 * 60, 2 * 60, LUNCH)).toBe(false);
    expect(spanCoversLunch(18 * 60, 2 * 60, 20 * 60)).toBe(true);
    expect(spanCoversLunch(18 * 60, 2 * 60, 1 * 60)).toBe(true);
  });
});

// ── minutesOfDayInTZ ────────────────────────────────────────────────────────
describe('minutesOfDayInTZ', () => {
  it('reads the wall clock of the requested zone, not the host', () => {
    const instant = new Date('2026-08-15T03:30:00.000Z');
    expect(minutesOfDayInTZ(instant, 'UTC')).toBe(3 * 60 + 30);
    // +05:30 → 09:00 local.
    expect(minutesOfDayInTZ(instant, TZ)).toBe(9 * 60);
    // -04:00 → 23:30 the previous day.
    expect(minutesOfDayInTZ(instant, 'America/New_York')).toBe(23 * 60 + 30);
  });

  it('falls back to the host clock rather than to zero on a bad zone', () => {
    // Wrong by an offset beats wrong by a whole day: a broken
    // `system_timezone` must not silently blank every hours figure.
    const instant = new Date('2026-08-15T03:30:00.000Z');
    expect(minutesOfDayInTZ(instant, 'Not/AZone')).toBe(
      instant.getHours() * 60 + instant.getMinutes(),
    );
  });
});

// ── workHoursOf ─────────────────────────────────────────────────────────────
describe('workHoursOf', () => {
  it('deducts the lunch break from a window that is open across it', () => {
    const hours = workHoursOf(
      { start: utc('2026-08-03', '09:00'), end: utc('2026-08-03', '18:00') },
      opts(),
    );
    expect(hours).toBe(8); // 9h span, less 60m
  });

  it('does not deduct from a shift that starts after lunch', () => {
    const hours = workHoursOf(
      { start: utc('2026-08-03', '14:00'), end: utc('2026-08-03', '18:00') },
      opts(),
    );
    expect(hours).toBe(4);
  });

  it('does not deduct when the break is configured to zero minutes', () => {
    const hours = workHoursOf(
      { start: utc('2026-08-03', '09:00'), end: utc('2026-08-03', '18:00') },
      opts({ durationMinutes: 0 }),
    );
    expect(hours).toBe(9);
  });

  it('resolves the lunch window in the company zone, not the shift zone', () => {
    // 03:30-12:30 UTC is 09:00-18:00 in Asia/Kolkata, so it IS open across a
    // 13:00 local lunch — but reading the same instants as UTC it is not.
    const shift = {
      start: utc('2026-08-03', '03:30'),
      end: utc('2026-08-03', '12:30'),
    };
    expect(workHoursOf(shift, opts({}, TZ))).toBe(8);
    expect(workHoursOf(shift, opts({}, 'UTC'))).toBe(9);
  });

  it('never deducts a break from a FLEXIBLE shift', () => {
    // There is no window for the break to fall inside; the target hours ARE the
    // worked hours. `calendar.service.ts` writes null times for these rows.
    const hours = workHoursOf(
      { shiftType: 'FLEXIBLE', requiredHours: 7.5, start: null, end: null },
      opts(),
    );
    expect(hours).toBe(7.5);
  });

  it('accepts requiredHours as the Decimal string Prisma serialises', () => {
    expect(
      workHoursOf({ shiftType: 'FLEXIBLE', requiredHours: '7.50' }, opts()),
    ).toBe(7.5);
  });

  it('treats a flexible shift with no usable target as zero, not NaN', () => {
    expect(
      workHoursOf({ shiftType: 'FLEXIBLE', requiredHours: null }, opts()),
    ).toBe(0);
    expect(
      workHoursOf(
        { shiftType: 'FLEXIBLE', requiredHours: 'not a number' },
        opts(),
      ),
    ).toBe(0);
  });

  it('is worth nothing on a day flagged as non-working', () => {
    const hours = workHoursOf(
      {
        isWorkDay: false,
        start: utc('2026-08-03', '09:00'),
        end: utc('2026-08-03', '18:00'),
      },
      opts(),
    );
    expect(hours).toBe(0);
  });

  it('treats an absent isWorkDay as a working day', () => {
    // The merged events feed carries no such flag, so absent must not read as
    // false — that would zero every figure on the shift screen.
    const hours = workHoursOf(
      { start: utc('2026-08-03', '09:00'), end: utc('2026-08-03', '18:00') },
      opts(),
    );
    expect(hours).toBe(8);
  });

  it('is worth nothing when a fixed shift is missing either end', () => {
    expect(workHoursOf({ start: utc('2026-08-03', '09:00') }, opts())).toBe(0);
    expect(workHoursOf({ end: utc('2026-08-03', '18:00') }, opts())).toBe(0);
    expect(workHoursOf({}, opts())).toBe(0);
  });

  it('is worth nothing when the window is inverted or empty', () => {
    expect(
      workHoursOf(
        { start: utc('2026-08-03', '18:00'), end: utc('2026-08-03', '09:00') },
        opts(),
      ),
    ).toBe(0);
    expect(
      workHoursOf(
        { start: utc('2026-08-03', '09:00'), end: utc('2026-08-03', '09:00') },
        opts(),
      ),
    ).toBe(0);
  });

  it('is worth nothing on an unparseable timestamp', () => {
    expect(
      workHoursOf({ start: 'never', end: utc('2026-08-03', '18:00') }, opts()),
    ).toBe(0);
  });

  it('never returns a negative figure when the break outlasts the shift', () => {
    const hours = workHoursOf(
      { start: utc('2026-08-03', '12:30'), end: utc('2026-08-03', '13:15') },
      opts({ durationMinutes: 120 }),
    );
    expect(hours).toBe(0);
  });

  it('returns an unrounded figure, leaving the rounding point to the caller', () => {
    // The overview rounds per cell so its tiles reconcile with the grid; the
    // shift screen sums raw and rounds once. Rounding here would silently
    // change one of them.
    const hours = workHoursOf(
      { start: utc('2026-08-03', '09:00'), end: utc('2026-08-03', '17:05') },
      opts({ durationMinutes: 0 }),
    );
    expect(hours).toBeCloseTo(8.0833, 4);
    expect(roundHours(hours)).toBe(8.1);
  });
});

// ── scheduledOvertimeOf ─────────────────────────────────────────────────────
describe('scheduledOvertimeOf', () => {
  const ot = (start: string, end: string, standardHoursPerDay = 8) =>
    scheduledOvertimeOf(
      { start: utc('2026-08-03', start), end: utc('2026-08-03', end) },
      { ...opts({ durationMinutes: 0 }), standardHoursPerDay },
    );

  it('counts only the hours beyond the standard day', () => {
    expect(ot('09:00', '19:00')).toBe(2);
  });

  it('is zero at exactly the standard day', () => {
    expect(ot('09:00', '17:00')).toBe(0);
  });

  it('is zero, not negative, for a short shift', () => {
    expect(ot('09:00', '13:00')).toBe(0);
  });

  it('follows the configured standard day rather than a hardcoded eight', () => {
    expect(ot('09:00', '17:00', 6)).toBe(2);
  });

  it('counts a flexible target above the standard day', () => {
    const over = scheduledOvertimeOf(
      { shiftType: 'FLEXIBLE', requiredHours: 10 },
      { ...opts(), standardHoursPerDay: 8 },
    );
    expect(over).toBe(2);
  });
});

// ── Calendar dates: the toISOString() trap ──────────────────────────────────
describe('toCalendarDate', () => {
  it('reports the day a locally-built Date already represents', () => {
    expect(toCalendarDate(new Date(2026, 7, 1))).toBe('2026-08-01');
    expect(toCalendarDate(new Date(2026, 7, 31))).toBe('2026-08-31');
  });

  it('zero-pads month and day', () => {
    expect(toCalendarDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('holds for every day of a month, in whatever zone the host runs in', () => {
    // The property that makes this the right helper: no conversion happens, so
    // the answer cannot drift by an offset. `toISOString().slice(0, 10)` drifts
    // for all 31 of these at any positive offset.
    for (let day = 1; day <= 31; day++) {
      const expected = `2026-08-${String(day).padStart(2, '0')}`;
      expect(toCalendarDate(new Date(2026, 7, day))).toBe(expected);
    }
  });
});

describe('nowCalendarDate', () => {
  it('reports the host-local day of the instant given', () => {
    // Injectable so the assertion does not depend on when it runs.
    expect(nowCalendarDate(new Date(2026, 7, 15, 2, 0))).toBe('2026-08-15');
    expect(nowCalendarDate(new Date(2026, 7, 15, 23, 59))).toBe('2026-08-15');
  });

  it('agrees with toCalendarDate, which is the whole point', () => {
    const instant = new Date(2026, 0, 1, 4, 30);
    expect(nowCalendarDate(instant)).toBe(toCalendarDate(instant));
  });

  it('defaults to now and returns a well-formed date', () => {
    expect(nowCalendarDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('monthBounds', () => {
  it('spans the whole of a 31-day month', () => {
    expect(monthBounds(new Date(2026, 7, 15))).toEqual({
      start: '2026-08-01',
      end: '2026-08-31',
    });
  });

  it('spans the whole of a 30-day month', () => {
    expect(monthBounds(new Date(2026, 8, 15))).toEqual({
      start: '2026-09-01',
      end: '2026-09-30',
    });
  });

  it('ends on the 28th in a common-year February and the 29th in a leap year', () => {
    expect(monthBounds(new Date(2026, 1, 10)).end).toBe('2026-02-28');
    expect(monthBounds(new Date(2028, 1, 10)).end).toBe('2028-02-29');
  });

  it('includes the last day of the month, which is the day the screens lost', () => {
    // A shift on the 31st was rendered by the grid and never asked for by the
    // query. This is the assertion that names the defect.
    const { end } = monthBounds(new Date(2026, 0, 1));
    expect(end).toBe('2026-01-31');
  });

  it('does not leak into a neighbouring month at either end', () => {
    const { start, end } = monthBounds(new Date(2026, 11, 25));
    expect(start).toBe('2026-12-01');
    expect(end).toBe('2026-12-31');
  });
});

describe('daysOfMonth', () => {
  it('returns one Date per calendar day, in order', () => {
    const days = daysOfMonth(new Date(2026, 8, 15));
    expect(days).toHaveLength(30);
    expect(toCalendarDate(days[0])).toBe('2026-09-01');
    expect(toCalendarDate(days[29])).toBe('2026-09-30');
  });

  it('agrees with monthBounds about where the month starts and ends', () => {
    // The grid renders `daysOfMonth` and the query asks for `monthBounds`; if
    // they ever disagree, a column exists that was never fetched.
    const anchor = new Date(2026, 7, 15);
    const days = daysOfMonth(anchor);
    const { start, end } = monthBounds(anchor);
    expect(toCalendarDate(days[0])).toBe(start);
    expect(toCalendarDate(days[days.length - 1])).toBe(end);
  });
});

// ── Weekly-off parsing ──────────────────────────────────────────────────────
describe('parseWeeklyOffDays', () => {
  it('reads a CSV of day numbers', () => {
    expect(parseWeeklyOffDays('0,6')).toEqual([0, 6]);
    expect(parseWeeklyOffDays('4,5')).toEqual([4, 5]);
  });

  it('tolerates whitespace and a single value', () => {
    expect(parseWeeklyOffDays(' 5 , 6 ')).toEqual([5, 6]);
    expect(parseWeeklyOffDays('0')).toEqual([0]);
  });

  it('falls back rather than reporting a week with no rest day', () => {
    expect(parseWeeklyOffDays(null)).toEqual([0]);
    expect(parseWeeklyOffDays(undefined)).toEqual([0]);
    expect(parseWeeklyOffDays('')).toEqual([0]);
    expect(parseWeeklyOffDays('   ')).toEqual([0]);
  });

  it('takes a caller-supplied fallback, so a branch can differ from the company', () => {
    expect(parseWeeklyOffDays(null, [4, 5])).toEqual([4, 5]);
  });

  it('drops out-of-range days instead of wrapping them', () => {
    // `'7'` must not become Sunday: a wrapped value would shade a day the
    // business never nominated, and look deliberate doing it.
    expect(parseWeeklyOffDays('7')).toEqual([0]);
    expect(parseWeeklyOffDays('-1')).toEqual([0]);
    expect(parseWeeklyOffDays('0,7')).toEqual([0]);
    expect(parseWeeklyOffDays('abc')).toEqual([0]);
  });
});

// ── parseCalendarDate: the mirror image of the toISOString() trap ───────────
describe('parseCalendarDate', () => {
  it('returns the day the string names, as a local Date', () => {
    const d = parseCalendarDate('2026-03-01');
    expect(d.getFullYear()).toBe(2026);
    // getMonth() is 0-based: 2 is March.
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(1);
  });

  it('lands on local midnight, not on an instant that may be another day', () => {
    // This is the whole point. `new Date('2026-03-01')` parses a bare date
    // string as UTC midnight, so at a NEGATIVE offset it is already 2026-02-28
    // locally — and anything that then reads `getDay()` or `getDate()` off it is
    // reasoning about the wrong day.
    const d = parseCalendarDate('2026-03-01');
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it('round-trips with toCalendarDate for every day of a month', () => {
    // The property that makes the pair safe to use together, and the one that
    // holds in every host timezone.
    for (let day = 1; day <= 31; day++) {
      const iso = `2026-01-${String(day).padStart(2, '0')}`;
      expect(toCalendarDate(parseCalendarDate(iso))).toBe(iso);
    }
  });

  it('reads the weekday the calendar says, not the one UTC says', () => {
    // 2026-03-01 is a Sunday. `new Date('2026-03-01').getDay()` answers 6
    // (Saturday) anywhere west of Greenwich; this must answer 0 everywhere.
    expect(parseCalendarDate('2026-03-01').getDay()).toBe(0);
    expect(parseCalendarDate('2026-08-16').getDay()).toBe(0);
    expect(parseCalendarDate('2026-08-17').getDay()).toBe(1);
  });
});

describe('datesBetween', () => {
  it('includes both ends of the range', () => {
    const days = datesBetween('2026-03-01', '2026-03-05');
    expect(days.map(toCalendarDate)).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
    ]);
  });

  it('returns a single day when the ends are equal', () => {
    expect(datesBetween('2026-03-01', '2026-03-01').map(toCalendarDate)).toEqual(
      ['2026-03-01'],
    );
  });

  it('returns nothing for an inverted range rather than looping forever', () => {
    expect(datesBetween('2026-03-05', '2026-03-01')).toEqual([]);
  });

  it('crosses a month boundary without dropping or repeating a day', () => {
    const days = datesBetween('2026-01-30', '2026-02-02').map(toCalendarDate);
    expect(days).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ]);
  });

  it('crosses a year boundary', () => {
    expect(datesBetween('2026-12-30', '2027-01-02').map(toCalendarDate)).toEqual(
      ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'],
    );
  });

  it('handles the leap day', () => {
    expect(datesBetween('2028-02-27', '2028-03-01').map(toCalendarDate)).toEqual(
      ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01'],
    );
  });

  it('never repeats a day across a DST transition', () => {
    // The reason the loop counts days rather than adding 24 hours. In zones
    // that observe DST, one day in the year is 23 hours long and another is 25;
    // an hours-based cursor either skips a day or emits one twice. Constructing
    // each day from calendar parts cannot do either.
    const march = datesBetween('2026-03-06', '2026-03-12').map(toCalendarDate);
    const november = datesBetween('2026-10-30', '2026-11-05').map(
      toCalendarDate,
    );
    expect(new Set(march).size).toBe(march.length);
    expect(new Set(november).size).toBe(november.length);
    expect(march).toHaveLength(7);
    expect(november).toHaveLength(7);
  });

  it('gives each day its true weekday, which is what skip-days reads', () => {
    // The bulk modal drops a day when `skippedDays.includes(date.getDay())`.
    // With the old UTC-parsed cursor every weekday was off by one at negative
    // offsets, so "skip Saturdays and Sundays" skipped Fridays and Saturdays —
    // a whole roster built on the wrong days, reported as a success.
    const week = datesBetween('2026-03-01', '2026-03-07');
    expect(week.map((d) => d.getDay())).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('spans a full 31-day month exactly once', () => {
    const days = datesBetween('2026-08-01', '2026-08-31');
    expect(days).toHaveLength(31);
    expect(toCalendarDate(days[30])).toBe('2026-08-31');
  });
});
