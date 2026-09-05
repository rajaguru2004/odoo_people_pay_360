import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { roundMoney } from '../common/utils/money.util';
import {
  allocateRecovery,
  splitPayment,
  type PaymentDue,
} from './loan-amortization.util';
import {
  LOAN_RECOVERABLE_STATUSES,
  type LeaveLoanPolicy,
  type RecoveryOutcome,
  type RecoveryReason,
} from './loan.types';
import type { ResolvedLoanPolicy } from './loan-policy.service';

/** One collectable instalment, already resolved to a due split. */
export interface LoanCandidate {
  requestId: string;
  employeeId: string;
  /** null for legacy / schedule-less advance recovery. */
  scheduleId: string | null;
  installmentNo: number | null;
  type: string; // 'ADVANCE' | 'LOAN'
  priority: number;
  createdAt: Date;
  outstanding: number;
  oldestDueCycleKey: number;
  due: PaymentDue;
}

/** What the payroll run should do about one instalment this cycle. */
export interface RecoveryLine {
  requestId: string;
  scheduleId: string | null;
  installmentNo: number | null;
  plannedAmount: number;
  amount: number;
  shortfallAmount: number;
  principalComponent: number;
  interestComponent: number;
  feeComponent: number;
  outcome: RecoveryOutcome;
  reason: RecoveryReason;
}

export interface RecoveryPlan {
  employeeId: string;
  totalRecovered: number;
  lines: RecoveryLine[];
  /** Appended to the payslip note so a skipped or partial EMI is explained. */
  noteLines: string[];
}

/** Everything the allocator needs about one employee's pay cycle. */
export interface CycleContext {
  employeeId: string;
  /** item.netSalary computed with ZERO loan recovery. */
  netPreRecovery: number;
  garnishment: number;
  unpaidLeaveDays: number;
  /** Per-leave-type policies of every approved leave overlapping the cycle. */
  leavePolicies: (LeaveLoanPolicy | null)[];
  /**
   * `year * 12 + month` for the run. Needed only by the grace rule, which asks
   * how far into a loan's life this cycle is; omitted, grace does not apply
   * and every existing caller behaves exactly as before.
   */
  cycleKey?: number;
}

const STRICTNESS: Record<LeaveLoanPolicy, number> = {
  CONTINUE: 0,
  EXTEND: 1,
  PAUSE: 2,
};

/**
 * Plans loan recovery for a payroll run.
 *
 * Split deliberately into an async loader and a PURE allocator:
 * `allocateForEmployee` touches no database, so the whole affordability /
 * priority / leave matrix is unit-testable as a table.
 */
@Injectable()
export class LoanRecoveryService {
  private readonly logger = new Logger(LoanRecoveryService.name);

  constructor(private prisma: PrismaService) {}

  static cycleKey(month: number, year: number): number {
    return year * 12 + month;
  }

