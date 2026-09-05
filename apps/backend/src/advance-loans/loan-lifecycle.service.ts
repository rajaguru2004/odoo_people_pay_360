import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { getBranchContext } from '../common/branch/branch-context';
import { roundMoney } from '../common/utils/money.util';
import {
  type InterestMethod, splitPayment } from './loan-amortization.util';
import { LoanScheduleService } from './loan-schedule.service';
import { LoanPolicyService } from './loan-policy.service';
import { LoanNotificationService } from './loan-notification.service';
import { LoanAccessService } from './loan-access.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { LOAN_TERMINAL_STATUSES } from './loan.types';

/** List page. Every notification deep-links to `${LINK}/${requestId}`. */
const LINK = '/dashboard/advance-loans';

/**
 * The client guard's exact sentence for a paused loan
 * (`apps/frontend/components/advance-loans/loanGuards.ts`).
 *
 * Repeated verbatim rather than paraphrased: the guard promises the user that a
 * held loan takes no payments and no schedule changes, and until now only a
 * hidden button enforced that promise. The API and the UI must refuse with the
 * same words or the two layers contradict each other.
 */
const HELD_MESSAGE =
  'Recovery is paused on this loan. Resume it before recording payments or changing the schedule.';

/**
 * Post-approval money operations on a loan: prepay, foreclose, close, write off,
 * reinstate, waive, hold/resume, skip an instalment, and convert an advance.
 *
 * Rules every operation here obeys:
 *  - `assertNoRunInFlight` first. If an unlocked payroll already holds a PENDING
 *    instalment for this loan, that run has committed to an amount and the
 *    ground must not move under it (requirement doc: "closure during payroll
 *    run", "prepayment on payroll date").
 *  - Optimistic concurrency via `version`, because the Prisma branch middleware
 *    deliberately skips `updateMany` on relation-scoped models — so a stale
 *    writer must lose at the DB, not silently win.
 *  - APPEND-ONLY money. Every balance change writes a LoanTransaction; nothing
 *    is deleted or rewritten in place.
 *  - `amountRepaid` counts PRINCIPAL only, matching the payroll lock path.
 */
@Injectable()
export class LoanLifecycleService {
  private readonly logger = new Logger(LoanLifecycleService.name);

  constructor(
    private prisma: PrismaService,
    private schedules: LoanScheduleService,
    private access: LoanAccessService,
    private settings: SystemSettingsService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private policy: LoanPolicyService,
    private loanNotifications: LoanNotificationService,
  ) {}

  // ── shared guards ────────────────────────────────────────────────────────

