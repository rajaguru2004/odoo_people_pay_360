import { FinanceHubService } from './finance-hub.service';

/**
 * The Finance hub aggregate.
 *
 * These cases pin the four things that made the rebuild worth doing: the loan
 * arrears read from the server's own buckets instead of being re-derived from
 * field names the server does not send, a settled-money figure that keys off
 * `paidAt` rather than an approval, an unknown baseline that draws no delta
 * instead of a fabricated one, and a utilisation that stays `null` when there
 * is nothing to divide by.
 */
describe('FinanceHubService', () => {
  // 2026-08-25 → current window Aug 2026, previous window Jul 2026.
  const NOW = new Date('2026-08-25T09:00:00.000Z');

  let paidRows: any[];
  let trendRows: any[];
  let statusRows: any[];
  let loanTxnRows: any[];
  let budgetRows: any[];

  const prisma: any = {
    reimbursement: {
      count: jest.fn(async ({ where }: any) => rowsFor(where).length),
      aggregate: jest.fn(async ({ where }: any) => ({
        _sum: { amount: rowsFor(where).reduce((a: number, r: any) => a + r.amount, 0) },
      })),
      groupBy: jest.fn(async () => statusRows),
      findMany: jest.fn(async ({ where }: any) =>
        // The trend read spans twelve months; the category read is one month.
        where?.paidAt?.gte && where.paidAt.gte < new Date('2026-08-01T00:00:00.000Z')
          ? trendRows
          : rowsFor(where),
      ),
    },
    loanTransaction: { findMany: jest.fn(async () => loanTxnRows) },
    budget: { findMany: jest.fn(async () => budgetRows) },
  };

  /** Rows whose `paidAt` falls in the queried window, and whose sourceType matches. */
  function rowsFor(where: any) {
    if (!where?.paidAt) return [];
    return paidRows.filter(
      (r) =>
        r.paidAt >= where.paidAt.gte &&
        r.paidAt < where.paidAt.lt &&
        (!where.sourceType || r.sourceType === where.sourceType),
    );
  }

  const reimbursements: any = {
    stats: jest.fn(async () => ({
      success: true,
      data: {
        pendingCount: 4,
        pendingAmount: 1250,
        olderThan7Days: 2,
        approvedThisMonth: 3,
        approvedAmountThisMonth: 900,
      },
    })),
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
  const loanReports: any = {
    portfolio: jest.fn(async () => ({
      success: true,
      data: [{ status: 'ACTIVE', type: 'LOAN', count: 3, principal: 9000, outstanding: 6000, isDebt: true }],
      totals: { count: 3, principal: 9000, outstanding: 6000 },
    })),
    overdue: jest.fn(async () => ({
      success: true,
      data: [
        { loanId: 'l1', referenceNo: 'LN-1', employeeName: 'Asha', overdueDays: 12, amountDue: 250, bucket: '1-30' },
        { loanId: 'l2', referenceNo: 'LN-2', employeeName: 'Bilal', overdueDays: 95, amountDue: 400, bucket: '90+' },
      ],
      buckets: {
        '1-30': { count: 1, amount: 250 },
        '31-60': { count: 0, amount: 0 },
        '61-90': { count: 0, amount: 0 },
        '90+': { count: 1, amount: 400 },
      },
      totals: { count: 2, amount: 650 },
    })),
  };

  let service: FinanceHubService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(NOW);

    paidRows = [
      { amount: 500, paidAt: new Date('2026-08-04T00:00:00Z'), sourceType: 'TRAVEL', budgetCategory: 'Travel', type: 'Travel' },
      { amount: 300, paidAt: new Date('2026-08-19T00:00:00Z'), sourceType: null, budgetCategory: 'Medical', type: 'Medical' },
      { amount: 200, paidAt: new Date('2026-07-11T00:00:00Z'), sourceType: 'TRAVEL', budgetCategory: 'Travel', type: 'Travel' },
    ];
    trendRows = paidRows;
    statusRows = [
      { status: 'PENDING', _count: { _all: 4 }, _sum: { amount: 1250 } },
      { status: 'PAID', _count: { _all: 9 }, _sum: { amount: 4400 } },
    ];
    loanTxnRows = [
      { requestId: 'l1', transactionDate: new Date('2026-07-05T00:00:00Z'), balanceAfter: 4000, principalComponent: 0, type: 'EMI_RECOVERY' },
      { requestId: 'l2', transactionDate: new Date('2026-07-20T00:00:00Z'), balanceAfter: 2500, principalComponent: 0, type: 'EMI_RECOVERY' },
    ];
    budgetRows = [{ id: 'b1', branchId: 'br1', startDate: new Date('2026-01-01T00:00:00Z') }];

    service = new FinanceHubService(prisma, reimbursements, travel, budgets, budgetActuals, loanReports);
  });

  afterEach(() => jest.useRealTimers());

  it('reports the window it measured, and the one it compares against', async () => {
    const { data } = await service.getHubSummary();
    expect(data.window.key).toBe('2026-08');
    expect(data.window.label).toBe('Aug 2026');
    expect(data.window.previous.key).toBe('2026-07');
  });

  it('sums settled money on paidAt, not on approval', async () => {
    const { data } = await service.getHubSummary();
    // 500 + 300 in August. The July row is the previous window's.
    expect(data.reimbursements.paidAmount).toBe(800);
    expect(data.reimbursements.paidCount).toBe(2);
    expect(data.reimbursements.prevPaidAmount).toBe(200);
    expect(data.reimbursements.paidDelta).toMatchObject({ direction: 'up', absolute: 600 });
  });

  it('reports travel as per diem only, from the claims travel actually raises', async () => {
    const { data } = await service.getHubSummary();
    // Only the TRAVEL-sourced August row. `estimatedCost` never enters this.
    expect(data.travel.perDiemPaidAmount).toBe(500);
    expect(data.travel.prevPerDiemPaidAmount).toBe(200);
  });

  it('zero-fills every claim status so a missing status is not a missing row', async () => {
    const { data } = await service.getHubSummary();
    expect(data.reimbursements.byStatus.REJECTED).toEqual({ count: 0, amount: 0 });
    expect(data.reimbursements.byStatus.PAID).toEqual({ count: 9, amount: 4400 });
  });

  it('passes the arrears buckets through instead of re-deriving them', async () => {
    const { data } = await service.getHubSummary();
    // The defect this replaces read `overdueAmount`/`daysOverdue`, which the
    // server never sends, so every row landed in 1-30 at amount 0.
    expect(data.loans.overdue.amount).toBe(650);
    expect(data.loans.overdue.buckets['90+']).toEqual({ count: 1, amount: 400 });
    expect(data.loans.overdue.top[1]).toMatchObject({ overdueDays: 95, amountDue: 400 });
  });

  it('reconstructs last month\'s loan book from the ledger balance', async () => {
    const { data } = await service.getHubSummary();
    expect(data.loans.outstandingAsOfPrev).toBe(6500);
    expect(data.loans.outstandingDelta).toMatchObject({ direction: 'down', absolute: -500 });
  });

  it('draws no loan delta when the ledger has no history to compare against', async () => {
    loanTxnRows = [];
    const { data } = await service.getHubSummary();
    // Not 0 — a database with no ledger cannot say what was owed last month.
    expect(data.loans.outstandingAsOfPrev).toBeNull();
    expect(data.loans.outstandingDelta).toBeNull();
  });

  it('computes utilisation from committed plus actual, and null when nothing is planned', async () => {
    const { data } = await service.getHubSummary();
    expect(data.budgets.utilization).toBe(50); // (200 + 300) / 1000
    // The second budget plans nothing; a rate off zero is not a rate.
    expect(data.budgets.rows[1].utilization).toBeNull();
  });

  it('splits the twelve-month trend by lane and totals each bucket', async () => {
    const { data } = await service.getHubSummary();
    expect(data.trend).toHaveLength(12);
    const aug = data.trend.find((b: any) => b.key === '2026-08')!;
    expect(aug.value).toBe(800);
    expect(aug.segments).toEqual([
      { key: 'travel', value: 500 },
      { key: 'training', value: 0 },
      { key: 'other', value: 300 },
    ]);
  });

  it('never re-implements a figure a feature service already owns', async () => {
    await service.getHubSummary();
    expect(reimbursements.stats).toHaveBeenCalled();
    expect(travel.stats).toHaveBeenCalled();
    expect(budgets.varianceSummary).toHaveBeenCalled();
    expect(loanReports.portfolio).toHaveBeenCalled();
    expect(loanReports.overdue).toHaveBeenCalled();
  });
});
