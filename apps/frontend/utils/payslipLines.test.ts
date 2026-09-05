import { describe, expect, it } from 'vitest';
import {
  bucketReconciles,
  buildPayslipLines,
  type PayslipItemLike,
  type StoredLine,
} from './payslipLines';

const LABELS = { pf: 'Provident Fund', tax: 'Income tax' };

const item = (over: Partial<PayslipItemLike> = {}): PayslipItemLike => ({
  baseSalary: 1000,
  allowances: 280,
  bonus: 0,
  overtimeHours: 4,
  overtimePay: 75,
  foodAllowance: 0,
  reimbursement: 0,
  deduction: 0,
  advanceLoanDeduction: 0,
  insurance: 120,
  tax: 90,
  actualWorkDays: 22,
  lines: null,
  ...over,
});

const line = (over: Partial<StoredLine> = {}): StoredLine => ({
  code: 'X',
  label: 'X',
  category: 'EARNING',
  bucket: 'allowances',
  amount: 100,
  displayOrder: 0,
  ...over,
});

/**
 * The contract this file exists for: with itemisation off — which is every
 * installation until someone deliberately turns it on — the payslip shows
 * exactly the rows it showed before the feature was written, in the same order.
 */
describe('buildPayslipLines — degradation to today’s layout', () => {
  it('produces the historical Income rows, in order, with no lines', () => {
    const { income } = buildPayslipLines(item(), {
      labels: LABELS,
      daily: false,
      dayRate: null,
    });
    expect(income).toEqual([
      { key: 'baseSalary', labelKey: 'basicSalary', amount: 1000, sign: 'none', source: 'COLUMN' },
      { key: 'allowances', label: 'Allowance', amount: 280, sign: 'plus', source: 'COLUMN' },
      { key: 'bonus', label: 'Bonus', amount: 0, sign: 'plus', source: 'COLUMN' },
      { key: 'overtimePay', label: 'Overtime (4h)', amount: 75, sign: 'plus', source: 'COLUMN' },
    ]);
  });

  it('produces the historical Deduction rows, in order, with no lines', () => {
    const { deductions } = buildPayslipLines(item(), {
      labels: LABELS,
      daily: false,
      dayRate: null,
    });
    expect(deductions).toEqual([
      { key: 'insurance', label: 'Provident Fund', amount: 120, sign: 'minus', source: 'COLUMN' },
      { key: 'tax', label: 'Income tax', amount: 90, sign: 'minus', source: 'COLUMN' },
    ]);
  });

  it('keeps basic, allowance, bonus and overtime visible at zero', () => {
    // They always have been. Hiding a zero row would be a visible change on
    // every payslip of anyone with no allowance.
    const { income } = buildPayslipLines(
      item({ allowances: 0, bonus: 0, overtimePay: 0, overtimeHours: 0 }),
      { labels: LABELS, daily: false, dayRate: null },
    );
    expect(income.map((r) => r.key)).toEqual([
      'baseSalary',
      'allowances',
      'bonus',
      'overtimePay',
    ]);
  });

  it('keeps food allowance, other deductions and loan recovery conditional', () => {
    const zero = buildPayslipLines(item(), { labels: LABELS, daily: false, dayRate: null });
    expect(zero.income.map((r) => r.key)).not.toContain('foodAllowance');
    expect(zero.deductions.map((r) => r.key)).not.toContain('deduction');
    expect(zero.deductions.map((r) => r.key)).not.toContain('advanceLoanDeduction');

    const some = buildPayslipLines(
      item({ foodAllowance: 30, deduction: 50, advanceLoanDeduction: 200 }),
      { labels: LABELS, daily: false, dayRate: null },
    );
    expect(some.income.map((r) => r.key)).toContain('foodAllowance');
    expect(some.deductions.map((r) => r.key)).toEqual([
      'insurance',
      'tax',
      'deduction',
      'advanceLoanDeduction',
    ]);
  });

  it('switches the other-deduction label on pay basis, as today', () => {
    const monthly = buildPayslipLines(item({ deduction: 50 }), {
      labels: LABELS,
      daily: false,
      dayRate: null,
    });
    const daily = buildPayslipLines(item({ deduction: 50 }), {
      labels: LABELS,
      daily: true,
      dayRate: 45,
    });
    // Loss of pay lives inside `deduction`, and a daily-wage employee never has
    // any — only discipline amounts.
    expect(monthly.deductions.find((r) => r.key === 'deduction')!.labelKey).toBe(
      'deductionsAbsenceAndOther',
    );
    expect(daily.deductions.find((r) => r.key === 'deduction')!.labelKey).toBe(
      'deductionOther',
    );
  });

  it('adds the days × rate sublabel only for daily-wage staff', () => {
    const daily = buildPayslipLines(item({ actualWorkDays: 19 }), {
      labels: LABELS,
      daily: true,
      dayRate: 45,
    });
    expect(daily.income[0]).toMatchObject({
      sublabelKey: 'daysTimesRate',
      sublabelValues: { days: 19, rate: 45 },
    });

    const monthly = buildPayslipLines(item(), { labels: LABELS, daily: false, dayRate: null });
    expect(monthly.income[0].sublabelKey).toBeUndefined();
  });

  it('shows the reimbursement block only when there is one', () => {
    expect(
      buildPayslipLines(item(), { labels: LABELS, daily: false, dayRate: null })
        .reimbursement,
    ).toEqual([]);
    expect(
      buildPayslipLines(item({ reimbursement: 500 }), {
        labels: LABELS,
        daily: false,
        dayRate: null,
      }).reimbursement,
    ).toHaveLength(1);
  });

  it('treats an empty lines array exactly like no lines at all', () => {
    const a = buildPayslipLines(item({ lines: [] }), { labels: LABELS, daily: false, dayRate: null });
    const b = buildPayslipLines(item({ lines: null }), { labels: LABELS, daily: false, dayRate: null });
    expect(a).toEqual(b);
  });
});

