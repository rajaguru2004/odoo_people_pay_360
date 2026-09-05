import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { roundMoney } from '../common/utils/money.util';
import { LOAN_TERMINAL_STATUSES } from './loan.types';
import { LoanLifecycleService } from './loan-lifecycle.service';
import { LoanScheduleService } from './loan-schedule.service';
import { assertInBranch } from '../common/branch/branch-scope.util';

export type SettlementAction =
  | 'RECOVER_FROM_FINAL_PAY'
  | 'RECOVER_FROM_GRATUITY'
  | 'RECOVER_FROM_LEAVE_ENCASHMENT'
  | 'PARTIAL'
  | 'WAIVE'
  | 'WRITE_OFF'
  | 'CARRY_AS_RECEIVABLE';

export interface SettlementDecision {
  loanId: string;
  action: SettlementAction;
  amount?: number;
  reference?: string;
  reason?: string;
}

/** One outstanding loan, as costed by `quote()`. */
interface SettlementQuoteItem {
  loanId: string;
  type: string;
  referenceNo: string | null;
  status: string;
  principal: number;
  interest: number;
  total: number;
}

/** A decision that has been validated against the quote and costed. */
interface PlannedDecision {
  decision: SettlementDecision;
  loan: SettlementQuoteItem;
  /** The figure that will actually be applied (write-offs cap at principal). */
  amount: number;
}

interface SettlementTotals {
  recovered: number;
  waived: number;
  writtenOff: number;
  carried: number;
}

/**
 * Records what is DECIDED about an employee's outstanding loans at exit, and
 * the ledger effect of that decision.
 *
 * This is deliberately NOT a full-and-final module — the repo has no F&F,
 * gratuity or leave-encashment payout model, so the payout itself stays
 * external. What this owns is the receivable: every loan an exiting employee
 * holds must end up recovered, forgiven, or explicitly carried, and the
 * decision must be reversible.
 */
@Injectable()
export class LoanSettlementService {
  private readonly logger = new Logger(LoanSettlementService.name);

  constructor(
    private prisma: PrismaService,
    private lifecycle: LoanLifecycleService,
    private audit: AuditService,
    // No forwardRef needed: LoanScheduleService depends only on Prisma,
    // SystemSettingsService and LoanAccessService, so nothing points back here.
    private schedules: LoanScheduleService,
  ) {}

