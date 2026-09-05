/**
 * Payroll runs — the period-level object every payslip hangs off.
 *
 * A run is a state machine, not a flag: DRAFT → CALCULATED → APPROVED → PAID,
 * with CANCELLED reachable from anything that has not been paid. The screen
 * offers an action because the STATUS allows it, never because a role does;
 * `@Roles` decides who may ask, the status decides whether the question makes
 * sense at all.
 */

import type { EmployeeRef, NamedRef, UserRef } from './common';

/**
 * Money as it arrives.
 *
 * `Decimal(18, 3)` server-side, which Prisma serialises as a STRING to keep the
 * third place of an OMR figure that a float would round away. Typed as the
 * union `formatCurrency` already accepts, so a component formats it rather than
 * `parseFloat`-ing it back into the very precision loss the column exists to
 * prevent.
 */
export type Money = string | number;

export type PayrollRunStatus =
  | 'DRAFT'
  | 'CALCULATED'
  | 'APPROVED'
  | 'PAID'
  | 'CANCELLED';

/**
 * What a payslip line does to the totals.
 *
 * `EMPLOYER_CONTRIBUTION` is recorded and never paid to the employee: it is
 * outside gross, outside deductions and outside net. See `utils/payrollTotals`.
 */
export type SalaryComponentType =
  | 'EARNING'
  | 'DEDUCTION'
  | 'EMPLOYER_CONTRIBUTION';

/**
 * A period, already worded by the server.
 *
 * `label` arrives formatted (`Aug 2026`) so the browser does no calendar maths;
 * `periodStart` / `periodEnd` are DATE-ONLY and must go through `formatDateOnly`
 * — an instant parse makes the 1st the previous month anywhere west of
 * Greenwich, which renames the whole run.
 */
export interface PayrollPeriod {
  label: string;
  periodStart: string;
  periodEnd: string;
}

export interface PayrollRun {
  id: string;
  /** Date-only. `formatDateOnly`, never `new Date(...)`. */
  periodStart: string;
  periodEnd: string;
  status: PayrollRunStatus;
  currency: string;
  totalGross: Money;
  totalNet: Money;
  notes?: string | null;
  approvedById?: string | null;
  /** Why it was sent back. Present only after a rejection, and it survives the
   *  return to DRAFT so the next attempt can read what was wrong. */
  rejectionReason?: string | null;
  approvedAt?: string | null;
  calculatedAt?: string | null;
  paidAt?: string | null;
  /** Stamped at calculation. A count taken in the database, not the length of a
   *  page of payslips. */
  employeeCount: number;
  approvedBy?: UserRef | null;
  createdAt?: string;
  updatedAt?: string;
}

/** The trimmed run every report embeds to say what it is reporting on. */
export interface PayrollRunRef extends PayrollPeriod {
  id: string;
  status: PayrollRunStatus;
  currency: string;
}

export interface PayrollRunListQuery {
  page?: number;
  limit?: number;
  status?: PayrollRunStatus;
  year?: number;
}

export interface CreatePayrollRunPayload {
  /** 1-12. The server resolves it to the period, so the browser never does. */
  month: number;
  year: number;
  /** Absent means the whole active population. */
  employeeIds?: string[];
  notes?: string;
}

export interface RejectPayrollRunPayload {
  reason: string;
}

// ── Pre-flight ──────────────────────────────────────────────────────────────

/**
 * A BLOCKER stops generation; a WARNING is a fact the approver should carry
 * into the run. The distinction is the server's, never re-derived on screen.
 */
export type PreflightSeverity = 'BLOCKER' | 'WARNING';

export interface PreflightFinding {
  code: string;
  severity: PreflightSeverity;
  employeeId?: string;
  employeeName?: string;
  message: string;
}

/**
 * `POST /payroll-runs/preflight` — writes nothing.
 *
 * It answers what a run WOULD do, so the period screen can show the objections
 * before anybody creates a row that then has to be cancelled.
 */
export interface PreflightResult {
  findings: PreflightFinding[];
  employeeCount: number;
  canGenerate: boolean;
  period: PayrollPeriod;
}

export interface PreflightPayload {
  month: number;
  year: number;
  employeeIds?: string[];
}

