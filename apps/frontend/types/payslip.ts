/**
 * Payslips.
 *
 * **A payslip is its own history.** Its lines carry `code` and `label` as
 * COLUMNS rather than only a `componentId`, so a component renamed or retired
 * years later cannot change what a payslip already issued says it paid. That is
 * why `componentId` is nullable here: the line outlives the catalogue row.
 */

import type { EmployeeRef } from './common';
import type {
  Money,
  PayrollRun,
  PayrollRunStatus,
  SalaryComponentType,
} from './payroll';

export interface PayslipLine {
  id: string;
  /** The stable machine key reports join on (`BASIC`, `HRA`, `LOP`). */
  code: string;
  /** What the payslip printed, frozen at issue. */
  label: string;
  type: SalaryComponentType;
  amount: Money;
  /** Display order. Lower comes first. */
  sequence: number;
  /** Null once the catalogue row behind the line is gone — the line still
   *  resolves, which is the whole point of carrying `code` and `label`. */
  componentId: string | null;
}

export interface Payslip {
  id: string;
  payrollRunId: string;
  employeeId: string;
  /** Unique, human-quotable, and the thing an auditor asks for by name. */
  payslipNumber: string;
  workDays: number;
  paidDays: number;
  /** `workDays − paidDays`, floored at 0. Priced as one `LOP` deduction line. */
  lopDays: number;
  grossPay: Money;
  totalDeductions: Money;
  netPay: Money;
  /** Recorded, never paid to the employee: outside gross, deductions and net. */
  totalEmployerCost: Money;
  employee?: EmployeeRef & {
    department?: { id: string; name: string } | null;
    branch?: { id: string; name: string } | null;
  };
  lines?: PayslipLine[];
  /**
   * The run this payslip belongs to, as `payslips.service.ts` decorates it.
   *
   * Optional because the run detail endpoint answers the run WITH its payslips
   * and does not repeat itself inside each one. `periodLabel` arrives already
   * formatted — the server owns every label, so no screen does calendar maths
   * on `periodStart` to produce one.
   */
  payrollRun?: PayslipRunRef;
  createdAt?: string;
  updatedAt?: string;
}

/** The slice of a run that travels on a payslip. */
export interface PayslipRunRef {
  id: string;
  /** Server-formatted, e.g. `Aug 2026`. */
  periodLabel: string;
  /** Date-only day keys. Put either through `formatDateOnly`, never `new Date`. */
  periodStart: string;
  periodEnd: string;
  status: PayrollRunStatus;
  currency: string;
  approvedAt?: string | null;
  paidAt?: string | null;
}

/** The run detail endpoint answers the run WITH its payslips. */
export interface PayrollRunDetail extends PayrollRun {
  payslips: Payslip[];
}

export interface PayslipListQuery {
  page?: number;
  limit?: number;
  runId?: string;
  employeeId?: string;
}

/**
 * `/payslips/my` — self-service.
 *
 * The server narrows this to the caller's own record and to APPROVED / PAID
 * runs: a figure still being calculated is not a payslip, and showing one would
 * tell somebody they had been paid an amount that can still change.
 */
export type MyPayslipListQuery = Omit<PayslipListQuery, 'employeeId'>;
