import { BadRequestException } from '@nestjs/common';
import { PeopleHubService } from './people-hub.service';

/**
 * The People hub aggregate.
 *
 * The hub owns the employee LIFECYCLE — deadlines and movements. The hardest
 * part is the status split: the brief asks for Active / Probation / Notice /
 * Inactive, and only two of those are stored. `Employee.status` is a free-text
 * column holding ACTIVE or INACTIVE; probation is an active contract of that
 * type, and notice is an open termination request. These cases pin the
 * derivations, and above all that the four buckets stay mutually exclusive —
 * a donut whose slices double-count somebody is worse than no donut.
 */
describe('PeopleHubService', () => {
  let statusRows: any[];
  let openTerminations: any[];
  let probationContracts: any[];
  let joinRows: any[];
  let leaveRows: any[];
  let activeIn: (ids: string[]) => number;

  const prisma: any = {
    employee: {
      groupBy: jest.fn(async () => statusRows),
      count: jest.fn(async ({ where }: any) => {
        if (where?.id?.in) return activeIn(where.id.in as string[]);
        if (where?.startDate) return 3; // previous-month joiners
        if (where?.endDate) return 1; // previous-month leavers
        return 0;
      }),
      findMany: jest.fn(async ({ select }: any) =>
        select?.startDate ? joinRows : leaveRows,
      ),
    },
    terminationRequest: {
      findMany: jest.fn(async () => openTerminations),
      count: jest.fn(async () => 2),
    },
    contract: { findMany: jest.fn(async () => probationContracts) },
  };

  const employees: any = {
    lifecycleStats: jest.fn(async () => ({
      success: true,
      data: {
        activeHeadcount: 40,
        joinersThisMonth: 4,
        leaversThisMonth: 2,
        netChangeThisMonth: 2,
        startingSoon: [{ id: 'n1', fullName: 'Priya Menon' }],
        probationEndingSoon: [{ contractId: 'c1', fullName: 'Tara Shah' }],
      },
    })),
  };

  const contracts: any = {
    getStatistics: jest.fn(async () => ({
      success: true,
      data: { total: 40, active: 36, expired: 2, expiringSoon: 5 },
    })),
    getExpiringContracts: jest.fn(async () => ({
      success: true,
      data: [
        {
          contract: {
            id: 'c9',
            endDate: new Date(Date.UTC(2026, 8, 4)),
            employee: { id: 'e9', fullName: 'Omar Said' },
          },
          daysUntilExpiry: 10,
        },
      ],
    })),
  };

  const service = new PeopleHubService(prisma, employees, contracts);
  const NOW = new Date(Date.UTC(2026, 7, 25)); // 2026-08-25

  beforeEach(() => {
    jest.clearAllMocks();
    statusRows = [
      { status: 'ACTIVE', _count: { _all: 40 } },
      { status: 'INACTIVE', _count: { _all: 4 } },
    ];
    openTerminations = [
      { status: 'PENDING_APPROVAL', contract: { employeeId: 'e1' } },
      { status: 'APPROVED', contract: { employeeId: 'e2' } },
    ];
    probationContracts = [{ employeeId: 'e3' }, { employeeId: 'e4' }, { employeeId: 'e5' }];
    joinRows = [];
    leaveRows = [];
    activeIn = (ids) => ids.length; // every derived id is an active employee
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => jest.useRealTimers());

  describe('the trend window', () => {
    it('refuses a window it does not offer', async () => {
      await expect(service.getSummary('24')).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.getSummary('nope')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('defaults to six months and honours twelve', async () => {
      expect((await service.getSummary()).trend.buckets).toHaveLength(6);
      expect((await service.getSummary('12')).trend.buckets).toHaveLength(12);
    });
  });

  describe('the status split', () => {
    it('sums to the whole workforce', async () => {
      const res = await service.getSummary();
      const total = res.statusSplit.reduce((a, s) => a + s.count, 0);
      expect(total).toBe(res.headcount.active + res.headcount.inactive);
    });

    it('derives probation from an active contract of that type', async () => {
      const res = await service.getSummary();
      expect(res.statusSplit.find((s) => s.key === 'probation')!.count).toBe(3);
    });

    it('derives notice from an open termination request', async () => {
      // Awaiting a decision, or approved with a leaving date still ahead.
      const res = await service.getSummary();
      expect(res.statusSplit.find((s) => s.key === 'notice')!.count).toBe(2);
    });

    it('counts somebody who is on probation AND leaving as leaving, once', async () => {
      // Notice is applied first because it is the fact that changes what HR
      // does next. Counted in both buckets, the donut would exceed the
      // headcount and the reader would see a workforce that does not exist.
      probationContracts = [{ employeeId: 'e1' }, { employeeId: 'e3' }];
      const res = await service.getSummary();
      expect(res.statusSplit.find((s) => s.key === 'notice')!.count).toBe(2);
      expect(res.statusSplit.find((s) => s.key === 'probation')!.count).toBe(1);
      expect(res.statusSplit.reduce((a, s) => a + s.count, 0)).toBe(44);
    });

    it('never draws a negative slice when a contract outlives its employee record', async () => {
      statusRows = [{ status: 'ACTIVE', _count: { _all: 1 } }];
      probationContracts = Array.from({ length: 8 }, (_, i) => ({ employeeId: `p${i}` }));
      const res = await service.getSummary();
      for (const s of res.statusSplit) expect(s.count).toBeGreaterThanOrEqual(0);
    });

    it('reports the raw status rows as they come, since status is free text', async () => {
      statusRows.push({ status: 'SUSPENDED', _count: { _all: 2 } });
      const res = await service.getSummary();
      expect(res.headcount.byStatus).toContainEqual({ status: 'SUSPENDED', count: 2 });
      // Anything that is not ACTIVE counts against the workforce as inactive.
      expect(res.headcount.inactive).toBe(6);
    });
  });

  describe('movement', () => {
    it('carries the previous month so a delta names a window somebody can check', async () => {
      const res = await service.getSummary();
      expect(res.lifecycle.joinersThisMonth).toBe(4);
      expect(res.lifecycle.previousMonth).toEqual({ joiners: 3, leavers: 1 });
    });

    it('reports turnover against the headcount the window opened with', async () => {
      leaveRows = [
        { endDate: new Date(Date.UTC(2026, 6, 4)) },
        { endDate: new Date(Date.UTC(2026, 6, 9)) },
      ];
      const res = await service.getSummary();
      // 40 now, two left and nobody joined, so the window opened at 42.
      expect(res.trend.turnoverRate).toBeCloseTo(4.8, 1);
    });

    it('answers "unknown" for turnover from an empty company', async () => {
      statusRows = [];
      const res = await service.getSummary();
      expect(res.trend.turnoverRate).toBeNull();
    });

    it('ends the trend on the headcount the card above it prints', async () => {
      joinRows = [{ startDate: new Date(Date.UTC(2026, 7, 3)) }];
      const res = await service.getSummary();
      const last = res.trend.buckets[res.trend.buckets.length - 1];
      expect(last.headcountEnd).toBe(res.headcount.active);
    });
  });

  describe('deadlines', () => {
    it('flattens the expiry feed to the name and the countdown it prints', async () => {
      const res = await service.getSummary();
      expect(res.contracts.expiring).toEqual([
        {
          id: 'c9',
          employeeId: 'e9',
          fullName: 'Omar Said',
          endDate: new Date(Date.UTC(2026, 8, 4)),
          daysUntilExpiry: 10,
        },
      ]);
    });

    it('separates terminations awaiting a decision from those already dated', async () => {
      const res = await service.getSummary();
      expect(res.terminations.awaitingApproval).toBe(1);
      expect(res.terminations.thisMonth).toBe(2);
    });

    it('reuses the contract statistics rather than recounting them', async () => {
      const res = await service.getSummary();
      expect(contracts.getStatistics).toHaveBeenCalled();
      expect(res.contracts.expiringSoon).toBe(5);
    });
  });

  it('asks the permit module for nothing', async () => {
    // /legal-documents/* answers 403 for some roles. The People hub quietens two
    // permit cards and keeps the rest of the page alive; folding permits into
    // this payload would let one module's 403 blank the whole dashboard.
    await service.getSummary();
    const touched = JSON.stringify(Object.keys(prisma));
    expect(touched).not.toContain('employeeLegalDocument');
  });
});
