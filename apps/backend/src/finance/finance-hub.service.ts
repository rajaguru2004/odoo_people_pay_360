import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReimbursementsService } from '../reimbursements/reimbursements.service';
import { TravelService } from '../travel/travel.service';
import { BudgetsService } from '../budgets/budgets.service';
import { BudgetActualsService } from '../budgets/budget-actuals.service';
import { LoanReportsService } from '../advance-loans/loan-reports.service';
import { LOAN_DEBT_STATUSES } from '../advance-loans/loan.types';
import { roundMoney } from '../common/utils/money.util';
import {
  buildSeriesBuckets,
  HUB_TREND_MONTHS,
  resolveMonthWindow,
  tallyByMonth,
  windowDelta,
} from '../common/utils/hub-window.util';

/**
 * One aggregate behind `/dashboard/finance`.
 *
 * The hub used to make five parallel calls from the browser and re-derive the
 * loan aging buckets client-side from field names the server does not send —
 * `overdueAmount`/`daysOverdue` against the real `amountDue`/`overdueDays`, so
 * the Overdue KPI has been printing a formatted zero. One server-side answer
 * removes both the fan-out and the chance of a second, divergent derivation.
 *
 * Everything that already has a correct implementation is CALLED, not rewritten:
 * `ReimbursementsService.stats`, `TravelService.stats`,
 * `BudgetsService.varianceSummary`, `LoanReportsService.portfolio`/`overdue`.
 * What is new here is the money-over-time series, the paid-in-window figures and
 * the previous-window baselines — none of which exists anywhere in the module.
 *
 * Permission boundary: this route is ADMIN/HR_MANAGER, the same gate
 * `loan-reports.controller.ts` carries, so calling `LoanReportsService` directly
 * widens nothing. `LoanReadOnlyGuard` only refuses mutating verbs, so it has no
 * bearing on a GET.
 *
 * Branch scoping is inherited: every model read here is in `branch-scope.map.ts`
 * and `groupBy`/`count`/`aggregate`/`findMany` are all in `BRANCH_READ_ACTIONS`.
 * Nothing uses `$queryRaw`, which would silently bypass it.
 */

