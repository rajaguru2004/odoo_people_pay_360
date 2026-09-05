/**
 * Pay-basis aware earnings math — the single place that decides what an
 * employee's contracted rate MEANS and how it turns into money for a period.
 *
 * Two bases exist (`Employee.salaryType`):
 *
 *  - **MONTHLY** — `baseSalary` is a monthly amount. The full month is paid and
 *    absence is clawed back as Loss of Pay (LOP), prorated over the month's
 *    work days.
 *  - **DAILY** (daily wage) — `baseSalary` is a **per-day rate**. The employee
 *    is paid strictly for days actually worked: `rate × presentDays`. There is
 *    no LOP (an unworked day is simply not paid), and no cap at the month's
 *    nominal work days — a daily-wage worker who works a rest day earns that
 *    day too. Approved paid leave and public holidays are unpaid by default;
 *    two settings can add them (see `paidLeaveDays` / `paidHolidayDays`), but
 *    weekly offs are never paid.
 *
 * The overtime hourly rate follows the same split: a monthly salary is spread
 * over the month's work days, a daily rate over one day's hours. Using the
 * monthly formula on a daily rate understates overtime by a factor of the
 * month's work days (a 30/day rate would yield 30/(26×8) = 0.14/h).
 */

/** Pay basis stored on `Employee.salaryType`. */
export enum SalaryBasis {
  MONTHLY = 'MONTHLY',
  DAILY = 'DAILY',
}

export type SalaryBasisValue = `${SalaryBasis}`;

/** Normalize an arbitrary stored/DTO value to a valid pay basis. */
export function toSalaryBasis(value: unknown): SalaryBasisValue {
  return String(value ?? '').toUpperCase() === SalaryBasis.DAILY
    ? SalaryBasis.DAILY
    : SalaryBasis.MONTHLY;
}

export const isDailyWage = (value: unknown): boolean =>
  toSalaryBasis(value) === SalaryBasis.DAILY;

/** The subset of a SalaryComponent this module needs. */
export interface EarningComponentLike {
  componentType: string;
  amount: unknown;
}

/**
 * The contracted rate for ONE period (one month for MONTHLY, one day for
 * DAILY), split into its basic and allowance parts.
 */
export interface ContractedRates {
  /** The BASIC part of the rate. */
  basicRate: number;
  /** Every non-BASIC earning component, summed. */
  allowanceRate: number;
  /** basicRate + allowanceRate — the whole contracted rate for one period. */
  fullRate: number;
}

/** PAYROLL_CONFIG rows carry deduction overrides in `note`, never money. */
const isEarning = (c: EarningComponentLike) =>
  c.componentType !== 'PAYROLL_CONFIG';

/** A day count that can be multiplied by a rate: non-negative and finite. */
const dayCount = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Split an employee's contracted rate into basic + allowances.
 *
 * Salary components, when present, are authoritative: the BASIC component is
 * the basic rate and every other earning component is an allowance. An employee
 * with allowance components but no BASIC row keeps `employee.baseSalary` as the
 * basic. With no components at all the whole rate is basic.
 *
 * Basic and allowances are returned SEPARATELY and must be added exactly once
 * by the caller — summing all components into `basicRate` *and* also reporting
 * the allowance subset double-counts every allowance.
 */
export function resolveContractedRates(
  employeeBaseSalary: unknown,
  components: EarningComponentLike[] = [],
): ContractedRates {
  const { basicRate, allowanceRate, fullRate } = resolveContractedRatesDetailed(
    employeeBaseSalary,
    components,
  );
  return { basicRate, allowanceRate, fullRate };
}

/** One contracted component, kept separate instead of summed into a rate. */
export interface ContractedComponent {
  /** Stable machine key — the `componentType` slug, or BASIC for the fallback. */
  code: string;
  /** The contracted amount for the period, before any proration. */
  amount: number;
  /** Which of the two rates this component was summed into. */
  bucket: 'basicRate' | 'allowanceRate';
}

export interface DetailedContractedRates extends ContractedRates {
  /**
   * The components behind the two rates, in input order.
   *
   * `basicRate === sum(components where bucket==='basicRate')` and likewise for
   * allowances, exactly — nothing is rounded here, so a caller that needs to
   * itemise can do its own rounding and know what the residual is.
   */
  components: ContractedComponent[];
}

/**
 * `resolveContractedRates`, without discarding which component contributed what.
 *
 * Added rather than folded in because `resolveContractedRates` is called from
 * the engine's hot path and from six spec fixtures; changing its return shape
 * would rewrite assertions that describe today's money. This function is the
 * implementation, the old one is a projection of it, and every existing caller
 * sees a byte-identical result.
 *
 * The detail exists so a payslip can say "Housing 200, Transport 80" instead of
 * "Allowances 280". The engine's totals still come from the two rates.
 */
