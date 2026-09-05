import { describe, expect, it } from 'vitest';
import {
  formatHours,
  formatOvertimeWindow,
  formatWallClock,
  hoursBetween,
  overtimeTimeOfDay,
  parseWallClock,
  tierRows,
  toOvertimeInstant,
  windowHours,
} from './overtimeCalc';

describe('parseWallClock', () => {
  it('reads a wall clock as minutes past midnight', () => {
    expect(parseWallClock('00:00')).toBe(0);
    expect(parseWallClock('17:30')).toBe(1050);
    expect(parseWallClock('23:59')).toBe(1439);
    expect(parseWallClock(' 9:05 ')).toBe(545);
  });

  it('is null for anything that is not one', () => {
    // Null rather than a default: a silent 00:00 would post a window nobody
    // typed, and the server would price it.
    expect(parseWallClock('24:00')).toBeNull();
    expect(parseWallClock('17:60')).toBeNull();
    expect(parseWallClock('half past five')).toBeNull();
    expect(parseWallClock('')).toBeNull();
    expect(parseWallClock(undefined)).toBeNull();
  });
});

describe('formatWallClock', () => {
  it('pads to HH:MM', () => {
    expect(formatWallClock(545)).toBe('09:05');
    expect(formatWallClock(1050)).toBe('17:30');
  });

  it('wraps rather than printing a 25th hour', () => {
    expect(formatWallClock(1440)).toBe('00:00');
    expect(formatWallClock(-60)).toBe('23:00');
  });
});

describe('toOvertimeInstant', () => {
  it('builds a UTC-tagged wall clock, whatever zone the browser is in', () => {
    // The whole point: a LOCAL constructor would shift an Omani 17:30 to 13:30
    // and the server would refuse the request as not matching its own hours.
    expect(toOvertimeInstant('2026-08-19', '17:30')).toBe(
      '2026-08-19T17:30:00.000Z',
    );
  });

  it('is null when either half is unusable', () => {
    expect(toOvertimeInstant('19-08-2026', '17:30')).toBeNull();
    expect(toOvertimeInstant('2026-08-19', '')).toBeNull();
  });
});

describe('windowHours', () => {
  it('measures an ordinary evening', () => {
    expect(windowHours('17:30', '21:30')).toBe(4);
  });

  it('reads an end before the start as crossing midnight', () => {
    // Four hours, not minus twenty. The naive subtraction is how a night worker
    // is told the shift they just worked is nonsense.
    expect(windowHours('22:00', '02:00')).toBe(4);
  });

  it('keeps two decimals, the precision the column holds', () => {
    expect(windowHours('17:00', '17:20')).toBe(0.33);
  });

  it('is null when either time is unusable', () => {
    expect(windowHours('17:00', 'later')).toBeNull();
  });
});

describe('hoursBetween', () => {
  it('measures two instants', () => {
    expect(
      hoursBetween('2026-08-19T17:00:00Z', '2026-08-19T23:00:00Z'),
    ).toBe(6);
  });

  it('treats an end at or before the start as the next day', () => {
    expect(
      hoursBetween('2026-08-19T22:00:00Z', '2026-08-19T01:00:00Z'),
    ).toBe(3);
  });

  it('is null for an unparseable pair', () => {
    expect(hoursBetween('yesterday', 'today')).toBeNull();
  });
});

describe('overtimeTimeOfDay', () => {
  it('reads the instant in UTC, not in the viewer zone', () => {
    // Three viewers in three zones must see the one hour the employee typed.
    expect(overtimeTimeOfDay('2026-08-19T17:30:00.000Z')).toBe('17:30');
    expect(overtimeTimeOfDay('2026-08-19T02:05:00.000Z')).toBe('02:05');
  });

  it('is an em dash for nothing and for nonsense', () => {
    expect(overtimeTimeOfDay(null)).toBe('—');
    expect(overtimeTimeOfDay('not a date')).toBe('—');
  });
});

describe('formatOvertimeWindow', () => {
  it('renders a same-day window plainly', () => {
    expect(
      formatOvertimeWindow(
        '2026-08-19T17:30:00.000Z',
        '2026-08-19T21:30:00.000Z',
      ),
    ).toBe('17:30 – 21:30');
  });

  it('marks a window that crosses midnight', () => {
    // Without the marker "22:00 – 02:00" reads as four hours going backwards.
    expect(
      formatOvertimeWindow(
        '2026-08-19T22:00:00.000Z',
        '2026-08-20T02:00:00.000Z',
      ),
    ).toBe('22:00 – 02:00 (+1)');
  });

  it('is an em dash when either end is missing', () => {
    expect(formatOvertimeWindow(null, '2026-08-19T21:30:00.000Z')).toBe('—');
  });
});

describe('formatHours', () => {
  it('prints one decimal with the unit', () => {
    expect(formatHours(6)).toBe('6h');
    expect(formatHours(6.25)).toBe('6.3h');
    expect(formatHours('4.50')).toBe('4.5h');
  });

  it('prints an em dash for an unknown figure, never 0h', () => {
    // A missing number is not the number zero.
    expect(formatHours(null)).toBe('—');
    expect(formatHours(undefined)).toBe('—');
    expect(formatHours('n/a')).toBe('—');
  });
});

describe('tierRows', () => {
  it('drops the empty tiers', () => {
    // A weekday request has two empty double-tier rows, and four lines where two
    // always read "0h" trains the reader to ignore the column that matters.
    const rows = tierRows({
      regularHours: 5,
      lateHours: 1,
      doubleHours: 0,
      doubleLateHours: 0,
      regularRate: 1.25,
      lateRate: 1.5,
    });
    expect(rows.map((r) => r.key)).toEqual(['regularHours', 'lateHours']);
    expect(rows[0]).toMatchObject({ label: 'Regular', hours: 5, rate: 1.25 });
  });

  it('reads the string decimals Prisma sends', () => {
    const rows = tierRows({
      regularHours: '0',
      lateHours: '0',
      doubleHours: '8.00',
      doubleLateHours: '0',
      doubleRate: 2,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'doubleHours', hours: 8, rate: 2 });
  });

  it('is empty when nothing was worked', () => {
    expect(
      tierRows({
        regularHours: 0,
        lateHours: 0,
        doubleHours: 0,
        doubleLateHours: 0,
      }),
    ).toEqual([]);
  });
});
