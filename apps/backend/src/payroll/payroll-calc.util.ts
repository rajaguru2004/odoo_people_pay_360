/**
 * The money engine: a salary structure and a month of attendance in, a
 * payslip's lines and totals out.
 *
 * Pure: no Prisma, no Nest, no clock. Layer 0, and the only place that decides
 * what an employee is owed. Everything above it — the run service, the seed,
 * the reports — reads these numbers rather than recomputing them, so the app
 * and its own demo data cannot diverge.
 *
 * Adapted from HRM's `payroll-earnings.util.ts`. HRM split a contracted rate
 * into `basicRate` + `allowanceRate` because its payslip did not itemise; this
 * model is line-first, so the split is unnecessary and the proration applies to
 * the earning SET. That is not a behaviour change: HRM's MONTHLY branch divides
 * `fullRate`, not `basicRate`.
 */

/** The three buckets `SalaryComponentType` names, as plain strings. */
export type ComponentType = 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION';

/** The machine key of the generated loss-of-pay line. It has no component behind it. */
export const LOP_CODE = 'LOP';
export const LOP_LABEL = 'Loss of Pay';

/** Money is `Decimal(18, 3)`, so three decimals is the storable precision. */
export const MONEY_DP = 3;
const MONEY_FACTOR = 10 ** MONEY_DP;

/** Day counts are `Decimal(5, 2)`. */
const DAY_FACTOR = 100;

/** One line of an employee's salary structure, as the calculator needs it. */
export interface StructureLineInput {
  /** Stable machine key — `BASIC`, `HRA`, `SOCIAL_SEC_EE`. */
  code: string;
  label: string;
  type: ComponentType;
  amount: number;
  sequence: number;
  /** Null for a generated line; the catalogue row's id otherwise. */
  componentId?: string | null;
}

export interface PayrollCalcInput {
  lines: StructureLineInput[];
  /** Working days in the period for this employee's branch calendar. */
  workDays: number;
  /** Days actually paid. Never more than `workDays`. */
  paidDays: number;
}

/** A line as it will be persisted on the payslip. */
export interface PayslipLineOutput {
  code: string;
  label: string;
  type: ComponentType;
  amount: number;
  sequence: number;
  componentId: string | null;
}

export interface PayrollCalcResult {
  lines: PayslipLineOutput[];
  workDays: number;
  paidDays: number;
  lopDays: number;
  grossPay: number;
  totalDeductions: number;
  netPay: number;
  /** Recorded, never paid: excluded from gross, deductions and net. */
  totalEmployerCost: number;
}

/** Three decimals, half-up, and never `-0`. */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * MONEY_FACTOR) / MONEY_FACTOR + 0;
}

/** Two decimals, for a day count. */
export function roundDays(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * DAY_FACTOR) / DAY_FACTOR + 0;
}

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Deterministic line order: by `sequence`, then by `code`.
 *
 * Two runs of the same input must produce byte-identical lines, because a
 * recalculation that only reorders rows still reads as a changed payslip to
 * anyone comparing two exports.
 */
function byDisplayOrder(a: PayslipLineOutput, b: PayslipLineOutput): number {
  return a.sequence - b.sequence || a.code.localeCompare(b.code);
}

/**
 * Push a rounding residual into the largest line of a bucket.
 *
 * Rounding each line independently leaves `Σ lines` a few thousandths away from
 * the total the header states, and a payslip whose rows do not add up to its own
 * gross is the first thing anybody notices. The largest line absorbs it because
 * a thousandth is invisible there and conspicuous on a small allowance.
 */
function absorbResidual(lines: PayslipLineOutput[], target: number): void {
  if (lines.length === 0) return;
  const summed = roundMoney(lines.reduce((a, l) => a + l.amount, 0));
  const residual = roundMoney(target - summed);
  if (residual === 0) return;

  // A residual bigger than one rounding step per line is not rounding — it is a
  // bug in the caller, and silently absorbing it would hide the money.
  const tolerance = (1 / MONEY_FACTOR) * lines.length;
  if (Math.abs(residual) > tolerance + Number.EPSILON) {
    throw new Error(
      `Payslip rounding residual ${residual} exceeds tolerance ${tolerance} across ${lines.length} lines`,
    );
  }

  let largest = lines[0];
  for (const line of lines) {
    if (Math.abs(line.amount) > Math.abs(largest.amount)) largest = line;
  }
  largest.amount = roundMoney(largest.amount + residual);
}

