/**
 * Pay-basis helpers for the UI — a deliberate mirror of the backend's
 * `apps/backend/src/payrolls/payroll-earnings.util.ts`, which is the source of
 * truth. Any change to the math there must be reflected here, or a preview will
 * promise a number the payslip does not pay.
 *
 * Two bases exist (`Employee.salaryType`):
 *
 *  - **MONTHLY** — `baseSalary` is a monthly amount. Absence comes back out as
 *    Loss of Pay, prorated over the month's work days.
 *  - **DAILY** — `baseSalary` is a **per-day rate**. Only days actually worked
 *    are paid (plus paid leave / public holidays if the admin enabled those);
 *    there is no LOP, and no cap at the month's nominal work days.
 *
 * Salary COMPONENTS follow the same basis: on a daily-wage employee every
 * component amount is a per-day figure too.
 */
import type { SalaryType } from '@/types/employee';
import type { LibraryItem } from '@/services/libraryService';

export type SalaryBasis = SalaryType;

/** Mirror of the backend `toSalaryBasis` — anything not DAILY is MONTHLY. */
export function toSalaryBasis(value: unknown): SalaryBasis {
  return String(value ?? '').toUpperCase() === 'DAILY' ? 'DAILY' : 'MONTHLY';
}

export function isDailyWage(value: unknown): boolean {
  return toSalaryBasis(value) === 'DAILY';
}

/**
 * Mirror of the backend `hourlyRateFor`.
 *
 * MONTHLY spreads the whole monthly rate over the month's work days and daily
 * hours; DAILY divides one day's rate by one day's hours, independent of how
 * many days the month happens to hold. Using the monthly formula on a day rate
 * understates overtime by a factor of the month's work days (~26x).
 */
export function hourlyRateFor(
  basis: SalaryBasis,
  fullRate: number,
  workDays: number,
  workHoursPerDay: number,
): number {
  if (!(workHoursPerDay > 0)) return 0;
  if (isDailyWage(basis)) return fullRate / workHoursPerDay;
  if (!(workDays > 0)) return 0;
  return fullRate / (workDays * workHoursPerDay);
}

/**
 * Rough working days in an average month, from the configured work week.
 * 5 days/week → 22, 6 → 26. Used ONLY for statutory previews, where a per-day
 * rate has to be compared against monthly caps (PF, ESI) before the employee
 * has any attendance. The payslip always uses real days.
 */
export function estimatedWorkDaysPerMonth(
  workDaysPerWeek: number | string | undefined,
): number {
  const perWeek = Number(workDaysPerWeek);
  if (!(perWeek > 0)) return 22; // 5-day week
  return Math.round((perWeek * 52) / 12);
}

/**
 * A rate expressed per month, whatever basis it was entered in. Identity for
 * MONTHLY; `rate x estimated work days` for DAILY.
 */
export function monthlyEquivalent(
  basis: SalaryBasis,
  rate: number,
  estWorkDaysPerMonth: number,
): number {
  if (!isDailyWage(basis)) return rate;
  return rate * Math.max(0, estWorkDaysPerMonth);
}

/**
 * Recover the per-day rate from a stored payroll item. A DAILY item holds
 * `dayRate x daysPaid` in baseSalary and the day count in actualWorkDays, so
 * the rate is derivable client-side without another request. Returns null when
 * there is nothing to divide by.
 */
export function impliedDailyRate(
  baseSalary: unknown,
  actualWorkDays: unknown,
): number | null {
  const total = Number(baseSalary);
  const days = Number(actualWorkDays);
  if (!Number.isFinite(total) || !Number.isFinite(days) || days <= 0) return null;
  return total / days;
}

/**
 * The pay basis an employment type forces, or null when it forces none (in
 * which case the Pay Basis field stays editable).
 */
export function payBasisForEmploymentType(
  items: Pick<LibraryItem, 'label' | 'payBasis'>[] | undefined,
  label?: string | null,
): SalaryBasis | null {
  if (!label || !items?.length) return null;
  const match = items.find((i) => i.label === label);
  return match?.payBasis ? toSalaryBasis(match.payBasis) : null;
}

/**
 * Minimal shape of the next-intl translator these helpers accept. Kept loose
 * (`any` key) because next-intl types a scoped translator against its own
 * message keys, which a shared util cannot name.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Translator = (key: any, values?: any) => string;

export const PAY_BASIS_OPTIONS: { value: SalaryBasis; labelKey: string }[] = [
  { value: 'MONTHLY', labelKey: 'monthly' },
  { value: 'DAILY', labelKey: 'daily' },
];

/** "Monthly salary" / "Daily wage". */
export function payBasisLabel(basis: SalaryBasis, t: Translator): string {
  return isDailyWage(basis) ? t('daily') : t('monthly');
}

/** What to call the amount field: "Daily Rate" vs "Base Salary". */
export function rateLabel(basis: SalaryBasis, t: Translator): string {
  return isDailyWage(basis) ? t('rateLabelDaily') : t('rateLabelMonthly');
}

/** " / day" or " / month", for appending to a formatted amount. */
export function rateSuffix(basis: SalaryBasis, t: Translator): string {
  return isDailyWage(basis) ? t('perDay') : t('perMonth');
}

/** The one-line explanation shown under the Pay Basis select. */
export function basisHelperText(basis: SalaryBasis, t: Translator): string {
  return isDailyWage(basis) ? t('dailyHelper') : t('monthlyHelper');
}
