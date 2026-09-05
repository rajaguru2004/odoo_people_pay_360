/**
 * The ONE place payroll money is added up.
 *
 * The summary cards and the payslip table on the same screen both read this, so
 * they cannot disagree: a card totalling the response while a row totals its own
 * lines is how a page ends up showing two different net figures for the same
 * run, and the reader has no way to tell which one is the payroll.
 *
 * Three rules, all of them the calculator's:
 *
 * 1. **Employer contributions are outside every bucket.** They are recorded and
 *    never paid — not in gross, not in deductions, not in net. Adding them to
 *    gross would inflate what people were paid by the company's own cost.
 * 2. **Net floors at zero.** Deductions exceeding earnings is a data problem,
 *    not a negative wage.
 * 3. **Money arrives as a `Decimal(18, 3)` STRING.** `'1250.500' + '90.250'` is
 *    string concatenation, which is why every amount goes through `toAmount`
 *    rather than into a bare `+`.
 */

import type { Money } from '@/types/payroll';
import type { Payslip, PayslipLine } from '@/types/payslip';

export interface PayslipBuckets {
  gross: number;
  deductions: number;
  net: number;
  /** Recorded, never paid. Reported beside the others, never inside them. */
  employerCost: number;
}

export interface RunTotals extends PayslipBuckets {
  employeeCount: number;
}

/**
 * A decimal string, a number, or nothing at all, as a number.
 *
 * An unparseable amount contributes 0 rather than poisoning the whole total
 * with `NaN` — one bad line must not blank every figure on the page.
 */
export function toAmount(value: Money | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

/** Sum one payslip's lines into the buckets they belong to. */
export function payslipTotals(
  lines: readonly PayslipLine[] | null | undefined,
): PayslipBuckets {
  let gross = 0;
  let deductions = 0;
  let employerCost = 0;

  for (const line of lines ?? []) {
    const amount = toAmount(line?.amount);
    if (line?.type === 'EARNING') gross += amount;
    else if (line?.type === 'DEDUCTION') deductions += amount;
    else if (line?.type === 'EMPLOYER_CONTRIBUTION') employerCost += amount;
  }

  return { gross, deductions, net: Math.max(0, gross - deductions), employerCost };
}

/**
 * A run's totals from its payslips.
 *
 * The stored per-payslip totals are used, not a re-derivation from the lines:
 * they are what the server calculated and what the payslip itself prints, and a
 * screen that recomputed them would be quietly auditing the payroll rather than
 * reporting it. `payslipTotals` exists for the ONE case there is no stored
 * total to read — a payslip being previewed line by line.
 *
 * `net` is summed rather than subtracted, because each payslip already floored
 * its own at zero and `gross − deductions` across the run would cancel one
 * person's shortfall against another's pay.
 */
export function runTotals(
  payslips: readonly Payslip[] | null | undefined,
): RunTotals {
  const rows = payslips ?? [];

  let gross = 0;
  let deductions = 0;
  let net = 0;
  let employerCost = 0;

  for (const slip of rows) {
    gross += toAmount(slip?.grossPay);
    deductions += toAmount(slip?.totalDeductions);
    net += toAmount(slip?.netPay);
    employerCost += toAmount(slip?.totalEmployerCost);
  }

  return { gross, deductions, net, employerCost, employeeCount: rows.length };
}

/**
 * Gross plus employer contributions — what the run actually costs the company,
 * which is a different number from what anybody was paid.
 */
export function totalCost(totals: PayslipBuckets): number {
  return totals.gross + totals.employerCost;
}
