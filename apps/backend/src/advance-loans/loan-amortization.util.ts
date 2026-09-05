/**
 * Loan & Advances v2 — pure amortization / interest engine.
 *
 * ZERO Nest and Prisma imports on purpose. Everything here is a pure function
 * so the whole interest surface is unit-testable without a database, and so the
 * payroll allocator can be exercised as a table-driven matrix.
 *
 * ── MONEY PRECISION POLICY (read before editing) ───────────────────────────
 * Storage stays Decimal(12,2). This engine computes EXCLUSIVELY in integer
 * minor units: `toMinor()` on entry, `fromMinor()` on exit, no `+ - *` on
 * floating money inside the amortization loop. That is what makes
 * `sum(principalComponents) === principal` an EQUALITY rather than a tolerance,
 * and it is what closes the requirement doc's "EMI rounding causes a 0.01-1.00
 * balance after the final installment" case.
 *
 * `minorScale` is a parameter (default 100) so moving to Decimal(12,3) for OMR
 * baisa later is a settings + migration change, not an engine rewrite.
 *
 * Invariants are ASSERTED, not hoped for: a violated invariant throws rather
 * than silently persisting a bad schedule.
 */

import { toMinor, fromMinor, DEFAULT_MINOR_SCALE } from '../common/utils/money.util';

// ── Types ───────────────────────────────────────────────────────────────────

export type InterestMethod = 'NONE' | 'FLAT' | 'REDUCING_BALANCE';
export type Frequency = 'MONTHLY' | 'WEEKLY' | 'QUARTERLY';
export type FeeMode =
  | 'DEDUCT_FROM_DISBURSEMENT'
  | 'ADD_TO_FIRST_EMI'
  | 'CAPITALIZE';
export type GraceMode =
  | 'NONE'
  | 'MORATORIUM_FULL'
  | 'MORATORIUM_INTEREST_ONLY';

export interface AmortizationInput {
  /** Major units, > 0. */
  principal: number;
  /** Annual NOMINAL rate, percent. 0 when method = NONE. */
  annualRatePercent: number;
  method: InterestMethod;
  /** Integer >= 1. */
  installments: number;
  frequency: Frequency;
  /** Caller has already applied grace and any payroll-cycle snapping. */
  firstDueDate: Date;
  processingFee?: number;
  processingFeeMode?: FeeMode;
  /** 0..100, applied to INTEREST only — never to principal. */
  employerSubsidyPercent?: number;
  /** Smallest representable EMI step: 0.01 (default) or 1 for whole-currency EMIs. */
  roundingUnit?: number;
  /** Minor units per major unit. 100 default. */
  minorScale?: number;
}

export interface ScheduleRow {
  installmentNo: number;
  dueDate: Date;
  openingBalance: number;
  principalComponent: number;
  /** FULL interest for the period, before the employer subsidy. */
  interestComponent: number;
  /** Part of interestComponent the employer bears. Never deducted from salary. */
  employerSubsidyComponent: number;
  feeComponent: number;
  /** EMPLOYEE-PAYABLE: principal + (interest - subsidy) + fee. Payroll deducts THIS. */
  emiAmount: number;
  closingBalance: number;
}

export interface AmortizationResult {
  rows: ScheduleRow[];
  totalPrincipal: number;
  totalInterest: number;
  totalEmployerSubsidy: number;
  totalFee: number;
  /** What the employee actually pays across the whole loan. */
  totalPayable: number;
  /** The level EMI before last-row residue absorption. */
  levelEmi: number;
  lastEmi: number;
  /** Fee taken off the disbursement rather than repaid. */
  upfrontFee: number;
  netDisbursement: number;
}

export class LoanAmortizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoanAmortizationError';
  }
}

// ── Date helpers ────────────────────────────────────────────────────────────

export function periodsPerYear(f: Frequency): 12 | 52 | 4 {
  switch (f) {
    case 'MONTHLY':
      return 12;
    case 'WEEKLY':
      return 52;
    case 'QUARTERLY':
      return 4;
    default:
      throw new LoanAmortizationError(`Unsupported deduction frequency: ${f}`);
  }
}

