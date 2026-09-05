import { BudgetsService } from './budgets.service';

/**
 * Variance across every active budget.
 *
 * Deliberately built on the existing per-budget report rather than a second
 * aggregate: two implementations of "committed plus actual against planned" is
 * exactly how two screens come to disagree about whether a budget is
 * overspent. This asserts that it really does delegate, and that the
 * over-budget count uses committed + actual rather than actual alone.
 */
describe('BudgetsService.varianceSummary', () => {
  let budgets: any[];
  let reports: Record<string, any>;

  const prisma: any = {
    budget: { findMany: jest.fn(async () => budgets) },
  };

  let service: BudgetsService;

  beforeEach(() => {
    jest.clearAllMocks();
    budgets = [
      { id: 'b1', name: 'Training 2026', fiscalYear: 2026 },
      { id: 'b2', name: 'Recruitment 2026', fiscalYear: 2026 },
    ];
    reports = {
      b1: { data: { lines: [{ planned: 1000, committed: 200, actual: 300 }] } },
      // Committed pushes this one over even though actual alone does not.
      b2: { data: { lines: [{ planned: 500, committed: 400, actual: 200 }] } },
    };

    service = new BudgetsService(prisma, {} as any, {} as any, {} as any);
    jest
      .spyOn(service, 'varianceReport')
      .mockImplementation(async (id: string) => reports[id]);
  });

  it('adds the per-budget reports up rather than recomputing them', async () => {
    const res: any = await service.varianceSummary(2026);

    expect(service.varianceReport).toHaveBeenCalledTimes(2);
    expect(res.data.totals.planned).toBe(1500);
    expect(res.data.totals.committed).toBe(600);
    expect(res.data.totals.actual).toBe(500);
    expect(res.data.totals.remaining).toBe(400);
  });

  it('counts a budget as over when commitments push it past plan', async () => {
    // b2 has spent 200 of 500 but committed a further 400 — the money is gone
    // in every sense that matters to whoever is about to approve more.
    const res: any = await service.varianceSummary(2026);
    expect(res.data.totals.overBudget).toBe(1);
  });

  it('names each budget in the breakdown', async () => {
    const res: any = await service.varianceSummary(2026);
    expect(res.data.rows.map((r: any) => r.name)).toEqual(['Training 2026', 'Recruitment 2026']);
  });
});