  /**
   * Load every collectable instalment for these employees, keyed by employee.
   *
   * Selection is date-based, not count-based: everything whose cycle key is
   * this cycle OR EARLIER. That single `<=` is what sweeps a deferred or
   * skipped instalment forward automatically, and it is what lets a WEEKLY loan
   * contribute several rows to one monthly run.
   */
  async loadCandidates(
    employeeIds: string[],
    month: number,
    year: number,
    runType: string,
    policy: ResolvedLoanPolicy,
  ): Promise<Map<string, LoanCandidate[]>> {
    const byEmployee = new Map<string, LoanCandidate[]>();
    if (employeeIds.length === 0) return byEmployee;

    // A bonus-only or retro/arrears run must not charge an EMI a second time.
    // Only gated when v2 is on: the legacy path had no run-type concept, and
    // the kill-switch must mean "behave exactly as before".
    if (
      policy.moduleV2Enabled &&
      !policy.recoverOnRunTypes.includes(runType.toUpperCase())
    ) {
      return byEmployee;
    }

    const cycleKey = LoanRecoveryService.cycleKey(month, year);
    const cycleStart = new Date(Date.UTC(year, month - 1, 1));

    // Chunked: Postgres plans degrade badly on very large IN lists.
    const chunks: string[][] = [];
    for (let i = 0; i < employeeIds.length; i += 1000) {
      chunks.push(employeeIds.slice(i, i + 1000));
    }

    for (const chunk of chunks) {
      const loans = await this.prisma.advanceLoanRequest.findMany({
        where: {
          employeeId: { in: chunk },
          status: { in: LOAN_RECOVERABLE_STATUSES },
          // In-flight guard: an instalment already carried by an unlocked draft
          // payroll must not be picked up twice.
          deductions: { none: { status: 'PENDING' } },
          OR: [{ holdUntil: null }, { holdUntil: { lt: cycleStart } }],
        },
        select: {
          id: true,
          employeeId: true,
          type: true,
          priority: true,
          createdAt: true,
          amount: true,
          amountRepaid: true,
          installmentAmount: true,
          scheduleVersion: true,
          // NOT filtered by dueCycleKey. We need to tell "this loan has no
          // schedule at all" (a pre-v2 row, where the legacy bridge applies)
          // apart from "this loan has a schedule but nothing is due yet"
          // (grace period, or a regeneration that starts next cycle). Filtering
          // here collapses both to an empty list, and the legacy bridge then
          // recovers an instalment that is NOT due. Schedules are at most a
          // tenure long, so fetching them all is cheap.
          schedules: {
            where: { status: { in: ['SCHEDULED', 'PARTIAL', 'DEFERRED'] } },
            orderBy: { installmentNo: 'asc' },
            select: {
              id: true,
              version: true,
              installmentNo: true,
              dueCycleKey: true,
              emiAmount: true,
              principalComponent: true,
              interestComponent: true,
              employerSubsidyComponent: true,
              feeComponent: true,
              paidAmount: true,
              paidPrincipal: true,
              paidInterest: true,
            },
          },
        },
      });

      for (const loan of loans) {
        const outstanding =
          Number(loan.amount) - Number(loan.amountRepaid);
        if (outstanding <= 0) continue;

        // Only rows belonging to the LIVE schedule version are collectable.
        // Superseded rows are already CANCELLED, so this is defence in depth.
        const live = (loan.schedules ?? []).filter(
          (s) => s.version === loan.scheduleVersion,
        );
        // Of those, the ones actually due this cycle or earlier. The `<=` is
        // what sweeps arrears forward.
        const due = live.filter((s) => s.dueCycleKey <= cycleKey);

        const candidates: LoanCandidate[] = [];

        if (live.length > 0) {
          // A scheduled loan with nothing due this cycle recovers NOTHING. It
          // must never fall through to the legacy bridge, or a grace period
          // would be silently ignored.
          for (const s of due) {
            const feeDue = Math.max(0, Number(s.feeComponent));
            const interestDue = Math.max(
              0,
              Number(s.interestComponent) -
                Number(s.employerSubsidyComponent) -
                Number(s.paidInterest),
            );
            const principalDue = Math.max(
              0,
              Number(s.principalComponent) - Number(s.paidPrincipal),
            );
            const total = feeDue + interestDue + principalDue;
            if (total <= 0) continue;
            candidates.push({
              requestId: loan.id,
              employeeId: loan.employeeId,
              scheduleId: s.id,
              installmentNo: s.installmentNo,
              type: loan.type,
              priority: loan.priority ?? 100,
              createdAt: loan.createdAt ?? new Date(0),
              outstanding,
              oldestDueCycleKey: s.dueCycleKey,
              due: {
                fee: roundMoney(feeDue),
                interest: roundMoney(interestDue),
                principal: roundMoney(principalDue),
              },
            });
          }
        } else {
          // ── Legacy bridge ────────────────────────────────────────────────
          // Pre-v2 loans have no schedule rows at all. Reproduce the v1 rule
          // exactly (LOAN takes one instalment capped at the balance, ADVANCE
          // recovers in full) so existing approved loans keep being recovered
          // with no data migration.
          const perCycle =
            loan.type === 'LOAN'
              ? Math.min(Number(loan.installmentAmount || 0), outstanding)
              : outstanding;
          if (perCycle <= 0) continue;
          candidates.push({
            requestId: loan.id,
            employeeId: loan.employeeId,
            scheduleId: null,
            installmentNo: null,
            type: loan.type,
            priority: loan.priority ?? 100,
            createdAt: loan.createdAt ?? new Date(0),
            outstanding,
            oldestDueCycleKey: cycleKey,
            due: { fee: 0, interest: 0, principal: roundMoney(perCycle) },
          });
        }

        if (candidates.length === 0) continue;
        const list = byEmployee.get(loan.employeeId) ?? [];
        list.push(...candidates);
        byEmployee.set(loan.employeeId, list);
      }
    }

    return byEmployee;
  }