/**
 * Add whole months, ANCHORED on the original day-of-month.
 *
 * Jan 31 +1 -> Feb 28, +2 -> Mar 31 (not Mar 28). Walking a due date by
 * repeatedly adding one month to the PREVIOUS result drifts a month-end
 * schedule permanently earlier after February; always add from the anchor.
 */
function addMonthsAnchored(anchor: Date, months: number): Date {
  const day = anchor.getUTCDate();
  const target = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + months, 1),
  );
  const lastDayOfTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDayOfTarget));
  return target;
}

/** Advance `anchor` by `n` whole periods of the given frequency. */
export function addPeriods(anchor: Date, f: Frequency, n: number): Date {
  if (!Number.isInteger(n)) {
    throw new LoanAmortizationError(`addPeriods requires an integer n, got ${n}`);
  }
  if (f === 'WEEKLY') {
    const d = new Date(anchor.getTime());
    d.setUTCDate(d.getUTCDate() + 7 * n);
    return d;
  }
  return addMonthsAnchored(anchor, f === 'QUARTERLY' ? 3 * n : n);
}

// ── Core engine ─────────────────────────────────────────────────────────────

function assertFinitePositive(name: string, v: number, allowZero = false) {
  if (!Number.isFinite(v)) {
    throw new LoanAmortizationError(`${name} must be a finite number, got ${v}`);
  }
  if (allowZero ? v < 0 : v <= 0) {
    throw new LoanAmortizationError(
      `${name} must be ${allowZero ? '>= 0' : '> 0'}, got ${v}`,
    );
  }
}

/**
 * Split a whole into `n` integer parts, giving every part `floor(whole / n)`
 * and pushing the entire remainder onto the LAST part.
 *
 * Last-row absorption (rather than spreading the remainder) is what guarantees
 * the closing balance lands on exactly zero.
 */
function splitEvenlyLastAbsorbs(wholeMinor: number, n: number): number[] {
  const base = Math.floor(wholeMinor / n);
  const parts = new Array<number>(n).fill(base);
  parts[n - 1] = wholeMinor - base * (n - 1);
  return parts;
}

/**
 * Build the amortization plan.
 *
 * FLAT and NONE track principal only; REDUCING_BALANCE recomputes interest on
 * the live balance each period and gives the final row `principal = remaining
 * balance` so all rounding residue is absorbed there.
 */
