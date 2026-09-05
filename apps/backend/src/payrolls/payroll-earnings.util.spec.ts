import {
  computeEarnedSalary,
  hourlyRateFor,
  isDailyWage,
  resolveContractedRates,
  toSalaryBasis,
} from './payroll-earnings.util';

/**
 * Pay-basis earnings math.
 *
 * The two bugs these lock down:
 *  1. A daily-wage rate read as a monthly salary — one day's pay for a whole
 *     month, and an overtime hour worth 1/workDays of what it should be.
 *  2. Allowance double-counting — summing every earning component into the
 *     "basic" figure *and* reporting the allowance subset separately, so a
 *     caller that adds base + allowances pays the allowances twice.
 */
describe('payroll earnings — pay basis', () => {
  describe('toSalaryBasis / isDailyWage', () => {
    it.each([
      ['DAILY', 'DAILY'],
      ['daily', 'DAILY'],
      ['MONTHLY', 'MONTHLY'],
      ['', 'MONTHLY'],
      [null, 'MONTHLY'],
      [undefined, 'MONTHLY'],
      ['nonsense', 'MONTHLY'],
    ])('%p → %s', (input, expected) => {
      expect(toSalaryBasis(input)).toBe(expected);
    });

    it('only DAILY is a daily wage', () => {
      expect(isDailyWage('DAILY')).toBe(true);
      expect(isDailyWage('MONTHLY')).toBe(false);
      expect(isDailyWage(undefined)).toBe(false);
    });
  });

  describe('resolveContractedRates', () => {
    it('no components → the whole base salary is basic', () => {
      expect(resolveContractedRates(30, [])).toEqual({
        basicRate: 30,
        allowanceRate: 0,
        fullRate: 30,
      });
    });

    it('BASIC + allowances → split, and NOT double-counted', () => {
      const rates = resolveContractedRates(9999, [
        { componentType: 'BASIC', amount: 1000 },
        { componentType: 'HRA', amount: 200 },
        { componentType: 'TRANSPORT', amount: 100 },
      ]);
      expect(rates).toEqual({
        basicRate: 1000,
        allowanceRate: 300,
        fullRate: 1300,
      });
      // The regression: basic must NOT be the 1300 total, else base+allowances
      // would gross up to 1600 for a 1300 salary.
      expect(rates.basicRate + rates.allowanceRate).toBe(1300);
    });

    it('PAYROLL_CONFIG rows carry no money and are ignored', () => {
      expect(
        resolveContractedRates(500, [
          { componentType: 'PAYROLL_CONFIG', amount: 0 },
        ]),
      ).toEqual({ basicRate: 500, allowanceRate: 0, fullRate: 500 });
    });

    it('allowance components with no BASIC row keep employee.baseSalary as basic', () => {
      expect(
        resolveContractedRates(1000, [
          { componentType: 'HRA', amount: 200 },
        ]),
      ).toEqual({ basicRate: 1000, allowanceRate: 200, fullRate: 1200 });
    });
  });

  describe('computeEarnedSalary — MONTHLY', () => {
    const rates = { basicRate: 1000, allowanceRate: 200, fullRate: 1200 };

    it('full attendance → full month, no LOP', () => {
      expect(
        computeEarnedSalary({
          salaryType: 'MONTHLY',
          rates,
          workDays: 20,
          presentDays: 20,
          effectiveWorkDays: 20,
        }),
      ).toEqual({
        basePay: 1000,
        allowancePay: 200,
        payableDays: 20,
        lopDays: 0,
        lopDeduction: 0,
      });
    });

    it('absence is clawed back as LOP prorated on the WHOLE rate', () => {
      const earned = computeEarnedSalary({
        salaryType: 'MONTHLY',
        rates,
        workDays: 20,
        presentDays: 15,
        effectiveWorkDays: 15,
      });
      expect(earned.lopDays).toBe(5);
      expect(earned.lopDeduction).toBe(300); // 1200 × 5/20
    });

    it('zero paid days forfeits allowances entirely', () => {
      const earned = computeEarnedSalary({
        salaryType: 'MONTHLY',
        rates,
        workDays: 20,
        presentDays: 0,
        effectiveWorkDays: 0,
      });
      expect(earned.allowancePay).toBe(0);
      expect(earned.lopDays).toBe(20);
    });

    it('a zero-work-day month cannot divide by zero', () => {
      expect(
        computeEarnedSalary({
          salaryType: 'MONTHLY',
          rates,
          workDays: 0,
          presentDays: 0,
          effectiveWorkDays: 0,
        }).lopDeduction,
      ).toBe(0);
    });
  });

  describe('computeEarnedSalary — DAILY', () => {
    const rates = { basicRate: 30, allowanceRate: 5, fullRate: 35 };

    it('pays rate × days actually present, with no LOP', () => {
      expect(
        computeEarnedSalary({
          salaryType: 'DAILY',
          rates,
          workDays: 26,
          presentDays: 22,
          effectiveWorkDays: 22,
        }),
      ).toEqual({
        basePay: 660, // 30 × 22
        allowancePay: 110, // 5 × 22
        payableDays: 22,
        lopDays: 0,
        lopDeduction: 0,
      });
    });

    it('paid leave earns a daily-wage worker nothing', () => {
      // 18 present + 4 paid-leave days → still only 18 days paid.
      const earned = computeEarnedSalary({
        salaryType: 'DAILY',
        rates,
        workDays: 26,
        presentDays: 18,
        effectiveWorkDays: 22,
      });
      expect(earned.payableDays).toBe(18);
      expect(earned.basePay).toBe(540);
    });

    it('days worked beyond the month’s nominal work days are still paid', () => {
      // Worked 28 days in a 26-work-day month (two rest days worked).
      const earned = computeEarnedSalary({
        salaryType: 'DAILY',
        rates,
        workDays: 26,
        presentDays: 28,
        effectiveWorkDays: 28,
      });
      expect(earned.payableDays).toBe(28);
      expect(earned.basePay).toBe(840);
      expect(earned.lopDays).toBe(0);
    });

    it('no attendance at all → nothing earned, and never negative', () => {
      const earned = computeEarnedSalary({
        salaryType: 'DAILY',
        rates,
        workDays: 26,
        presentDays: 0,
        effectiveWorkDays: 0,
      });
      expect(earned.basePay).toBe(0);
      expect(earned.allowancePay).toBe(0);
      expect(earned.lopDeduction).toBe(0);
    });
  });

  describe('computeEarnedSalary — DAILY, opt-in paid days', () => {
    const rates = { basicRate: 500, allowanceRate: 100, fullRate: 600 };
    const base = {
      salaryType: 'DAILY' as const,
      rates,
      workDays: 26,
      presentDays: 20,
      effectiveWorkDays: 22,
    };

    it('omitting both is byte-identical to the days-worked-only rule', () => {
      expect(computeEarnedSalary(base)).toEqual(
        computeEarnedSalary({ ...base, paidLeaveDays: 0, paidHolidayDays: 0 }),
      );
      expect(computeEarnedSalary(base).payableDays).toBe(20);
    });

    it('paid leave days are paid at the day rate, basic AND allowances', () => {
      const r = computeEarnedSalary({ ...base, paidLeaveDays: 2 });
      expect(r.payableDays).toBe(22);
      expect(r.basePay).toBe(500 * 22);
      expect(r.allowancePay).toBe(100 * 22);
      expect(r.lopDays).toBe(0);
      expect(r.lopDeduction).toBe(0);
    });

    it('public-holiday days are paid the same way', () => {
      const r = computeEarnedSalary({ ...base, paidHolidayDays: 3 });
      expect(r.payableDays).toBe(23);
      expect(r.basePay).toBe(500 * 23);
    });

    it('both together are additive, not double-counted', () => {
      const r = computeEarnedSalary({ ...base, paidLeaveDays: 2, paidHolidayDays: 3 });
      expect(r.payableDays).toBe(25);
      expect(r.basePay).toBe(500 * 25);
    });

    it('exceeding the month nominal work days is allowed', () => {
      // 26 nominal work days, but 26 worked + 2 holidays is legitimate.
      const r = computeEarnedSalary({
        ...base,
        presentDays: 26,
        paidHolidayDays: 2,
      });
      expect(r.payableDays).toBe(28);
    });

    it.each([
      [-5, 0],
      [Number.NaN, 0],
    ])('a negative/NaN extra of %p contributes %p days', (input, contributed) => {
      const r = computeEarnedSalary({ ...base, paidLeaveDays: input as number });
      expect(r.payableDays).toBe(20 + contributed);
    });
  });

  describe('computeEarnedSalary — MONTHLY ignores the daily-wage extras', () => {
    const rates = { basicRate: 1000, allowanceRate: 200, fullRate: 1200 };
    const base = {
      salaryType: 'MONTHLY' as const,
      rates,
      workDays: 20,
      presentDays: 16,
      effectiveWorkDays: 18,
    };

    /**
     * The double-credit guard. A monthly salary already contains paid leave
     * (via effectiveWorkDays) and public holidays (which are excluded from
     * workDays), so adding them again would pay for them twice.
     */
    it('paid leave / holiday inputs change nothing on the MONTHLY branch', () => {
      expect(
        computeEarnedSalary({ ...base, paidLeaveDays: 5, paidHolidayDays: 5 }),
      ).toEqual(computeEarnedSalary(base));
    });
  });

  describe('hourlyRateFor', () => {
    it('MONTHLY spreads the month over its work days', () => {
      expect(hourlyRateFor('MONTHLY', 3200, 20, 8)).toBe(20); // 3200 / 160
    });

    it('DAILY spreads ONE day over one day of hours', () => {
      expect(hourlyRateFor('DAILY', 30, 26, 8)).toBe(3.75); // 30 / 8
    });

    it('the daily rate is independent of how many days the month holds', () => {
      expect(hourlyRateFor('DAILY', 30, 22, 8)).toBe(
        hourlyRateFor('DAILY', 30, 31, 8),
      );
    });

    it('regression: reading a daily rate as monthly understates OT ~workDays-fold', () => {
      const wrong = hourlyRateFor('MONTHLY', 30, 26, 8); // the old behaviour
      const right = hourlyRateFor('DAILY', 30, 26, 8);
      expect(right / wrong).toBeCloseTo(26, 6);
    });

    it('degenerate divisors yield 0 rather than Infinity/NaN', () => {
      expect(hourlyRateFor('MONTHLY', 3200, 0, 8)).toBe(0);
      expect(hourlyRateFor('MONTHLY', 3200, 20, 0)).toBe(0);
      expect(hourlyRateFor('DAILY', 30, 26, 0)).toBe(0);
    });
  });
});
