import { FinanceHubService } from './finance-hub.service';

/**
 * The Finance hub aggregate.
 *
 * These cases pin what made the rebuild worth doing: the window the payload
 * measured is reported alongside the one it compares against, a utilisation
 * that stays `null` when there is nothing to divide by, and figures a feature
 * service already owns being called rather than re-implemented.
 */
describe('FinanceHubService', () => {
  // 2026-08-25 → current window Aug 2026, previous window Jul 2026.
  const NOW = new Date('2026-08-25T09:00:00.000Z');

  let budgetRows: any[];

  const prisma: any = {
    budget: { findMany: jest.fn(async () => budgetRows) },
  };

  const travel: any = {
    stats: jest.fn(async () => ({
      success: true,
      data: { pending: 1, onTripToday: 2, upcoming30Days: 5 },
    })),
  };
  const budgets: any = {
    varianceSummary: jest.fn(async () => ({
      success: true,
      data: {
        rows: [
          { budgetId: 'b1', name: 'FY26 HR', fiscalYear: 2026, planned: 1000, committed: 200, actual: 300, remaining: 500 },
          { budgetId: 'b2', name: 'FY26 Ops', fiscalYear: 2026, planned: 0, committed: 0, actual: 0, remaining: 0 },
        ],
        totals: { budgets: 2, overBudget: 1, planned: 1000, committed: 200, actual: 300, remaining: 500 },
      },
    })),
  };
  const budgetActuals: any = {
    forWindow: jest.fn(async () => new Map([['COMPANY::Travel', 120]])),
  };

  let service: FinanceHubService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(NOW);

    budgetRows = [{ id: 'b1', branchId: 'br1', startDate: new Date('2026-01-01T00:00:00Z') }];

    service = new FinanceHubService(prisma, travel, budgets, budgetActuals);
  });

  afterEach(() => jest.useRealTimers());

  it('reports the window it measured, and the one it compares against', async () => {
    const { data } = await service.getHubSummary();
    expect(data.window.key).toBe('2026-08');
    expect(data.window.label).toBe('Aug 2026');
    expect(data.window.previous.key).toBe('2026-07');
  });

  it('passes the travel queue through as the feature service reports it', async () => {
    const { data } = await service.getHubSummary();
    expect(data.travel).toEqual({ pending: 1, onTripToday: 2, upcoming30Days: 5 });
  });

  it('computes utilisation from committed plus actual, and null when nothing is planned', async () => {
    const { data } = await service.getHubSummary();
    expect(data.budgets.utilization).toBe(50); // (200 + 300) / 1000
    // The second budget plans nothing; a rate off zero is not a rate.
    expect(data.budgets.rows[1].utilization).toBeNull();
  });

  it('draws no utilisation delta when there is no budget to baseline against', async () => {
    budgetRows = [];
    const { data } = await service.getHubSummary();
    // Not 0 — a database with no budgets cannot say what was spent last month.
    expect(data.budgets.prevUtilization).toBeNull();
    expect(data.budgets.utilizationDelta).toBeNull();
  });

  it('never re-implements a figure a feature service already owns', async () => {
    await service.getHubSummary();
    expect(travel.stats).toHaveBeenCalled();
    expect(budgets.varianceSummary).toHaveBeenCalled();
  });
});