export function generateSchedule(input: AmortizationInput): AmortizationResult {
  const scale = input.minorScale ?? DEFAULT_MINOR_SCALE;
  const n = input.installments;

  assertFinitePositive('principal', input.principal);
  if (!Number.isInteger(n) || n < 1) {
    throw new LoanAmortizationError(
      `installments must be an integer >= 1, got ${input.installments}`,
    );
  }
  if (!Number.isFinite(input.annualRatePercent) || input.annualRatePercent < 0) {
    throw new LoanAmortizationError(
      `annualRatePercent must be a finite number >= 0, got ${input.annualRatePercent}`,
    );
  }
  const subsidyPercent = input.employerSubsidyPercent ?? 0;
  if (subsidyPercent < 0 || subsidyPercent > 100) {
    throw new LoanAmortizationError(
      `employerSubsidyPercent must be within 0..100, got ${subsidyPercent}`,
    );
  }
  if (!(input.firstDueDate instanceof Date) || isNaN(input.firstDueDate.getTime())) {
    throw new LoanAmortizationError('firstDueDate must be a valid Date');
  }

  const feeMode = input.processingFeeMode ?? 'DEDUCT_FROM_DISBURSEMENT';
  const feeMinor = toMinor(input.processingFee ?? 0, scale);
  if (feeMinor < 0) {
    throw new LoanAmortizationError('processingFee must be >= 0');
  }

  const originalPrincipalMinor = toMinor(input.principal, scale);
  // CAPITALIZE folds the fee into principal BEFORE amortizing, so the fee
  // itself bears interest.
  const principalMinor =
    feeMode === 'CAPITALIZE'
      ? originalPrincipalMinor + feeMinor
      : originalPrincipalMinor;

  const roundingUnitMinor = Math.max(
    1,
    Math.round((input.roundingUnit ?? 1 / scale) * scale),
  );

  const ppy = periodsPerYear(input.frequency);
  const method: InterestMethod =
    input.annualRatePercent === 0 ? 'NONE' : input.method;

  // ── principal / interest per period, in minor units ──────────────────────
  let principalParts: number[];
  let interestParts: number[];
  let openingBalances: number[];
  let closingBalances: number[];
  let levelEmiMinor: number;

  if (method === 'NONE') {
    principalParts = splitEvenlyLastAbsorbs(principalMinor, n);
    interestParts = new Array<number>(n).fill(0);
    ({ openingBalances, closingBalances } = walkBalances(
      principalMinor,
      principalParts,
    ));
    levelEmiMinor = principalParts[0];
  } else if (method === 'FLAT') {
    const tenureYears = n / ppy;
    const totalInterestMinor = Math.round(
      (principalMinor * input.annualRatePercent * tenureYears) / 100,
    );
    principalParts = splitEvenlyLastAbsorbs(principalMinor, n);
    interestParts = splitEvenlyLastAbsorbs(totalInterestMinor, n);
    ({ openingBalances, closingBalances } = walkBalances(
      principalMinor,
      principalParts,
    ));
    levelEmiMinor = principalParts[0] + interestParts[0];
  } else {
    const r = input.annualRatePercent / 100 / ppy;
    const growth = Math.pow(1 + r, n);
    const rawEmi = (principalMinor * r * growth) / (growth - 1);
    if (!Number.isFinite(rawEmi)) {
      throw new LoanAmortizationError(
        'Reducing-balance EMI is not finite; check rate and installments',
      );
    }
    levelEmiMinor =
      Math.round(rawEmi / roundingUnitMinor) * roundingUnitMinor;

    principalParts = [];
    interestParts = [];
    let balance = principalMinor;
    for (let k = 0; k < n; k++) {
      const interest = Math.round(balance * r);
      let principalPart: number;
      if (k === n - 1) {
        // Final row absorbs ALL residue: principal is whatever is left.
        principalPart = balance;
      } else {
        principalPart = levelEmiMinor - interest;
        if (principalPart <= 0) {
          throw new LoanAmortizationError(
            'Interest exceeds the level EMI: this loan can never amortize. ' +
              'Reduce the rate or increase the number of installments.',
          );
        }
        // Clamp so a rounding overshoot cannot drive the balance negative.
        if (principalPart > balance) principalPart = balance;
      }
      principalParts.push(principalPart);
      interestParts.push(interest);
      balance -= principalPart;
      if (balance <= 0 && k < n - 1) {
        // Fully amortized early (aggressive rounding unit). Stop here; the
        // trailing rows would be empty and an empty EMI is not a schedule.
        break;
      }
    }
    ({ openingBalances, closingBalances } = walkBalances(
      principalMinor,
      principalParts,
    ));
  }

  const rowCount = principalParts.length;

  // ── employer interest subsidy ────────────────────────────────────────────
  const totalInterestMinor = interestParts.reduce((a, b) => a + b, 0);
  const totalSubsidyMinor = Math.round(
    (totalInterestMinor * subsidyPercent) / 100,
  );
  const subsidyParts = new Array<number>(rowCount).fill(0);
  if (totalSubsidyMinor > 0) {
    let assigned = 0;
    for (let k = 0; k < rowCount - 1; k++) {
      subsidyParts[k] = Math.round((interestParts[k] * subsidyPercent) / 100);
      assigned += subsidyParts[k];
    }
    // Remainder onto the last row so the subsidy total reconciles exactly.
    subsidyParts[rowCount - 1] = totalSubsidyMinor - assigned;
    if (subsidyParts[rowCount - 1] < 0) subsidyParts[rowCount - 1] = 0;
  }

  // ── processing fee placement ─────────────────────────────────────────────
  const feeParts = new Array<number>(rowCount).fill(0);
  if (feeMode === 'ADD_TO_FIRST_EMI' && feeMinor > 0) {
    feeParts[0] = feeMinor;
  }
  const upfrontFeeMinor = feeMode === 'DEDUCT_FROM_DISBURSEMENT' ? feeMinor : 0;
  const netDisbursementMinor = originalPrincipalMinor - upfrontFeeMinor;

  // ── materialize rows ─────────────────────────────────────────────────────
  const rows: ScheduleRow[] = [];
  for (let k = 0; k < rowCount; k++) {
    const employeeInterest = interestParts[k] - subsidyParts[k];
    const emiMinor = principalParts[k] + employeeInterest + feeParts[k];
    rows.push({
      installmentNo: k + 1,
      dueDate: addPeriods(input.firstDueDate, input.frequency, k),
      openingBalance: fromMinor(openingBalances[k], scale),
      principalComponent: fromMinor(principalParts[k], scale),
      interestComponent: fromMinor(interestParts[k], scale),
      employerSubsidyComponent: fromMinor(subsidyParts[k], scale),
      feeComponent: fromMinor(feeParts[k], scale),
      emiAmount: fromMinor(emiMinor, scale),
      closingBalance: fromMinor(closingBalances[k], scale),
    });
  }

  // ── invariants (throw, never return a bad schedule) ──────────────────────
  const sumPrincipal = principalParts.reduce((a, b) => a + b, 0);
  if (sumPrincipal !== principalMinor) {
    throw new LoanAmortizationError(
      `loan amortization invariant violated: principal components sum to ${sumPrincipal}, expected ${principalMinor}`,
    );
  }
  const sumSubsidy = subsidyParts.reduce((a, b) => a + b, 0);
  if (sumSubsidy > totalInterestMinor) {
    throw new LoanAmortizationError(
      'loan amortization invariant violated: employer subsidy exceeds total interest',
    );
  }
  if (closingBalances[rowCount - 1] !== 0) {
    throw new LoanAmortizationError(
      `loan amortization invariant violated: final closing balance is ${closingBalances[rowCount - 1]}, expected 0`,
    );
  }
  for (const row of rows) {
    if (row.emiAmount <= 0) {
      throw new LoanAmortizationError(
        `loan amortization invariant violated: installment ${row.installmentNo} has a non-positive EMI`,
      );
    }
  }

  const totalPayableMinor = rows.reduce(
    (a, row) => a + toMinor(row.emiAmount, scale),
    0,
  );

  return {
    rows,
    totalPrincipal: fromMinor(principalMinor, scale),
    totalInterest: fromMinor(totalInterestMinor, scale),
    totalEmployerSubsidy: fromMinor(sumSubsidy, scale),
    totalFee: fromMinor(feeMinor, scale),
    totalPayable: fromMinor(totalPayableMinor, scale),
    levelEmi: fromMinor(levelEmiMinor, scale),
    lastEmi: rows[rowCount - 1].emiAmount,
    upfrontFee: fromMinor(upfrontFeeMinor, scale),
    netDisbursement: fromMinor(netDisbursementMinor, scale),
  };
}

