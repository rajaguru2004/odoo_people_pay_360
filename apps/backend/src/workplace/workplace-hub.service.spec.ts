import { WorkplaceHubService } from './workplace-hub.service';

/**
 * The Workplace hub aggregate.
 *
 * These cases pin what the module can honestly say and what it cannot: custody
 * at a past date is exact because the assignment table is append-only, and
 * letter turnaround is real on the issue side and unmeasurable on the reject
 * side.
 */
describe('WorkplaceHubService', () => {
  const NOW = new Date('2026-08-25T09:00:00.000Z');
  const AUG = new Date('2026-08-01T00:00:00.000Z');
  const SEP = new Date('2026-09-01T00:00:00.000Z');
  const JUL = new Date('2026-07-01T00:00:00.000Z');

  let assignmentRows: any[];
  let letterRows: any[];
  let issuedRows: any[];
  let warrantyCounts: { expired: number; expiring60: number };
  let valueAtRisk: number;

  const between = (rows: any[], field: string, where: any) =>
    rows.filter(
      (r) => r[field] && r[field] >= where[field].gte && r[field] < where[field].lt,
    );

  const prisma: any = {
    assetAssignment: {
      count: jest.fn(async ({ where }: any) => {
        if (where?.OR) {
          const asOf = where.assignedAt.lt;
          return assignmentRows.filter(
            (r) => r.assignedAt < asOf && (!r.returnedAt || r.returnedAt >= asOf),
          ).length;
        }
        if (where?.assignedAt) return between(assignmentRows, 'assignedAt', where).length;
        if (where?.returnedAt) return between(assignmentRows, 'returnedAt', where).length;
        return 0;
      }),
    },
    assetItem: {
      count: jest.fn(async ({ where }: any) =>
        where?.warrantyExpiry?.lt ? warrantyCounts.expired : warrantyCounts.expiring60,
      ),
      aggregate: jest.fn(async () => ({ _sum: { purchaseCost: valueAtRisk } })),
    },
    letterRequest: {
      count: jest.fn(async ({ where }: any) =>
        where?.status === 'ISSUED'
          ? between(issuedRows, 'issuedAt', where).length
          : between(letterRows, 'createdAt', where).length,
      ),
      findMany: jest.fn(async ({ where, select }: any) => {
        if (select?.issuedAt && select?.createdAt) return issuedRows;
        if (where?.status === 'ISSUED') return issuedRows;
        return letterRows;
      }),
      groupBy: jest.fn(async () => [
        { templateKey: 'SALARY_CERTIFICATE', _count: { _all: 6 } },
        { templateKey: 'NOC', _count: { _all: 2 } },
      ]),
    },
  };

  const assets: any = {
    getSummary: jest.fn(async () => ({
      success: true,
      data: {
        byStatus: { AVAILABLE: 19, ASSIGNED: 8, IN_REPAIR: 4, RETIRED: 1 },
        total: 32,
        held: 8,
        unacknowledged: 3,
      },
    })),
  };
  const clearance: any = {
    getOutstandingForInactive: jest.fn(async () => ({
      success: true,
      data: [
        {
          id: 'aa1',
          assignedAt: new Date('2026-02-01T00:00:00Z'),
          asset: { assetTag: 'LAP-004', name: 'ThinkPad' },
          employee: { fullName: 'Rahul', status: 'TERMINATED' },
        },
      ],
    })),
  };
  const letters: any = {
    stats: jest.fn(async () => ({
      success: true,
      data: {
        pending: 3,
        byStatus: { PENDING: 3, ISSUED: 4, REJECTED: 1 },
        issuedThisMonth: 4,
        oldestPendingAt: new Date('2026-08-02T00:00:00Z'),
      },
    })),
  };

  let service: WorkplaceHubService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(NOW);

    assignmentRows = [
      // Out before August and still out.
      { assignedAt: new Date('2026-05-02T00:00:00Z'), returnedAt: null },
      // Out before August, returned during it — held at the baseline, not now.
      { assignedAt: new Date('2026-06-11T00:00:00Z'), returnedAt: new Date('2026-08-09T00:00:00Z') },
      // Issued this month: not held at the baseline.
      { assignedAt: new Date('2026-08-13T00:00:00Z'), returnedAt: null },
    ];
    letterRows = [
      { createdAt: new Date('2026-08-04T00:00:00Z') },
      { createdAt: new Date('2026-08-18T00:00:00Z') },
      { createdAt: new Date('2026-07-15T00:00:00Z') },
    ];
    issuedRows = [
      { createdAt: new Date('2026-08-01T00:00:00Z'), issuedAt: new Date('2026-08-05T00:00:00Z') },
      { createdAt: new Date('2026-07-10T00:00:00Z'), issuedAt: new Date('2026-07-12T00:00:00Z') },
    ];
    warrantyCounts = { expired: 2, expiring60: 5 };
    valueAtRisk = 4200;

    service = new WorkplaceHubService(prisma, assets, clearance, letters);
  });

  afterEach(() => jest.useRealTimers());

  it('counts custody at a past date exactly, from the append-only assignment log', async () => {
    const { data } = await service.getHubSummary();
    // At 1 Aug: the May and June assignments were out. The August one was not.
    expect(data.assets.heldAsOfPrev).toBe(2);
    expect(prisma.assetAssignment.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assignedAt: { lt: AUG },
          OR: [{ returnedAt: null }, { returnedAt: { gte: AUG } }],
        }),
      }),
    );
  });

  it('zero-fills every asset status, including the one with no rows', async () => {
    const { data } = await service.getHubSummary();
    // LOST has no rows on any seeded database today. A missing key would make
    // the breakdown silently four-valued.
    expect(data.assets.byStatus.LOST).toBe(0);
    expect(data.assets.byStatus.IN_REPAIR).toBe(4);
  });

  it('builds the attention composite from the three signals that are real', async () => {
    const { data } = await service.getHubSummary();
    // IN_REPAIR 4 + LOST 0 + warranty expired 2. Not "overdue for return",
    // which no column supports.
    expect(data.assets.needingAttention).toBe(6);
    expect(data.assets.valueAtRisk).toBe(4200);
  });

  it('measures the letter desk on issuedAt, not on updatedAt', async () => {
    const { data } = await service.getHubSummary();
    expect(data.letters.issuedInWindow).toBe(1);
    expect(data.letters.prevIssuedInWindow).toBe(1);
    expect(prisma.letterRequest.count).toHaveBeenCalledWith({
      where: { status: 'ISSUED', issuedAt: { gte: AUG, lt: SEP } },
    });
    expect(prisma.letterRequest.count).toHaveBeenCalledWith({
      where: { status: 'ISSUED', issuedAt: { gte: JUL, lt: AUG } },
    });
  });

  it('reports issue turnaround and declares the reject side unmeasurable', async () => {
    const { data } = await service.getHubSummary();
    expect(data.letters.avgIssueTurnaroundDays).toBe(3); // (4 + 2) / 2
    // `LetterRequest` has no `rejectedAt`; the panel has to be able to say so.
    expect(data.letters.rejectTurnaroundMeasurable).toBe(false);
  });

  it('returns null turnaround, not zero, when nothing has ever been issued', async () => {
    issuedRows = [];
    const { data } = await service.getHubSummary();
    // Zero days would read as instant service.
    expect(data.letters.avgIssueTurnaroundDays).toBeNull();
  });

  it('never lets the letter backlog segment go negative', async () => {
    // More issued than requested in a month is normal — a February request
    // issued in March.
    letterRows = [];
    const { data } = await service.getHubSummary();
    const aug = data.trend.find((b: any) => b.key === '2026-08')!;
    expect(aug.segments.find((s: any) => s.key === 'outstanding')!.value).toBe(0);
  });

  it('surfaces the clearance worklist with names, not just a count', async () => {
    const { data } = await service.getHubSummary();
    expect(data.clearances.outstandingCount).toBe(1);
    expect(data.clearances.top[0]).toMatchObject({
      assetTag: 'LAP-004',
      employeeName: 'Rahul',
      employeeStatus: 'TERMINATED',
    });
  });
});
