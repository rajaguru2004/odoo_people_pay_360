import { describe, expect, it } from 'vitest';
import {
  cellKind,
  cellLabel,
  isAtLatestMonth,
  matchesSearch,
  monthLabel,
  monthOf,
  stepMonth,
  weekdayLabel,
} from './monthGrid';
import type {
  MonthlyAttendanceCell,
  MonthlyAttendanceEntry,
} from '@/types/attendance';

function cell(patch: Partial<MonthlyAttendanceCell> = {}): MonthlyAttendanceCell {
  return {
    date: '2026-09-03',
    attendanceId: null,
    hasRecord: false,
    status: 'ABSENT',
    checkIn: null,
    checkOut: null,
    workHours: null,
    expectedHours: 8,
    source: null,
    isLate: false,
    lateMinutes: 0,
    isEarlyLeave: false,
    isEarlyIn: false,
    isLateOut: false,
    isWorkingDay: true,
    isWeeklyOff: false,
    holiday: null,
    isFuture: false,
    settled: true,
    notes: null,
    zone: 'Asia/Muscat',
    ...patch,
  };
}

describe('stepMonth', () => {
  it('crosses a year boundary in both directions', () => {
    expect(stepMonth({ month: 12, year: 2026 }, 1)).toEqual({ month: 1, year: 2027 });
    expect(stepMonth({ month: 1, year: 2026 }, -1)).toEqual({ month: 12, year: 2025 });
  });

  it('walks several months at once', () => {
    expect(stepMonth({ month: 3, year: 2026 }, -5)).toEqual({ month: 10, year: 2025 });
  });
});

describe('monthLabel', () => {
  it('names the month and the year', () => {
    expect(monthLabel({ month: 9, year: 2026 })).toBe('September 2026');
  });
});

describe('isAtLatestMonth', () => {
  const now = new Date('2026-09-05T10:00:00.000Z');

  it('is true for the month in progress', () => {
    expect(isAtLatestMonth({ month: 9, year: 2026 }, now, 'utc')).toBe(true);
  });

  it('is false once the reader has stepped back', () => {
    expect(isAtLatestMonth({ month: 8, year: 2026 }, now, 'utc')).toBe(false);
  });

  it('refuses to walk into a month that has not happened', () => {
    // Every cell in it would be blank, and a page of blanks reads as a page
    // that failed to load.
    expect(isAtLatestMonth({ month: 10, year: 2026 }, now, 'utc')).toBe(true);
  });
});

describe('monthOf', () => {
  it('reads the month in the given zone, not the runner’s', () => {
    // 21:30 UTC on the 31st is already the 1st in Muscat, and the log for
    // "this month" has to agree with the branch's clock.
    const instant = new Date('2026-08-31T21:30:00.000Z');
    expect(monthOf(instant, 'Asia/Muscat')).toEqual({ month: 9, year: 2026 });
    expect(monthOf(instant, 'utc')).toEqual({ month: 8, year: 2026 });
  });
});

describe('weekdayLabel', () => {
  it('maps ISO weekdays, 1 = Monday', () => {
    expect(weekdayLabel(1)).toBe('Mon');
    expect(weekdayLabel(7)).toBe('Sun');
  });
});

describe('cellKind', () => {
  it('calls a punched day worked whatever the calendar says', () => {
    // Somebody who came in on a public holiday worked that day.
    expect(cellKind(cell({ checkIn: '2026-09-03T04:00:00.000Z', holiday: { id: 'h', name: 'National Day' } }))).toBe(
      'worked',
    );
  });

  it('names a holiday ahead of the weekly rest', () => {
    const kind = cellKind(
      cell({ isWeeklyOff: true, isWorkingDay: false, holiday: { id: 'h', name: 'National Day' } }),
    );
    expect(kind).toBe('holiday');
    expect(cellLabel(cell({ holiday: { id: 'h', name: 'National Day' } }), 'holiday')).toBe(
      'National Day',
    );
  });

  it('leaves an unfinished day blank rather than calling it an absence', () => {
    // Before the shift closes, a missing punch is somebody still on their way.
    expect(cellKind(cell({ settled: false }))).toBe('blank');
    expect(cellKind(cell({ settled: true }))).toBe('absent');
  });

  it('counts a recorded absence the moment it is written', () => {
    expect(cellKind(cell({ hasRecord: true, settled: false }))).toBe('absent');
  });

  it('draws nothing for a day that has not happened', () => {
    expect(cellKind(cell({ isFuture: true, settled: false }))).toBe('future');
  });
});

describe('matchesSearch', () => {
  const entry = {
    employee: {
      id: 'e1',
      employeeCode: 'EMP-0007',
      firstName: 'Aisha',
      lastName: 'Al Balushi',
      department: { id: 'd1', name: 'Finance' },
      branch: { id: 'b1', code: 'HQ', name: 'Head Office' },
      status: 'ACTIVE',
    },
    zone: 'Asia/Muscat',
    days: [],
    summary: {},
  } as unknown as MonthlyAttendanceEntry;

  it('matches a name, a code or a department', () => {
    expect(matchesSearch(entry, 'aisha')).toBe(true);
    expect(matchesSearch(entry, 'emp-0007')).toBe(true);
    expect(matchesSearch(entry, 'finance')).toBe(true);
  });

  it('keeps everybody when nothing was typed', () => {
    expect(matchesSearch(entry, '   ')).toBe(true);
  });

  it('drops a row nothing in it matches', () => {
    expect(matchesSearch(entry, 'logistics')).toBe(false);
  });
});
