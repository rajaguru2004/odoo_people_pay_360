/**
 * What a payslip's Income and Deduction sections should show.
 *
 * Pure and separate from the component for one reason: the contract that
 * matters here is *"with itemisation off, the payslip renders exactly what it
 * rendered before"*, and that is a statement about an array. Asserting it as an
 * array equality in a millisecond unit test is stronger and cheaper than
 * asserting it through a browser.
 *
 * The numbers never come from lines. `totalIncome`, `totalDeductions` and
 * `netSalary` stay derived from the authoritative columns, so turning
 * itemisation on cannot change a figure on screen — only the granularity of the
 * labels beside it.
 */

export type PayslipSign = 'plus' | 'minus' | 'none';

export interface PayslipRow {
  /** Stable key for React and for tests. */
  key: string;
  /** i18n key, when the label is one of the fixed ones. */
  labelKey?: string;
  /** Literal label — used for itemised lines, whose names are data. */
  label?: string;
  /** Interpolation values for `labelKey`. */
  labelValues?: Record<string, string | number>;
  /** Second line under the label, e.g. "19 days × 1,200". */
  sublabelKey?: string;
  sublabelValues?: Record<string, string | number>;
  amount: number;
  sign: PayslipSign;
  /** Whether this row came from a stored line or from a column. */
  source: 'COLUMN' | 'LINE';
}

export interface PayslipGroups {
  income: PayslipRow[];
  deductions: PayslipRow[];
}

export interface PayslipItemLike {
  baseSalary: unknown;
  allowances: unknown;
  bonus: unknown;
  overtimeHours: unknown;
  overtimePay: unknown;
  foodAllowance: unknown;
  siteAllowance?: unknown;
  deduction: unknown;
  insurance: unknown;
  tax: unknown;
  actualWorkDays?: unknown;
  lines?: StoredLine[] | null;
}

export interface StoredLine {
  code: string;
  label: string;
  category: 'EARNING' | 'DEDUCTION';
  bucket: string;
  amount: unknown;
  displayOrder?: number;
}

export interface BuildOptions {
  /** Country-aware labels for the two combined statutory columns. */
  labels: { pf: string; tax: string };
  /** Daily-wage staff get a "days × rate" sublabel under basic. */
  daily: boolean;
  dayRate: number | null;
}

const num = (v: unknown) => Number(v ?? 0);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Which buckets belong to which section, and in what order they read. */
const INCOME_BUCKETS = [
  'baseSalary',
  'allowances',
  'bonus',
  'overtimePay',
  'foodAllowance',
  'siteAllowance',
] as const;

const DEDUCTION_BUCKETS = ['insurance', 'tax', 'deduction'] as const;

/**
 * Do the stored lines account for a column exactly?
 *
 * A bucket is only replaced by its lines when they add up to it. If they do not
 * — a payslip written before a fix, a run whose itemisation was tolerated by the
 * non-strict setting — the aggregate row is shown instead, because a breakdown
 * that disagrees with the money is worse than no breakdown.
 */
export function bucketReconciles(
  lines: StoredLine[],
  bucket: string,
  column: number,
): boolean {
  const mine = lines.filter((l) => l.bucket === bucket);
  if (mine.length === 0) return false;
  const sum = round2(mine.reduce((a, l) => a + num(l.amount), 0));
  return Math.abs(sum - round2(column)) <= 0.005;
}

/**
 * Build the two sections.
 *
 * With `item.lines` empty or absent, the output is exactly the rows the payslip
 * has always shown, in the order it has always shown them — including the ones
 * that are conditional on being non-zero (food allowance, site allowance, other
 * deductions).
 */
export function buildPayslipLines(
  item: PayslipItemLike,
  opts: BuildOptions,
): PayslipGroups {
  const lines = (item.lines ?? []).slice().sort(
    (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0),
  );

  const columns: Record<string, number> = {
    baseSalary: num(item.baseSalary),
    allowances: num(item.allowances),
    bonus: num(item.bonus),
    overtimePay: num(item.overtimePay),
    foodAllowance: num(item.foodAllowance),
    siteAllowance: num(item.siteAllowance),
    deduction: num(item.deduction),
    insurance: num(item.insurance),
    tax: num(item.tax),
  };

  const itemised = (bucket: string, sign: PayslipSign): PayslipRow[] =>
    lines
      .filter((l) => l.bucket === bucket)
      .map((l) => ({
        key: `${bucket}:${l.code}`,
        label: l.label,
        amount: num(l.amount),
        sign,
        source: 'LINE' as const,
      }));

  // ── Income ─────────────────────────────────────────────────────────────
  const income: PayslipRow[] = [];

  if (bucketReconciles(lines, 'baseSalary', columns.baseSalary)) {
    income.push(...itemised('baseSalary', 'none'));
  } else {
    income.push({
      key: 'baseSalary',
      labelKey: 'basicSalary',
      ...(opts.daily && opts.dayRate !== null
        ? {
            sublabelKey: 'daysTimesRate',
            sublabelValues: {
              days: Number(item.actualWorkDays) || 0,
              rate: opts.dayRate,
            },
          }
        : {}),
      amount: columns.baseSalary,
      sign: 'none',
      source: 'COLUMN',
    });
  }

  for (const bucket of INCOME_BUCKETS.slice(1)) {
    const column = columns[bucket] ?? 0;
    // Food and site allowance have always been conditional; basic, allowance,
    // bonus and overtime have always shown even at zero.
    const alwaysShown = bucket === 'allowances' || bucket === 'bonus' || bucket === 'overtimePay';
    if (!alwaysShown && column <= 0) continue;

    if (bucketReconciles(lines, bucket, column)) {
      income.push(...itemised(bucket, 'plus'));
      continue;
    }
    income.push({
      key: bucket,
      ...(bucket === 'allowances'
        ? { label: 'Allowance' }
        : bucket === 'bonus'
          ? { label: 'Bonus' }
          : bucket === 'overtimePay'
            ? {
                label: `Overtime (${num(item.overtimeHours)}h)`,
              }
            : bucket === 'foodAllowance'
              ? { label: 'Food Allowance (Overtime)' }
              : { label: 'Site Allowance (Overtime)' }),
      amount: column,
      sign: 'plus',
      source: 'COLUMN',
    });
  }

  // ── Deductions ─────────────────────────────────────────────────────────
  const deductions: PayslipRow[] = [];

  for (const bucket of DEDUCTION_BUCKETS) {
    const column = columns[bucket] ?? 0;
    // PF and tax have always shown even at zero; the rest are conditional.
    const alwaysShown = bucket === 'insurance' || bucket === 'tax';
    if (!alwaysShown && column <= 0) continue;

    if (bucketReconciles(lines, bucket, column)) {
      deductions.push(...itemised(bucket, 'minus'));
      continue;
    }
    deductions.push({
      key: bucket,
      ...(bucket === 'insurance'
        ? { label: opts.labels.pf }
        : bucket === 'tax'
          ? { label: opts.labels.tax }
          : {
              labelKey: opts.daily ? 'deductionOther' : 'deductionsAbsenceAndOther',
            }),
      amount: column,
      sign: 'minus',
      source: 'COLUMN',
    });
  }

  return { income, deductions };
}