// ── Reports ─────────────────────────────────────────────────────────────────
//
// `/payroll/reports/*` reads APPROVED and PAID runs only — a figure in a draft
// has not been paid to anybody, and a report that mixed the two would be
// reporting on an intention.
//
// These shapes are the WIRE, transcribed from `payroll-reports.service.ts` and
// checked against live responses. The report rows are flat — `name`,
// `department`, `branch` as strings rather than nested refs — because a report
// is a table, and re-nesting a row only to flatten it again in the renderer is
// two shapes to keep in step instead of one. The currency lives on `run`, not
// at the top level: it is the run's currency, and a second copy is a second
// thing that can be wrong.

/** The run a report is about, with its label already formatted by the server. */
export interface PayrollReportRun {
  id: string;
  /** e.g. `Aug 2026`. The server owns every label. */
  label: string;
  periodStart: string;
  periodEnd: string;
  status: PayrollRunStatus;
  currency: string;
  employeeCount: number;
  approvedAt: string | null;
  paidAt: string | null;
}

export interface PayrollReportTotals {
  gross: Money;
  deductions: Money;
  net: Money;
  employerCost: Money;
}

/** One employee's line on the register. */
export interface PayrollRegisterRow {
  payslipId: string;
  payslipNumber: string;
  employeeId: string;
  employeeCode: string;
  name: string;
  position: string | null;
  department: string | null;
  branch: string | null;
  workDays: number;
  paidDays: number;
  lopDays: number;
  gross: Money;
  deductions: Money;
  net: Money;
  employerCost: Money;
  lines: PayslipLineRow[];
}

/** A payslip line as a report renders it: denormalised, joined on by `code`. */
export interface PayslipLineRow {
  code: string;
  label: string;
  type: SalaryComponentType;
  amount: Money;
}

export interface PayrollRegisterReport {
  run: PayrollReportRun;
  rows: PayrollRegisterRow[];
  totals: PayrollReportTotals;
  /** Counted in the database, not taken from `rows.length`. */
  count: number;
}

export type PayrollCostGroupBy = 'department' | 'branch';

export interface PayrollCostRow {
  /** The literal `unassigned` bucket for people who belong to no group yet. */
  id: string | null;
  name: string;
  employees: number;
  gross: Money;
  deductions: Money;
  net: Money;
  employerCost: Money;
  /** Gross + employer contributions: what the group actually costs. */
  totalCost: Money;
  /** Share of the run's total cost, or `null` when there was nothing to divide
   *  by. Rendered as an em dash — `0.0%` would be a different claim. */
  share: number | null;
}

export interface PayrollCostReport {
  run: PayrollReportRun;
  groupBy: PayrollCostGroupBy;
  rows: PayrollCostRow[];
  totals: PayrollReportTotals & { totalCost: Money };
}

/** One heading money was withheld or contributed under. */
export interface StatutoryComponentRow {
  code: string;
  label: string;
  type: 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION';
  amount: Money;
  /** How many people the heading applied to. */
  employees: number;
}

/**
 * What was withheld and what was contributed, under the heading it was recorded
 * against.
 *
 * The two never merge: one leaves the employee's pay and the other never
 * entered it, so a single "statutory" total would answer neither question.
 */
export interface StatutoryReport {
  run: PayrollReportRun;
  deductions: StatutoryComponentRow[];
  employerContributions: StatutoryComponentRow[];
  totals: {
    deductions: Money;
    employerContributions: Money;
    combined: Money;
  };
}

/** One settled period on an employee's year. */
export interface YtdPeriodRow {
  /** Server-formatted, e.g. `Aug 2026`. */
  label: string;
  periodStart: string;
  payslipId: string;
  payslipNumber: string;
  gross: Money;
  deductions: Money;
  net: Money;
  employerCost: Money;
}

export interface YtdReport {
  year: number;
  employee: {
    id: string;
    employeeCode: string;
    name: string;
    position: string | null;
    department: string | null;
    branch: string | null;
  };
  currency: string;
  totals: PayrollReportTotals & {
    workDays: number;
    paidDays: number;
    lopDays: number;
  };
  /** How many settled periods the year actually contains. */
  periodsPaid: number;
  periods: YtdPeriodRow[];
  byComponent: StatutoryComponentRow[];
}

// ── Employee self-service payroll (GET /payrolls/*) ─────────────────────────
// The read side an employee sees of their own pay. Separate shapes from the
// register/report types above because the endpoints are separate: these come
// from the ESS `payrolls` module, not from the payroll hub.

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
