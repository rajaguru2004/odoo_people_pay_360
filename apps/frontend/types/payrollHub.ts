/**
 * `GET /payroll/hub-summary?months=6|12` — the Payroll hub payload.
 *
 * One aggregate answers the whole landing page rather than the page fanning out
 * to the list endpoints and counting rows off them: a queue longer than one
 * page would otherwise be under-reported on the very card whose job is to say
 * how much work is waiting.
 *
 * **Money counts APPROVED and PAID runs only.** A draft total is an intention,
 * not a payroll, and a card that added the two would tell the reader the
 * company had spent money it has not agreed to spend.
 *
 * **Every rate is `null`, never `0`, when there was nothing to divide by.** No
 * previous period and a period that genuinely did not move are different
 * claims; the frontend renders `null` as an em dash.
 */

import type { PayrollPeriod, PayrollRunStatus } from './payroll';
import type { TrendMonths } from './organizationHub';

export type { TrendMonths };

/** The run pipeline, one count per status. Counted in the database. */
export type PayrollRunStatusCounts = Record<PayrollRunStatus, number>;

export interface PayrollHubRuns {
  byStatus: PayrollRunStatusCounts;
  /**
   * The run that has been waiting longest for a decision, or null when nothing
   * is. It is the single most actionable thing on the page, which is why it
   * arrives already chosen rather than derived from a page of the list.
   */
  oldestAwaitingApproval: {
    id: string;
    /** Server-formatted (`Aug 2026`). The browser does no calendar maths. */
    label: string;
    calculatedAt: string;
  } | null;
}

export interface PayrollHubMoney {
  currency: string;
  gross: number;
  net: number;
  deductions: number;
  /** Employer contributions — recorded, never paid to anybody. Outside net. */
  employerCost: number;
  previousNet: number;
  /**
   * Movement against the previous period, or null when there is no previous
   * period to compare against. 0 would claim pay held exactly steady.
   */
  changePct: number | null;
}

export interface PayrollHubEmployees {
  paid: number;
  /** In a run that has not been paid yet. */
  inOpenRun: number;
  active: number;
  /**
   * Nobody can be paid without one, so this is the number that blocks the next
   * run. `withoutStructureNames` is a capped SAMPLE — never read its length as
   * the count.
   */
  withoutStructure: number;
  withoutStructureNames: string[];
}

export interface PayrollHubAttention {
  code: string;
  severity: 'BLOCKER' | 'WARNING' | 'INFO';
  /** The true total. `names` is a capped sample of it. */
  count: number;
  names: string[];
  message: string;
}

export interface PayrollHubTrendBucket {
  /** Arrives formatted. */
  label: string;
  /** Date-only — `formatDateOnly`. */
  periodStart: string;
  gross: number;
  net: number;
  employeeCount: number;
}

export interface PayrollHubSummary {
  period: PayrollPeriod;
  /** The same window one step back; every delta on the page reads this. */
  previousPeriod: PayrollPeriod;
  runs: PayrollHubRuns;
  money: PayrollHubMoney;
  employees: PayrollHubEmployees;
  attention: PayrollHubAttention[];
  trend: PayrollHubTrendBucket[];
}
