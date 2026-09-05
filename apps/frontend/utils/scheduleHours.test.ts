import { describe, expect, it } from 'vitest';
import {
  crossesMidnight,
  dayKeysBetween,
  formatWallClock,
  isWeeklyOff,
  isoWeekday,
  monthBounds,
  monthLabel,
  parseWallClock,
  roundHours,
  shiftHours,
  shiftWindowLabel,
  shiftDays,
  toDayKey,
  weekBounds,
  weekdayLabel,
} from './scheduleHours';

const fixed = (startTime: string | null, endTime: string | null) => ({
  shiftType: 'FULL_DAY' as const,
  startTime,
  endTime,
});

describe('parseWallClock', () => {
  it('reads a valid clock as minutes past midnight', () => {
    expect(parseWallClock('00:00')).toBe(0);
    expect(parseWallClock('08:30')).toBe(510);
    expect(parseWallClock('23:59')).toBe(1439);
  });

  it('refuses anything that is not one, rather than coercing it', () => {
    expect(parseWallClock('24:00')).toBeNull();
    expect(parseWallClock('8:00')).toBeNull();
    expect(parseWallClock('half past')).toBeNull();
    expect(parseWallClock(null)).toBeNull();
  });
});

describe('formatWallClock', () => {
  it('renders midnight and noon by name rather than as a zero', () => {
    expect(formatWallClock('00:00')).toBe('12:00 AM');
    expect(formatWallClock('12:00')).toBe('12:00 PM');
  });

  it('keeps the minutes padded', () => {
    expect(formatWallClock('09:05')).toBe('9:05 AM');
    expect(formatWallClock('22:30')).toBe('10:30 PM');
  });

  it('is empty for a value that is not a clock', () => {
    expect(formatWallClock(undefined)).toBe('');
  });
});

describe('shiftHours', () => {
  it('measures an ordinary daytime shift', () => {
    expect(shiftHours(fixed('09:00', '17:30'))).toBe(8.5);
  });

  it('measures a night shift across midnight instead of reporting a negative', () => {
    expect(
      shiftHours({ shiftType: 'NIGHT', startTime: '22:00', endTime: '06:00' }),
    ).toBe(8);
  });

  it('is zero for equal clocks, not a full day', () => {
    expect(shiftHours(fixed('08:00', '08:00'))).toBe(0);
  });

  it('takes a flexible shift at its stated hours, whatever clocks it carries', () => {
    expect(
      shiftHours({
        shiftType: 'FLEXIBLE',
        startTime: '09:00',
        endTime: '23:00',
        requiredHours: 6,
      }),
    ).toBe(6);
  });

  it('accepts requiredHours as the string Prisma decimals arrive as', () => {
    expect(
      shiftHours({ shiftType: 'FLEXIBLE', requiredHours: '7.5' }),
    ).toBe(7.5);
  });

  it('falls back to the stated hours when the window cannot be read', () => {
    expect(shiftHours({ ...fixed('09:00', null), requiredHours: 4 })).toBe(4);
  });
});

describe('crossesMidnight', () => {
  it('is true only when the end is genuinely earlier than the start', () => {
    expect(crossesMidnight('22:00', '06:00')).toBe(true);
    expect(crossesMidnight('09:00', '17:00')).toBe(false);
    expect(crossesMidnight('08:00', '08:00')).toBe(false);
    expect(crossesMidnight(null, '06:00')).toBe(false);
  });
});

describe('shiftWindowLabel', () => {
  it('names the window for a fixed shift', () => {
    expect(shiftWindowLabel(fixed('09:00', '17:00'))).toBe('9:00 AM – 5:00 PM');
  });

  it('names the hours for a flexible one, which has no window', () => {
    expect(shiftWindowLabel({ shiftType: 'FLEXIBLE', hours: 7 })).toBe(
      '7h flexible',
    );
  });

  it('falls back to the type when the clocks are missing', () => {
    expect(shiftWindowLabel({ shiftType: 'NIGHT', startTime: null, endTime: null })).toBe(
      'Night',
    );
  });
});

describe('day-key arithmetic', () => {
  it('never zone-converts a date-only value', () => {
    // 15 January read as an instant is the 14th anywhere west of Greenwich.
    // A local-time Date must keep the calendar day it was built from.
    expect(toDayKey(new Date(2026, 0, 15, 23, 30))).toBe('2026-01-15');
    expect(toDayKey('2026-01-15T00:00:00.000Z')).toBe('2026-01-15');
  });

  it('bounds a month by its own length', () => {
    expect(monthBounds('2026-02-14')).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    });
    expect(monthBounds('2024-02-14').end).toBe('2024-02-29');
  });

  it('bounds a Monday-first week', () => {
    // 11 March 2026 is a Wednesday.
    expect(weekBounds('2026-03-11')).toEqual({
      start: '2026-03-09',
      end: '2026-03-15',
    });
  });

  it('walks a closed range inclusively', () => {
    expect(dayKeysBetween('2026-03-09', '2026-03-11')).toEqual([
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
    ]);
  });

  it('returns nothing for an inverted or unparseable range', () => {
    expect(dayKeysBetween('2026-03-11', '2026-03-09')).toEqual([]);
    expect(dayKeysBetween('nonsense', '2026-03-09')).toEqual([]);
  });

  it('steps across a month boundary', () => {
    expect(shiftDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(shiftDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('numbers weekdays Monday-first', () => {
    expect(isoWeekday('2026-03-09')).toBe(1);
    expect(isoWeekday('2026-03-15')).toBe(7);
  });

  it('labels a day and a month for the reader', () => {
    expect(weekdayLabel('2026-03-09')).toBe('Mon');
    expect(monthLabel('2026-03-09')).toBe('March 2026');
  });
});

describe('isWeeklyOff', () => {
  it('shades only the days the branch actually rests', () => {
    // Friday and Saturday, as an Oman branch keeps them.
    expect(isWeeklyOff('2026-03-13', [5, 6])).toBe(true);
    expect(isWeeklyOff('2026-03-14', [5, 6])).toBe(true);
    expect(isWeeklyOff('2026-03-15', [5, 6])).toBe(false);
  });

  it('treats an empty list as "no rest configured", not "every day is rest"', () => {
    // Read the other way round it would shade every column in the grid and
    // report a workforce that never works.
    expect(isWeeklyOff('2026-03-13', [])).toBe(false);
    expect(isWeeklyOff('2026-03-13', null)).toBe(false);
    expect(isWeeklyOff('2026-03-13', undefined)).toBe(false);
  });
});

describe('roundHours', () => {
  it('keeps one decimal so a column of these sums to what it shows', () => {
    expect(roundHours(8.25)).toBe(8.3);
    expect(roundHours(7.999)).toBe(8);
  });
});