  private outstandingPrincipalOf(loan: {
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
   * Interest ACCRUED AND UNPAID on one loan today.
   *
   * Derived from the live schedule, never read from
   * `AdvanceLoanRequest.outstandingInterest`. That column is only a cache of
   * this figure (see the LoanScheduleService class doc) and the importer still
   * parks the loan's whole LIFETIME interest in it — so quoting from it billed
   * an exiting employee for interest on instalments that had not happened yet,
   * on the one operation where they have the least opportunity to argue.
   *
   * A freshly disbursed loan has nothing due, so its settlement quote is
   * principal only. That is the point.
   */
  private async accruedInterestOf(
    requestId: string,
    tx?: any,
  ): Promise<number> {
    return Math.max(
      0,
      await this.schedules.accruedUnpaidInterest(requestId, {}, tx),
    );
  }

  /** Everything still owed by this employee, for the exit checklist. */
  /**
   * Resolve the settlement subject and prove the caller may reach them.
   *
   * This file used to contain no branch guard at all, relying on the Prisma
   * middleware — which scopes `findMany` but NOT `findUnique`, and does not
   * scope `updateMany` for relation-scoped models like `AdvanceLoanRequest`.
   * A branch-scoped HR could therefore quote, and then SETTLE, an employee they
   * could not otherwise see. Resolving the employee explicitly also gives the
   * two settlement routes something to disagree about, which is what stops a
   * settlement id being accepted where an employee id belongs.
   */
  private async assertSettleableEmployee(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, branchId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertInBranch(employee.branchId);
    return employee;
  }

  async quote(employeeId: string) {
    await this.assertSettleableEmployee(employeeId);

    const loans = await this.prisma.advanceLoanRequest.findMany({
      where: {
        employeeId,
        status: { notIn: LOAN_TERMINAL_STATUSES as any },
      },
      select: {
        id: true,
        type: true,
        referenceNo: true,
        status: true,
        amount: true,
        amountRepaid: true,
        writtenOffAmount: true,
        waivedAmount: true,
        // `outstandingInterest` is deliberately NOT selected — see
        // accruedInterestOf. The live plan is the only source of truth.
      },
    });

    const items = await Promise.all(
      loans.map(async (l) => {
        const principal = this.outstandingPrincipalOf(l);
        const interest = await this.accruedInterestOf(l.id);
        return {
          loanId: l.id,
          type: l.type,
          referenceNo: l.referenceNo,
          status: l.status,
          principal,
          interest,
          total: roundMoney(principal + interest),
        };
      }),
    );

    return {
      employeeId,
      loans: items,
      totalOutstanding: roundMoney(items.reduce((a, i) => a + i.total, 0)),
      cleared: items.every((i) => i.total <= 0.005),
    };
  }

  /**
   * Turn the raw decision list into a validated plan.
   *
   * NOTHING is written until every decision in the set has passed. A refusal
   * used to arrive halfway through the apply loop, leaving every earlier
   * decision standing; validating the whole set up front removes most of that
   * exposure before a single row is touched.
   */
  private planSettlement(
    quote: { loans: SettlementQuoteItem[] },
    decisions: SettlementDecision[],
  ): { plan: PlannedDecision[]; totals: SettlementTotals } {
    const plan: PlannedDecision[] = [];
    const seen = new Set<string>();
    let recovered = 0;
    let waived = 0;
    let writtenOff = 0;
    let carried = 0;

    for (const decision of decisions) {
      const loan = quote.loans.find((l) => l.loanId === decision.loanId);
      if (!loan) {
        throw new BadRequestException(
          `Loan ${decision.loanId} is not outstanding for this employee`,
        );
      }
      const label = loan.referenceNo ?? loan.loanId;

      // Every decision is costed against the SAME quote, so naming a loan twice
      // would apply both against the same opening balance.
      if (seen.has(decision.loanId)) {
        throw new BadRequestException(
          `Loan ${label} has more than one settlement decision`,
        );
      }
      seen.add(decision.loanId);

      let amount = roundMoney(decision.amount ?? loan.total);

      switch (decision.action) {
        case 'RECOVER_FROM_FINAL_PAY':
          break;

        case 'RECOVER_FROM_GRATUITY':
        case 'RECOVER_FROM_LEAVE_ENCASHMENT':
        case 'PARTIAL': {
          if (amount <= 0) {
            throw new BadRequestException('Recovery amount must be greater than 0');
          }
          if (amount > loan.total) {
            throw new BadRequestException(
              `Recovery of ${amount} exceeds the ${loan.total} outstanding on loan ${label}`,
            );
          }
          recovered = roundMoney(recovered + amount);
          break;
        }

        case 'WAIVE': {
          // Mirrors LoanLifecycleService.waive's own ceiling for waiveType
          // BOTH, so the refusal it would raise mid-apply is raised here
          // instead — before anything has moved.
          if (amount <= 0) {
            throw new BadRequestException('Waiver amount must be greater than 0');
          }
          if (amount > loan.total) {
            throw new BadRequestException(
              `Waiver of ${amount} exceeds the ${loan.total} outstanding on loan ${label}`,
            );
          }
          waived = roundMoney(waived + amount);
          break;
        }

        case 'WRITE_OFF': {
          // A write-off only ever touches principal, so the planned figure is
          // the one actually applied — the settlement record is written BEFORE
          // the apply and must not claim more than will happen.
          amount = roundMoney(Math.min(amount, loan.principal));
          if (amount <= 0) {
            throw new BadRequestException(
              `Write-off amount must be greater than 0 (loan ${label} has ${loan.principal} outstanding principal)`,
            );
          }
          writtenOff = roundMoney(writtenOff + amount);
          break;
        }

        case 'CARRY_AS_RECEIVABLE':
          carried = roundMoney(carried + loan.total);
          break;

        default:
          throw new BadRequestException(
            `Unknown settlement action: ${String(decision.action)}`,
          );
      }

      plan.push({ decision, loan, amount });
    }

    return { plan, totals: { recovered, waived, writtenOff, carried } };
  }

  /**
   * Apply exit decisions.
   *
   * Every non-terminal loan must be named, or the settlement is refused — a
   * silent omission is how a receivable disappears at exit.
   */
  async settle(
    employeeId: string,
    user: any,
    dto: { decisions: SettlementDecision[]; reason?: string },
  ) {
    await this.assertSettleableEmployee(employeeId);

    const quote = await this.quote(employeeId);
    if (quote.loans.length === 0) {
      throw new BadRequestException(
        'This employee has no outstanding advances or loans to settle',
      );
    }

    const named = new Set(dto.decisions.map((d) => d.loanId));
    const missing = quote.loans.filter((l) => !named.has(l.loanId));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Every outstanding loan must have a settlement decision. Missing: ${missing
          .map((m) => m.referenceNo ?? m.loanId)
          .join(', ')}`,
      );
    }

    // Validate the ENTIRE decision set before applying anything.
    const { plan, totals } = this.planSettlement(quote, dto.decisions);

    // Snapshot BEFORE anything moves, so the settlement can be restored
    // exactly rather than guessed at.
    const preState = await this.snapshot([...named]);

    /**
     * ATOMICITY — and why the settlement record is written FIRST.
     *
     * The whole settlement must apply or none of it. One `$transaction` around
     * the loop cannot deliver that on its own: WAIVE and WRITE_OFF delegate to
     * LoanLifecycleService, which opens its OWN `$transaction` on the base
     * Prisma client and runs its own `casVersion` compare-and-set. Called from
     * inside an outer interactive transaction those inner transactions commit
     * on a separate connection and are invisible to the outer rollback — the
     * money would silently survive the failure, which is worse than today
     * because it would LOOK atomic. The other option, threading a tx client
     * through `waive`/`writeOff`, changes another service's signatures and its
     * CAS semantics, and that service is not this one's to redefine.
     *
     * So the guarantee is built here instead:
     *   1. `planSettlement` validates every decision — nothing is written until
     *      the whole set is known good.
     *   2. The `LoanSettlement` row, carrying `preState`, is created BEFORE the
     *      first effect. It is the undo record; previously it was created after
     *      the loop, so a refusal on a later decision left the earlier ones
     *      applied with nothing for `reverseSettlement()` to restore from.
     *   3. Any failure during apply runs the SAME restore path
     *      `reverseSettlement` uses and marks the settlement reversed, so every
     *      loan goes back exactly where it was. A hard crash mid-apply now
     *      leaves a reversible record instead of no record at all.
     *
     * The apply order is deliberate too: the delegated lifecycle calls run
     * first, then everything this service owns runs in ONE transaction. A
     * failure in that transaction rolls itself back, so the compensating
     * restore only ever has to undo the delegated half.
     */
    const settlement = await this.prisma.loanSettlement.create({
      data: {
        employeeId,
        totalOutstanding: quote.totalOutstanding,
        ...totals,
        decisionsJson: {
          decisions: dto.decisions,
          preState,
        } as any,
        decidedBy: user?.id ?? null,
      },
    });

    try {
      // ── delegated: own transaction, own CAS, own role gate ──────────────
      for (const step of plan) {
        if (step.decision.action === 'WAIVE') {
          await this.lifecycle.waive(step.loan.loanId, user, {
            amount: step.amount,
            waiveType: 'BOTH',
            reason: step.decision.reason ?? 'Waived at exit settlement',
          });
        } else if (step.decision.action === 'WRITE_OFF') {
          await this.lifecycle.writeOff(step.loan.loanId, user, {
            amount: step.amount,
            reason: step.decision.reason ?? 'Written off at exit settlement',
          });
        }
      }

      // ── everything this service owns, in one transaction ────────────────
      await this.prisma.$transaction(async (tx) => {
        for (const step of plan) {
          const { decision, loan, amount } = step;

          switch (decision.action) {
            case 'RECOVER_FROM_FINAL_PAY': {
              // Flagged for the payroll planner: on a FINAL_SETTLEMENT run the
              // minimum-take-home floor is lifted and the whole balance is
              // taken.
              await tx.advanceLoanRequest.update({
                where: { id: loan.loanId },
                data: {
                  settlementMode: 'FINAL_PAY',
                  status: 'ACTIVE',
                  version: { increment: 1 },
                },
              });
              break;
            }

            case 'RECOVER_FROM_GRATUITY':
            case 'RECOVER_FROM_LEAVE_ENCASHMENT':
            case 'PARTIAL': {
              const sourceType =
                decision.action === 'RECOVER_FROM_GRATUITY'
                  ? 'GRATUITY'
                  : decision.action === 'RECOVER_FROM_LEAVE_ENCASHMENT'
                    ? 'LEAVE_ENCASHMENT'
                    : 'FINAL_PAY';

              // The payout is external; what is recorded here is the
              // receivable being satisfied, so the ledger and any GL journal
              // stay correct.
              //
              // `loan.interest` is the ACCRUED-and-unpaid figure derived by
              // quote(), not the lifetime total the column used to hold, so the
              // interest-first waterfall can no longer consume interest nobody
              // has earned.
              const interestPart = Math.min(amount, loan.interest);
              const principalPart = roundMoney(amount - interestPart);

              // Stamp the collected interest onto the instalments it came from,
              // oldest first. Without this the same accrued interest would be
              // derived again on the next quote and billed a second time — and
              // a schedule rebuild would re-bill it too.
              if (interestPart > 0) {
                await this.schedules.creditAccruedInterest(
                  loan.loanId,
                  interestPart,
                  { note: `Recovered at exit settlement from ${sourceType}` },
                  tx,
                );
              }

              // Refresh the cache FROM the plan it caches, after the credit.
              const remainingInterest = await this.accruedInterestOf(
                loan.loanId,
                tx,
              );

              await tx.advanceLoanRequest.update({
                where: { id: loan.loanId },
                data: {
                  amountRepaid: { increment: principalPart },
                  interestPaid: { increment: interestPart },
                  outstandingPrincipal: roundMoney(loan.principal - principalPart),
                  outstandingInterest: remainingInterest,
                  settlementMode: sourceType,
                  version: { increment: 1 },
                  ...(roundMoney(loan.total - amount) <= 0.005
                    ? {
                        status: 'SETTLED',
                        closureType: 'SETTLEMENT',
                        closedAt: new Date(),
                      }
                    : {}),
                },
              });
              await tx.loanTransaction.create({
                data: {
                  requestId: loan.loanId,
                  type: 'SETTLEMENT',
                  transactionDate: new Date(),
                  amount,
                  principalComponent: principalPart,
                  interestComponent: interestPart,
                  sourceType,
                  reference: decision.reference ?? null,
                  createdById: user?.id ?? null,
                  narration: decision.reason ?? `Recovered from ${sourceType}`,
                },
              });
              break;
            }

            case 'CARRY_AS_RECEIVABLE': {
              // Excluded from payroll planning but retained for reporting —
              // this is the "settlement insufficient" / "negative settlement"
              // outcome, and it is what a rehire is resumed from.
              await tx.advanceLoanRequest.update({
                where: { id: loan.loanId },
                data: {
                  status: 'RECEIVABLE',
                  settlementMode: 'CARRIED',
                  closureRemarks:
                    decision.reason ?? 'Carried as a receivable at exit',
                  version: { increment: 1 },
                },
              });
              break;
            }

            // WAIVE / WRITE_OFF were applied above by LoanLifecycleService.
            default:
              break;
          }
        }
      });
    } catch (err) {
      // Compensate: put every named loan back exactly where it was and mark
      // the settlement reversed, so nothing is left half-settled.
      await this.restoreFromSettlement(
        settlement.id,
        preState,
        user,
        `Automatic rollback: ${err instanceof Error ? err.message : String(err)}`,
      ).catch((restoreErr) => {
        this.logger.error(
          `Settlement ${settlement.id} failed AND could not be rolled back automatically: ${
            restoreErr instanceof Error ? restoreErr.message : String(restoreErr)
          }. Reverse it manually.`,
        );
      });
      throw err;
    }

    await this.audit.log({
      userId: user?.id,
      action: 'LOAN_SETTLEMENT_DECIDED',
      resourceType: 'LoanSettlement',
      resourceId: settlement.id,
      newData: { employeeId, ...totals } as any,
    });

    // ...and one row per LOAN under the resourceType the @AuditResource
    // interceptor uses, so "this loan's history" is answerable from a single
    // query. The settlement row above is a genuinely different resource (it is
    // keyed by settlement id and is what a reversal targets), so it stays.
    await this.trailLoans(
      plan.map((step) => ({
        loanId: step.loan.loanId,
        data: {
          settlementId: settlement.id,
          employeeId,
          action: step.decision.action,
          amount: step.amount,
          reference: step.decision.reference ?? null,
          reason: step.decision.reason ?? dto.reason ?? null,
        },
      })),
      'LOAN_SETTLEMENT_DECIDED',
      user,
    );

    return {
      success: true,
      message: 'Loan settlement recorded',
      data: { settlementId: settlement.id, ...totals },
    };
  }

  /** Pre-state for every loan a settlement names, as stored in decisionsJson. */
  private async snapshot(loanIds: string[]) {
    const rows = await this.prisma.advanceLoanRequest.findMany({
      where: { id: { in: loanIds } },
      select: {
        id: true,
        status: true,
        amountRepaid: true,
        writtenOffAmount: true,
        waivedAmount: true,
        outstandingPrincipal: true,
        outstandingInterest: true,
        settlementMode: true,
        closureType: true,
        closedAt: true,
        version: true,
      },
    });
    return rows.map((p) => ({
      ...p,
      amountRepaid: Number(p.amountRepaid),
      writtenOffAmount: Number(p.writtenOffAmount),
      waivedAmount: Number(p.waivedAmount),
      outstandingPrincipal: Number(p.outstandingPrincipal ?? 0),
      outstandingInterest: Number(p.outstandingInterest ?? 0),
    }));
  }

  /** One audit row per loan, under the shared 'AdvanceLoan' resourceType. */
  private async trailLoans(
    entries: { loanId: string; data: Record<string, unknown> }[],
    action: string,
    user: any,
  ) {
    for (const entry of entries) {
      await this.audit.log({
        userId: user?.id,
        action,
        // NOT 'AdvanceLoanRequest'. The controller interceptor writes
        // 'AdvanceLoan', and two resourceType values meant neither query found
        // the other's rows.
        resourceType: 'AdvanceLoan',
        resourceId: entry.loanId,
        newData: entry.data as any,
      });
    }
  }

  /**
   * Restore every loan a settlement names to its captured pre-state and mark
   * the settlement reversed.
   *
   * Shared by the operator-driven `reverseSettlement` and by `settle`'s
   * automatic rollback, so both undo in exactly the same way.
   */
  private async restoreFromSettlement(
    settlementId: string,
    preState: any[],
    user: any,
    reason: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      for (const p of preState) {
        await tx.advanceLoanRequest.update({
          where: { id: p.id },
          data: {
            status: p.status,
            amountRepaid: p.amountRepaid,
            writtenOffAmount: p.writtenOffAmount,
            waivedAmount: p.waivedAmount,
            outstandingPrincipal: p.outstandingPrincipal,
            outstandingInterest: p.outstandingInterest,
            settlementMode: p.settlementMode,
            closureType: p.closureType,
            closedAt: p.closedAt,
            version: { increment: 1 },
          },
        });
        await tx.loanTransaction.create({
          data: {
            requestId: p.id,
            type: 'REVERSAL',
            transactionDate: new Date(),
            amount: 0,
            createdById: user?.id ?? null,
            narration: `Settlement ${settlementId} reversed: ${reason}`,
          },
        });
      }
      await tx.loanSettlement.update({
        where: { id: settlementId },
        data: {
          reversedAt: new Date(),
          reversedBy: user?.id ?? null,
          reversalReason: reason,
        },
      });
    });

    await this.audit.log({
      userId: user?.id,
      action: 'LOAN_SETTLEMENT_REVERSED',
      resourceType: 'LoanSettlement',
      resourceId: settlementId,
      newData: { reason, restored: preState.length } as any,
    });
    await this.trailLoans(
      preState.map((p) => ({
        loanId: p.id,
        data: { settlementId, reason, restoredTo: p.status },
      })),
      'LOAN_SETTLEMENT_REVERSED',
      user,
    );
  }

  /** Restore every loan to the state captured in `decisionsJson`. */
  async reverseSettlement(
    settlementId: string,
    user: any,
    dto: { reason: string },
  ) {
    const settlement = await this.prisma.loanSettlement.findUnique({
      where: { id: settlementId },
    });
    if (!settlement) throw new NotFoundException('Settlement not found');
    if (settlement.reversedAt) {
      throw new BadRequestException('This settlement has already been reversed');
    }

    const payload = settlement.decisionsJson as any;
    const preState: any[] = payload?.preState ?? [];

    await this.restoreFromSettlement(settlementId, preState, user, dto.reason);

    return {
      success: true,
      message: `Settlement reversed; ${preState.length} loan(s) restored`,
    };
  }

  /** Loans carried past an exit, for the rehire workflow. */
  async listReceivable() {
    return this.prisma.advanceLoanRequest.findMany({
      where: { status: 'RECEIVABLE' },
      include: {
        employee: {
          select: { id: true, employeeCode: true, fullName: true, status: true },
        },
      },
    });
  }
}
