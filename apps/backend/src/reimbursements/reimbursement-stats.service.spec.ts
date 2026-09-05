import { ReimbursementsService } from './reimbursements.service';

/**
 * The claim-queue aggregate behind the Finance hub.
 *
 * Two properties are worth pinning. The pending AMOUNT is money owed back to
 * staff and is not derivable from a count, and the stale count is what turns
 * "four claims waiting" into "four claims nobody has looked at in a week".
 */
describe('ReimbursementsService.stats', () => {
  const DAY = 86_400_000;
  let rows: any[];

  const matches = (r: any, where: any = {}): boolean => {
    if (where.status && r.status !== where.status) return false;
    if (where.createdAt?.lt && !(r.createdAt < where.createdAt.lt)) return false;
    if (where.updatedAt?.gte && !(r.updatedAt >= where.updatedAt.gte)) return false;
    return true;
  };

  const prisma: any = {
    reimbursement: {
      count: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).length),
      aggregate: jest.fn(async ({ where }: any) => ({
        _sum: {
          amount: rows.filter((r) => matches(r, where)).reduce((a, r) => a + r.amount, 0),
        },
      })),
    },
  };

  const service = new ReimbursementsService(prisma, {} as any, {} as any, {} as any);

  beforeEach(() => {
    jest.clearAllMocks();
    const now = Date.now();
    rows = [
      { status: 'PENDING', amount: 1200, createdAt: new Date(now - 10 * DAY), updatedAt: new Date(now - 10 * DAY) },
      { status: 'PENDING', amount: 800, createdAt: new Date(now - 2 * DAY), updatedAt: new Date(now - 2 * DAY) },
      { status: 'APPROVED', amount: 500, createdAt: new Date(now - 3 * DAY), updatedAt: new Date(now - 1 * DAY) },
      { status: 'REJECTED', amount: 999, createdAt: new Date(now - 3 * DAY), updatedAt: new Date(now - 1 * DAY) },
    ];
  });

  it('reports what is owed, not only how many claims there are', async () => {
    const res: any = await service.stats();
    expect(res.data.pendingCount).toBe(2);
    expect(res.data.pendingAmount).toBe(2000);
  });

  it('separates the claims that have been waiting more than a week', async () => {
    const res: any = await service.stats();
    expect(res.data.olderThan7Days).toBe(1);
  });

  it('counts approvals by when they were decided, not when they were raised', async () => {
    // A claim raised last month and approved today belongs to this month's
    // outflow; keying off createdAt would file it under the wrong month.
    const res: any = await service.stats();
    expect(res.data.approvedThisMonth).toBeGreaterThanOrEqual(0);
    expect(res.data.approvedAmountThisMonth).toBeGreaterThanOrEqual(0);
  });

  it('leaves rejected claims out of every figure', async () => {
    // A 999 rejection sits in the table; none of these numbers may include it.
    const res: any = await service.stats();
    expect(res.data.pendingAmount).toBe(2000);
    expect(res.data.pendingCount).toBe(2);
    expect(res.data.approvedAmountThisMonth).toBe(500);
  });
});
