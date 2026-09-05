import { DateTime } from 'luxon';
import {
  computeStatus,
  dayKeyToDate,
  expectedHours,
  FALLBACK_TIMEZONE,
  haversineMetres,
  isoWeekday,
  isWeeklyOff,
  minutesFromShiftStart,
  parseDayKey,
  parseWallClock,
  rate,
  resolveZone,
  toDayKey,
  workHoursBetween,
} from './attendance-calendar.util';

/** A wall clock in a named zone, as an instant. */
const at = (iso: string, zone = 'Asia/Muscat') =>
  DateTime.fromISO(iso, { zone }).toJSDate();

describe('resolveZone', () => {
  it('prefers the employee zone', () => {
    expect(
      resolveZone(
        { timezone: 'Asia/Dubai' },
        { timezone: 'Asia/Muscat' },
        'UTC',
      ),
    ).toBe('Asia/Dubai');
  });

  it('falls through to the branch when the employee inherits', () => {
    expect(
      resolveZone(
        { timezone: null },
        { timezone: 'Asia/Muscat' },
        'Europe/London',
      ),
    ).toBe('Asia/Muscat');
  });

  it('falls through to the company when both inherit', () => {
    expect(
      resolveZone({ timezone: null }, { timezone: null }, 'Europe/London'),
    ).toBe('Europe/London');
  });

  it('treats a blank string as inheriting, not as a zone', () => {
    expect(
      resolveZone({ timezone: '  ' }, { timezone: '' }, 'Asia/Muscat'),
    ).toBe('Asia/Muscat');
  });

  it('handles a missing employee and branch entirely', () => {
    expect(resolveZone(null, undefined, 'Asia/Muscat')).toBe('Asia/Muscat');
  });

  it('only reaches the fallback when nothing at all is configured', () => {
    expect(resolveZone(null, null, null)).toBe(FALLBACK_TIMEZONE);
  });
});

describe('isoWeekday', () => {
  it('reads a date-only column at UTC midnight, not the server offset', () => {
    // 2026-03-01 is a Sunday.
    expect(isoWeekday(new Date('2026-03-01T00:00:00.000Z'))).toBe(7);
    expect(isoWeekday(new Date('2026-03-02T00:00:00.000Z'))).toBe(1);
  });

  it('reads a DateTime in its own zone', () => {
    expect(
      isoWeekday(DateTime.fromISO('2026-03-06T23:30', { zone: 'Asia/Muscat' })),
    ).toBe(5);
  });
});

describe('isWeeklyOff', () => {
  it('is false for an empty configuration — no rest days is not every day', () => {
    expect(isWeeklyOff(new Date('2026-03-06T00:00:00.000Z'), [])).toBe(false);
    expect(isWeeklyOff(new Date('2026-03-07T00:00:00.000Z'), [])).toBe(false);
  });

  it('is false when the field was never set at all', () => {
    expect(isWeeklyOff(new Date('2026-03-06T00:00:00.000Z'), null)).toBe(false);
    expect(isWeeklyOff(new Date('2026-03-06T00:00:00.000Z'), undefined)).toBe(
      false,
    );
  });

  it('matches a configured Friday/Saturday weekend', () => {
    const friday = new Date('2026-03-06T00:00:00.000Z');
    const saturday = new Date('2026-03-07T00:00:00.000Z');
    const sunday = new Date('2026-03-08T00:00:00.000Z');
    expect(isWeeklyOff(friday, [5, 6])).toBe(true);
    expect(isWeeklyOff(saturday, [5, 6])).toBe(true);
    expect(isWeeklyOff(sunday, [5, 6])).toBe(false);
  });

  it('matches a configured Saturday/Sunday weekend', () => {
    expect(isWeeklyOff(new Date('2026-03-08T00:00:00.000Z'), [6, 7])).toBe(
      true,
    );
    expect(isWeeklyOff(new Date('2026-03-06T00:00:00.000Z'), [6, 7])).toBe(
      false,
    );
  });
});

describe('parseWallClock', () => {
  it('reads HH:MM as minutes past midnight', () => {
    expect(parseWallClock('00:00')).toBe(0);
    expect(parseWallClock('08:30')).toBe(510);
    expect(parseWallClock('23:59')).toBe(1439);
  });

  it('refuses anything that is not a 24-hour wall clock', () => {
    for (const bad of ['24:00', '8:00', '08:60', '', null, undefined, 'noon']) {
      expect(parseWallClock(bad)).toBeNull();
    }
  });
});