function walkBalances(
  startMinor: number,
  principalParts: number[],
): { openingBalances: number[]; closingBalances: number[] } {
  const openingBalances: number[] = [];
  const closingBalances: number[] = [];
  let balance = startMinor;
  for (const part of principalParts) {
    openingBalances.push(balance);
    balance -= part;
    closingBalances.push(balance);
  }
  return { openingBalances, closingBalances };
}

/**
 * Re-amortize a REMAINING balance over the remaining periods.
 *
 * Used after a prepayment, a rate change, a hold/resume, or a restructure.
 * The outstanding principal MUST come from the ledger (recomputeBalances), not
 * from the original principal — the requirement doc's "loan is edited after
 * some EMIs have already been deducted" case turns on exactly that.
 *
 * `openingArrears` (an unpaid shortfall carried from a PARTIAL row) is added to
 * installment #1's EMI only — never to its principalComponent, or the arrear
 * would be counted as principal twice.
 */
export function regenerateFromBalance(
  input: AmortizationInput & {
    outstandingPrincipal: number;
    startInstallmentNo: number;
    openingArrears?: number;
  },
): AmortizationResult {
  const scale = input.minorScale ?? DEFAULT_MINOR_SCALE;
  const result = generateSchedule({
    ...input,
    principal: input.outstandingPrincipal,
    // Fees were already dealt with on the original disbursement; a regeneration
    // must not re-charge them.
    processingFee: 0,
    processingFeeMode: 'DEDUCT_FROM_DISBURSEMENT',
  });

  const arrearsMinor = toMinor(input.openingArrears ?? 0, scale);
  const rows = result.rows.map((row, idx) => ({
    ...row,
    installmentNo: input.startInstallmentNo + idx,
    emiAmount:
      idx === 0 && arrearsMinor > 0
        ? fromMinor(toMinor(row.emiAmount, scale) + arrearsMinor, scale)
        : row.emiAmount,
  }));

  return {
    ...result,
    rows,
    lastEmi: rows[rows.length - 1].emiAmount,
    totalPayable: fromMinor(
      rows.reduce((a, r) => a + toMinor(r.emiAmount, scale), 0),
      scale,
    ),
  };
}

