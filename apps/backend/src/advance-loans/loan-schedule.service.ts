import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { roundMoney, toMinor, fromMinor } from '../common/utils/money.util';
import {
  generateSchedule,
  regenerateFromBalance,
  LoanAmortizationError,
  type AmortizationInput,
  type AmortizationResult,
  type Frequency,
  type InterestMethod,
  type FeeMode,
} from './loan-amortization.util';
import { LoanRecoveryService } from './loan-recovery.service';
import { LoanAccessService } from './loan-access.service';
import { assertInBranch } from '../common/branch/branch-scope.util';

type Tx = Prisma.TransactionClient | PrismaService;

/**
 * Owns the amortization PLAN: generating it at approval/disbursement and
 * regenerating it after a prepayment, rate change, hold or restructure.
 *
 * Persistence rules that the rest of the module depends on:
 *  - Rows are immutable once money has touched them. PAID / PARTIAL / SKIPPED /
 *    WAIVED rows are never regenerated; only SCHEDULED rows are superseded.
 *  - A regeneration bumps `AdvanceLoanRequest.scheduleVersion` and marks the old
 *    SCHEDULED rows CANCELLED (retained, not deleted) — that IS the audit trail
 *    for "schedule regenerated".
 *  - Regeneration is BLOCKED while an unlocked payroll holds a PENDING ledger
 *    row for the loan, because that payroll has already committed to an amount.
 *
 * ── WHAT `AdvanceLoanRequest.outstandingInterest` MEANS ────────────────────
 * It is the EMPLOYEE-BORNE interest that has ACCRUED and is still UNPAID:
 * the sum, over live schedule rows whose `dueDate` has already passed, of
 * `interestComponent - employerSubsidyComponent - paidInterest`.
 *
 * It is NOT the loan's remaining lifetime interest. It used to be, and that is
 * what made a prepayment more expensive than not prepaying: `prepay` ran its
 * interest-before-principal waterfall against the whole lifetime figure, so a
 * payment made on day one was eaten by interest nobody had earned yet, and then
 * this service re-amortized the un-reduced balance and charged interest over the
 * same calendar a second time.
 *
 * The LIVE SCHEDULE is the source of truth (`accruedUnpaidInterest`); the column
 * is a cache refreshed by every writer here and in `LoanLifecycleService`. Any
 * new writer MUST agree with that definition — never park a lifetime total in it.
 */
@Injectable()
export class LoanScheduleService {
  private readonly logger = new Logger(LoanScheduleService.name);

  /**
   * Row statuses money can still be collected against. The same set
   * `LoanRecoveryService.loadCandidates` uses, deliberately: a row payroll
   * would collect from and a row a payoff quote charges for must not be two
   * different populations. (The DATE cut differs — see `accruedUnpaidInterest`.)
   */
  private static readonly COLLECTABLE: Array<
    'SCHEDULED' | 'PARTIAL' | 'DEFERRED'
  > = ['SCHEDULED', 'PARTIAL', 'DEFERRED'];

  constructor(
    private prisma: PrismaService,
    private settings: SystemSettingsService,
    private access: LoanAccessService,
  ) {}

  /**
   * Snap a due date to the payroll cycle it should land in.
   *
   * Payroll is monthly, so a MONTHLY instalment is due on the last day of its
   * month; anything else keeps its exact date and is swept up by the
   * `dueCycleKey <= cycle` rule at recovery time.
   */
  private snapToCycle(d: Date, frequency: Frequency): Date {
    if (frequency !== 'MONTHLY') return d;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  }