describe('expectedHours', () => {
  it('measures an ordinary office day', () => {
    expect(expectedHours('08:00', '17:00')).toBe(9);
    expect(expectedHours('09:30', '17:00')).toBe(7.5);
  });

  it('measures a window that crosses midnight', () => {
    expect(expectedHours('22:00', '06:00')).toBe(8);
    expect(expectedHours('23:30', '07:15')).toBe(7.75);
  });

  it('treats identical clocks as an unconfigured window, not 24 hours', () => {
    expect(expectedHours('08:00', '08:00')).toBe(0);
  });

  it('returns zero rather than NaN for an unparseable clock', () => {
    expect(expectedHours('eight', '17:00')).toBe(0);
    expect(expectedHours('08:00', '')).toBe(0);
  });
});

describe('workHoursBetween', () => {
  it('is null while either punch is missing', () => {
    expect(workHoursBetween(null, at('2026-03-02T17:00'))).toBeNull();
    expect(workHoursBetween(at('2026-03-02T08:00'), null)).toBeNull();
    expect(workHoursBetween(null, null)).toBeNull();
  });

  it('rounds to two decimals', () => {
    expect(
      workHoursBetween(at('2026-03-02T08:00'), at('2026-03-02T16:40')),
    ).toBe(8.67);
  });

  it('is null rather than negative when the check-out precedes the check-in', () => {
    expect(
      workHoursBetween(at('2026-03-02T17:00'), at('2026-03-02T08:00')),
    ).toBeNull();
  });

  it('counts a shift that runs past midnight', () => {
    expect(
      workHoursBetween(at('2026-03-02T22:00'), at('2026-03-03T06:00')),
    ).toBe(8);
  });
});

describe('minutesFromShiftStart', () => {
  it('is negative for an early arrival', () => {
    expect(
      minutesFromShiftStart(at('2026-03-02T07:45'), '08:00', 'Asia/Muscat'),
    ).toBe(-15);
  });

  it('picks the previous day for a night shift punched after midnight', () => {
    expect(
      minutesFromShiftStart(at('2026-03-03T00:10'), '22:00', 'Asia/Muscat'),
    ).toBe(130);
  });

  it('measures real elapsed minutes across a DST spring-forward', () => {
    // New York clocks jump 02:00 → 03:00 on 2026-03-08. From 22:00 the previous
    // evening to 03:10 is four hours ten, not five hours ten.
    expect(
      minutesFromShiftStart(
        at('2026-03-08T03:10', 'America/New_York'),
        '22:00',
        'America/New_York',
      ),
    ).toBe(250);
  });

  it('is null when the shift start is not a wall clock', () => {
    expect(
      minutesFromShiftStart(at('2026-03-02T08:00'), 'morning', 'Asia/Muscat'),
    ).toBeNull();
  });
});

