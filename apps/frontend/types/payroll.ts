import type { EmployeeRef, NamedRef } from './common';

export type PayrollRunStatus =
  | 'DRAFT'
  | 'CALCULATED'
  | 'APPROVED'
  | 'PAID'
  | 'CANCELLED';

/**
 * What a line does to the total.
 *
 * `EMPLOYER_CONTRIBUTION` is a cost to the company and NOT income: it belongs
 * on the payslip so an employee can see what is paid on their behalf, and it
 * must never be added to gross or to net.
 */
export type SalaryComponentType =
  | 'EARNING'
  | 'DEDUCTION'
  | 'EMPLOYER_CONTRIBUTION';

/**
 * Money arrives as a STRING.
 *
 * The API's money columns are `Decimal(18, 3)`, which Prisma serialises as a
 * decimal string rather than a float — deliberately, because 0.1 + 0.2 is not
 * 0.3 and a payslip that rounds does not reconcile. Format it with
 * `formatCurrency`, which takes its decimal count from the currency; only
 * convert to a number to compare or to chart.
 */
export type Money = string;

export interface PayslipLine {
  id: string;
  componentId?: string | null;
  /**
   * Denormalised on the server on purpose — a payslip is a legal record and has
   * to keep reading correctly after the component behind it is renamed. Never
   * resolve this label through the component at display time.
   */
  label: string;
  type: SalaryComponentType;
  amount: Money;
  sequence: number;
}

interface PayrollRunRef {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: PayrollRunStatus;
  currency: string;
  approvedAt?: string | null;
}

/** One row of `GET /payrolls/my-payslips/list`. */
export interface PayslipSummary {
  id: string;
  payrollRunId: string;
  employeeId: string;
  grossPay: Money;
  totalDeductions: Money;
  netPay: Money;
  /** Lifted out of the run so a list can group and sort without reaching in. */
  month: number;
  year: number;
  status: PayrollRunStatus;
  currency: string;
  periodStart: string;
  periodEnd: string;
  payrollRun: PayrollRunRef;
  createdAt: string;
}

/** What the lines add up to, reported beside the stored gross and net. */
export interface PayslipTotals {
  earnings: number;
  deductions: number;
  employerContributions: number;
  net: number;
}

export interface Payslip extends PayslipSummary {
  updatedAt: string;
  employee?:
    | (EmployeeRef & {
        /** Joined server-side from firstName/lastName. */
        fullName: string;
        department?: { id: string; name: string } | null;
        branch?: NamedRef | null;
      })
    | null;
  lines: PayslipLine[];
  totals: PayslipTotals;
}

/**
 * `GET /payrolls/my-ytd-summary` — earnings so far this year.
 *
 * Counts PAID runs only. An approved run is money that is going to move, and
 * including it would make this disagree with the bank until it does.
 */
export interface YtdSummary {
  year: number;
  employeeId: string | null;
  currency: string | null;
  totalGross: number;
  totalDeductions: number;
  totalNet: number;
  monthsCount: number;
  monthlyBreakdown: Array<{
    month: number;
    gross: number;
    deductions: number;
    net: number;
  }>;
}

export interface SalaryStructureLine {
  id: string;
  componentId: string;
  code: string;
  label: string;
  type: SalaryComponentType;
  sequence: number;
  amount: Money;
}

/** The standing figure a payslip is generated FROM. */
export interface SalaryStructure {
  id: string;
  employeeId: string;
  currency: string;
  effectiveFrom: string;
  updatedAt: string;
  lines: SalaryStructureLine[];
  totals: PayslipTotals;
}
