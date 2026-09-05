import { BadRequestException } from '@nestjs/common';
import { OrganizationHubService } from './organization-hub.service';

/**
 * The Organization hub aggregate.
 *
 * The page it feeds used to fan out to six list endpoints and count rows, which
 * under-reported every queue longer than a page. These cases pin the three
 * things that made the rebuild worth doing: counts that come from the database
 * rather than from a page of results, an unknown rate that stays unknown
 * instead of printing 0%, and a trend whose last bucket reconciles with the
 * headcount card printed above it.
 */

// The branch middleware is what scopes these queries in production; the mock
// answers as an unscoped (global) caller, which is the shape the assertions are
// written against.
jest.mock('../common/branch/branch-scope.util', () => ({
  // Both helpers, because the service asks two different questions: the
  // SELECTED branch for the panels that have to agree with the headcount, and
  // the caller's whole envelope for the change-request queue.
  getScopedBranchIds: () => null,
  getEnvelopeBranchIds: () => null,
}));
jest.mock('../common/branch/branch-context', () => ({
  runWithBranchBypass: (fn: () => any) => fn(),
}));

describe('OrganizationHubService', () => {
  let departments: any[];
  let branches: any[];
  let changeRequestRows: any[];
  let activeCount: number;
  let joinRows: any[];
  let leaveRows: any[];
  let noBranchCount: number;

  const prisma: any = {
    employee: {
      count: jest.fn(async ({ where }: any) => {
        if (where?.branchId === null) return noBranchCount;
        if (where?.status === 'ACTIVE') return activeCount;
        return 2; // inactive
      }),
      groupBy: jest.fn(async () => [
        { supervisorId: 's1', _count: { _all: 14 } },
        { supervisorId: 's2', _count: { _all: 4 } },
      ]),
      findMany: jest.fn(async ({ select }: any) =>
        select?.startDate ? joinRows : leaveRows,
      ),
    },
    department: { findMany: jest.fn(async () => departments) },
    branch: { findMany: jest.fn(async () => branches) },
    departmentChangeRequest: { groupBy: jest.fn(async () => changeRequestRows) },
  };

  const departmentsService: any = {
    departmentBranchFilters: () => ({ empWhere: undefined, deptScope: {}, empCount: true }),
    structureStats: jest.fn(async () => ({
      success: true,
      data: {
        spanOfControl: [
          { supervisorId: 's1', name: 'Asha Rahman', department: 'Engineering', reports: 14 },
          { supervisorId: 's2', name: 'Karim Idris', department: null, reports: 4 },
        ],
      },
    })),
  };

  const service = new OrganizationHubService(prisma, departmentsService);
  // Fixed so the month buckets are deterministic — Date.now() in a spec makes a
  // trend assertion fail once a month for reasons nobody can reproduce.
  const NOW = new Date(Date.UTC(2026, 7, 25)); // 2026-08-25

  beforeEach(() => {
    jest.clearAllMocks();
    activeCount = 30;
    noBranchCount = 4;
    departments = [
      { id: 'd1', name: 'Engineering', managerId: 'e-lead', _count: { employees: 15 } },
      { id: 'd2', name: 'Operations', managerId: null, _count: { employees: 9 } },
      { id: 'd3', name: 'Facilities', managerId: null, _count: { employees: 6 } },
    ];
    branches = [
      { id: 'b1', name: 'Muscat', managerId: 'm1', _count: { employees: 18 } },
      { id: 'b2', name: 'Bengaluru', managerId: null, _count: { employees: 12 } },
    ];
    changeRequestRows = [
      { status: 'PENDING', _count: { _all: 5 } },
      { status: 'APPROVED', _count: { _all: 8 } },
      { status: 'REJECTED', _count: { _all: 2 } },
    ];
    joinRows = [];
    leaveRows = [];
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => jest.useRealTimers());

  describe('the trend window', () => {
    it('refuses a window it does not offer rather than quietly defaulting', async () => {
      // Phase E's `anchor=2026-13-45` lesson: a silent fallback answers for a
      // period nobody asked about, and the reader cannot see it happen.
      await expect(service.getSummary('13')).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.getSummary('abc')).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.getSummary('6.5')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('defaults to six months when nothing is asked for', async () => {
      const res = await service.getSummary();
      expect(res.months).toBe(6);
      expect(res.growth.buckets).toHaveLength(6);
    });

    it('honours a twelve-month window', async () => {
      const res = await service.getSummary('12');
      expect(res.growth.buckets).toHaveLength(12);
      expect(res.growth.buckets[11].key).toBe('2026-08');
    });
  });

  describe('the shares', () => {
    it('never claims more than the whole workforce', async () => {
      const res = await service.getSummary();
      for (const row of [...res.departments.rows, ...res.branches.rows]) {
        expect(row.share).not.toBeNull();
        expect(row.share!).toBeLessThanOrEqual(100);
      }
    });

    it('adds up to the workforce it divided by', async () => {
      const res = await service.getSummary();
      const total = res.branches.rows.reduce((a, r) => a + r.employees, 0);
      expect(total).toBe(res.headcount.active);
    });

    it('answers "unknown" rather than 0% when there is nobody to divide by', async () => {
      // An empty branch and an empty company are different claims, and a hub
      // that prints 0.0% for both has told the reader something false about one.
      activeCount = 0;
      const res = await service.getSummary();
      expect(res.departments.rows[0].share).toBeNull();
    });

    it('ranks the biggest unit first, not alphabetically', async () => {
      const res = await service.getSummary();
      expect(res.departments.rows.map((r) => r.name)).toEqual([
        'Engineering',
        'Operations',
        'Facilities',
      ]);
    });
  });

  describe('governance', () => {
    it('names the departments nobody is heading, with what that costs', async () => {
      const res = await service.getSummary();
      expect(res.departments.headless.map((d) => d.name)).toEqual(['Operations', 'Facilities']);
      expect(res.departments.withoutHead).toBe(2);
      // The consequence, not the count: fifteen people with no approver.
      expect(res.departments.unmanagedHeadcount).toBe(15);
    });

    it('counts a branch with no manager', async () => {
      const res = await service.getSummary();
      expect(res.branches.withoutManager).toBe(1);
    });

    it('counts one person once, however many hats they wear', async () => {
      // A department head who also manages a branch and carries direct reports
      // is one manager. Summing the three roles would report three.
      departments = [{ id: 'd1', name: 'Eng', managerId: 'p1', _count: { employees: 5 } }];
      branches = [{ id: 'b1', name: 'Muscat', managerId: 'p1', _count: { employees: 5 } }];
      prisma.employee.groupBy.mockResolvedValueOnce([
        { supervisorId: 'p1', _count: { _all: 5 } },
      ]);

      const res = await service.getSummary();
      expect(res.managers.total).toBe(1);
      expect(res.managers.deptHeads).toBe(1);
      expect(res.managers.branchManagers).toBe(1);
      expect(res.managers.supervisors).toBe(1);
    });

    it('leads with the widest span of control', async () => {
      const res = await service.getSummary();
      expect(res.managers.widestSpan).toEqual({
        supervisorId: 's1',
        name: 'Asha Rahman',
        department: 'Engineering',
        reports: 14,
      });
    });

    it('reports employees with no branch at all', async () => {
      // Nullable `branchId` is a real governance gap; the department equivalent
      // is impossible because `departmentId` is NOT NULL.
      const res = await service.getSummary();
      expect(res.unassigned.noBranch).toBe(4);
    });
  });

  describe('the change-request queue', () => {
    it('counts by status in the database, not by the length of a page', async () => {
      // The bug this endpoint exists to close: the list route sends no
      // pagination meta, so the hub was reporting `rows.length`.
      const res = await service.getSummary();
      expect(res.changeRequests.pending).toBe(5);
      expect(res.changeRequests.approved).toBe(8);
      expect(res.changeRequests.rejected).toBe(2);
      expect(prisma.departmentChangeRequest.groupBy).toHaveBeenCalled();
    });

    it('keeps a status it has never heard of inside the total', async () => {
      // Summing the four named statuses would make a fifth one vanish from the
      // total while still sitting in the queue.
      changeRequestRows.push({ status: 'ESCALATED', _count: { _all: 3 } });
      const res = await service.getSummary();
      expect(res.changeRequests.total).toBe(18);
    });

    it('reports an empty queue as zero, not as missing', async () => {
      changeRequestRows = [];
      const res = await service.getSummary();
      expect(res.changeRequests).toEqual({
        pending: 0,
        approved: 0,
        rejected: 0,
        cancelled: 0,
        total: 0,
      });
    });
  });

  describe('the workforce trend', () => {
    it('buckets joiners and leavers by the month they actually happened', async () => {
      joinRows = [
        { startDate: new Date(Date.UTC(2026, 5, 3)) },
        { startDate: new Date(Date.UTC(2026, 5, 20)) },
        { startDate: new Date(Date.UTC(2026, 7, 1)) },
      ];
      leaveRows = [{ endDate: new Date(Date.UTC(2026, 6, 15)) }];

      const res = await service.getSummary();
      const by = new Map(res.growth.buckets.map((b) => [b.key, b]));
      expect(by.get('2026-06')!.joiners).toBe(2);
      expect(by.get('2026-07')!.leavers).toBe(1);
      expect(by.get('2026-07')!.net).toBe(-1);
      expect(by.get('2026-08')!.joiners).toBe(1);
    });

    it('ignores a date outside the window rather than clamping it into the first bucket', async () => {
      // Somebody who joined three years ago is not a joiner this March.
      joinRows = [{ startDate: new Date(Date.UTC(2023, 0, 5)) }];
      const res = await service.getSummary();
      expect(res.growth.buckets.reduce((a, b) => a + b.joiners, 0)).toBe(0);
    });

    it('ends on the headcount the card above the chart prints', async () => {
      // A chart that disagrees with the KPI beside it gives the reader no way
      // to tell which one is lying.
      joinRows = [{ startDate: new Date(Date.UTC(2026, 7, 1)) }];
      const res = await service.getSummary();
      const last = res.growth.buckets[res.growth.buckets.length - 1];
      expect(last.headcountEnd).toBe(res.headcount.active);
    });

    it('walks earlier months back through the net movement', async () => {
      joinRows = [
        { startDate: new Date(Date.UTC(2026, 7, 1)) },
        { startDate: new Date(Date.UTC(2026, 7, 2)) },
      ];
      const res = await service.getSummary();
      const buckets = res.growth.buckets;
      expect(buckets[buckets.length - 1].headcountEnd).toBe(30);
      // Two joiners in August, so July closed two people lighter.
      expect(buckets[buckets.length - 2].headcountEnd).toBe(28);
    });

    it('never draws a negative headcount', async () => {
      // A backfilled database can carry more leavers in the window than the
      // company currently has people; a negative line is visibly absurd in a
      // way a merely wrong one is not.
      activeCount = 1;
      leaveRows = Array.from({ length: 9 }, () => ({
        endDate: new Date(Date.UTC(2026, 7, 4)),
      }));
      const res = await service.getSummary();
      for (const b of res.growth.buckets) expect(b.headcountEnd).toBeGreaterThanOrEqual(0);
    });

    it('reports growth against the headcount the window opened with', async () => {
      joinRows = [
        { startDate: new Date(Date.UTC(2026, 7, 1)) },
        { startDate: new Date(Date.UTC(2026, 7, 2)) },
      ];
      const res = await service.getSummary();
      // 30 now, +2 over the window, so it opened at 28: 2/28 = 7.1%.
      expect(res.growth.netChange).toBe(2);
      expect(res.growth.growthPct).toBeCloseTo(7.1, 1);
    });

    it('answers "unknown" for growth from an empty company', async () => {
      activeCount = 0;
      const res = await service.getSummary();
      expect(res.growth.growthPct).toBeNull();
    });
  });
});