/** The claim statuses the dashboard splits on. Swagger's list, in report order. */
const REIMBURSEMENT_STATUSES = ['PENDING', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED'] as const;

/**
 * Ledger events that REDUCE outstanding principal, and the one that raises it.
 *
 * Used only to walk the book backwards to a past date. `REVERSAL` is deliberately
 * absent: a reversal row points at what it reverses and the reversed row is
 * marked `REVERSED`, so filtering on `status: 'POSTED'` already excludes both
 * halves. Counting the reversal as a movement would double-correct.
 */
const PRINCIPAL_REDUCING = [
  'EMI_RECOVERY',
  'PREPAYMENT',
  'WRITE_OFF',
  'WAIVER',
  'SETTLEMENT',
  'TOPUP_SETTLEMENT',
] as const;

/** Same rule as `budget-actuals.service.ts`, so the two never disagree. */
function categoryForType(type: string): string {
  const normalized = (type ?? '').trim().toLowerCase();
  if (normalized === 'travel' || normalized === 'per diem') return 'Travel';
  if (normalized === 'training') return 'Training';
  return 'Other';
}

@Injectable()
export class FinanceHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reimbursements: ReimbursementsService,
    private readonly travel: TravelService,
    private readonly budgets: BudgetsService,
    private readonly budgetActuals: BudgetActualsService,
    private readonly loanReports: LoanReportsService,
  ) {}

  async getHubSummary() {
    const now = new Date();
    const window = resolveMonthWindow(now);

    const [claims, travelStats, portfolio, overdue, variance] = await Promise.all([
      this.reimbursements.stats(),
      this.travel.stats(),
      this.loanReports.portfolio(),
      this.loanReports.overdue({}),
      this.budgets.varianceSummary(),
    ]);

    const [paid, prevPaid, perDiem, prevPerDiem, byStatus, byCategory, trend, outstandingAsOfPrev, prevBudgetActual] =
      await Promise.all([
        this.paidInWindow(window.current.start, window.current.end),
        this.paidInWindow(window.previous.start, window.previous.end),
        this.paidInWindow(window.current.start, window.current.end, 'TRAVEL'),
        this.paidInWindow(window.previous.start, window.previous.end, 'TRAVEL'),
        this.claimsByStatus(),
        this.claimsByCategory(window.current.start, window.current.end),
        this.expenseTrend(now),
        this.outstandingAsOf(window.previous.end),
        this.budgetActualAsOf(window.previous.end),
      ]);

    const claimsData = claims.data;
    const portfolioTotals = portfolio.totals;

    const budgetTotals = variance.data.totals;
    const utilization =
      budgetTotals.planned > 0
        ? Math.round(((budgetTotals.committed + budgetTotals.actual) / budgetTotals.planned) * 1000) / 10
        : null;
    const prevUtilization =
      prevBudgetActual !== null && budgetTotals.planned > 0
        ? Math.round(((budgetTotals.committed + prevBudgetActual) / budgetTotals.planned) * 1000) / 10
        : null;

    return {
      success: true,
      data: {
        window: {
          key: window.current.key,
          label: window.current.label,
          start: window.current.start,
          end: window.current.end,
          previous: {
            key: window.previous.key,
            label: window.previous.label,
            start: window.previous.start,
            end: window.previous.end,
          },
        },

        reimbursements: {
          pendingCount: claimsData.pendingCount,
          pendingAmount: claimsData.pendingAmount,
          olderThan7Days: claimsData.olderThan7Days,
          paidCount: paid.count,
          paidAmount: paid.amount,
          prevPaidAmount: prevPaid.amount,
          paidDelta: windowDelta(paid.amount, prevPaid.amount),
          byStatus,
          byCategory,
        },

        travel: {
          pending: travelStats.data.pending,
          onTripToday: travelStats.data.onTripToday,
          upcoming30Days: travelStats.data.upcoming30Days,
          perDiemPaidAmount: perDiem.amount,
          prevPerDiemPaidAmount: prevPerDiem.amount,
          perDiemDelta: windowDelta(perDiem.amount, prevPerDiem.amount),
        },

        loans: {
          outstanding: portfolioTotals.outstanding,
          principal: portfolioTotals.principal,
          accounts: portfolioTotals.count,
          // `null` when the ledger has nothing at or before the baseline date:
          // an unknown baseline draws no badge rather than a fabricated one.
          outstandingAsOfPrev,
          outstandingDelta: windowDelta(portfolioTotals.outstanding, outstandingAsOfPrev),
          byStatus: portfolio.data,
          overdue: {
            count: overdue.totals.count,
            amount: overdue.totals.amount,
            buckets: overdue.buckets,
            // The rows the attention strip names. The report itself is capped at
            // 500; the strip needs a handful.
            top: overdue.data.slice(0, 8).map((r: any) => ({
              loanId: r.loanId,
              referenceNo: r.referenceNo,
              employeeName: r.employeeName,
              overdueDays: r.overdueDays,
              amountDue: r.amountDue,
              bucket: r.bucket,
            })),
          },
        },

        budgets: {
          budgets: budgetTotals.budgets,
          overBudget: budgetTotals.overBudget,
          planned: budgetTotals.planned,
          committed: budgetTotals.committed,
          actual: budgetTotals.actual,
          remaining: budgetTotals.remaining,
          utilization,
          prevUtilization,
          utilizationDelta:
            utilization !== null && prevUtilization !== null
              ? {
                  value: Math.round((utilization - prevUtilization) * 10) / 10,
                  direction: utilization >= prevUtilization ? ('up' as const) : ('down' as const),
                  absolute: Math.round((utilization - prevUtilization) * 10) / 10,
                }
              : null,
          rows: variance.data.rows.map((r: any) => ({
            budgetId: r.budgetId,
            name: r.name,
            fiscalYear: r.fiscalYear,
            planned: r.planned,
            committed: r.committed,
            actual: r.actual,
            remaining: r.remaining,
            utilization:
              r.planned > 0 ? Math.round(((r.committed + r.actual) / r.planned) * 1000) / 10 : null,
          })),
        },

        trendKind: 'month',
        trend,
      },
    };
  }

  /**
   * Money that actually left, in a window.
   *
   * `status='PAID'` with `paidAt` set is written by payroll at LOCK
   * (`payrolls.service.ts:3606`) and reversed on unlock, so this is the settled
   * figure rather than an approval. `expenseDate` would answer a different and
   * less useful question — when the employee spent it, not when we repaid them.
   */
  private async paidInWindow(start: Date, end: Date, sourceType?: string) {
    const where = {
      status: 'PAID',
      paidAt: { gte: start, lt: end },
      ...(sourceType ? { sourceType } : {}),
    };
    const [count, sum] = await Promise.all([
      this.prisma.reimbursement.count({ where }),
      this.prisma.reimbursement.aggregate({ where, _sum: { amount: true } }),
    ]);
    return { count, amount: roundMoney(Number(sum._sum.amount ?? 0)) };
  }

  /** Every claim status with its count and its money, zero-filled. */
  private async claimsByStatus() {
    const grouped = await this.prisma.reimbursement.groupBy({
      by: ['status'],
      _count: { _all: true },
      _sum: { amount: true },
    });
    const out: Record<string, { count: number; amount: number }> = {};
    for (const s of REIMBURSEMENT_STATUSES) out[s] = { count: 0, amount: 0 };
    for (const g of grouped) {
      // `status` is a VarChar with no DB constraint, so a value outside the
      // Swagger list is possible and is reported rather than dropped.
      out[g.status] = {
        count: g._count._all,
        amount: roundMoney(Number(g._sum.amount ?? 0)),
      };
    }
    return out;
  }

  /**
   * Settled spend split by expense category.
   *
   * Deliberately NOT a split by department: Payroll owns cost-by-department, and
   * `budget-actuals.service.ts:78-82` subtracts reimbursement out of the payroll
   * figure precisely so the two are not added together by accident.
   */
  private async claimsByCategory(start: Date, end: Date) {
    const rows = await this.prisma.reimbursement.findMany({
      where: { status: 'PAID', paidAt: { gte: start, lt: end } },
      select: { amount: true, budgetCategory: true, sourceType: true, type: true },
    });

    const totals = new Map<string, number>();
    for (const r of rows) {
      const category =
        r.budgetCategory ??
        (r.sourceType === 'TRAVEL'
          ? 'Travel'
          : r.sourceType === 'TRAINING'
            ? 'Training'
            : categoryForType(r.type));
      totals.set(category, (totals.get(category) ?? 0) + Number(r.amount ?? 0));
    }

    return [...totals.entries()]
      .map(([key, amount]) => ({ key, label: key, amount: roundMoney(amount) }))
      .sort((a, b) => b.amount - a.amount);
  }

  /** Twelve months of settled employee expense, split Travel / Training / Other. */
  private async expenseTrend(now: Date) {
    const buckets = buildSeriesBuckets(HUB_TREND_MONTHS, now).map((b) => ({
      ...b,
      total: 0,
      travel: 0,
      training: 0,
      other: 0,
    }));
    if (!buckets.length) return [];

    const rows = await this.prisma.reimbursement.findMany({
      where: {
        status: 'PAID',
        paidAt: { gte: buckets[0].start, lt: buckets[buckets.length - 1].end },
      },
      select: { amount: true, paidAt: true, budgetCategory: true, sourceType: true, type: true },
    });

    const laneOf = (r: (typeof rows)[number]): 'travel' | 'training' | 'other' => {
      if (r.sourceType === 'TRAVEL') return 'travel';
      if (r.sourceType === 'TRAINING') return 'training';
      const category = (r.budgetCategory ?? categoryForType(r.type)).toLowerCase();
      if (category === 'travel') return 'travel';
      if (category === 'training') return 'training';
      return 'other';
    };

    // One pass per lane keeps `tallyByMonth` generic; the row set is the same
    // few thousand either way.
    for (const lane of ['travel', 'training', 'other'] as const) {
      tallyByMonth(
        buckets,
        rows.filter((r) => laneOf(r) === lane).map((r) => ({ date: r.paidAt, amount: Number(r.amount ?? 0) })),
        (bucket, amount) => {
          bucket[lane] += amount;
          bucket.total += amount;
        },
      );
    }

    return buckets.map((b) => ({
      key: b.key,
      label: b.label,
      value: roundMoney(b.total),
      segments: [
        { key: 'travel', value: roundMoney(b.travel) },
        { key: 'training', value: roundMoney(b.training) },
        { key: 'other', value: roundMoney(b.other) },
      ],
    }));
  }

  /**
   * Outstanding principal as it stood at `asOf`, from the ledger.
   *
   * `LoanTransaction.balanceAfter` is the outstanding principal immediately
   * after each event, so the honest reconstruction is "the latest POSTED event
   * on or before that date, per loan" — no re-derivation, no drift against the
   * denormalised columns.
   *
   * Returns `null` when the ledger holds nothing at or before the date. That is
   * not the same as zero: a database with no loan history cannot say what was
   * owed last month, and a KPI must not answer a question it cannot answer.
   */
  private async outstandingAsOf(asOf: Date): Promise<number | null> {
    const rows = await this.prisma.loanTransaction.findMany({
      where: {
        status: 'POSTED',
        transactionDate: { lt: asOf },
        request: { status: { in: LOAN_DEBT_STATUSES as unknown as string[] } },
      },
      select: {
        requestId: true,
        transactionDate: true,
        balanceAfter: true,
        principalComponent: true,
        type: true,
      },
      orderBy: { transactionDate: 'asc' },
    });

    if (!rows.length) return null;

    // Last event wins per loan; ties inside a day fall to the later row in the
    // ordered scan, which is the same order the employee statement prints.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) latest.set(r.requestId, r);

    let total = 0;
    for (const r of latest.values()) {
      if (r.balanceAfter !== null && r.balanceAfter !== undefined) {
        total += Number(r.balanceAfter);
        continue;
      }
      // `balanceAfter` is nullable and older imported rows may not carry it.
      // Fall back to walking the loan's own principal movements.
      total += await this.walkPrincipal(r.requestId, asOf);
    }
    return roundMoney(Math.max(0, total));
  }

  /** Disbursed minus reduced, for one loan, up to a date. */
  private async walkPrincipal(requestId: string, asOf: Date): Promise<number> {
    const rows = await this.prisma.loanTransaction.findMany({
      where: { requestId, status: 'POSTED', transactionDate: { lt: asOf } },
      select: { type: true, principalComponent: true, amount: true },
    });
    let balance = 0;
    for (const r of rows) {
      const principal = Number(r.principalComponent ?? 0) || Number(r.amount ?? 0);
      if (r.type === 'DISBURSEMENT') balance += principal;
      else if ((PRINCIPAL_REDUCING as readonly string[]).includes(r.type)) balance -= principal;
    }
    return Math.max(0, balance);
  }

  /**
   * Cumulative budget actual as at the end of the previous window.
   *
   * Reuses `BudgetActualsService.forWindow` with the budget's own fiscal start
   * and an earlier end, so the baseline is the same calculation as the live
   * figure — a second implementation is how two panels come to disagree about
   * whether a budget is overspent.
   *
   * `null` when there are no budgets to measure, so the utilisation card shows
   * no delta rather than a change from nothing.
   */
  private async budgetActualAsOf(asOf: Date): Promise<number | null> {
    const budgets = await this.prisma.budget.findMany({
      // Same predicate as `varianceSummary` so the two lists cannot diverge.
      // `APPROVED` is not a reachable budget status; it is kept only for parity.
      where: { status: { in: ['ACTIVE', 'APPROVED'] } },
      select: { id: true, branchId: true, startDate: true },
    });
    if (!budgets.length) return null;

    let total = 0;
    for (const b of budgets) {
      if (b.startDate >= asOf) continue;
      const actuals = await this.budgetActuals.forWindow(b.branchId, b.startDate, asOf);
      for (const amount of actuals.values()) total += amount;
    }
    return roundMoney(total);
  }
}