// ── Payment application ─────────────────────────────────────────────────────

export interface PaymentDue {
  fee: number;
  interest: number;
  principal: number;
}

/**
 * Split one payment across fee, interest and principal.
 *
 * The FEE is always taken first, under either order: it is a charge for the
 * transaction rather than part of the debt, and leaving it unpaid would keep a
 * loan open on a rounding-sized balance.
 *
 * After that, `order` decides:
 *
 *  - **INTEREST_FIRST** (the default, and the conventional one) — a partial
 *    recovery does not under-report interest income or silently understate
 *    what is still owed.
 *  - **PRINCIPAL_FIRST** — every payment reduces the balance the next period's
 *    interest is computed on, so the borrower pays less overall. Some
 *    jurisdictions and staff-loan schemes require it.
 *
 * `ResolvedLoanPolicy.paymentAllocationOrder` carried both values from the
 * start and was branched on nowhere: a deployment could set PRINCIPAL_FIRST,
 * see it saved, and be charged INTEREST_FIRST forever.
 *
 * Any surplus beyond `due` is NOT returned here — the caller treats it as a
 * prepayment.
 */
export function splitPayment(
  amount: number,
  due: PaymentDue,
  minorScale = DEFAULT_MINOR_SCALE,
  order: 'INTEREST_FIRST' | 'PRINCIPAL_FIRST' = 'INTEREST_FIRST',
): PaymentDue {
  let remaining = Math.max(0, toMinor(amount, minorScale));
  const take = (dueMajor: number): number => {
    const dueMinor = Math.max(0, toMinor(dueMajor, minorScale));
    const taken = Math.min(remaining, dueMinor);
    remaining -= taken;
    return taken;
  };

  const fee = take(due.fee);
  let interest: number;
  let principal: number;
  if (order === 'PRINCIPAL_FIRST') {
    principal = take(due.principal);
    interest = take(due.interest);
  } else {
    interest = take(due.interest);
    principal = take(due.principal);
  }

  return {
    fee: fromMinor(fee, minorScale),
    interest: fromMinor(interest, minorScale),
    principal: fromMinor(principal, minorScale),
  };
}

// ── Multi-loan allocation against a limited net ─────────────────────────────

export interface AllocationCandidate {
  scheduleId: string;
  requestId: string;
  /** Lower is recovered first. */
  priority: number;
  due: PaymentDue;
}

export interface AllocationLine {
  scheduleId: string;
  requestId: string;
  amount: number;
  feeComponent: number;
  interestComponent: number;
  principalComponent: number;
  plannedAmount: number;
  shortfallAmount: number;
}

export interface AllocationResult {
  totalDeducted: number;
  rows: AllocationLine[];
}

/**
 * Distribute an available net-pay pool across competing installments.
 *
 * Candidates must arrive ALREADY sorted by the caller's full comparator
 * (priority, type rank, oldest due, tiebreak, id) so that "same priority" never
 * depends on row order. This function only drains the budget in the given
 * order; `priority` is carried for reporting.
 *
 * `ALL_OR_NOTHING` skips a row it cannot fully fund and moves on to the next —
 * a smaller later loan can still be recovered in full.
 */
