import type {
  PayrollRunStatus,
  PayslipLine,
  SalaryComponentType,
} from '@/types/payroll';
import type { StatusTone } from '@/components/attendance/attendanceFormat';

/**
 * The vocabulary the payslip screens share.
 *
 * Pure, so the grouping and the labels can be tested without a DOM — and so the
 * list, the breakdown and any later export cannot drift into three different
 * answers for what a deduction is.
 */

/**
 * What a run's status means to the person being paid.
 *
 * Only two ever reach an employee: the server refuses to serve a payslip from a
 * run that is not APPROVED or PAID. The rest are listed so a payroll role
 * looking at the same component sees the whole vocabulary rather than a blank.
 */
export const RUN_STATUS_LABEL: Record<PayrollRunStatus, string> = {
  DRAFT: 'Being prepared',
  CALCULATED: 'Being checked',
  APPROVED: 'Approved',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
};

export const RUN_STATUS_TONE: Record<PayrollRunStatus, StatusTone> = {
  DRAFT: 'neutral',
  CALCULATED: 'neutral',
  APPROVED: 'info',
  PAID: 'success',
  CANCELLED: 'error',
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "August 2026". Out-of-range months are shown as the raw pair rather than blank. */
export function periodLabel(month: number, year: number): string {
  const name = MONTHS[month - 1];
  return name ? `${name} ${year}` : `${month}/${year}`;
}

/** "Aug". For a chart axis, where the full name will not fit. */
export function shortMonth(month: number): string {
  return MONTHS[month - 1]?.slice(0, 3) ?? String(month);
}

/**
 * Money as a NUMBER, from the decimal string the API sends.
 *
 * Only ever for arithmetic and comparison. Formatting goes through
 * `formatCurrency`, which knows that OMR has three decimal places — rounding an
 * OMR figure to hundredths loses baisa, and a payslip that loses baisa does not
 * reconcile against the bank.
 */
export function amountOf(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface GroupedLines {
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  employerContributions: PayslipLine[];
}

/**
 * The three columns of a payslip, in the order payroll numbered them.
 *
 * Employer contributions are kept apart from earnings rather than folded in.
 * They are money paid on somebody's behalf and never money they receive, and a
 * breakdown that adds them to gross tells the reader they were paid several
 * hundred more than the bank sent.
 */
export function groupLines(lines: PayslipLine[]): GroupedLines {
  const by = (type: SalaryComponentType) =>
    lines
      .filter((line) => line.type === type)
      .sort((a, b) => a.sequence - b.sequence || a.label.localeCompare(b.label));

  return {
    earnings: by('EARNING'),
    deductions: by('DEDUCTION'),
    employerContributions: by('EMPLOYER_CONTRIBUTION'),
  };
}

/**
 * What fraction of gross was taken off, for the deduction meter.
 *
 * `null` when there is no gross to take it off. Zero would draw an empty bar
 * that reads as "nothing was deducted", which is a different statement from
 * "there was nothing to deduct from".
 */
export function deductionShare(
  gross: string | number | null | undefined,
  deductions: string | number | null | undefined,
): number | null {
  const total = amountOf(gross);
  if (total <= 0) return null;
  return Math.min(100, Math.round((amountOf(deductions) / total) * 1000) / 10);
}

/**
 * The years worth offering in the payslip filter.
 *
 * Built from the payslips the person actually has, plus this year — so somebody
 * who has just joined and has no payslip yet still sees the year they are in,
 * rather than an empty picker that looks broken.
 */
export function payslipYears(
  rows: Array<{ year: number }>,
  currentYear: number = new Date().getFullYear(),
): number[] {
  const years = new Set<number>(rows.map((row) => row.year));
  years.add(currentYear);
  return [...years].sort((a, b) => b - a);
}
