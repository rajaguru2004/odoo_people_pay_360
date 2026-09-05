import { describe, expect, it, vi } from 'vitest';
import {
  PAY_BASIS_OPTIONS,
  basisHelperText,
  estimatedWorkDaysPerMonth,
  hourlyRateFor,
  impliedDailyRate,
  isDailyWage,
  monthlyEquivalent,
  payBasisForEmploymentType,
  payBasisLabel,
  rateLabel,
  rateSuffix,
  toSalaryBasis,
} from './payBasis';
import type { LibraryItem } from '@/services/libraryService';

/**
 * These helpers decide whether `baseSalary` means "per month" or "per day".
 * Read the wrong way round, a 1,000/day worker is previewed as earning 1,000 a
 * month — or a 30,000/month salary is previewed at 30,000 a day. The file is a
 * deliberate mirror of the backend's `payroll-earnings.util.ts`, so the tests
 * pin the shared arithmetic rather than the wording around it.
 */

describe('toSalaryBasis', () => {
  it('recognises DAILY in any casing', () => {
    expect(toSalaryBasis('DAILY')).toBe('DAILY');
    expect(toSalaryBasis('daily')).toBe('DAILY');
    expect(toSalaryBasis('Daily')).toBe('DAILY');
  });

  it('treats everything else as MONTHLY', () => {
    // The safe default: a mislabelled value must not turn a monthly salary into
    // a day rate. MONTHLY is the conservative reading.
    expect(toSalaryBasis('MONTHLY')).toBe('MONTHLY');
    expect(toSalaryBasis('WEEKLY')).toBe('MONTHLY');
    expect(toSalaryBasis('')).toBe('MONTHLY');
    expect(toSalaryBasis(null)).toBe('MONTHLY');
    expect(toSalaryBasis(undefined)).toBe('MONTHLY');
    expect(toSalaryBasis(0)).toBe('MONTHLY');
    expect(toSalaryBasis({})).toBe('MONTHLY');
  });

  it('isDailyWage agrees with toSalaryBasis', () => {
    for (const value of ['DAILY', 'daily', 'MONTHLY', '', null, undefined, 42]) {
      expect(isDailyWage(value)).toBe(toSalaryBasis(value) === 'DAILY');
    }
  });
});

describe('hourlyRateFor', () => {
  it('spreads a MONTHLY rate over work days and daily hours', () => {
    // 26,000 a month, 26 work days, 8h/day → 125/h.
    expect(hourlyRateFor('MONTHLY', 26_000, 26, 8)).toBe(125);
  });

  it('divides a DAILY rate by one day of hours only', () => {
    // 1,000 a day over 8h → 125/h, regardless of the month's length.
    expect(hourlyRateFor('DAILY', 1_000, 26, 8)).toBe(125);
  });

  it('ignores workDays entirely on the DAILY basis', () => {
    // The specific bug this guards: applying the monthly formula to a day rate
    // understates overtime by roughly the month's work-day count.
    const a = hourlyRateFor('DAILY', 1_000, 26, 8);
    const b = hourlyRateFor('DAILY', 1_000, 20, 8);
    const c = hourlyRateFor('DAILY', 1_000, 0, 8);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe(125);
  });

  it('returns 0 when daily hours are missing or non-positive', () => {
    // Division guard — a NaN or Infinity here would surface as a garbage
    // overtime figure rather than an error.
    for (const hours of [0, -1, NaN]) {
      expect(hourlyRateFor('MONTHLY', 26_000, 26, hours)).toBe(0);
      expect(hourlyRateFor('DAILY', 1_000, 26, hours)).toBe(0);
    }
  });

  it('returns 0 for MONTHLY when work days are missing', () => {
    expect(hourlyRateFor('MONTHLY', 26_000, 0, 8)).toBe(0);
    expect(hourlyRateFor('MONTHLY', 26_000, -5, 8)).toBe(0);
  });

  it('never returns a non-finite number', () => {
    const cases: Array<[Parameters<typeof hourlyRateFor>[0], number, number, number]> = [
      ['MONTHLY', 26_000, 0, 0],
      ['DAILY', 1_000, 0, 0],
      ['MONTHLY', 0, 26, 8],
      ['DAILY', 0, 26, 8],
    ];
    for (const [basis, rate, days, hours] of cases) {
      expect(Number.isFinite(hourlyRateFor(basis, rate, days, hours))).toBe(true);
    }
  });
});

describe('estimatedWorkDaysPerMonth', () => {
  it('maps the documented work weeks', () => {
    expect(estimatedWorkDaysPerMonth(5)).toBe(22);
    expect(estimatedWorkDaysPerMonth(6)).toBe(26);
  });

  it('accepts a numeric string, as settings store it', () => {
    expect(estimatedWorkDaysPerMonth('6')).toBe(26);
    expect(estimatedWorkDaysPerMonth('5')).toBe(22);
  });

  it('falls back to a 5-day week for anything unusable', () => {
    for (const value of [undefined, 0, -3, 'abc', '']) {
      expect(estimatedWorkDaysPerMonth(value as never)).toBe(22);
    }
  });
});