  private toRows(
    requestId: string,
    version: number,
    result: AmortizationResult,
    frequency: Frequency,
  ): Prisma.LoanScheduleCreateManyInput[] {
    return result.rows.map((row) => {
      const due = this.snapToCycle(row.dueDate, frequency);
      const dueMonth = due.getUTCMonth() + 1;
      const dueYear = due.getUTCFullYear();
      return {
        requestId,
        version,
        installmentNo: row.installmentNo,
        dueDate: due,
        dueCycleKey: LoanRecoveryService.cycleKey(dueMonth, dueYear),
        dueMonth,
        dueYear,
        openingBalance: row.openingBalance,
        principalComponent: row.principalComponent,
        interestComponent: row.interestComponent,
        employerSubsidyComponent: row.employerSubsidyComponent,
        feeComponent: row.feeComponent,
        emiAmount: row.emiAmount,
        closingBalance: row.closingBalance,
      };
    });
  }

  /** Turn an engine error into a 400 rather than leaking a 500. */
  private run<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof LoanAmortizationError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  private async roundingUnit(): Promise<number> {
    const raw = await this.settings.getSetting('loan_rounding_unit', '0.01');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0.01;
  }

  // ── accrued interest ─────────────────────────────────────────────────────

  /**
   * Interest that has ACCRUED and is still unpaid, read from the live plan.
   *
   * "Accrued" is `dueDate <= today`: the instalment date has actually arrived,
   * so the period it covers has actually elapsed. An instalment still ahead has
   * earned nothing, which is what makes a payment before the first due date
   * entirely principal.
   *
   * Deliberately STRICTER than payroll's `dueCycleKey <= cycle`, which treats
   * an instalment due on the 31st as collectable from the 1st. Using the cycle
   * rule here would make a rebuilt plan owe a month's interest the instant it
   * was rebuilt — a smaller version of the very thing being fixed. The gap is
   * only ever intra-month and it errs in the borrower's favour; a payroll run
   * that has already committed to an amount blocks these operations anyway
   * (`assertNoRunInFlight`), so the two can never disagree about live money.
   *
   * Employee-borne only: the employer subsidy is never owed by the borrower,
   * and `paidInterest` has already been collected (or forgiven, see
   * `creditAccruedInterest`).
   *
   * Integer minor units throughout, so summing a 12-row plan cannot drift.
   */
  async accruedUnpaidInterest(
    requestId: string,
    opts: { version?: number; asOf?: Date } = {},
    tx: Tx = this.prisma,
  ): Promise<number> {
    let version = opts.version;
    if (version == null) {
      const loan = await tx.advanceLoanRequest.findUnique({
        where: { id: requestId },
        select: { scheduleVersion: true },
      });
      // A pre-v2 loan has no plan at all, and a plan is the only thing that can
      // say interest was earned. No plan => nothing accrued, never a guess.
      if (!loan) return 0;
      version = loan.scheduleVersion ?? 0;
    }

    const rows = await tx.loanSchedule.findMany({
      where: {
        requestId,
        version,
        dueDate: { lte: opts.asOf ?? new Date() },
        status: { in: LoanScheduleService.COLLECTABLE },
      },
      select: {
        interestComponent: true,
        employerSubsidyComponent: true,
        paidInterest: true,
      },
    });

    let owedMinor = 0;
    for (const r of rows) {
      const rowMinor =
        toMinor(Number(r.interestComponent)) -
        toMinor(Number(r.employerSubsidyComponent)) -
        toMinor(Number(r.paidInterest));
      if (rowMinor > 0) owedMinor += rowMinor;
    }
    return fromMinor(owedMinor);
  }