  /**
   * Order candidates for recovery.
   *
   * Every key down to `requestId` is present on purpose: the requirement doc
   * calls out "same priority" as a case, and without a final deterministic
   * tiebreak the outcome would depend on row order from the database.
   */
  static sortCandidates(
    candidates: LoanCandidate[],
    policy: ResolvedLoanPolicy,
  ): LoanCandidate[] {
    const typeRank = (t: string) => {
      const i = policy.recoveryPriorityOrder.indexOf(t.toUpperCase());
      return i === -1 ? policy.recoveryPriorityOrder.length : i;
    };
    return [...candidates].sort(
      (a, b) =>
        a.priority - b.priority ||
        typeRank(a.type) - typeRank(b.type) ||
        a.oldestDueCycleKey - b.oldestDueCycleKey ||
        (policy.priorityTiebreak === 'SMALLEST_BALANCE_FIRST'
          ? a.outstanding - b.outstanding
          : a.createdAt.getTime() - b.createdAt.getTime()) ||
        (a.installmentNo ?? 0) - (b.installmentNo ?? 0) ||
        a.requestId.localeCompare(b.requestId),
    );
  }

  /**
   * Decide what to recover from ONE employee this cycle. PURE — no database.
   *
   * Priority ladder (the requirement doc's "statutory deductions, garnishments,
   * advances and loans compete for a limited net salary"):
   *   1. Statutory — already subtracted inside calculateSalaryOptimized before
   *      netPreRecovery exists, so it wins structurally. Nothing to enforce.
   *   2. Garnishment — subtracted here.
   *   3. Protected minimum take-home.
   *   4. Salary advances (employer cash already out the door), then loans,
   *      by priority then age.
   */
  static allocateForEmployee(
    ctx: CycleContext,
    candidates: LoanCandidate[],
    policy: ResolvedLoanPolicy,
    runType: string,
  ): RecoveryPlan {
    const empty: RecoveryPlan = {
      employeeId: ctx.employeeId,
      totalRecovered: 0,
      lines: [],
      noteLines: [],
    };
    if (candidates.length === 0) return empty;

    const sorted = LoanRecoveryService.sortCandidates(candidates, policy);

    // ── Kill-switch: legacy behaviour ────────────────────────────────────
    // With v2 off, recover every due instalment IN FULL with no affordability
    // cap, no minimum-take-home floor and no leave pause — exactly what the
    // pre-v2 payroll did. Turning the switch on is the ONLY thing that changes
    // how much money moves, which is what makes this safe to ship enabled-off.
    if (!policy.moduleV2Enabled) {
      const lines: RecoveryLine[] = sorted.map((c) => {
        const planned = roundMoney(
          c.due.fee + c.due.interest + c.due.principal,
        );
        // The deployment's allocation order, which this was ignoring: the
        // policy carried PRINCIPAL_FIRST and every recovery applied interest
        // first anyway.
        const split = splitPayment(
          planned,
          c.due,
          undefined,
          policy.paymentAllocationOrder,
        );
        return {
          requestId: c.requestId,
          scheduleId: c.scheduleId,
          installmentNo: c.installmentNo,
          plannedAmount: planned,
          amount: planned,
          shortfallAmount: 0,
          principalComponent: split.principal,
          interestComponent: split.interest,
          feeComponent: split.fee,
          outcome: 'FULL' as RecoveryOutcome,
          reason: 'AFFORDABLE' as RecoveryReason,
        };
      });
      return {
        employeeId: ctx.employeeId,
        totalRecovered: roundMoney(lines.reduce((a, l) => a + l.amount, 0)),
        lines,
        noteLines: [],
      };
    }

    /** Zero-amount explanatory line. Written so "why was nothing recovered?" is answerable. */
    const skipAll = (
      outcome: RecoveryOutcome,
      reason: RecoveryReason,
      note: string,
    ): RecoveryPlan => ({
      employeeId: ctx.employeeId,
      totalRecovered: 0,
      lines: sorted.map((c) => ({
        requestId: c.requestId,
        scheduleId: c.scheduleId,
        installmentNo: c.installmentNo,
        plannedAmount: roundMoney(c.due.fee + c.due.interest + c.due.principal),
        amount: 0,
        shortfallAmount: roundMoney(
          c.due.fee + c.due.interest + c.due.principal,
        ),
        principalComponent: 0,
        interestComponent: 0,
        feeComponent: 0,
        outcome,
        reason,
      })),
      noteLines: [note],
    });

    // ── Leave interaction ────────────────────────────────────────────────
    // Strictest wins across every approved leave overlapping the cycle, so a
    // month containing one PAUSE leave type pauses regardless of the others.
    let leavePolicy: LeaveLoanPolicy | null = null;
    if (ctx.unpaidLeaveDays >= policy.unpaidLeaveMinDays) {
      const resolved = ctx.leavePolicies.filter(Boolean) as LeaveLoanPolicy[];
      leavePolicy = resolved.length
        ? resolved.reduce((a, b) => (STRICTNESS[b] > STRICTNESS[a] ? b : a))
        : policy.unpaidLeavePolicy;
    }
    if (leavePolicy === 'PAUSE') {
      return skipAll(
        'SKIP',
        'UNPAID_LEAVE',
        `Loan instalment paused: ${ctx.unpaidLeaveDays} unpaid leave day(s) this cycle.`,
      );
    }
    if (leavePolicy === 'EXTEND') {
      return skipAll(
        'DEFER',
        'UNPAID_LEAVE',
        `Loan instalment deferred and the schedule extended: ${ctx.unpaidLeaveDays} unpaid leave day(s) this cycle.`,
      );
    }

    // ── Deployment-wide grace ────────────────────────────────────────────
    //
    // `gracePeriodCycles` was resolved into the policy and branched on nowhere,
    // so a company that wanted "no recovery in a loan's first N cycles" could
    // set it, see it saved, and be recovered from immediately.
    //
    // Distinct from `AdvanceLoanRequest.gracePeriods`, which shifts the first
    // DUE DATE when a schedule is built: that is a term of one agreement, this
    // is a standing rule applied to every loan, including ones already running.
    // Wiring it also gives `RecoveryReason.GRACE_PERIOD` its first producer —
    // it was an enum member no code path could emit.
    if (policy.gracePeriodCycles > 0 && ctx.cycleKey != null) {
      const inGrace = sorted.filter(
        (c) => ctx.cycleKey! < c.oldestDueCycleKey + policy.gracePeriodCycles,
      );
      if (inGrace.length === sorted.length) {
        return skipAll(
          'DEFER',
          'GRACE_PERIOD',
          `Loan recovery is inside its ${policy.gracePeriodCycles}-cycle grace period.`,
        );
      }
    }

    // ── Zero-salary cycle ────────────────────────────────────────────────
    if (ctx.netPreRecovery <= 0) {
      return skipAll(
        policy.zeroSalaryPolicy === 'SKIP' ? 'SKIP' : 'DEFER',
        'ZERO_NET',
        'No loan recovery: net pay for this cycle is zero.',
      );
    }

    // ── Available pool ───────────────────────────────────────────────────
    const ignoreFloor =
      runType.toUpperCase() === 'FINAL_SETTLEMENT' &&
      policy.finalSettlementIgnoresMinNet;

    const protectedNet = ignoreFloor
      ? 0
      : Math.max(
          policy.minNetPayAmount,
          (ctx.netPreRecovery * policy.minNetPayPercent) / 100,
        );
    const capByPercent = ignoreFloor
      ? Number.POSITIVE_INFINITY
      : (ctx.netPreRecovery * policy.maxTotalDeductionPercentOfNet) / 100;

    const pool = Math.max(
      0,
      Math.min(
        ctx.netPreRecovery - Math.max(0, ctx.garnishment) - protectedNet,
        capByPercent,
      ),
    );

    if (pool <= 0) {
      return skipAll(
        policy.shortfallPolicy === 'SKIP' ? 'SKIP' : 'DEFER',
        'INSUFFICIENT_NET',
        'No loan recovery: net pay is at or below the protected minimum take-home.',
      );
    }

    // ── Allocate ─────────────────────────────────────────────────────────
    const partialPolicy =
      policy.shortfallPolicy === 'PARTIAL'
        ? 'PARTIAL'
        : policy.shortfallPolicy === 'SKIP'
          ? 'ALL_OR_NOTHING'
          : 'DEFER';

    const alloc = allocateRecovery(
      sorted.map((c) => ({
        scheduleId: c.scheduleId ?? c.requestId, // key only; mapped back below
        requestId: c.requestId,
        priority: c.priority,
        due: c.due,
      })),
      pool,
      { partialPolicy },
    );

    const allocByKey = new Map(
      alloc.rows.map((r) => [`${r.requestId}|${r.scheduleId}`, r]),
    );

    const lines: RecoveryLine[] = [];
    const noteLines: string[] = [];

    for (const c of sorted) {
      const key = `${c.requestId}|${c.scheduleId ?? c.requestId}`;
      const row = allocByKey.get(key);
      const planned = roundMoney(c.due.fee + c.due.interest + c.due.principal);

      if (!row || row.amount <= 0) {
        lines.push({
          requestId: c.requestId,
          scheduleId: c.scheduleId,
          installmentNo: c.installmentNo,
          plannedAmount: planned,
          amount: 0,
          shortfallAmount: planned,
          principalComponent: 0,
          interestComponent: 0,
          feeComponent: 0,
          outcome: policy.shortfallPolicy === 'SKIP' ? 'SKIP' : 'DEFER',
          reason: 'INSUFFICIENT_NET',
        });
        continue;
      }

      // A recovery too small to be worth posting is deferred whole, so the
      // ledger does not fill with 0.01 rows.
      if (
        row.amount < planned &&
        row.amount < policy.minPartialRecoveryAmount
      ) {
        lines.push({
          requestId: c.requestId,
          scheduleId: c.scheduleId,
          installmentNo: c.installmentNo,
          plannedAmount: planned,
          amount: 0,
          shortfallAmount: planned,
          principalComponent: 0,
          interestComponent: 0,
          feeComponent: 0,
          outcome: 'DEFER',
          reason: 'INSUFFICIENT_NET',
        });
        continue;
      }

      const full = row.amount >= planned;
      const split = splitPayment(
        row.amount,
        c.due,
        undefined,
        policy.paymentAllocationOrder,
      );
      lines.push({
        requestId: c.requestId,
        scheduleId: c.scheduleId,
        installmentNo: c.installmentNo,
        plannedAmount: planned,
        amount: roundMoney(row.amount),
        shortfallAmount: roundMoney(planned - row.amount),
        principalComponent: split.principal,
        interestComponent: split.interest,
        feeComponent: split.fee,
        outcome: full ? 'FULL' : 'PARTIAL',
        reason: full ? 'AFFORDABLE' : 'INSUFFICIENT_NET',
      });
      if (!full) {
        noteLines.push(
          `Partial loan recovery: ${roundMoney(row.amount)} of ${planned} deducted; ` +
            `${roundMoney(planned - row.amount)} carried forward.`,
        );
      }
    }

    const deferred = lines.filter((l) => l.amount === 0);
    if (deferred.length > 0) {
      noteLines.push(
        `${deferred.length} loan instalment(s) not recovered this cycle (insufficient net pay).`,
      );
    }

    return {
      employeeId: ctx.employeeId,
      totalRecovered: roundMoney(
        lines.reduce((a, l) => a + l.amount, 0),
      ),
      lines,
      noteLines,
    };
  }
}
