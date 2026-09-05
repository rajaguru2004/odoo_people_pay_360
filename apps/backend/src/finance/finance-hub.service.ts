import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TravelService } from '../travel/travel.service';
import { BudgetsService } from '../budgets/budgets.service';
import { BudgetActualsService } from '../budgets/budget-actuals.service';
import { roundMoney } from '../common/utils/money.util';
import { resolveMonthWindow } from '../common/utils/hub-window.util';

/**
 * One aggregate behind `/dashboard/finance`.
 *
 * The hub used to make parallel calls from the browser and re-derive its figures
 * client-side. One server-side answer removes both the fan-out and the chance of
 * a second, divergent derivation.
 *
 * Everything that already has a correct implementation is CALLED, not rewritten:
 * `TravelService.stats`, `BudgetsService.varianceSummary`. What is new here is
 * the previous-window baseline for budget utilisation, which exists nowhere else
 * in the module.
 *
 * Branch scoping is inherited: every model read here is in `branch-scope.map.ts`
 * and `groupBy`/`count`/`aggregate`/`findMany` are all in `BRANCH_READ_ACTIONS`.
 * Nothing uses `$queryRaw`, which would silently bypass it.
 */

@Injectable()
export class FinanceHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly travel: TravelService,
    private readonly budgets: BudgetsService,
    private readonly budgetActuals: BudgetActualsService,
  ) {}

  async getHubSummary() {
    const now = new Date();
    const window = resolveMonthWindow(now);

    const [travelStats, variance] = await Promise.all([
      this.travel.stats(),
      this.budgets.varianceSummary(),
    ]);

    const prevBudgetActual = await this.budgetActualAsOf(window.previous.end);

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

        travel: {
          pending: travelStats.data.pending,
          onTripToday: travelStats.data.onTripToday,
          upcoming30Days: travelStats.data.upcoming30Days,
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
      },
    };
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