  private async getLoan(id: string) {
    const loan = await this.prisma.advanceLoanRequest.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            fullName: true,
            branchId: true,
            departmentId: true,
          },
        },
      },
    });
    if (!loan) throw new NotFoundException('Advance/loan request not found');
    // findUnique bypasses auto-scoping, so guard the object explicitly. 404, not
    // 403, so a foreign-branch id never leaks existence.
    assertInBranch(loan.employee.branchId);
    return loan;
  }

  private async assertNoRunInFlight(loanId: string) {
    const row = await this.prisma.advanceLoanDeduction.findFirst({
      where: {
        requestId: loanId,
        status: 'PENDING',
        payrollItem: {
          payroll: { status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] } },
        },
      },
      select: { month: true, year: true },
    });
    if (row) {
      throw new ConflictException(
        `Payroll ${row.month}/${row.year} is in progress and already includes an instalment for this loan. ` +
          `Lock or delete that run first.`,
      );
    }
  }

  private assertActive(loan: { status: string }) {
    if (LOAN_TERMINAL_STATUSES.includes(loan.status as any)) {
      throw new BadRequestException(
        `This loan is ${loan.status.toLowerCase()} and can no longer be changed`,
      );
    }
    if (loan.status === 'PENDING' || loan.status === 'DRAFT') {
      throw new BadRequestException(
        'This request has not been approved yet',
      );
    }
  }

  /**
   * Refuse the operations a paused loan must not accept.
   *
   * Applied per operation, NOT as a blanket rule on ON_HOLD: a hold suspends
   * RECOVERY, not the employer's ability to forgive, write off, close or settle
   * the debt, and `resume` obviously has to work on a held loan. The three that
   * are refused are the three the client guard names — prepay, skip and hold —
   * because those are the ones whose promise the user was shown.
   */
  private assertNotHeld(loan: { status: string }) {
    if (loan.status === 'ON_HOLD') {
      throw new BadRequestException(HELD_MESSAGE);
    }
  }

  /** Compare-and-set on `version`; a stale writer loses. */
  private async casVersion(
    tx: any,
    id: string,
    expected: number,
    data: Record<string, unknown>,
  ) {
    const res = await tx.advanceLoanRequest.updateMany({
      where: { id, version: expected },
      data: { ...data, version: { increment: 1 } },
    });
    if (res.count === 0) {
      throw new ConflictException(
        'This loan was modified by another operation. Reload and retry.',
      );
    }
  }

  private async assertRole(user: any, key: string, fallback: string) {
    const raw = await this.settings.getSetting(key, fallback);
    const allowed = raw
      .split(',')
      .map((r) => r.trim().toUpperCase())
      .filter(Boolean);
    if (!allowed.includes(String(user?.role).toUpperCase())) {
      throw new ForbiddenException(
        `Your role is not permitted to perform this operation (allowed: ${allowed.join(', ') || 'none'})`,
      );
    }
  }

  /**
   * The branch's own answer to "who may do this", applied on top of the
   * company-wide one.
   *
   * `LoanPolicy.writeOffRoles` and `.waiverRoles` are columns that existed with
   * no reader at all, so a branch could record its own authority list and every
   * check read the global setting instead.
   *
   * Deliberately STRICTER-WINS and deliberately SECOND: the global check runs
   * before the loan is loaded so an unauthorised caller cannot learn whether a
   * loan exists, and a branch can narrow authority but never widen it past what
   * the company allows.
   */
  private assertBranchRole(
    user: any,
    allowedCsv: string,
    what: string,
  ): void {
    const allowed = allowedCsv
      .split(',')
      .map((r) => r.trim().toUpperCase())
      .filter(Boolean);
    if (allowed.length === 0) return;
    if (!allowed.includes(String(user?.role).toUpperCase())) {
      throw new ForbiddenException(
        `This branch does not permit your role to ${what} (allowed here: ${allowed.join(', ')})`,
      );
    }
  }

  /**
   * The second pair of eyes a restructure needs.
   *
   * `loan_restructure_requires_approval` is seeded `'true'` and was read by
   * NOTHING: every restructure — a prepayment that re-amortises, an extension,
   * a reinstatement — applied immediately, so a single person could reshape an
   * agreed repayment plan with no second signature anywhere.
   *
   * Implemented as an explicit two-person rule rather than a queue: the actor
   * names who authorised it, that person must actually be able to approve loans,
   * and it may not be the actor. A queue would need its own request type,
   * workflow rows and decision routes; this is the same guarantee — no one
   * person reshapes a live plan alone — without inventing a second approval
   * system beside the one the module already has.
   *
   * `authorisedBy` is recorded on the audit row by the caller, so the trail
   * names both people.
   */
  private async assertRestructureAuthorised(
    user: any,
    authorisedBy: string | undefined,
    what: string,
  ): Promise<void> {
    // Read with a default of OFF, and seeded OFF, even though the key used to
    // be seeded `'true'`. It was read by nothing, so no deployment has ever
    // had this rule enforced: switching it on for everybody the day it gained
    // a reader would start refusing operations that worked yesterday, in a
    // module where the refusal lands on somebody's repayment plan. New
    // enforcement ships off here — the same call `loan_module_v2_enabled` and
    // `supervisor_approval_enabled` already make.
    const required =
      (await this.settings.getSetting('loan_restructure_requires_approval', 'false')) ===
      'true';
    if (!required) return;

    if (!authorisedBy) {
      throw new BadRequestException(
        `${what} changes an agreed repayment plan, so it needs a second approver. ` +
          `Send authorisedBy with the user id of whoever approved it, or turn off ` +
          `loan_restructure_requires_approval.`,
      );
    }
    if (authorisedBy === user?.id) {
      throw new BadRequestException(
        'A restructure cannot be authorised by the person performing it.',
      );
    }

    const approver = await this.prisma.user.findUnique({
      where: { id: authorisedBy },
      select: { id: true, role: true, isActive: true },
    });
    if (!approver || !approver.isActive) {
      throw new BadRequestException('The named approver is not an active user.');
    }

    const roles = (
      await this.settings.getSetting('advance_loan_approver_roles', 'HR_MANAGER,ADMIN')
    )
      .split(',')
      .map((r) => r.trim().toUpperCase())
      .filter(Boolean);
    if (!roles.includes(String(approver.role).toUpperCase())) {
      throw new BadRequestException(
        `The named approver cannot approve loans (allowed: ${roles.join(', ')}).`,
      );
    }
  }

  /** The policy in force for the branch a loan's employee belongs to. */
  private async policyForLoan(loan: { employeeId: string }) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: loan.employeeId },
      select: { branchId: true },
    });
    return this.policy.resolve(employee?.branchId ?? null);
  }

  private outstandingOf(loan: {
    amount: any;
    amountRepaid: any;
    writtenOffAmount: any;
    waivedAmount: any;
  }) {
    return roundMoney(
      Number(loan.amount) -
        Number(loan.amountRepaid) -
        Number(loan.writtenOffAmount) -
        Number(loan.waivedAmount),
    );
  }

  /**
   * Interest ACCRUED AND UNPAID on this loan today.
   *
   * The single reader for every money decision in this service. It goes to the
   * live schedule rather than `AdvanceLoanRequest.outstandingInterest`, because
   * that column is only a cache of this figure (see the LoanScheduleService
   * class doc) and the importer still parks a lifetime total in it. Deriving
   * means a stale or wrong cache can never move money.
   */
  private async accruedInterestOf(id: string): Promise<number> {
    return Math.max(0, await this.schedules.accruedUnpaidInterest(id));
  }

  private async trail(
    loan: any,
    action: string,
    oldData: unknown,
    newData: unknown,
    user: any,
  ) {
    await this.audit.log({
      userId: user?.id,
      action,
      // 'AdvanceLoan', matching @AuditResource('AdvanceLoan') on the controller.
      // These two used to disagree ('AdvanceLoanRequest' here), so an auditor
      // pulling one loan's history got half of it with no sign the rest existed.
      // The interceptor's value wins because it is the one a caller can discover
      // from the controller.
      resourceType: 'AdvanceLoan',
      resourceId: loan.id,
      oldData: oldData as any,
      newData: newData as any,
      branchId:
        getBranchContext()?.effectiveBranchId ?? loan.employee.branchId ?? null,
    });
  }

  /**
   * Tell the borrower what just happened to their loan.
   *
   * `requestId` is required, and the link is per-loan. It used to be the module
   * constant for every notice, so someone told their loan had been written off
   * was handed a page listing all of their loans and no way to tell which one
   * the message was about. `notifyUser` already takes a link; it just was not
   * being given one worth having.
   */
  private async notifyEmployee(
    employeeId: string,
    requestId: string,
    title: string,
    msg: string,
  ) {
    try {
      const u = await this.prisma.user.findFirst({
        where: { employeeId },
        select: { id: true },
      });
      if (u) {
        // One call site covers prepay / foreclose / close / write-off /
        // reinstate / waive / hold / resume / skip / convert-to-loan, so a
        // single template key does too.
        //
        // Logged, but deliberately NOT deduped. These are money operations
        // that can legitimately repeat — two prepayments in a month are two
        // events and the borrower must hear about both — so the period key is
        // unique per occurrence. The row exists for the delivery record and
        // the retry, which is what was missing; collapsing repeats would be a
        // different bug from the one being fixed.
        await this.loanNotifications.notifyOnce({
          requestId,
          event: `LOAN_${title.replace(/[^A-Za-z]+/g, '_').toUpperCase()}`,
          periodKey: new Date().toISOString(),
          recipientUserId: u.id,
          title,
          message: msg,
          link: `${LINK}/${requestId}`,
          meta: {
            waTemplate: 'loan_lifecycle',
            waData: { action: title },
          },
        });
      }
    } catch {
      // Notification failure must never roll back money that already moved.
    }
  }

  // ── quotes ───────────────────────────────────────────────────────────────

  /**
   * What it would cost to settle this loan today.
   *
   * Principal outstanding + interest ACCRUED AND UNPAID, read from the live
   * schedule. Not principal + all future interest, which is what it used to be:
   * that quoted a day-one payoff of 1279.42 on a 1200.00 loan whose borrower
   * owed 1200.00, and `prepay` then used that inflated figure as the ceiling it
   * would let someone overpay to.
   *
   * EARLY-SETTLEMENT POLICY. `loan_flat_prepayment_interest` (FULL | PRORATA |
   * NONE, seeded PRORATA) is still read by nothing, here included, and that is
   * deliberate. Accruing per elapsed instalment IS pro-rata at the granularity
   * the plan has — a FLAT loan splits its interest evenly per period, so the
   * accrued figure is the earned share and the unearned remainder is dropped,
   * which is what both PRORATA and NONE ask for. Only FULL would differ, by
   * charging unearned interest on early settlement; that is an early-settlement
   * premium with no DTO, no UI and no ledger type behind it, and the gap report
   * (§6) already carries it as a missing feature rather than a defect.
   */
  async payoffQuote(id: string, user?: any) {
    const loan = await this.getLoan(id);
    if (user) await this.access.assertCanViewLoan(loan, user);
    const principal = this.outstandingOf(loan);
    let interest = await this.accruedInterestOf(id);
    let unearnedInterest = 0;

    // FULL: charge the interest the plan would have earned, not the interest it
    // HAS earned. An early-settlement premium, which some flat-rate schemes
    // contract for — the borrower pays the whole agreed interest whenever they
    // settle, so there is no advantage to paying early.
    //
    // Only meaningful on a FLAT loan: reducing-balance interest is by
    // definition unearned until the balance has been carried, and the other two
    // values (PRORATA, NONE) are already satisfied by accruing per elapsed
    // instalment — a FLAT plan splits its interest evenly per period, so the
    // accrued figure IS the earned share.
    if (loan.interestMethod === 'FLAT') {
      const rule = await this.settings.getSetting(
        'loan_flat_prepayment_interest',
        'PRORATA',
      );
      if (rule.toUpperCase() === 'FULL') {
        const remaining = await this.prisma.loanSchedule.aggregate({
          where: {
            requestId: id,
            version: loan.scheduleVersion ?? 1,
            status: { in: ['SCHEDULED', 'PARTIAL', 'DEFERRED'] },
          },
          _sum: { interestComponent: true, paidInterest: true },
        });
        const scheduled = Number(remaining._sum.interestComponent ?? 0);
        const alreadyPaid = Number(remaining._sum.paidInterest ?? 0);
        const outstandingScheduled = roundMoney(
          Math.max(0, scheduled - alreadyPaid),
        );
        unearnedInterest = roundMoney(Math.max(0, outstandingScheduled - interest));
        interest = roundMoney(interest + unearnedInterest);
      }
    }

    return {
      success: true,
      data: {
        loanId: loan.id,
        status: loan.status,
        outstandingPrincipal: principal,
        outstandingInterest: interest,
        // Stated separately so a borrower can see they are being charged
        // interest the loan has not earned, rather than finding an unexplained
        // figure in a payoff quote.
        unearnedInterest,
        payoffAmount: roundMoney(principal + interest),
        asOf: new Date(),
      },
    };
  }

  // ── prepayment / foreclosure ─────────────────────────────────────────────

  /**
   * Take a cash/bank payment outside payroll.
   *
   * Waterfall is interest then principal, so a part payment cannot silently
   * under-report interest. A payment that clears the whole balance closes the
   * loan as an early closure rather than leaving a 0.00 open loan behind.
   *
   * The interest in that waterfall is what has ACCRUED and is unpaid — never
   * the loan's remaining lifetime interest. Against the lifetime figure, 200.00
   * paid on day one of a 1200.00 @ 12% loan bought 120.58 of principal and the
   * borrower's total outlay ROSE from 1279.42 to 1350.85. Nothing has accrued
   * before the first instalment falls due, so that payment is now 200.00 of
   * principal, and whatever interest IS taken is credited to the instalments it
   * came from so the rebuild cannot bill it again.
   */
  async prepay(
    id: string,
    user: any,
    dto: {
      amount: number;
      paidOn?: string;
      mode?: string;
      reference?: string;
      recalc?: 'REDUCE_EMI' | 'REDUCE_TENURE';
      idempotencyKey?: string;
    },
  ) {
    const loan = await this.getLoan(id);
    this.assertActive(loan);
    this.assertNotHeld(loan);
    await this.assertNoRunInFlight(id);

    const amount = roundMoney(Number(dto.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Prepayment amount must be greater than 0');
    }

    const principalDue = this.outstandingOf(loan);
    const interestDue = await this.accruedInterestOf(id);
    const payoff = roundMoney(principalDue + interestDue);
    if (amount > payoff) {
      throw new BadRequestException(
        `Prepayment of ${amount} exceeds the payoff amount of ${payoff}. ` +
          `Pay exactly ${payoff} to close the loan.`,
      );
    }

    // The branch's allocation order. A prepayment is the one payment a
    // borrower makes deliberately to pay less, so applying it interest-first
    // where the policy says principal-first is the difference the borrower was
    // trying to buy.
    // Who may record a payment against this loan.
    //
    // `loan_employee_self_prepay` was seeded and read by nothing, so a borrower
    // who paid at the counter had no way to record it and had to ask HR to do
    // it for them. Two narrowings, both necessary: the switch must be on, and
    // an employee may only ever act on their OWN loan.
    if (!['ADMIN', 'HR_MANAGER'].includes(String(user?.role))) {
      const allowed =
        (await this.settings.getSetting('loan_employee_self_prepay', 'false')) ===
        'true';
      if (!allowed) {
        throw new ForbiddenException(
          'Recording your own payment is switched off here. Ask HR to record it.',
        );
      }
      if (loan.employeeId !== user?.employeeId) {
        throw new ForbiddenException('You can only pay towards your own loan.');
      }
    }

    const prepayPolicy = await this.policyForLoan(loan);
    const split = splitPayment(
      amount,
      {
        fee: 0,
        interest: interestDue,
        principal: principalDue,
      },
      undefined,
      prepayPolicy.paymentAllocationOrder,
    );
    const clears = amount >= payoff - 0.005;
    const valueDate = dto.paidOn ? new Date(dto.paidOn) : new Date();

    // Replay guard. The unique index on loan_transactions.idempotency_key is
    // the real protection; checking first turns a retried request into a clear
    // 409 instead of a 500 from a constraint violation.
    if (dto.idempotencyKey) {
      const seen = await this.prisma.loanTransaction.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
        select: { id: true, requestId: true },
      });
      if (seen) {
        throw new ConflictException(
          'This payment has already been recorded (duplicate idempotency key).',
        );
      }
    }

    try {
    await this.prisma.$transaction(async (tx) => {
      await this.casVersion(tx, id, loan.version, {
        amountRepaid: { increment: split.principal },
        interestPaid: { increment: split.interest },
        outstandingPrincipal: roundMoney(principalDue - split.principal),
        outstandingInterest: roundMoney(interestDue - split.interest),
        ...(clears
          ? {
              status: 'CLOSED',
              closureType: 'EARLY_CLOSURE',
              closedAt: new Date(),
              closureRemarks: 'Closed by full prepayment',
            }
          : {}),
      });

      // Stamp the interest onto the instalments it was owed on, oldest first.
      // Without this the next quote would derive the SAME accrued interest all
      // over again and charge for it a second time.
      if (split.interest > 0) {
        await this.schedules.creditAccruedInterest(id, split.interest, {}, tx);
      }

      await tx.loanTransaction.create({
        data: {
          requestId: id,
          type: 'PREPAYMENT',
          transactionDate: valueDate,
          amount,
          principalComponent: split.principal,
          interestComponent: split.interest,
          balanceAfter: roundMoney(principalDue - split.principal),
          reference: dto.reference ?? null,
          sourceType: dto.mode ?? 'CASH',
          idempotencyKey: dto.idempotencyKey ?? null,
          createdById: user?.id ?? null,
          narration: clears ? 'Full prepayment (loan closed)' : 'Partial prepayment',
        },
      });

      if (clears) {
        await tx.loanSchedule.updateMany({
          where: {
            requestId: id,
            status: { in: ['SCHEDULED', 'PARTIAL', 'DEFERRED'] },
          },
          data: { status: 'CLOSED_EARLY', supersededAt: new Date() },
        });
      }
    });
    } catch (err: any) {
      // Two retries racing past the pre-check both reach the unique index; the
      // loser must read as "already recorded", not as a server error.
      if (err?.code === 'P2002') {
        throw new ConflictException(
          'This payment has already been recorded (duplicate idempotency key).',
        );
      }
      throw err;
    }

    // Regenerating outside the transaction keeps the money write short; a
    // failure here leaves the balance correct and only the plan stale, which
    // the next regeneration fixes.
    if (!clears) {
      const mode =
        dto.recalc ??
        ((await this.settings.getSetting(
          'loan_prepayment_mode',
          'REDUCE_TENURE',
        )) as 'REDUCE_EMI' | 'REDUCE_TENURE');
      try {
        await this.schedules.regenerate(id, {
          // REDUCE_EMI keeps the remaining count and re-amortizes lower;
          // REDUCE_TENURE keeps the EMI and drops instalments off the tail.
          newInstallments:
            mode === 'REDUCE_EMI'
              ? undefined
              : Math.max(
                  1,
                  Math.ceil(
                    roundMoney(principalDue - split.principal) /
                      Math.max(1, Number(loan.installmentAmount ?? 1)),
                  ),
                ),
          actorId: user?.id ?? null,
        });
      } catch (err) {
        this.logger.error(
          `Prepayment applied but schedule regeneration failed for ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    await this.trail(
      loan,
      'LOAN_PREPAYMENT',
      { amountRepaid: Number(loan.amountRepaid), status: loan.status },
      { amount, split, closed: clears },
      user,
    );
    await this.notifyEmployee(
      loan.employeeId,
      id,
      clears ? 'Loan closed' : 'Prepayment received',
      clears
        ? `Your loan has been fully repaid and is now closed.`
        : `A prepayment of ${amount} was applied to your loan.`,
    );

    return this.payoffQuote(id);
  }

  /** Close the loan today, optionally waiving whatever interest remains. */
  async foreclose(
    id: string,
    user: any,
    dto: { waiveFutureInterest?: boolean; reason?: string },
  ) {
    const loan = await this.getLoan(id);
    this.assertActive(loan);
    await this.assertNoRunInFlight(id);

    const principal = this.outstandingOf(loan);
    if (principal > 0.005) {
      throw new BadRequestException(
        `This loan still has ${principal} of principal outstanding. ` +
          `Record a prepayment of the payoff amount first, or use write-off/waive.`,
      );
    }
    // Accrued and unpaid — the only interest a borrower actually owes today.
    // Interest on instalments that have not fallen due needs no waiver: the
    // CLOSED_EARLY sweep below retires those rows and it is never charged.
    const interest = await this.accruedInterestOf(id);

    await this.prisma.$transaction(async (tx) => {
      await this.casVersion(tx, id, loan.version, {
        status: 'CLOSED',
        closureType: 'FORECLOSED',
        closedAt: new Date(),
        closureRemarks: dto.reason ?? 'Foreclosed',
        ...(dto.waiveFutureInterest && interest > 0
          ? {
              waivedAmount: { increment: interest },
              outstandingInterest: 0,
            }
          : {}),
      });
      if (dto.waiveFutureInterest && interest > 0) {
        await tx.loanTransaction.create({
          data: {
            requestId: id,
            type: 'WAIVER',
            transactionDate: new Date(),
            amount: interest,
            interestComponent: interest,
            createdById: user?.id ?? null,
            narration: 'Future interest waived on foreclosure',
          },
        });
      }
      await tx.loanSchedule.updateMany({
        where: {
          requestId: id,
          status: { in: ['SCHEDULED', 'PARTIAL', 'DEFERRED'] },
        },
        data: { status: 'CLOSED_EARLY', supersededAt: new Date() },
      });
    });

    await this.trail(loan, 'LOAN_FORECLOSED', { status: loan.status }, dto, user);
    await this.notifyEmployee(
      loan.employeeId,
      id,
      'Loan closed',
      'Your loan has been closed.',
    );
    return this.payoffQuote(id);
  }

  /**
   * Manual closure. A residual within `loan_rounding_tolerance` is written off
   * as a rounding adjustment — this is the doc's "EMI rounding leaves a 0.01-1.00
   * balance after the final instalment" case, closed explicitly instead of
   * leaving a phantom open loan.
   */
  async close(id: string, user: any, dto: { reason: string }) {
    const loan = await this.getLoan(id);
    this.assertActive(loan);
    await this.assertNoRunInFlight(id);

    const residual = this.outstandingOf(loan);
    const tolerance =
      Number(await this.settings.getSetting('loan_rounding_tolerance', '1.00')) ||
      1;

    if (residual > tolerance) {
      throw new BadRequestException(
        `Outstanding balance is ${residual}, above the rounding tolerance of ${tolerance}. ` +
          `Use prepay, waive or write-off instead of a manual close.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.casVersion(tx, id, loan.version, {
        status: 'CLOSED',
        closureType: 'MANUAL',
        closedAt: new Date(),
        closureRemarks: dto.reason,
        ...(residual > 0
          ? { waivedAmount: { increment: residual }, outstandingPrincipal: 0 }
          : {}),
      });
      if (residual > 0) {
        await tx.loanTransaction.create({
          data: {
            requestId: id,
            type: 'ADJUSTMENT',
            transactionDate: new Date(),
            amount: residual,
            principalComponent: residual,
            createdById: user?.id ?? null,
            narration: `Rounding adjustment on manual closure: ${dto.reason}`,
          },
        });
      }
      await tx.loanSchedule.updateMany({
        where: {
          requestId: id,
          status: { in: ['SCHEDULED', 'PARTIAL', 'DEFERRED'] },
        },
        data: { status: 'CLOSED_EARLY', supersededAt: new Date() },
      });
    });

    await this.trail(loan, 'LOAN_CLOSED', { status: loan.status }, dto, user);
    await this.notifyEmployee(
      loan.employeeId,
      id,
      'Loan closed',
      residual > 0
        ? `Your loan has been closed. The remaining ${residual} was written off as a rounding adjustment, and nothing further is owed.`
        : 'Your loan has been closed and nothing further is owed.',
    );
    return this.payoffQuote(id);
  }

  // ── write-off / reinstate / waive ────────────────────────────────────────

  /** Forgive company money. Restricted, always audited, always reversible. */
  async writeOff(
    id: string,
    user: any,
    dto: { amount?: number; reason: string },
  ) {
    await this.assertRole(user, 'advance_loan_writeoff_roles', 'ADMIN');
    const loan = await this.getLoan(id);
    this.assertBranchRole(
      user,
      (await this.policyForLoan(loan)).writeOffRoles,
      'write off a balance',
    );
    this.assertActive(loan);
    await this.assertNoRunInFlight(id);

    const outstanding = this.outstandingOf(loan);
    const amount = roundMoney(dto.amount ?? outstanding);
    if (amount <= 0) throw new BadRequestException('Write-off amount must be greater than 0');
    if (amount > outstanding) {
      throw new BadRequestException(
        `Write-off of ${amount} exceeds the outstanding balance of ${outstanding}`,
      );
    }
    const full = amount >= outstanding - 0.005;

    await this.prisma.$transaction(async (tx) => {
      await this.casVersion(tx, id, loan.version, {
        writtenOffAmount: { increment: amount },
        outstandingPrincipal: roundMoney(outstanding - amount),
        ...(full
          ? {
              status: 'WRITTEN_OFF',
              closureType: 'WRITE_OFF',
              closedAt: new Date(),
              closureRemarks: dto.reason,
            }
          : {}),
      });
      await tx.loanTransaction.create({
        data: {
          requestId: id,
          type: 'WRITE_OFF',
          transactionDate: new Date(),
          amount,
          principalComponent: amount,
          createdById: user?.id ?? null,
          narration: dto.reason,
        },
      });
      if (full) {
        await tx.loanSchedule.updateMany({
          where: {
            requestId: id,
            status: { in: ['SCHEDULED', 'PARTIAL', 'DEFERRED'] },
          },
          data: { status: 'WRITTEN_OFF', supersededAt: new Date() },
        });
      }
    });

    await this.trail(
      loan,
      'LOAN_WRITTEN_OFF',
      { writtenOffAmount: Number(loan.writtenOffAmount), status: loan.status },
      { amount, full, reason: dto.reason },
      user,
    );
    await this.notifyEmployee(
      loan.employeeId,
      id,
      'Loan written off',
      `${amount} of your loan has been written off.`,
    );
    return this.payoffQuote(id);
  }

  /**
   * Reprice a running loan.
   *
   * `LoanRateChange` was a complete model with zero code references, and
   * `regenerate()` accepted `newInterestRate`/`newInterestMethod` from the
   * start with nothing ever passing them — so a floating rate, a mid-loan
   * repricing and a correction to a mistyped rate were all impossible.
   *
   * Two guarantees:
   *
   *  - **Settled instalments are never re-priced.** `regenerate()` retains
   *    anything money has already touched and re-plans only what is still
   *    owed, so a rate change cannot reach backwards into paid months.
   *  - **The change is recorded, both versions.** The row carries the old and
   *    new rate AND the schedule version either side, so the plan a borrower
   *    was on before the change can still be reconstructed.
   */
  async rateChange(
    id: string,
    user: any,
    dto: {
      newRate: number;
      newMethod?: string;
      mode?: 'KEEP_TENURE' | 'KEEP_EMI';
      effectiveFrom?: string;
      reason?: string;
      authorisedBy?: string;
    },
  ) {
    await this.assertRole(user, 'advance_loan_approver_roles', 'HR_MANAGER,ADMIN');
    const loan = await this.getLoan(id);
    await this.assertRestructureAuthorised(
      user,
      dto.authorisedBy,
      'Repricing a live loan',
    );
    this.assertActive(loan);
    this.assertNotHeld(loan);
    await this.assertNoRunInFlight(id);

    const interestEnabled =
      (await this.settings.getSetting('loan_interest_enabled', 'false')) === 'true';
    if (!interestEnabled) {
      throw new BadRequestException(
        'Interest is switched off in this system, so a rate cannot be changed. Turn on loan_interest_enabled first.',
      );
    }

    const newMethod = (dto.newMethod ?? loan.interestMethod) as InterestMethod;
    const oldMethod = loan.interestMethod as InterestMethod;
    const oldRate = Number(loan.interestRate);

    if (newMethod === 'NONE' && dto.newRate > 0) {
      throw new BadRequestException(
        'An interest rate was given but the new method is NONE — either choose FLAT or REDUCING_BALANCE, or set the rate to 0.',
      );
    }
    if (newMethod !== 'NONE' && dto.newRate <= 0) {
      throw new BadRequestException(
        `Interest method ${newMethod} needs a rate above 0. Use NONE to make the loan interest-free.`,
      );
    }
    if (newMethod === oldMethod && dto.newRate === oldRate) {
      throw new BadRequestException(
        `This loan is already on ${oldRate}% ${oldMethod}. Nothing to change.`,
      );
    }

    const versionBefore = loan.scheduleVersion ?? 1;

    // KEEP_EMI lets the tenure absorb the change; KEEP_TENURE holds the end
    // date and lets the instalment move. `regenerate()` re-plans the unsettled
    // balance over the instalments that remain, which IS keep-tenure — so only
    // KEEP_EMI needs to say anything, and it says it by asking for the number
    // of instalments that keeps the old instalment size.
    const mode = dto.mode ?? 'KEEP_TENURE';
    const opts: Parameters<LoanScheduleService['regenerate']>[1] = {
      newInterestRate: dto.newRate,
      newInterestMethod: newMethod,
      reason: dto.reason,
      actorId: user?.id ?? null,
    };
    if (mode === 'KEEP_EMI') {
      const emi = Number(loan.installmentAmount ?? 0);
      const outstanding = this.outstandingOf(loan);
      if (emi > 0 && outstanding > 0) {
        opts.newInstallments = Math.max(1, Math.ceil(outstanding / emi));
      }
    }

    await this.prisma.advanceLoanRequest.update({
      where: { id },
      data: {
        interestMethod: newMethod as any,
        interestRate: dto.newRate,
        restructuredAt: new Date(),
        restructuredBy: user?.id ?? null,
      },
    });

    let regenerated = true;
    try {
      await this.schedules.regenerate(id, opts);
    } catch (err) {
      regenerated = false;
      this.logger.error(
        `Rate change recorded on loan ${id} but the schedule could not be re-planned: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const after = await this.prisma.advanceLoanRequest.findUnique({
      where: { id },
      select: { scheduleVersion: true },
    });

    // Written even when the re-plan failed: the agreement changed, and a rate
    // change with no record is exactly the hole this closes.
    await this.prisma.loanRateChange.create({
      data: {
        requestId: id,
        effectiveFrom: dto.effectiveFrom
          ? new Date(`${dto.effectiveFrom}T00:00:00.000Z`)
          : new Date(),
        oldRate,
        newRate: dto.newRate,
        oldMethod,
        newMethod,
        mode,
        reason: dto.reason ?? null,
        scheduleVersionBefore: versionBefore,
        scheduleVersionAfter: after?.scheduleVersion ?? versionBefore,
        appliedById: user?.id ?? null,
      },
    });

    await this.trail(loan, 'LOAN_RATE_CHANGED', { oldRate, oldMethod }, dto, user);

    await this.notifyEmployee(
      loan.employeeId,
      id,
      'Loan interest changed',
      `The interest on your loan changed from ${oldRate}% to ${dto.newRate}% ` +
        `(${mode === 'KEEP_EMI' ? 'your instalment stays the same and the term moves' : 'the term stays the same and your instalment moves'}).`,
    );

    if (!regenerated) {
      throw new BadRequestException(
        'The new rate was recorded, but the schedule could not be re-planned. Check the loan before the next payroll run.',
      );
    }

    return this.payoffQuote(id);
  }

  /**
   * Replace a running loan with a larger one.
   *
   * Every piece of this existed and none of it was wired: the transaction type
   * `TOPUP_SETTLEMENT`, the closure type `TOPPED_UP`, `approvalSource = 'TOPUP'`
   * and both `loan_topup_*` settings. So a borrower who needed more money ran
   * two loans side by side — two instalments out of one salary — or cleared the
   * first from savings they did not have.
   *
   * The rule that makes it one movement rather than two: the NEW loan's
   * principal covers the old balance, and only the difference is money the
   * employee actually receives. A top-up for less than the outstanding balance
   * is therefore refused — that is a part-payment, and `prepay` is the honest
   * way to make one.
   *
   * Both loans are written in ONE transaction. Half of this — an old loan
   * closed with no replacement, or a new loan beside an unsettled old one — is
   * worse than neither.
   */
  async topup(
    id: string,
    user: any,
    dto: {
      amount: number;
      installments: number;
      reason?: string;
      authorisedBy?: string;
    },
  ) {
    await this.assertRole(user, 'advance_loan_approver_roles', 'HR_MANAGER,ADMIN');
    const loan = await this.getLoan(id);
    await this.assertRestructureAuthorised(
      user,
      dto.authorisedBy,
      'Topping up a loan',
    );
    this.assertActive(loan);
    this.assertNotHeld(loan);
    await this.assertNoRunInFlight(id);

    const enabled =
      (await this.settings.getSetting('loan_topup_enabled', 'false')) === 'true';
    if (!enabled) {
      throw new BadRequestException(
        'Loan top-up is switched off in this system. Turn on loan_topup_enabled to use it.',
      );
    }

    const principalOutstanding = this.outstandingOf(loan);
    const interestOutstanding = await this.accruedInterestOf(id);
    const settleAmount = roundMoney(principalOutstanding + interestOutstanding);

    if (dto.amount <= settleAmount) {
      throw new BadRequestException(
        `A top-up has to be larger than the ${settleAmount} still owed — otherwise it is a part-payment, which is what prepay is for.`,
      );
    }

    const cashToEmployee = roundMoney(dto.amount - settleAmount);

    const created = await this.prisma.$transaction(async (tx) => {
      // 1. Settle the old loan out of the new principal.
      await tx.loanTransaction.create({
        data: {
          requestId: id,
          type: 'TOPUP_SETTLEMENT',
          transactionDate: new Date(),
          amount: settleAmount,
          principalComponent: principalOutstanding,
          interestComponent: interestOutstanding,
          narration: `Settled by a top-up of ${dto.amount}`,
          createdById: user?.id ?? null,
        },
      });

      await tx.advanceLoanRequest.update({
        where: { id },
        data: {
          status: 'CLOSED',
          closureType: 'TOPPED_UP',
          closedAt: new Date(),
          closureRemarks: dto.reason ?? 'Replaced by a top-up',
          amountRepaid: roundMoney(
            Number(loan.amountRepaid) + principalOutstanding,
          ),
          interestPaid: roundMoney(Number(loan.interestPaid) + interestOutstanding),
          outstandingPrincipal: 0,
          outstandingInterest: 0,
        },
      });

      // Anything still scheduled on the old plan is cancelled: it belongs to
      // an agreement that no longer exists.
      await tx.loanSchedule.updateMany({
        where: {
          requestId: id,
          version: loan.scheduleVersion ?? 1,
          status: { in: ['SCHEDULED', 'PARTIAL', 'DEFERRED'] },
        },
        data: { status: 'CANCELLED', supersededAt: new Date() },
      });

      // 2. The replacement, carrying the old loan's terms forward. A top-up is
      // a bigger version of the same agreement, not a renegotiation of it —
      // repricing is what `rate-change` is for.
      return tx.advanceLoanRequest.create({
        data: {
          employeeId: loan.employeeId,
          type: loan.type,
          amount: dto.amount,
          installments: dto.installments,
          status: 'APPROVED',
          approverId: user?.id ?? null,
          approvedAt: new Date(),
          approvalSource: 'TOPUP',
          topupOfId: id,
          loanTypeId: loan.loanTypeId,
          interestMethod: loan.interestMethod,
          interestRate: loan.interestRate,
          deductionFrequency: loan.deductionFrequency,
          priority: loan.priority,
          effectiveDate: new Date(),
          reason: dto.reason ?? `Top-up of ${loan.referenceNo ?? id}`,
          employeeCodeSnapshot: loan.employeeCodeSnapshot,
          employeeNameSnapshot: loan.employeeNameSnapshot,
          // What actually left the company this time.
          disbursedAmount: cashToEmployee,
        },
      });
    });

    // Best-effort, exactly like approval's own generation: a schedule failure
    // must not strand a loan that has already replaced another.
    try {
      await this.schedules.generate(created.id);
    } catch (err) {
      this.logger.error(
        `Top-up ${created.id} created but its schedule could not be generated: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.trail(
      loan,
      'LOAN_TOPPED_UP',
      { settleAmount, cashToEmployee, newLoanId: created.id },
      dto,
      user,
    );

    await this.notifyEmployee(
      loan.employeeId,
      created.id,
      'Loan topped up',
      `Your loan was replaced by a larger one of ${dto.amount}. ` +
        `${settleAmount} settled the previous balance and ${cashToEmployee} is being paid to you.`,
    );

    return {
      success: true,
      data: {
        settledLoanId: id,
        newLoanId: created.id,
        settledAmount: settleAmount,
        cashToEmployee,
      },
    };
  }

  /** Every recorded repricing of one loan, newest first. */
  async rateHistory(id: string) {
    await this.getLoan(id);
    return this.prisma.loanRateChange.findMany({
      where: { requestId: id },
      orderBy: { appliedAt: 'desc' },
    });
  }

  /** Undo a write-off — the doc's "written off and later reinstated" case. */
  async reinstate(id: string, user: any, dto: { reason: string }) {
    await this.assertRole(user, 'advance_loan_writeoff_roles', 'ADMIN');
    const loan = await this.getLoan(id);
    this.assertBranchRole(
      user,
      (await this.policyForLoan(loan)).writeOffRoles,
      'reinstate a written-off loan',
    );

    const written = Number(loan.writtenOffAmount);
    if (written <= 0) {
      throw new BadRequestException('This loan has nothing written off to reinstate');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.casVersion(tx, id, loan.version, {
        writtenOffAmount: 0,
        status: 'ACTIVE',
        closureType: null,
        closedAt: null,
        closureRemarks: null,
        outstandingPrincipal: roundMoney(this.outstandingOf(loan) + written),
      });
      await tx.loanTransaction.create({
        data: {
          requestId: id,
          type: 'REVERSAL',
          transactionDate: new Date(),
          amount: written,
          principalComponent: written,
          createdById: user?.id ?? null,
          narration: `Write-off reinstated: ${dto.reason}`,
        },
      });
    });

    try {
      // The write-off marked every remaining instalment WRITTEN_OFF, and
      // regenerate() treats that as SETTLED (money is not owed on a forgiven
      // row). Left alone, a reinstated loan therefore had "0 instalments
      // remaining" and collapsed into a single lump sum due next cycle — the
      // employee would suddenly owe the whole balance in one payslip.
      //
      // Those rows were never PAID, so clear them to CANCELLED (retained as the
      // audit trail, exactly like any superseded row) and rebuild over the same
      // number of instalments the write-off had cut short.
      const forgiven = await this.prisma.loanSchedule.findMany({
        where: { requestId: id, status: 'WRITTEN_OFF' },
        select: { id: true },
      });
      if (forgiven.length > 0) {
        await this.prisma.loanSchedule.updateMany({
          where: { id: { in: forgiven.map((r) => r.id) } },
          data: { status: 'CANCELLED', supersededAt: new Date() },
        });
      }
      await this.schedules.regenerate(id, {
        newInstallments: forgiven.length > 0 ? forgiven.length : undefined,
        actorId: user?.id ?? null,
      });
    } catch (err) {
      this.logger.error(
        `Reinstated ${id} but schedule regeneration failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.trail(loan, 'LOAN_REINSTATED', { writtenOffAmount: written }, dto, user);
    // The one notification in this service that is not a courtesy: a reinstate
    // puts a forgiven balance back on the books and the employee owes money
    // again. Doing that silently is how somebody discovers it in a payslip.
    await this.notifyEmployee(
      loan.employeeId,
      id,
      'Loan reinstated',
      `A write-off of ${written} on your loan has been reversed: ${dto.reason}. ` +
        `That amount is owed again and payroll recovery has resumed.`,
    );
    return this.payoffQuote(id);
  }

  /** Employer forgives part of the debt (interest, principal, or both). */
  async waive(
    id: string,
    user: any,
    dto: {
      amount?: number;
      waiveType?: 'INTEREST' | 'PRINCIPAL' | 'BOTH';
      reason: string;
    },
  ) {
    await this.assertRole(user, 'loan_waiver_roles', 'ADMIN,HR_MANAGER');
    const loan = await this.getLoan(id);
    this.assertBranchRole(
      user,
      (await this.policyForLoan(loan)).waiverRoles,
      'waive a balance',
    );
    this.assertActive(loan);
    await this.assertNoRunInFlight(id);

    const type = dto.waiveType ?? 'BOTH';
    const principalOut = this.outstandingOf(loan);
    // Only interest that has been EARNED can be forgiven — you cannot waive a
    // charge nobody has made yet. Interest on instalments still ahead simply
    // stops being charged when the plan is retired or rebuilt.
    const interestOut = await this.accruedInterestOf(id);

    const cap =
      type === 'INTEREST'
        ? interestOut
        : type === 'PRINCIPAL'
          ? principalOut
          : roundMoney(principalOut + interestOut);
    const amount = roundMoney(dto.amount ?? cap);
    if (amount <= 0) throw new BadRequestException('Waiver amount must be greater than 0');
    if (amount > cap) {
      throw new BadRequestException(
        `Waiver of ${amount} exceeds the ${type.toLowerCase()} balance of ${cap}`,
      );
    }

    const interestPart =
      type === 'PRINCIPAL' ? 0 : Math.min(amount, interestOut);
    const principalPart = roundMoney(amount - interestPart);
    const clears =
      roundMoney(principalOut - principalPart) <= 0.005 &&
      roundMoney(interestOut - interestPart) <= 0.005;

    await this.prisma.$transaction(async (tx) => {
      await this.casVersion(tx, id, loan.version, {
        waivedAmount: { increment: amount },
        outstandingPrincipal: roundMoney(principalOut - principalPart),
        outstandingInterest: roundMoney(interestOut - interestPart),
        ...(clears
          ? {
              status: 'CLOSED',
              closureType: 'WAIVER',
              closedAt: new Date(),
              closureRemarks: dto.reason,
            }
          : {}),
      });
      // Forgiven interest must stop being asked for, exactly as paid interest
      // does — otherwise the next quote derives it from the plan all over again
      // and the waiver is undone by the following read. The WAIVER ledger row
      // below is what records that it was forgiven rather than collected.
      if (interestPart > 0) {
        await this.schedules.creditAccruedInterest(
          id,
          interestPart,
          { note: `Interest waived: ${dto.reason}` },
          tx,
        );
      }
      await tx.loanTransaction.create({
        data: {
          requestId: id,
          type: 'WAIVER',
          transactionDate: new Date(),
          amount,
          principalComponent: principalPart,
          interestComponent: interestPart,
          createdById: user?.id ?? null,
          narration: dto.reason,
        },
      });
      if (clears) {
        await tx.loanSchedule.updateMany({
          where: {
            requestId: id,
            status: { in: ['SCHEDULED', 'PARTIAL', 'DEFERRED'] },
          },
          data: { status: 'WAIVED', supersededAt: new Date() },
        });
      }
    });

    await this.trail(loan, 'LOAN_WAIVED', { waivedAmount: Number(loan.waivedAmount) }, { amount, type }, user);
    await this.notifyEmployee(
      loan.employeeId,
      id,
      'Loan amount waived',
      `${amount} of your loan has been waived.`,
    );
    return this.payoffQuote(id);
  }

  // ── hold / resume / skip ─────────────────────────────────────────────────

  /** Suspend recovery. The planner skips a held loan entirely. */
  async hold(
    id: string,
    user: any,
    dto: { until?: string; reason: string },
  ) {
    const loan = await this.getLoan(id);
    this.assertActive(loan);
    // Re-holding an already-held loan is refused, matching the client guard.
    // Changing the hold window is `resume` then `hold`, so the release is on
    // the audit trail instead of one hold silently overwriting another.
    this.assertNotHeld(loan);
    await this.assertNoRunInFlight(id);

    // A far-future sentinel means "until explicitly resumed".
    const until = dto.until
      ? new Date(dto.until)
      : new Date(Date.UTC(9999, 11, 31));

    await this.prisma.$transaction(async (tx) => {
      await this.casVersion(tx, id, loan.version, {
        status: 'ON_HOLD',
        holdFrom: new Date(),
        holdUntil: until,
        holdReason: dto.reason,
      });
    });

    await this.trail(loan, 'LOAN_HOLD_APPLIED', { status: loan.status }, dto, user);
    await this.notifyEmployee(
      loan.employeeId,
      id,
      'Loan recovery paused',
      `Recovery of your loan has been paused: ${dto.reason}`,
    );
    return this.payoffQuote(id);
  }

  async resume(id: string, user: any, dto: { reason?: string } = {}) {
    const loan = await this.getLoan(id);
    if (loan.status !== 'ON_HOLD') {
      throw new BadRequestException('This loan is not on hold');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.casVersion(tx, id, loan.version, {
        status: 'ACTIVE',
        holdFrom: null,
        holdUntil: null,
        holdReason: null,
      });
    });

    await this.trail(loan, 'LOAN_HOLD_RELEASED', { status: 'ON_HOLD' }, dto, user);
    await this.notifyEmployee(
      loan.employeeId,
      id,
      'Loan recovery resumed',
      'Recovery of your loan has resumed.',
    );
    return this.payoffQuote(id);
  }

  /**
   * Skip one planned instalment.
   *
   * EXTEND leaves the debt owed and pushes the tail out; FORGIVE waives the
   * instalment outright. Only a future, untouched instalment can be skipped.
   */
  async skipInstallment(
    id: string,
    user: any,
    dto: {
      installmentNo: number;
      mode?: 'EXTEND' | 'FORGIVE';
      reason: string;
      authorisedBy?: string;
    },
  ) {
    const loan = await this.getLoan(id);
    // EXTEND re-plans the agreement; FORGIVE writes money off and is already
    // gated by its own role check further down.
    if ((dto.mode ?? 'EXTEND') === 'EXTEND') {
      await this.assertRestructureAuthorised(
        user,
        dto.authorisedBy,
        'Moving an instalment to the end of the schedule',
      );
    }
    this.assertActive(loan);
    this.assertNotHeld(loan);
    await this.assertNoRunInFlight(id);

    const row = await this.prisma.loanSchedule.findFirst({
      where: {
        requestId: id,
        version: loan.scheduleVersion,
        installmentNo: dto.installmentNo,
      },
    });
    if (!row) throw new NotFoundException('Instalment not found on the live schedule');
    if (row.status !== 'SCHEDULED') {
      throw new BadRequestException(
        `Instalment ${dto.installmentNo} is ${row.status.toLowerCase()} and cannot be skipped`,
      );
    }

    const mode = dto.mode ?? 'EXTEND';
    const emi = Number(row.emiAmount);

    await this.prisma.$transaction(async (tx) => {
      await tx.loanSchedule.update({
        where: { id: row.id },
        data: {
          status: mode === 'FORGIVE' ? 'WAIVED' : 'SKIPPED',
          note: `${mode}: ${dto.reason}`,
        },
      });
      if (mode === 'FORGIVE') {
        // waivedAmount is a PRINCIPAL counter (outstandingOf subtracts it from
        // the principal), so it must move by the principal component only.
        // Adding the whole EMI would also subtract the forgiven interest from
        // principal and understate the balance.
        const principalPart = Number(row.principalComponent);
        // The row is already WAIVED above, so it has dropped out of the
        // collectable set and re-deriving is what keeps the cache honest.
        // Subtracting the row's interest from the old figure was wrong in both
        // directions: an instalment that had not fallen due had contributed
        // nothing to subtract, and one that had was subtracted twice if it was
        // also part-paid.
        await this.casVersion(tx, id, loan.version, {
          waivedAmount: { increment: principalPart },
          outstandingPrincipal: roundMoney(
            this.outstandingOf(loan) - principalPart,
          ),
          outstandingInterest: await this.schedules.accruedUnpaidInterest(
            id,
            { version: loan.scheduleVersion },
            tx,
          ),
        });
        await tx.loanTransaction.create({
          data: {
            requestId: id,
            type: 'WAIVER',
            transactionDate: new Date(),
            amount: emi,
            principalComponent: row.principalComponent,
            interestComponent: row.interestComponent,
            createdById: user?.id ?? null,
            narration: `Instalment ${dto.installmentNo} forgiven: ${dto.reason}`,
          },
        });
      }
    });

    // EXTEND re-amortizes the still-owed balance over fresh instalments, which
    // is NOT a date shift: under reducing balance an extra period accrues extra
    // interest, so it has to go through the engine.
    //
    // `extendBy: 1` is what makes it an EXTENSION. Left to its default count the
    // rebuild spread the whole balance over the instalments that HAPPENED to be
    // left, so skipping #4 of 6 turned six deductions of 100 into two of 300 —
    // the request to move one instalment out tripled the next payslip instead.
    // One more instalment than are still open keeps the deduction where it is
    // and simply ends the loan a cycle later, which is what was asked for.
    if (mode === 'EXTEND') {
      try {
        await this.schedules.regenerate(id, {
          extendBy: 1,
          actorId: user?.id ?? null,
        });
      } catch (err) {
        this.logger.error(
          `Instalment skipped on ${id} but regeneration failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    await this.trail(
      loan,
      'LOAN_INSTALLMENT_SKIPPED',
      { installmentNo: dto.installmentNo, status: row.status },
      { mode, reason: dto.reason },
      user,
    );
    // Silence here changes the next payslip without warning, which is the one
    // thing a deduction notice exists to prevent.
    await this.notifyEmployee(
      loan.employeeId,
      id,
      'Loan instalment skipped',
      mode === 'FORGIVE'
        ? `Instalment ${dto.installmentNo} of ${emi} has been forgiven and will not be deducted: ${dto.reason}`
        : `Instalment ${dto.installmentNo} of ${emi} will not be deducted this cycle: ${dto.reason}. ` +
          `The amount is still owed — your loan now runs one instalment longer.`,
    );
    return this.payoffQuote(id);
  }

  // ── conversion ───────────────────────────────────────────────────────────

  /**
   * Turn an outstanding ADVANCE into an instalment LOAN.
   *
   * Creates a NEW request rather than mutating the advance, so the already
   * recovered history stays attached to the terms it was recovered under. The
   * pair nets to zero via CONVERSION transactions, keeping the receivable
   * ledger continuous.
   */
  async convertToLoan(
    id: string,
    user: any,
    dto: { installments: number; interestRate?: number; reason?: string },
  ) {
    const loan = await this.getLoan(id);
    this.assertActive(loan);
    await this.assertNoRunInFlight(id);

    if (loan.type !== 'ADVANCE') {
      throw new BadRequestException('Only an advance can be converted to a loan');
    }
    const outstanding = this.outstandingOf(loan);
    if (outstanding <= 0) {
      throw new BadRequestException('This advance has nothing left to convert');
    }
    if (!Number.isInteger(dto.installments) || dto.installments < 1) {
      throw new BadRequestException('Instalments must be a whole number of at least 1');
    }

    const newId = await this.prisma.$transaction(async (tx) => {
      await this.casVersion(tx, id, loan.version, {
        status: 'CLOSED',
        closureType: 'CONVERTED',
        closedAt: new Date(),
        closureRemarks: dto.reason ?? 'Converted to loan',
        outstandingPrincipal: 0,
        amountRepaid: Number(loan.amount),
      });
      await tx.loanSchedule.updateMany({
        where: {
          requestId: id,
          status: { in: ['SCHEDULED', 'PARTIAL', 'DEFERRED'] },
        },
        data: { status: 'CLOSED_EARLY', supersededAt: new Date() },
      });
      await tx.loanTransaction.create({
        data: {
          requestId: id,
          type: 'CONVERSION',
          transactionDate: new Date(),
          amount: outstanding,
          principalComponent: outstanding,
          createdById: user?.id ?? null,
          narration: 'Advance converted to loan (credit)',
        },
      });

      const created = await tx.advanceLoanRequest.create({
        data: {
          employeeId: loan.employeeId,
          type: 'LOAN',
          amount: outstanding,
          installments: dto.installments,
          reason: `Converted from advance ${loan.referenceNo ?? loan.id}`,
          // Re-enters approval on purpose: new terms need a fresh decision.
          status: 'PENDING',
          approvalSource: 'CONVERSION',
          convertedFromId: loan.id,
          currency: loan.currency,
          ...(dto.interestRate !== undefined
            ? { interestRate: dto.interestRate }
            : {}),
        },
      });

      await tx.loanTransaction.create({
        data: {
          requestId: created.id,
          type: 'CONVERSION',
          transactionDate: new Date(),
          amount: outstanding,
          principalComponent: outstanding,
          createdById: user?.id ?? null,
          narration: `Converted from advance ${loan.id} (debit)`,
        },
      });

      return created.id;
    });

    await this.trail(
      loan,
      'ADVANCE_CONVERTED_TO_LOAN',
      { status: loan.status, outstanding },
      { newLoanId: newId, installments: dto.installments },
      user,
    );
    await this.notifyEmployee(
      loan.employeeId,
      id,
      'Advance converted to a loan',
      `Your outstanding advance of ${outstanding} has been converted to a ${dto.installments}-instalment loan, pending approval.`,
    );

    return {
      success: true,
      message: 'Advance converted; the new loan is awaiting approval',
      data: { closedAdvanceId: id, newLoanId: newId, amount: outstanding },
    };
  }
}
