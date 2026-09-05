import { describe, expect, it } from 'vitest';
import {
  payslipTotals,
  runTotals,
  toAmount,
  totalCost,
} from './payrollTotals';
import type { Money } from '@/types/payroll';
import type { Payslip, PayslipLine } from '@/types/payslip';

let seq = 0;

function line(
  type: PayslipLine['type'],
  amount: Money,
  code = `C${(seq += 1)}`,
): PayslipLine {
  return {
    id: `line-${seq}`,
    code,
    label: code,
    type,
    amount,
    sequence: seq,
    componentId: null,
  };
}

function payslip(over: Partial<Payslip> = {}): Payslip {
  return {
    id: `slip-${(seq += 1)}`,
    payrollRunId: 'run-1',
    employeeId: `emp-${seq}`,
    payslipNumber: `PS-${seq}`,
    workDays: 26,
    paidDays: 26,
    lopDays: 0,
    grossPay: 0,
    totalDeductions: 0,
    netPay: 0,
    totalEmployerCost: 0,
    ...over,
  };
}

describe('toAmount', () => {
  it('reads a Decimal(18,3) string without losing the third place', () => {
    expect(toAmount('1250.125')).toBe(1250.125);
  });

  it('contributes 0 rather than poisoning a total with NaN', () => {
    // One unparseable line must not blank every figure on the page.
    expect(toAmount('not-money')).toBe(0);
    expect(toAmount(null)).toBe(0);
    expect(toAmount(undefined)).toBe(0);
  });
});

describe('payslipTotals', () => {
  it('leaves employer contributions out of gross, deductions and net', () => {
    // The rule the whole module exists for: an employer contribution is
    // recorded and never paid. Inside gross it would inflate what the employee
    // was paid by the company's own cost.
    const totals = payslipTotals([
      line('EARNING', 1000),
      line('DEDUCTION', 70),
      line('EMPLOYER_CONTRIBUTION', 105),
    ]);

    expect(totals.gross).toBe(1000);
    expect(totals.deductions).toBe(70);
    expect(totals.net).toBe(930);
    expect(totals.employerCost).toBe(105);
    // Reported beside the others, never inside them.
    expect(totalCost(totals)).toBe(1105);
  });

  it('sums decimal STRINGS as money, not as text', () => {
    // `'600.500' + '250.250'` concatenates. Every amount goes through toAmount.
    const totals = payslipTotals([
      line('EARNING', '600.500'),
      line('EARNING', '250.250'),
      line('DEDUCTION', '42.125'),
      line('EMPLOYER_CONTRIBUTION', '63.375'),
    ]);

    expect(totals.gross).toBeCloseTo(850.75, 3);
    expect(totals.deductions).toBeCloseTo(42.125, 3);
    expect(totals.net).toBeCloseTo(808.625, 3);
    expect(totals.employerCost).toBeCloseTo(63.375, 3);
  });

  it('gives zeros, never NaN, for an empty or absent line list', () => {
    for (const input of [[], null, undefined]) {
      const totals = payslipTotals(input);
      expect(totals).toEqual({
        gross: 0,
        deductions: 0,
        net: 0,
        employerCost: 0,
      });
      expect(Number.isNaN(totals.net)).toBe(false);
    }
  });

  it('floors net at zero rather than reporting a negative wage', () => {
    const totals = payslipTotals([
      line('EARNING', '100.000'),
      line('DEDUCTION', '250.000'),
    ]);
    expect(totals.net).toBe(0);
    // The deduction is still reported in full — the floor hides nothing.
    expect(totals.deductions).toBe(250);
  });
});

describe('runTotals', () => {
  it('sums the stored per-payslip totals and counts the rows', () => {
    const totals = runTotals([
      payslip({
        grossPay: '1000.500',
        totalDeductions: '70.250',
        netPay: '930.250',
        totalEmployerCost: '105.000',
      }),
      payslip({
        grossPay: '800.250',
        totalDeductions: '56.000',
        netPay: '744.250',
        totalEmployerCost: '84.000',
      }),
    ]);

    expect(totals.gross).toBeCloseTo(1800.75, 3);
    expect(totals.deductions).toBeCloseTo(126.25, 3);
    expect(totals.net).toBeCloseTo(1674.5, 3);
    expect(totals.employerCost).toBeCloseTo(189, 3);
    expect(totals.employeeCount).toBe(2);
  });

  it('does not fold employer cost into the run gross or net', () => {
    const totals = runTotals([
      payslip({
        grossPay: 1000,
        totalDeductions: 0,
        netPay: 1000,
        totalEmployerCost: 105,
      }),
    ]);

    expect(totals.gross).toBe(1000);
    expect(totals.net).toBe(1000);
    expect(totalCost(totals)).toBe(1105);
  });

  it('sums each payslip’s floored net instead of subtracting across the run', () => {
    // Netting gross against deductions run-wide would cancel one person's
    // shortfall against another's pay and report a run nobody was paid.
    const totals = runTotals([
      payslip({ grossPay: 100, totalDeductions: 250, netPay: 0 }),
      payslip({ grossPay: 900, totalDeductions: 100, netPay: 800 }),
    ]);

    expect(totals.net).toBe(800);
    expect(totals.gross).toBe(1000);
    expect(totals.deductions).toBe(350);
  });

  it('gives zeros, never NaN, for an empty or absent run', () => {
    for (const input of [[], null, undefined]) {
      expect(runTotals(input)).toEqual({
        gross: 0,
        deductions: 0,
        net: 0,
        employerCost: 0,
        employeeCount: 0,
      });
    }
  });
});