/**
 * Compute one payslip.
 *
 * ```
 * gross           = Σ EARNING lines                     (the full contracted amount)
 * lopDays         = max(0, workDays − paidDays)
 * lopAmount       = workDays > 0 ? gross × lopDays / workDays : 0
 * totalDeductions = Σ DEDUCTION lines + lopAmount
 * netPay          = max(0, gross − totalDeductions)
 * employerCost    = Σ EMPLOYER_CONTRIBUTION lines       (in none of the above)
 * ```
 *
 * `workDays === 0` yields no LOP rather than a division by zero: a month a
 * branch never opens is not a month everybody was absent.
 */
export function calculatePayslip(input: PayrollCalcInput): PayrollCalcResult {
  const workDays = Math.max(0, Math.trunc(num(input.workDays)));
  const paidDays = roundDays(
    Math.max(0, Math.min(num(input.paidDays), workDays)),
  );
  const lopDays = roundDays(Math.max(0, workDays - paidDays));

  const earnings: PayslipLineOutput[] = [];
  const deductions: PayslipLineOutput[] = [];
  const employer: PayslipLineOutput[] = [];

  for (const line of input.lines ?? []) {
    const out: PayslipLineOutput = {
      code: String(line.code ?? '')
        .trim()
        .toUpperCase(),
      label: line.label,
      type: line.type,
      amount: roundMoney(num(line.amount)),
      sequence: Number.isFinite(Number(line.sequence))
        ? Number(line.sequence)
        : 100,
      componentId: line.componentId ?? null,
    };
    if (out.type === 'EARNING') earnings.push(out);
    else if (out.type === 'DEDUCTION') deductions.push(out);
    else if (out.type === 'EMPLOYER_CONTRIBUTION') employer.push(out);
  }

  const grossPay = roundMoney(earnings.reduce((a, l) => a + l.amount, 0));
  absorbResidual(earnings, grossPay);

  // LOP prorates the WHOLE earning set, allowances included: an employee absent
  // half the month did not earn half a housing allowance either.
  const rawLop =
    workDays > 0 && lopDays > 0 ? (grossPay * lopDays) / workDays : 0;
  // Capped at gross. A LOP larger than everything earned would make the payslip
  // claim the employee owes the company money for turning up at all.
  const lopAmount = roundMoney(Math.min(Math.max(0, rawLop), grossPay));

  if (lopAmount > 0) {
    deductions.push({
      code: LOP_CODE,
      label: LOP_LABEL,
      type: 'DEDUCTION',
      amount: lopAmount,
      // Last in the deductions block: it is derived from the others' bucket, not
      // contracted alongside them.
      sequence: 900,
      componentId: null,
    });
  }

  const totalDeductions = roundMoney(
    deductions.reduce((a, l) => a + l.amount, 0),
  );
  absorbResidual(deductions, totalDeductions);

  const totalEmployerCost = roundMoney(
    employer.reduce((a, l) => a + l.amount, 0),
  );
  absorbResidual(employer, totalEmployerCost);

  // Net floors at zero. A negative net is never persisted — the shortfall is a
  // recovery to raise against the next period, not a figure to pay.
  const netPay = roundMoney(Math.max(0, grossPay - totalDeductions));

  return {
    lines: [...earnings, ...deductions, ...employer].sort(byDisplayOrder),
    workDays,
    paidDays,
    lopDays,
    grossPay,
    totalDeductions,
    netPay,
    totalEmployerCost,
  };
}

/**
 * Does this structure produce a payslip at all?
 *
 * An employee with no structure, or one with no earning line, produces NO
 * payslip — never a zero one. A zero payslip reads as "paid nothing this month"
 * when what actually happened is "nobody said what to pay them".
 */
export function isPayable(
  lines: StructureLineInput[] | null | undefined,
): boolean {
  return (lines ?? []).some((l) => l.type === 'EARNING' && num(l.amount) > 0);
}