export function resolveContractedRatesDetailed(
  employeeBaseSalary: unknown,
  components: EarningComponentLike[] = [],
): DetailedContractedRates {
  const fallbackBasic = Number(employeeBaseSalary) || 0;
  const earnings = (components ?? []).filter(isEarning);

  if (earnings.length === 0) {
    return {
      basicRate: fallbackBasic,
      allowanceRate: 0,
      fullRate: fallbackBasic,
      // The fallback is still a line: a payslip with no components must show a
      // basic, not an empty earnings section.
      components: [
        { code: 'BASIC', amount: fallbackBasic, bucket: 'basicRate' },
      ],
    };
  }

  const sum = (list: EarningComponentLike[]) =>
    list.reduce((acc, c) => acc + (Number(c.amount) || 0), 0);

  const basicComponents = earnings.filter((c) => c.componentType === 'BASIC');
  const hasBasicRow = basicComponents.length > 0;
  const basicRate = hasBasicRow ? sum(basicComponents) : fallbackBasic;
  const allowanceComponents = earnings.filter(
    (c) => c.componentType !== 'BASIC',
  );
  const allowanceRate = sum(allowanceComponents);

  const detail: ContractedComponent[] = hasBasicRow
    ? basicComponents.map((c) => ({
        code: 'BASIC',
        amount: Number(c.amount) || 0,
        bucket: 'basicRate' as const,
      }))
    : // No BASIC row, so the basic came from `employee.baseSalary`. It is one
      // line whose amount is the fallback, not one line per allowance.
      [{ code: 'BASIC', amount: fallbackBasic, bucket: 'basicRate' as const }];

  for (const c of allowanceComponents) {
    detail.push({
      code: c.componentType || 'ALLOWANCE',
      amount: Number(c.amount) || 0,
      bucket: 'allowanceRate',
    });
  }

  return {
    basicRate,
    allowanceRate,
    fullRate: basicRate + allowanceRate,
    components: detail,
  };
}

export interface EarnedSalaryInput {
  salaryType: SalaryBasisValue;
  rates: ContractedRates;
  /** Nominal work days in the period for the employee's branch. */
  workDays: number;
  /** Days with PRESENT attendance. */
  presentDays: number;
  /** presentDays + paid (non-UNPAID) leave days. */
  effectiveWorkDays: number;
  /**
   * DAILY only: approved PAID leave days to pay at the day rate.
   *
   * The caller has already applied the `payroll_daily_wage_pay_leave` setting
   * and passes 0 when it is off, so this module stays a pure function with no
   * config dependency. Ignored entirely on the MONTHLY branch, where paid leave
   * is already inside `effectiveWorkDays` — counting it again would double-pay.
   */
  paidLeaveDays?: number;
  /**
   * DAILY only: public-holiday days to pay at the day rate. Already gated on
   * `payroll_daily_wage_pay_holidays` by the caller, already de-duplicated
   * against days the employee actually worked, and already clamped to their
   * employment window. Ignored on the MONTHLY branch, where holidays are
   * excluded from `workDays` and so are implicitly paid already.
   */
  paidHolidayDays?: number;
}

export interface EarnedSalary {
  /** What lands in payroll_items.base_salary. */
  basePay: number;
  /** What lands in payroll_items.allowances. */
  allowancePay: number;
  /** Days actually paid — only meaningful for DAILY. */
  payableDays: number;
  lopDays: number;
  lopDeduction: number;
}

/**
 * Turn a contracted rate into the money earned for one payroll period.
 *
 * MONTHLY: the full monthly basic + allowances are reported, and unworked days
 * come back out as `lopDeduction` (prorated over `workDays` on the whole rate,
 * basic and allowances alike). Allowances are forfeited entirely when there was
 * not a single paid day in the period.
 *
 * DAILY: `presentDays × rate`, no LOP, plus any `paidLeaveDays` /
 * `paidHolidayDays` the caller opted into. `effectiveWorkDays` is ignored on
 * this branch — it already blends present and paid-leave days, and daily-wage
 * pay needs those two counted separately.
 */
export function computeEarnedSalary(input: EarnedSalaryInput): EarnedSalary {
  const { rates, workDays, presentDays, effectiveWorkDays } = input;

  if (isDailyWage(input.salaryType)) {
    // Math.max(0, NaN) is NaN, which would silently poison every downstream
    // money figure — clamp non-finite day counts to 0 explicitly.
    const days =
      dayCount(presentDays) +
      dayCount(input.paidLeaveDays) +
      dayCount(input.paidHolidayDays);
    return {
      basePay: rates.basicRate * days,
      allowancePay: rates.allowanceRate * days,
      payableDays: days,
      lopDays: 0,
      lopDeduction: 0,
    };
  }

  const lopDays = Math.max(0, workDays - effectiveWorkDays);
  const lopDeduction = workDays > 0 ? rates.fullRate * (lopDays / workDays) : 0;

  return {
    basePay: rates.basicRate,
    allowancePay: effectiveWorkDays === 0 ? 0 : rates.allowanceRate,
    payableDays: effectiveWorkDays,
    lopDays,
    lopDeduction,
  };
}

/**
 * The overtime hourly rate for an employee.
 *
 * MONTHLY: the whole monthly rate spread over the month's work days and daily
 * hours. DAILY: one day's rate over one day's hours — independent of how many
 * days the month happens to hold.
 */
export function hourlyRateFor(
  salaryType: SalaryBasisValue,
  fullRate: number,
  workDays: number,
  workHoursPerDay: number,
): number {
  if (!(workHoursPerDay > 0)) return 0;
  if (isDailyWage(salaryType)) return fullRate / workHoursPerDay;
  if (!(workDays > 0)) return 0;
  return fullRate / (workDays * workHoursPerDay);
}