  /**
   * Settle `amount` of accrued interest against the due instalments, oldest
   * first, and report how much was actually absorbed.
   *
   * Both a prepayment (money received) and an interest waiver (debt forgiven)
   * end the same way from the PLAN's point of view: that interest must never be
   * asked for again. Without this, `accruedUnpaidInterest` would re-report the
   * same interest on the next quote and the borrower would be charged twice —
   * the second half of the double-charge this module is being fixed for.
   *
   * PRINCIPAL is deliberately NOT credited here. A prepayment's principal is
   * carried by `amountRepaid`, and the regeneration that follows re-amortizes
   * the reduced balance; crediting it to a row as well would spend it twice.
   */
  async creditAccruedInterest(
    requestId: string,
    amount: number,
    opts: { asOf?: Date; note?: string } = {},
    tx: Tx = this.prisma,
  ): Promise<number> {
    let remainingMinor = toMinor(Math.max(0, Number(amount) || 0));
    if (remainingMinor <= 0) return 0;

    const loan = await tx.advanceLoanRequest.findUnique({
      where: { id: requestId },
      select: { scheduleVersion: true },
    });
    if (!loan) return 0;

    const now = opts.asOf ?? new Date();
    const rows = await tx.loanSchedule.findMany({
      where: {
        requestId,
        version: loan.scheduleVersion ?? 0,
        dueDate: { lte: now },
        status: { in: LoanScheduleService.COLLECTABLE },
      },
      orderBy: { installmentNo: 'asc' },
      select: {
        id: true,
        emiAmount: true,
        interestComponent: true,
        employerSubsidyComponent: true,
        paidInterest: true,
        paidAmount: true,
      },
    });

    let appliedMinor = 0;
    for (const r of rows) {
      if (remainingMinor <= 0) break;
      const owedMinor =
        toMinor(Number(r.interestComponent)) -
        toMinor(Number(r.employerSubsidyComponent)) -
        toMinor(Number(r.paidInterest));
      if (owedMinor <= 0) continue;

      const takeMinor = Math.min(owedMinor, remainingMinor);
      remainingMinor -= takeMinor;
      appliedMinor += takeMinor;

      // Projected exactly as the payroll lock projects a recovery, so a row
      // half-settled here and half-settled by payroll reads the same either way.
      const paidAmountMinor = toMinor(Number(r.paidAmount)) + takeMinor;
      const emiMinor = toMinor(Number(r.emiAmount));
      const settled = paidAmountMinor >= emiMinor;
      await tx.loanSchedule.update({
        where: { id: r.id },
        data: {
          paidInterest: fromMinor(toMinor(Number(r.paidInterest)) + takeMinor),
          paidAmount: fromMinor(paidAmountMinor),
          carryForwardAmount: fromMinor(Math.max(0, emiMinor - paidAmountMinor)),
          status: settled ? 'PAID' : 'PARTIAL',
          ...(settled ? { settledAt: now } : {}),
          ...(opts.note ? { note: opts.note } : {}),
        },
      });
    }

    return fromMinor(appliedMinor);
  }