describe('monthlyEquivalent', () => {
  it('is the identity for MONTHLY', () => {
    expect(monthlyEquivalent('MONTHLY', 30_000, 26)).toBe(30_000);
    // The estimate is irrelevant on this basis.
    expect(monthlyEquivalent('MONTHLY', 30_000, 0)).toBe(30_000);
  });

  it('scales a day rate by the estimated work days', () => {
    expect(monthlyEquivalent('DAILY', 1_000, 26)).toBe(26_000);
  });

  it('clamps a negative estimate to zero rather than inverting the sign', () => {
    expect(monthlyEquivalent('DAILY', 1_000, -5)).toBe(0);
  });
});

describe('impliedDailyRate', () => {
  it('recovers the day rate from a stored payroll item', () => {
    // A DAILY item stores dayRate x daysPaid, plus the day count.
    expect(impliedDailyRate(22_000, 22)).toBe(1_000);
  });

  it('returns null when there is nothing to divide by', () => {
    // Null, not 0 or Infinity: the caller shows a dash rather than a wrong rate.
    expect(impliedDailyRate(22_000, 0)).toBeNull();
    expect(impliedDailyRate(22_000, -1)).toBeNull();
    expect(impliedDailyRate(22_000, null)).toBeNull();
    expect(impliedDailyRate(22_000, 'abc')).toBeNull();
  });

  it('returns null when the amount is unparseable', () => {
    expect(impliedDailyRate('abc', 22)).toBeNull();
    expect(impliedDailyRate(undefined, 22)).toBeNull();
    expect(impliedDailyRate({}, 22)).toBeNull();
  });

  it('reads a null amount as zero, not as missing', () => {
    // Asymmetry worth knowing about: the guard is `Number.isFinite`, and
    // `Number(null)` is 0 while `Number('abc')` is NaN. So a null baseSalary
    // renders as a 0.00 day rate where an unparseable one renders as a dash.
    // Harmless while the API always sends a number; pinned so that changing the
    // guard to reject null is a deliberate decision with a failing test.
    expect(impliedDailyRate(null, 22)).toBe(0);
  });

  it('accepts numeric strings, which is how the API sends decimals', () => {
    expect(impliedDailyRate('22000', '22')).toBe(1_000);
  });

  it('round-trips against monthlyEquivalent', () => {
    const dayRate = 1_250;
    const days = 26;
    const total = monthlyEquivalent('DAILY', dayRate, days);
    expect(impliedDailyRate(total, days)).toBe(dayRate);
  });
});

describe('payBasisForEmploymentType', () => {
  const items = [
    { label: 'Permanent', payBasis: 'MONTHLY' },
    { label: 'Daily Wage', payBasis: 'DAILY' },
    { label: 'Consultant', payBasis: null },
  ] as unknown as Pick<LibraryItem, 'label' | 'payBasis'>[];

  it('returns the basis the employment type forces', () => {
    expect(payBasisForEmploymentType(items, 'Daily Wage')).toBe('DAILY');
    expect(payBasisForEmploymentType(items, 'Permanent')).toBe('MONTHLY');
  });

  it('returns null when the type forces nothing, leaving the field editable', () => {
    // null and "MONTHLY" are different answers: one unlocks the select, the
    // other locks it to MONTHLY. Conflating them removes the user's choice.
    expect(payBasisForEmploymentType(items, 'Consultant')).toBeNull();
  });

  it('returns null for an unknown or absent label', () => {
    expect(payBasisForEmploymentType(items, 'Intern')).toBeNull();
    expect(payBasisForEmploymentType(items, '')).toBeNull();
    expect(payBasisForEmploymentType(items, null)).toBeNull();
    expect(payBasisForEmploymentType(items, undefined)).toBeNull();
  });

  it('returns null when the library has not loaded yet', () => {
    // The form renders before the library request resolves; an empty list must
    // not read as "forces MONTHLY".
    expect(payBasisForEmploymentType(undefined, 'Daily Wage')).toBeNull();
    expect(payBasisForEmploymentType([], 'Daily Wage')).toBeNull();
  });

  it('matches the label exactly, not loosely', () => {
    expect(payBasisForEmploymentType(items, 'daily wage')).toBeNull();
    expect(payBasisForEmploymentType(items, 'Daily')).toBeNull();
  });

  it('normalises a lowercase payBasis stored on the item', () => {
    const loose = [{ label: 'Casual', payBasis: 'daily' }] as unknown as Pick<LibraryItem, 'label' | 'payBasis'>[];
    expect(payBasisForEmploymentType(loose, 'Casual')).toBe('DAILY');
  });
});

describe('label helpers', () => {
  // The translator is only asked for a key; these assert the branch, not copy.
  const t = vi.fn((key: string) => key);

  it('offers exactly the two supported bases, monthly first', () => {
    expect(PAY_BASIS_OPTIONS.map((o) => o.value)).toEqual(['MONTHLY', 'DAILY']);
  });

  it('picks the daily key on the DAILY basis and the monthly key otherwise', () => {
    expect(payBasisLabel('DAILY', t)).toBe('daily');
    expect(payBasisLabel('MONTHLY', t)).toBe('monthly');

    expect(rateLabel('DAILY', t)).toBe('rateLabelDaily');
    expect(rateLabel('MONTHLY', t)).toBe('rateLabelMonthly');

    expect(rateSuffix('DAILY', t)).toBe('perDay');
    expect(rateSuffix('MONTHLY', t)).toBe('perMonth');

    expect(basisHelperText('DAILY', t)).toBe('dailyHelper');
    expect(basisHelperText('MONTHLY', t)).toBe('monthlyHelper');
  });
});
