/**
 * Composing an exit package from parts that were computed elsewhere.
 *
 * Pure: no Prisma, no Nest. Layer 0. Everything expensive — the gratuity
 * entitlement, the encashment quote, the loan balances — is worked out by the
 * services that own those things and handed in here as numbers. This decides
 * only what appears, in what order, on which side, and what the totals are.
 *
 * The ordering is fixed rather than incidental so that two compositions of the
 * same data produce the same document, which is what lets a settlement be
 * regenerated and compared with the one it replaced.
 */

export type SettlementVariant =
  | 'RESIGNATION'
  | 'TERMINATION'
  | 'RETIREMENT'
  | 'DEATH'
  | 'CONTRACT_END';

export type LineCategory = 'EARNING' | 'DEDUCTION';

export interface SettlementLineSpec {
  code: string;
  label: string;
  category: LineCategory;
  computedAmount: number;
  sourceType?: string | null;
  sourceId?: string | null;
  displayOrder: number;
}

export interface ComposeInput {
  variant: SettlementVariant;
  /** Net of the FINAL_SETTLEMENT payroll run, if one has been generated. */
  pendingSalary: number;
  /** Employer-borne gratuity entitlement at the last working day. */
  gratuity: number;
  /** Value of unused leave the policy allows to be encashed on exit. */
  leaveEncashment: number;
  /** Pay in lieu of notice the EMPLOYER owes. */
  noticePay: number;
  /** Anything else owed to the employee, already named. */
  otherEarnings: Array<{ code: string; label: string; amount: number; sourceId?: string | null }>;

  /** Outstanding loan and advance balances to recover. */
  loanRecovery: number;
  /** Court-ordered amounts still attached. */
  garnishment: number;
  /** Company recoveries: asset damage, training bonds, notice shortfall. */
  recoveries: Array<{ code: string; label: string; amount: number; sourceId?: string | null }>;
  /** Balances an earlier payslip could not take. */
  carryForward: number;
  otherDeductions: Array<{ code: string; label: string; amount: number; sourceId?: string | null }>;
}

export interface ComposeResult {
  lines: SettlementLineSpec[];
  totalEarnings: number;
  totalDeductions: number;
  netPayable: number;
  workingLines: string[];
  /** True when deductions exceed what is owed — a debt, not a payment. */
  isReceivable: boolean;
}

const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Apply an override to a line, if one was recorded.
 *
 * The rule that matters: `adjustedAmount` of 0 is a real decision — "this line
 * is not payable" — and must not be read as "no adjustment". Only `null` and
 * `undefined` mean untouched.
 */
export function effectiveAmount(line: {
  computedAmount: unknown;
  adjustedAmount?: unknown;
}): number {
  const adjusted = line.adjustedAmount;
  if (adjusted === null || adjusted === undefined) {
    return round2(Number(line.computedAmount) || 0);
  }
  return round2(Number(adjusted) || 0);
}

/**
 * Sum a set of lines into the three figures a settlement is judged on.
 *
 * Separate from `compose` because it has to run again every time a line is
 * adjusted, and re-composing from scratch would discard the adjustments.
 */
export function totalsFor(
  lines: Array<{ category: string; computedAmount: unknown; adjustedAmount?: unknown }>,
): { totalEarnings: number; totalDeductions: number; netPayable: number; isReceivable: boolean } {
  let totalEarnings = 0;
  let totalDeductions = 0;
  for (const l of lines) {
    const amount = effectiveAmount(l);
    if (l.category === 'EARNING') totalEarnings += amount;
    else totalDeductions += amount;
  }
  totalEarnings = round2(totalEarnings);
  totalDeductions = round2(totalDeductions);
  const netPayable = round2(totalEarnings - totalDeductions);
  return {
    totalEarnings,
    totalDeductions,
    // Deliberately NOT floored at zero, unlike a payslip.
    //
    // A payslip cannot go negative because you do not collect money through
    // one. A settlement can: an employee who owes more than they are due leaves
    // with a debt, and the document has to be able to say so — that is exactly
    // what `CARRY_AS_RECEIVABLE` on the loan side is for.
    netPayable,
    isReceivable: netPayable < 0,
  };
}

/**
 * Build the lines of an exit package.
 *
 * Zero-valued lines are dropped: a settlement listing "Notice pay 0.00" and
 * "Court-ordered deduction 0.00" for someone who had neither is harder to read
 * and no more accurate.
 */
export function composeSettlement(input: ComposeInput): ComposeResult {
  const lines: SettlementLineSpec[] = [];
  let order = 0;

  const add = (
    code: string,
    label: string,
    category: LineCategory,
    amount: number,
    sourceType?: string,
    sourceId?: string | null,
  ) => {
    const value = round2(amount);
    if (value <= 0) return;
    lines.push({
      code,
      label,
      category,
      computedAmount: value,
      sourceType: sourceType ?? null,
      sourceId: sourceId ?? null,
      displayOrder: order++,
    });
  };

  // Earnings, in the order a leaver reads them: what they were owed for work
  // already done, then what the law adds, then anything discretionary.
  add('PENDING_SALARY', 'Pending salary', 'EARNING', input.pendingSalary, 'PAYROLL');
  add('GRATUITY', 'End-of-service gratuity', 'EARNING', input.gratuity, 'GRATUITY');
  add('LEAVE_ENCASHMENT', 'Unused leave encashed', 'EARNING', input.leaveEncashment, 'ENCASHMENT');
  add('NOTICE_PAY', 'Pay in lieu of notice', 'EARNING', input.noticePay, 'NOTICE');
  for (const e of input.otherEarnings) {
    add(e.code, e.label, 'EARNING', e.amount, 'OTHER', e.sourceId);
  }

  // Deductions, strongest claim first — the same ladder payroll recovers in.
  add('GARNISHMENT', 'Court-ordered deduction', 'DEDUCTION', input.garnishment, 'GARNISHMENT');
  add('LOAN_RECOVERY', 'Outstanding loans and advances', 'DEDUCTION', input.loanRecovery, 'LOAN');
  for (const r of input.recoveries) {
    add(r.code, r.label, 'DEDUCTION', r.amount, 'RECOVERY', r.sourceId);
  }
  add('CARRY_FORWARD', 'Deductions carried from earlier payslips', 'DEDUCTION', input.carryForward, 'CARRY_FORWARD');
  for (const d of input.otherDeductions) {
    add(d.code, d.label, 'DEDUCTION', d.amount, 'OTHER', d.sourceId);
  }

  const totals = totalsFor(lines);

  const workingLines: string[] = [
    `Settlement variant: ${input.variant}.`,
    ...lines.map(
      (l) =>
        `${l.category === 'EARNING' ? '+' : '−'} ${l.label}: ${l.computedAmount}`,
    ),
    `Total earnings ${totals.totalEarnings}, total deductions ` +
      `${totals.totalDeductions}, net ${totals.netPayable}.`,
  ];
  if (totals.isReceivable) {
    workingLines.push(
      'Deductions exceed the amount due: this settlement leaves a balance ' +
        'RECEIVABLE from the employee rather than a payment to them.',
    );
  }

  return { lines, ...totals, workingLines };
}
