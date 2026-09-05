import {
  countWorkingDays,
  eachDayKey,
  isValidPeriod,
  periodFor,
  periodLabel,
  previousPeriod,
} from './payroll-period.util';

describe('periodFor', () => {
  it('returns the first and last day of the month as day keys', () => {
    expect(periodFor(9, 2026)).toEqual({
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
    });
  });

  it('gets February right in a leap year and in a common one', () => {
    expect(periodFor(2, 2024).periodEnd).toBe('2024-02-29');
    expect(periodFor(2, 2026).periodEnd).toBe('2026-02-28');
  });

  it('does not shift the boundary west of Greenwich', () => {
    // The failure this guards: an instant parse of the period start in a
    // negative-offset zone reads as the previous month's last day.
    const original = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      expect(periodFor(1, 2026).periodStart).toBe('2026-01-01');
    } finally {
      process.env.TZ = original;
    }
  });

  it('refuses a month nobody could have asked for', () => {
    expect(() => periodFor(13, 2026)).toThrow(RangeError);
    expect(() => periodFor(0, 2026)).toThrow(RangeError);
    expect(() => periodFor(6, 1899)).toThrow(RangeError);
  });
});

describe('isValidPeriod', () => {
  it('accepts every real month of a plausible year', () => {
    for (let m = 1; m <= 12; m += 1) expect(isValidPeriod(m, 2026)).toBe(true);
  });

  it('rejects fractional and out-of-range input', () => {
    expect(isValidPeriod(6.5, 2026)).toBe(false);
    expect(isValidPeriod(6, 2101)).toBe(false);
  });
});

describe('eachDayKey', () => {
  it('is inclusive of both ends', () => {
    expect(eachDayKey('2026-09-01', '2026-09-03')).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ]);
  });

  it('spans a whole month without losing or repeating a day', () => {
    const keys = eachDayKey('2026-09-01', '2026-09-30');
    expect(keys).toHaveLength(30);
    expect(new Set(keys).size).toBe(30);
  });

  it('crosses a month and a year boundary', () => {
    expect(eachDayKey('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });

  it('returns nothing for a reversed or malformed range', () => {
    expect(eachDayKey('2026-09-10', '2026-09-01')).toEqual([]);
    expect(eachDayKey('September', '2026-09-01')).toEqual([]);
  });
});

describe('countWorkingDays', () => {
  const keys = eachDayKey('2026-09-01', '2026-09-07');

  it('counts only the days the predicate accepts', () => {
    const weekdaysOnly = (key: string) => {
      const day = new Date(`${key}T00:00:00Z`).getUTCDay();
      return day !== 5 && day !== 6; // Friday, Saturday off
    };
    expect(countWorkingDays(keys, weekdaysOnly)).toBe(5);
  });

  it('is zero when the calendar closes every day', () => {
    expect(countWorkingDays(keys, () => false)).toBe(0);
  });

  it('is the whole range when nothing is closed', () => {
    expect(countWorkingDays(keys, () => true)).toBe(7);
  });
});

describe('previousPeriod', () => {
  it('steps back one month', () => {
    expect(previousPeriod(9, 2026)).toEqual({ month: 8, year: 2026 });
  });

  it('wraps January into the previous December', () => {
    expect(previousPeriod(1, 2026)).toEqual({ month: 12, year: 2025 });
  });
});

describe('periodLabel', () => {
  it('formats a day key on the server, so the browser does no calendar maths', () => {
    expect(periodLabel('2026-08-01')).toBe('Aug 2026');
  });

  it('formats a date column the same way', () => {
    expect(periodLabel(new Date('2026-08-01T00:00:00Z'))).toBe('Aug 2026');
  });
});