  /**
   * Build and persist the FIRST schedule for a request.
   *
   * Called at approval (or disbursement). Replaces the pre-v2
   * `installmentAmount = Math.round(amount / installments)`, which never
   * reconciled — 100,000 over 7 became 100,002.
   */
  async generate(
    requestId: string,
    tx: Tx = this.prisma,
  ): Promise<AmortizationResult> {
    const loan = await tx.advanceLoanRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        type: true,
        amount: true,
        installments: true,
        interestMethod: true,
        interestRate: true,
        deductionFrequency: true,
        processingFee: true,
        processingFeeMode: true,
        employerSubsidyPercent: true,
        gracePeriods: true,
        firstDeductionDate: true,
        disbursementDate: true,
        effectiveDate: true,
        scheduleVersion: true,
        createdAt: true,
      },
    });
    if (!loan) throw new NotFoundException('Loan request not found');

    const frequency = loan.deductionFrequency as Frequency;
    const interestEnabled =
      (await this.settings.getSetting('loan_interest_enabled', 'false')) ===
      'true';
    const method: InterestMethod = interestEnabled
      ? (loan.interestMethod as InterestMethod)
      : 'NONE';

    // Grace shifts the FIRST due date; the tenure and total interest are
    // unchanged (MORATORIUM_FULL). An explicit firstDeductionDate always wins.
    const anchor =
      loan.firstDeductionDate ??
      loan.disbursementDate ??
      loan.effectiveDate ??
      loan.createdAt;
    const base = new Date(anchor);
    const withGrace = new Date(
      Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth() + (loan.gracePeriods ?? 0),
        base.getUTCDate(),
      ),
    );

    const input: AmortizationInput = {
      principal: Number(loan.amount),
      annualRatePercent: interestEnabled ? Number(loan.interestRate) : 0,
      method,
      // An ADVANCE is always a single instalment; that keeps it on the same
      // schedule machinery as a loan instead of needing a bespoke branch.
      installments: loan.type === 'ADVANCE' ? 1 : (loan.installments ?? 1),
      frequency,
      firstDueDate: this.snapToCycle(withGrace, frequency),
      processingFee: Number(loan.processingFee ?? 0),
      processingFeeMode: loan.processingFeeMode as FeeMode,
      employerSubsidyPercent: Number(loan.employerSubsidyPercent ?? 0),
      roundingUnit: await this.roundingUnit(),
    };

    const result = this.run(() => generateSchedule(input));
    const version = (loan.scheduleVersion ?? 0) + 1;

    await tx.loanSchedule.createMany({
      data: this.toRows(loan.id, version, result, frequency),
    });

    // Accrued-and-unpaid, NOT the lifetime total (see the class doc). A brand
    // new plan whose first instalment is still ahead has earned nothing, so this
    // is 0 — which is exactly what makes a day-one prepayment all principal.
    // It is non-zero only when the loan is booked with a due date already past.
    const accruedInterest = await this.accruedUnpaidInterest(
      loan.id,
      { version },
      tx,
    );

    await tx.advanceLoanRequest.update({
      where: { id: loan.id },
      data: {
        scheduleVersion: version,
        // Kept in sync for the legacy UI and the pre-v2 recovery bridge.
        installmentAmount: result.levelEmi,
        totalPayable: result.totalPayable,
        outstandingPrincipal: result.totalPrincipal,
        outstandingInterest: accruedInterest,
        // Lifetime SCHEDULED interest, snapshotted at approval for reporting.
        // Despite the name this is not "accrued to date" — outstandingInterest
        // is the accrual figure; this one is the plan's total.
        interestAccrued: result.totalInterest,
        disbursedAmount: result.netDisbursement,
        firstDeductionDate: result.rows[0]?.dueDate ?? null,
      },
    });

    return result;
  }

  /**
   * Rebuild the remaining schedule from the CURRENT outstanding balance.
   *
   * The balance must come from what has actually been paid, never from the
   * original principal — that is exactly the requirement doc's "loan is edited
   * after some EMIs have already been deducted" case.
   */
  async regenerate(
    requestId: string,
    opts: {
      newInstallments?: number;
      /**
       * Lengthen the plan by this many instalments beyond what is still
       * unsettled, keeping the instalment amount roughly where it was.
       *
       * `skip EXTEND` passes 1: the balance that was spread over N unsettled
       * instalments is spread over N+1, so the loan simply ends a cycle later.
       * Ignored when `newInstallments` names an exact count.
       */
      extendBy?: number;
      newInterestRate?: number;
      newInterestMethod?: InterestMethod;
      newFrequency?: Frequency;
      firstDueDate?: Date;
      reason?: string;
      actorId?: string | null;
    } = {},
    tx: Tx = this.prisma,
  ): Promise<AmortizationResult | null> {
    const loan = await tx.advanceLoanRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        amount: true,
        amountRepaid: true,
        writtenOffAmount: true,
        waivedAmount: true,
        interestMethod: true,
        interestRate: true,
        deductionFrequency: true,
        employerSubsidyPercent: true,
        scheduleVersion: true,
        installments: true,
      },
    });
    if (!loan) throw new NotFoundException('Loan request not found');

    // A payroll that has already committed to an amount must not have the
    // ground moved under it.
    const inFlight = await tx.advanceLoanDeduction.findFirst({
      where: { requestId, status: 'PENDING' },
      select: { month: true, year: true },
    });
    if (inFlight) {
      throw new BadRequestException(
        `This loan has an instalment in an unlocked payroll (${inFlight.month}/${inFlight.year}). ` +
          `Lock or delete that payroll before changing the schedule.`,
      );
    }

    const version = loan.scheduleVersion ?? 1;

    // Anything already touched by money is history and is retained as-is.
    const settled = await tx.loanSchedule.findMany({
      where: {
        requestId,
        version,
        status: { in: ['PAID', 'PARTIAL', 'SKIPPED', 'WAIVED', 'WRITTEN_OFF'] },
      },
      select: { installmentNo: true, emiAmount: true, paidAmount: true },
    });
    const highestSettledNo = settled.reduce(
      (a, r) => Math.max(a, r.installmentNo),
      0,
    );

    // How many instalments are actually being REPLACED, counted on the live
    // plan rather than inferred from `installments - highestSettledNo`.
    //
    // That subtraction is what collapsed a `skip EXTEND`: skipping #4 of 6 made
    // it 6 - 4 = 2, so the whole balance was re-amortized over two instalments
    // and the deduction tripled — from the one operation whose purpose is to
    // move an instalment OUT. The rows still open are 1, 2, 3, 5 and 6: five of
    // them, +1 for the extension, which keeps the instalment where it was.
    const unsettledCount = await tx.loanSchedule.count({
      where: { requestId, version, status: { in: ['SCHEDULED', 'DEFERRED'] } },
    });

    // Interest already EARNED on the plan about to be superseded. It is a real
    // debt and must survive the rebuild; the rebuilt rows charge interest only
    // from here forward, so nothing is charged over the same calendar twice.
    const carriedInterest = await this.accruedUnpaidInterest(
      requestId,
      { version },
      tx,
    );

    // NO opening arrears are folded into the new schedule.
    //
    // It is tempting to carry `emiAmount - paidAmount` from every settled row
    // onto instalment #1, but that DOUBLE-CHARGES: the unpaid principal of a
    // PARTIAL or SKIPPED row was never credited to `amountRepaid`, so it is
    // still inside `outstanding` below and the new schedule already amortizes
    // it. Adding it again would demand it twice — and for a WAIVED row it
    // would resurrect a debt the employer deliberately forgave.
    //
    // The one thing genuinely NOT in `outstanding` is unpaid interest, and that
    // is regenerated from scratch by the engine against the remaining balance.

    const outstanding = roundMoney(
      Number(loan.amount) -
        Number(loan.amountRepaid) -
        Number(loan.writtenOffAmount) -
        Number(loan.waivedAmount),
    );

    // Supersede the live SCHEDULED rows. Retained at their old version with
    // status CANCELLED — this is the audit trail, so never delete them.
    await tx.loanSchedule.updateMany({
      where: { requestId, version, status: { in: ['SCHEDULED', 'DEFERRED'] } },
      data: { status: 'CANCELLED', supersededAt: new Date() },
    });

    if (outstanding <= 0) {
      await tx.advanceLoanRequest.update({
        where: { id: requestId },
        data: {
          scheduleVersion: version + 1,
          outstandingPrincipal: 0,
          // No rows left to carry it, so the cache holds the carried figure.
          outstandingInterest: carriedInterest,
          restructuredAt: new Date(),
          restructuredBy: opts.actorId ?? null,
        },
      });
      return null;
    }

    // Live plan first, `installments - highestSettledNo` only as the fallback
    // for a loan that has no schedule rows to count (pre-v2 / legacy bridge).
    const fromLivePlan = unsettledCount + (opts.extendBy ?? 0);
    const remainingCount = Math.max(
      1,
      opts.newInstallments ??
        (fromLivePlan > 0
          ? fromLivePlan
          : (loan.installments ?? 1) - highestSettledNo),
    );
    const frequency = (opts.newFrequency ??
      loan.deductionFrequency) as Frequency;
    const interestEnabled =
      (await this.settings.getSetting('loan_interest_enabled', 'false')) ===
      'true';

    const nextDue =
      opts.firstDueDate ??
      new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0));

    const roundingUnit = await this.roundingUnit();
    const result = this.run(() =>
      regenerateFromBalance({
        principal: outstanding, // overridden by outstandingPrincipal below
        outstandingPrincipal: outstanding,
        startInstallmentNo: highestSettledNo + 1,
        annualRatePercent: interestEnabled
          ? (opts.newInterestRate ?? Number(loan.interestRate))
          : 0,
        method: interestEnabled
          ? ((opts.newInterestMethod ??
              loan.interestMethod) as InterestMethod)
          : 'NONE',
        installments: remainingCount,
        frequency,
        firstDueDate: this.snapToCycle(nextDue, frequency),
        employerSubsidyPercent: Number(loan.employerSubsidyPercent ?? 0),
        roundingUnit,
      }),
    );

    await tx.loanSchedule.createMany({
      data: this.toRows(requestId, version + 1, result, frequency),
    });

    // NOT `result.totalInterest`. Resetting the cache to the NEW plan's lifetime
    // interest is what let a prepayment be charged interest it had just paid:
    // the waterfall took 79.42 out of a 200.00 payment and the rebuild
    // immediately re-billed the same twelve months as another 71.43. What is
    // owed after a rebuild is the interest already earned and not yet settled —
    // carried across from the superseded rows, plus anything the new rows have
    // already fallen due for (normally nothing: they start next cycle).
    const accruedInterest = roundMoney(
      carriedInterest +
        (await this.accruedUnpaidInterest(
          requestId,
          { version: version + 1 },
          tx,
        )),
    );

    await tx.advanceLoanRequest.update({
      where: { id: requestId },
      data: {
        scheduleVersion: version + 1,
        installmentAmount: result.levelEmi,
        outstandingPrincipal: outstanding,
        outstandingInterest: accruedInterest,
        restructuredAt: new Date(),
        restructuredBy: opts.actorId ?? null,
        ...(opts.newInterestRate !== undefined
          ? { interestRate: opts.newInterestRate }
          : {}),
        ...(opts.newInterestMethod
          ? { interestMethod: opts.newInterestMethod }
          : {}),
        ...(opts.newFrequency ? { deductionFrequency: opts.newFrequency } : {}),
      },
    });

    return result;
  }

  /**
   * Live (non-superseded) schedule rows for a loan, oldest instalment first.
   *
   * `user` is required. A repayment schedule is instalment amounts, dates and
   * what somebody still owes — exactly as private as the loan record it belongs
   * to, which `AdvanceLoansService.findOne` and `payoffQuote` both guard. This
   * one did not: it resolved the loan with a bare `findUnique` (which the branch
   * middleware does not intercept) and returned the rows to anyone who had the
   * id. Both callers — the HTTP route and the `loan_schedule` MCP tool — get the
   * guard from here rather than each remembering it.
   */
  async listLive(requestId: string, user?: any) {
    const loan = await this.prisma.advanceLoanRequest.findUnique({
      where: { id: requestId },
      select: {
        scheduleVersion: true,
        employeeId: true,
        employee: { select: { branchId: true, departmentId: true } },
      },
    });
    if (!loan) throw new NotFoundException('Loan request not found');

    // 404 (not 403) outside the caller's branch, so existence never leaks.
    assertInBranch(loan.employee.branchId);
    if (user) await this.access.assertCanViewLoan(loan, user);

    return this.prisma.loanSchedule.findMany({
      where: { requestId, version: loan.scheduleVersion },
      orderBy: { installmentNo: 'asc' },
    });
  }
}
