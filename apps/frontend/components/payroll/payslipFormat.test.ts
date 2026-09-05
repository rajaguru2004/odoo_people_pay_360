import { describe, expect, it } from 'vitest';
import {
  amountOf,
  deductionShare,
  groupLines,
  payslipYears,
  periodLabel,
  shortMonth,
} from './payslipFormat';
import type { PayslipLine } from '@/types/payroll';

const line = (
  label: string,
  type: PayslipLine['type'],
  sequence: number,
): PayslipLine => ({
  id: label,
  label,
  type,
  amount: '100.000',
  sequence,
});

describe('periodLabel', () => {
  it('names the month', () => {
    expect(periodLabel(8, 2026)).toBe('August 2026');
  });

  it('falls back to the raw pair rather than going blank', () => {
    expect(periodLabel(13, 2026)).toBe('13/2026');
    expect(periodLabel(0, 2026)).toBe('0/2026');
  });
});

describe('shortMonth', () => {
  it('abbreviates for an axis', () => {
    expect(shortMonth(9)).toBe('Sep');
  });
});

describe('amountOf', () => {
  it('reads the decimal string the API sends', () => {
    expect(amountOf('1234.567')).toBe(1234.567);
  });

  it('treats an absent amount as nothing rather than NaN', () => {
    expect(amountOf(null)).toBe(0);
    expect(amountOf(undefined)).toBe(0);
    expect(amountOf('')).toBe(0);
    expect(amountOf('not-a-number')).toBe(0);
  });
});

describe('groupLines', () => {
  const lines = [
    line('Loan repayment', 'DEDUCTION', 120),
    line('Housing allowance', 'EARNING', 20),
    line('Social security (employer)', 'EMPLOYER_CONTRIBUTION', 210),
    line('Basic salary', 'EARNING', 10),
    line('Social security', 'DEDUCTION', 110),
  ];

  it('splits the three kinds apart', () => {
    const grouped = groupLines(lines);

    expect(grouped.earnings.map((l) => l.label)).toEqual([
      'Basic salary',
      'Housing allowance',
    ]);
    expect(grouped.deductions.map((l) => l.label)).toEqual([
      'Social security',
      'Loan repayment',
    ]);
    expect(grouped.employerContributions).toHaveLength(1);
  });

  it('never folds an employer contribution into earnings', () => {
    // It is money paid on somebody's behalf, not money they receive. Counting
    // it as an earning overstates what the bank sent them.
    const grouped = groupLines(lines);
    expect(grouped.earnings.some((l) => l.type === 'EMPLOYER_CONTRIBUTION')).toBe(
      false,
    );
  });

  it('breaks a sequence tie by label so the order is stable', () => {
    const grouped = groupLines([
      line('Zeta', 'EARNING', 10),
      line('Alpha', 'EARNING', 10),
    ]);
    expect(grouped.earnings.map((l) => l.label)).toEqual(['Alpha', 'Zeta']);
  });
});

describe('deductionShare', () => {
  it('reports the percentage taken off gross', () => {
    expect(deductionShare('1000.000', '125.000')).toBe(12.5);
  });

  it('is null when there is no gross to take it off', () => {
    // Zero would draw an empty bar reading "nothing was deducted", which is a
    // different claim from "there was nothing to deduct from".
    expect(deductionShare('0', '0')).toBeNull();
    expect(deductionShare(null, '10')).toBeNull();
  });

  it('never exceeds 100 even on a payslip that nets nothing', () => {
    expect(deductionShare('100', '400')).toBe(100);
  });
});

describe('payslipYears', () => {
  it('offers every year the person has a payslip in, newest first', () => {
    expect(
      payslipYears([{ year: 2024 }, { year: 2026 }, { year: 2024 }], 2026),
    ).toEqual([2026, 2024]);
  });

  it('still offers this year to somebody with no payslips yet', () => {
    expect(payslipYears([], 2026)).toEqual([2026]);
  });
});