export function allocateRecovery(
  candidates: AllocationCandidate[],
  pool: number,
  opts: { partialPolicy: 'PARTIAL' | 'ALL_OR_NOTHING' | 'DEFER' },
  minorScale = DEFAULT_MINOR_SCALE,
): AllocationResult {
  let remaining = Math.max(0, toMinor(pool, minorScale));
  const rows: AllocationLine[] = [];

  for (const candidate of candidates) {
    const dueMinor =
      toMinor(candidate.due.fee, minorScale) +
      toMinor(candidate.due.interest, minorScale) +
      toMinor(candidate.due.principal, minorScale);
    if (dueMinor <= 0) continue;
    if (remaining <= 0) break;

    let takeMinor: number;
    if (dueMinor <= remaining) {
      takeMinor = dueMinor;
    } else if (opts.partialPolicy === 'PARTIAL') {
      takeMinor = remaining;
    } else {
      // ALL_OR_NOTHING and DEFER both decline a partial payment here; the
      // difference between them is the SCHEDULE effect, which the caller
      // applies (defer carries forward, all-or-nothing just skips).
      continue;
    }

    const split = splitPayment(
      fromMinor(takeMinor, minorScale),
      candidate.due,
      minorScale,
    );
    remaining -= takeMinor;
    rows.push({
      scheduleId: candidate.scheduleId,
      requestId: candidate.requestId,
      amount: fromMinor(takeMinor, minorScale),
      feeComponent: split.fee,
      interestComponent: split.interest,
      principalComponent: split.principal,
      plannedAmount: fromMinor(dueMinor, minorScale),
      shortfallAmount: fromMinor(dueMinor - takeMinor, minorScale),
    });
  }

  return {
    totalDeducted: fromMinor(
      rows.reduce((a, r) => a + toMinor(r.amount, minorScale), 0),
      minorScale,
    ),
    rows,
  };
}

// ── Pre-approval affordability gates ────────────────────────────────────────

export type AffordabilityCode =
  | 'EMI_BELOW_MIN'
  | 'EMI_EXCEEDS_NET'
  | 'EMI_EXCEEDS_CAP'
  | 'NET_BELOW_FLOOR'
  | 'TOTAL_EMI_EXCEEDS_NET';

export type AffordabilityResult =
  | { ok: true }
  | { ok: false; code: AffordabilityCode; message: string };

/**
 * Gate an EMI against the employee's monthly net BEFORE any schedule is
 * persisted. Callers pass `monthlyNet` from the shared salary proxy so the
 * daily-wage scaling rule is applied consistently.
 */
export function validateAffordability(args: {
  emi: number;
  otherActiveEmis: number;
  monthlyNet: number;
  minEmi?: number;
  maxEmiPercentOfNet?: number;
  minNetAfterEmi?: number;
}): AffordabilityResult {
  const { emi, otherActiveEmis, monthlyNet } = args;

  if (args.minEmi != null && emi < args.minEmi) {
    return {
      ok: false,
      code: 'EMI_BELOW_MIN',
      message: `The instalment of ${emi} is below the minimum allowed of ${args.minEmi}. Reduce the number of instalments.`,
    };
  }
  if (emi > monthlyNet) {
    return {
      ok: false,
      code: 'EMI_EXCEEDS_NET',
      message: `The instalment of ${emi} exceeds the monthly net pay of ${monthlyNet}.`,
    };
  }
  if (args.maxEmiPercentOfNet != null) {
    const cap = (monthlyNet * args.maxEmiPercentOfNet) / 100;
    if (emi > cap) {
      return {
        ok: false,
        code: 'EMI_EXCEEDS_CAP',
        message: `The instalment of ${emi} exceeds ${args.maxEmiPercentOfNet}% of net pay (${cap}).`,
      };
    }
  }
  if (emi + otherActiveEmis > monthlyNet) {
    return {
      ok: false,
      code: 'TOTAL_EMI_EXCEEDS_NET',
      message: `Total instalments of ${emi + otherActiveEmis} across all active loans exceed the monthly net pay of ${monthlyNet}.`,
    };
  }
  if (args.minNetAfterEmi != null) {
    const left = monthlyNet - emi - otherActiveEmis;
    if (left < args.minNetAfterEmi) {
      return {
        ok: false,
        code: 'NET_BELOW_FLOOR',
        message: `Take-home would fall to ${left}, below the required minimum of ${args.minNetAfterEmi}.`,
      };
    }
  }
  return { ok: true };
}