describe('computeStatus', () => {
  const base = {
    expected: 8,
    graceMinutes: 15,
    officeStart: '08:00',
    zone: 'Asia/Muscat',
  };

  it('is ABSENT with null hours when nobody checked in', () => {
    expect(computeStatus({ ...base, checkIn: null, checkOut: null })).toEqual({
      status: 'ABSENT',
      isLate: false,
      lateMinutes: 0,
      isEarlyLeave: false,
      workHours: null,
    });
  });

  it('is PRESENT and not late for an on-time full day', () => {
    expect(
      computeStatus({
        ...base,
        checkIn: at('2026-03-02T07:55'),
        checkOut: at('2026-03-02T17:00'),
      }),
    ).toEqual({
      status: 'PRESENT',
      isLate: false,
      lateMinutes: 0,
      isEarlyLeave: false,
      workHours: 9.08,
    });
  });

  it('forgives an arrival exactly on the grace edge', () => {
    const result = computeStatus({
      ...base,
      checkIn: at('2026-03-02T08:15'),
      checkOut: at('2026-03-02T17:00'),
    });
    expect(result.isLate).toBe(false);
    expect(result.lateMinutes).toBe(0);
    expect(result.status).toBe('PRESENT');
  });

  it('measures lateness from the shift start, not from the end of grace', () => {
    const result = computeStatus({
      ...base,
      checkIn: at('2026-03-02T08:16'),
      checkOut: at('2026-03-02T17:00'),
    });
    expect(result.isLate).toBe(true);
    // Sixteen past eight, not one past the grace window.
    expect(result.lateMinutes).toBe(16);
    expect(result.status).toBe('LATE');
  });

  it('is PRESENT at exactly half the expected hours', () => {
    const result = computeStatus({
      ...base,
      checkIn: at('2026-03-02T08:00'),
      checkOut: at('2026-03-02T12:00'),
    });
    expect(result.workHours).toBe(4);
    expect(result.status).toBe('PRESENT');
  });

  it('is HALF_DAY just below half the expected hours', () => {
    const result = computeStatus({
      ...base,
      checkIn: at('2026-03-02T08:00'),
      checkOut: at('2026-03-02T11:59'),
    });
    expect(result.status).toBe('HALF_DAY');
    expect(result.isEarlyLeave).toBe(true);
  });

  it('reports HALF_DAY over LATE when a late arrival also worked a short day', () => {
    const result = computeStatus({
      ...base,
      checkIn: at('2026-03-02T09:00'),
      checkOut: at('2026-03-02T11:00'),
    });
    expect(result.status).toBe('HALF_DAY');
    expect(result.isLate).toBe(true);
    expect(result.lateMinutes).toBe(60);
  });

  it('leaves an open shift unjudged on hours', () => {
    const result = computeStatus({
      ...base,
      checkIn: at('2026-03-02T08:00'),
      checkOut: null,
    });
    expect(result.workHours).toBeNull();
    expect(result.isEarlyLeave).toBe(false);
    expect(result.status).toBe('PRESENT');
  });

  it('judges a night shift against the previous evening start', () => {
    const result = computeStatus({
      expected: 8,
      graceMinutes: 15,
      officeStart: '22:00',
      zone: 'Asia/Muscat',
      checkIn: at('2026-03-03T00:10'),
      checkOut: at('2026-03-03T06:00'),
    });
    expect(result.isLate).toBe(true);
    expect(result.lateMinutes).toBe(130);
    expect(result.workHours).toBe(5.83);
    // Short of the eight hours owed, but well over half of them.
    expect(result.status).toBe('LATE');
    expect(result.isEarlyLeave).toBe(true);
  });

  it('makes no hours judgement when the roster expects nothing', () => {
    const result = computeStatus({
      ...base,
      expected: 0,
      checkIn: at('2026-03-02T08:00'),
      checkOut: at('2026-03-02T08:30'),
    });
    expect(result.status).toBe('PRESENT');
    expect(result.isEarlyLeave).toBe(false);
  });
});

describe('haversineMetres', () => {
  it('is zero for the same point', () => {
    expect(haversineMetres(23.588, 58.3829, 23.588, 58.3829)).toBe(0);
  });

  it('measures a degree of longitude at the equator', () => {
    expect(haversineMetres(0, 0, 0, 1)).toBeCloseTo(111_195, -2);
  });

  it('measures a short walk across a car park', () => {
    // Roughly 100 m north of the first point.
    const d = haversineMetres(23.588, 58.3829, 23.5889, 58.3829);
    expect(d).toBeGreaterThan(95);
    expect(d).toBeLessThan(105);
  });

  it('is symmetric', () => {
    expect(haversineMetres(23.588, 58.3829, 23.6, 58.4)).toBe(
      haversineMetres(23.6, 58.4, 23.588, 58.3829),
    );
  });
});

describe('day keys', () => {
  it('round-trips a date-only value without drifting a day', () => {
    expect(toDayKey(dayKeyToDate('2026-01-15'))).toBe('2026-01-15');
  });

  it('reads a date-only column at UTC', () => {
    expect(toDayKey(new Date('2026-01-15T00:00:00.000Z'))).toBe('2026-01-15');
  });

  it('parses strictly, with no silent fallback', () => {
    expect(parseDayKey('2026-01-15')?.toISODate()).toBe('2026-01-15');
    for (const bad of [
      '15-01-2026',
      '2026-1-5',
      'today',
      '',
      null,
      undefined,
    ]) {
      expect(parseDayKey(bad)).toBeNull();
    }
  });
});

describe('rate', () => {
  it('is null when there was nothing to divide by', () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(5, 0)).toBeNull();
  });

  it('is a percentage to one decimal', () => {
    expect(rate(1, 3)).toBe(33.3);
    expect(rate(9, 10)).toBe(90);
  });
});