describe('buildPayslipLines — with stored lines', () => {
  it('replaces the aggregate allowance with its components', () => {
    const { income } = buildPayslipLines(
      item({
        lines: [
          line({ code: 'HOUSING', label: 'Housing', bucket: 'allowances', amount: 200, displayOrder: 0 }),
          line({ code: 'TRANSPORT', label: 'Transport', bucket: 'allowances', amount: 80, displayOrder: 1 }),
        ],
      }),
      { labels: LABELS, daily: false, dayRate: null },
    );
    expect(income.filter((r) => r.source === 'LINE').map((r) => [r.label, r.amount])).toEqual([
      ['Housing', 200],
      ['Transport', 80],
    ]);
    // And the aggregate row is gone, not shown alongside.
    expect(income.map((r) => r.key)).not.toContain('allowances');
  });

  it('splits PF from ESI, which the insurance column cannot say', () => {
    const { deductions } = buildPayslipLines(
      item({
        insurance: 127.5,
        lines: [
          line({ code: 'PF', label: 'Provident fund', category: 'DEDUCTION', bucket: 'insurance', amount: 120, displayOrder: 0 }),
          line({ code: 'ESI', label: 'ESI', category: 'DEDUCTION', bucket: 'insurance', amount: 7.5, displayOrder: 1 }),
        ],
      }),
      { labels: LABELS, daily: false, dayRate: null },
    );
    expect(deductions.filter((r) => r.source === 'LINE').map((r) => r.label)).toEqual([
      'Provident fund',
      'ESI',
    ]);
  });

  it('falls back to the aggregate when the lines do NOT add up', () => {
    // A payslip written before a fix, or one the non-strict setting let through.
    // Showing a breakdown that disagrees with the money is worse than showing
    // none, so the column wins.
    const { income } = buildPayslipLines(
      item({
        allowances: 280,
        lines: [line({ code: 'HOUSING', label: 'Housing', bucket: 'allowances', amount: 200 })],
      }),
      { labels: LABELS, daily: false, dayRate: null },
    );
    expect(income.find((r) => r.key === 'allowances')).toMatchObject({
      label: 'Allowance',
      amount: 280,
      source: 'COLUMN',
    });
  });

  it('itemises one bucket while leaving another aggregate', () => {
    const { income, deductions } = buildPayslipLines(
      item({
        lines: [line({ code: 'HOUSING', label: 'Housing', bucket: 'allowances', amount: 280 })],
      }),
      { labels: LABELS, daily: false, dayRate: null },
    );
    expect(income.some((r) => r.label === 'Housing')).toBe(true);
    // Insurance had no lines, so it stays the aggregate row.
    expect(deductions.find((r) => r.key === 'insurance')!.source).toBe('COLUMN');
  });

  it('renders lines in their stored display order', () => {
    const { income } = buildPayslipLines(
      item({
        lines: [
          line({ code: 'B', label: 'Second', bucket: 'allowances', amount: 80, displayOrder: 5 }),
          line({ code: 'A', label: 'First', bucket: 'allowances', amount: 200, displayOrder: 1 }),
        ],
      }),
      { labels: LABELS, daily: false, dayRate: null },
    );
    expect(income.filter((r) => r.source === 'LINE').map((r) => r.label)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('never lets lines change a number — only the labels beside it', () => {
    const withLines = buildPayslipLines(
      item({
        lines: [
          line({ code: 'HOUSING', label: 'Housing', bucket: 'allowances', amount: 200 }),
          line({ code: 'TRANSPORT', label: 'Transport', bucket: 'allowances', amount: 80 }),
        ],
      }),
      { labels: LABELS, daily: false, dayRate: null },
    );
    const sum = (rows: { amount: number }[]) =>
      Math.round(rows.reduce((a, r) => a + r.amount, 0) * 100) / 100;
    const without = buildPayslipLines(item(), { labels: LABELS, daily: false, dayRate: null });
    expect(sum(withLines.income)).toBe(sum(without.income));
    expect(sum(withLines.deductions)).toBe(sum(without.deductions));
  });
});

describe('bucketReconciles', () => {
  it('is false when a bucket has no lines', () => {
    expect(bucketReconciles([], 'allowances', 280)).toBe(false);
  });

  it('accepts a half-cent of float noise', () => {
    expect(
      bucketReconciles([line({ bucket: 'allowances', amount: 280.004 })], 'allowances', 280),
    ).toBe(true);
  });

  it('rejects a real discrepancy', () => {
    expect(
      bucketReconciles([line({ bucket: 'allowances', amount: 200 })], 'allowances', 280),
    ).toBe(false);
  });
});
