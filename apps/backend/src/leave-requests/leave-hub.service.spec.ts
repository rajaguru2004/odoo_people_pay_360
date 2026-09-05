import { BadRequestException } from '@nestjs/common';
import { RequestStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemSettingsService } from '../system-settings/system-settings.service';
import type { Principal } from '../auth/auth.service';
import type { WorkingDaysService } from './working-days.service';
import { LeaveHubService } from './leave-hub.service';

const day = (key: string) => new Date(`${key}T00:00:00.000Z`);

const HR: Principal = {
  id: 'user-hr',
  email: 'hr@peoplepay360.com',
  role: 'HR_MANAGER',
  employeeId: 'emp-hr',
  departmentId: 'dept-hr',
  branchId: 'branch-1',
};

interface LeaveFixture {
  id: string;
  employeeId: string;
  leaveType: string;
  startDate: Date;
  endDate: Date;
  totalDays: number;
  status: RequestStatus;
  createdAt: Date;
  name: string;
}

interface OvertimeFixture {
  employeeId: string;
  date: Date;
  hours: number;
  status: RequestStatus;
  name: string;
}

function makeHub(options: {
  leave?: LeaveFixture[];
  overtime?: OvertimeFixture[];
  balances?: Array<{
    leaveTypeKey: string;
    allocated: number;
    used: number;
    carriedOver: number;
    employees: number;
  }>;
  headcount?: number;
  overtimeEnabled?: boolean;
  /** Which dates the branch calendar calls working, by ISO key. */
  workingDays?: (key: string) => boolean;
}) {
  const leave = options.leave ?? [];
  const overtime = options.overtime ?? [];

  const prisma = {
    leaveRequest: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        const start = (where.endDate as { gte: Date }).gte;
        const end = (where.startDate as { lte: Date }).lte;
        return Promise.resolve(
          leave
            .filter((r) => r.startDate <= end && r.endDate >= start)
            .map((r) => ({
              ...r,
              employee: {
                firstName: r.name,
                lastName: '',
                branchId: 'branch-1',
                department: { id: 'dept-ops', name: 'Operations' },
              },
            })),
        );
      }),
    },
    overtimeRequest: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        const range = where.date as { gte: Date; lte: Date };
        return Promise.resolve(
          overtime
            .filter((r) => r.date >= range.gte && r.date <= range.lte)
            .map((r) => ({
              ...r,
              employee: {
                firstName: r.name,
                lastName: '',
                department: { id: 'dept-ops', name: 'Operations' },
              },
            })),
        );
      }),
    },
    leaveTypeBalance: {
      groupBy: jest.fn().mockResolvedValue(
        (options.balances ?? []).map((b) => ({
          leaveTypeKey: b.leaveTypeKey,
          _sum: {
            allocated: b.allocated,
            used: b.used,
            carriedOver: b.carriedOver,
          },
          _count: { employeeId: b.employees },
        })),
      ),
    },
    employee: { count: jest.fn().mockResolvedValue(options.headcount ?? 10) },
    department: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;

  const isWorking = options.workingDays ?? (() => true);
  const workingDays = {
    getWorkingDatesBetween: jest.fn((from: Date, to: Date) => {
      const dates: Date[] = [];
      for (
        let c = new Date(from);
        c.getTime() <= to.getTime();
        c = new Date(c.getTime() + 86_400_000)
      ) {
        if (isWorking(c.toISOString().slice(0, 10))) dates.push(new Date(c));
      }
      return Promise.resolve(dates);
    }),
  } as unknown as WorkingDaysService;

  const settings = {
    get: jest
      .fn()
      .mockResolvedValue(options.overtimeEnabled === false ? 'false' : 'true'),
  } as unknown as SystemSettingsService;

  return new LeaveHubService(prisma, workingDays, settings);
}

const leaveRow = (
  over: Partial<LeaveFixture> & { id: string; startDate: Date; endDate: Date },
): LeaveFixture => ({
  employeeId: `emp-${over.id}`,
  leaveType: 'Annual Leave',
  totalDays: 1,
  status: RequestStatus.APPROVED,
  createdAt: day('2026-08-01'),
  name: 'Somebody',
  ...over,
});

describe('the window', () => {
  it('refuses a period the hub does not offer', async () => {
    const hub = makeHub({});
    await expect(
      hub.getHubSummary('quarter' as never, undefined, HR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an anchor that is not a real date', async () => {
    // `Date.UTC` rolls month 13 into next January, so without the round-trip
    // check the hub would answer confidently for a period nobody asked about.
    const hub = makeHub({});
    await expect(
      hub.getHubSummary('month', '2026-13-45', HR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('labels the window on the server, so the browser does no calendar maths', async () => {
    const hub = makeHub({});
    const result = await hub.getHubSummary('month', '2026-08-15', HR);
    expect(result.range).toMatchObject({
      start: '2026-08-01',
      end: '2026-08-31',
      label: 'Aug 2026',
      prevAnchor: '2026-07-01',
      nextAnchor: '2026-09-01',
    });
  });
});

describe('counting requests', () => {
  it('counts all four statuses, CANCELLED included', async () => {
    // Four slices that sum to the caption above them. Dropping CANCELLED made
    // the donut disagree with its own total.
    const hub = makeHub({
      leave: [
        leaveRow({
          id: '1',
          startDate: day('2026-08-03'),
          endDate: day('2026-08-03'),
        }),
        leaveRow({
          id: '2',
          startDate: day('2026-08-04'),
          endDate: day('2026-08-04'),
          status: RequestStatus.PENDING,
        }),
        leaveRow({
          id: '3',
          startDate: day('2026-08-05'),
          endDate: day('2026-08-05'),
          status: RequestStatus.REJECTED,
        }),
        leaveRow({
          id: '4',
          startDate: day('2026-08-06'),
          endDate: day('2026-08-06'),
          status: RequestStatus.CANCELLED,
        }),
      ],
    });

    const result = await hub.getHubSummary('month', '2026-08-15', HR);
    expect(result.status).toEqual({
      approved: 1,
      pending: 1,
      rejected: 1,
      cancelled: 1,
    });
    expect(result.periodStats.requests).toBe(4);
    const summed =
      result.status.approved +
      result.status.pending +
      result.status.rejected +
      result.status.cancelled;
    expect(summed).toBe(result.periodStats.requests);
  });

  it('includes a request that straddles the window boundary', async () => {
    // Overlap, not containment: a leave running 28 Aug to 6 Sep is part of both
    // months, and filtering on the start date alone loses it from September.
    const hub = makeHub({
      leave: [
        leaveRow({
          id: '1',
          startDate: day('2026-08-28'),
          endDate: day('2026-09-06'),
          totalDays: 8,
        }),
      ],
    });

    const september = await hub.getHubSummary('month', '2026-09-15', HR);
    expect(september.periodStats.requests).toBe(1);
  });
});

describe('leave days', () => {
  it('keeps the requests own number when it sits wholly inside the window', async () => {
    // A recount could differ by a day at a branch whose calendar changed since
    // the leave was filed, and then the card disagrees with the request.
    const hub = makeHub({
      leave: [
        leaveRow({
          id: '1',
          startDate: day('2026-08-03'),
          endDate: day('2026-08-07'),
          totalDays: 4,
        }),
      ],
    });

    const result = await hub.getHubSummary('month', '2026-08-15', HR);
    expect(result.periodStats.leaveDays).toBe(4);
  });

  it('prorates a straddling request to the part inside the window', async () => {
    // 28 Aug to 6 Sep: four days land in August, six in September. Charging
    // August for September days is a confident wrong answer.
    const hub = makeHub({
      leave: [
        leaveRow({
          id: '1',
          startDate: day('2026-08-28'),
          endDate: day('2026-09-06'),
          totalDays: 10,
        }),
      ],
    });

    const august = await hub.getHubSummary('month', '2026-08-15', HR);
    const september = await hub.getHubSummary('month', '2026-09-15', HR);
    expect(august.periodStats.leaveDays).toBe(4);
    expect(september.periodStats.leaveDays).toBe(6);
    expect(august.periodStats.leaveDays + september.periodStats.leaveDays).toBe(
      10,
    );
  });

  it('counts only APPROVED leave as days taken', async () => {
    // A pending request is a request, not an absence.
    const hub = makeHub({
      leave: [
        leaveRow({
          id: '1',
          startDate: day('2026-08-03'),
          endDate: day('2026-08-05'),
          totalDays: 3,
          status: RequestStatus.PENDING,
        }),
      ],
    });

    const result = await hub.getHubSummary('month', '2026-08-15', HR);
    expect(result.periodStats.leaveDays).toBe(0);
    expect(result.periodStats.pending).toBe(1);
  });
});

describe('rates', () => {
  it('are null, never 0%, when there was nothing to divide by', async () => {
    // An empty month and a month where nothing was approved are different
    // claims, and a card printing 0.0% for both has told the reader something
    // false about one of them.
    const hub = makeHub({ headcount: 0 });
    const result = await hub.getHubSummary('month', '2026-08-15', HR);
    expect(result.periodStats.approvalRate).toBeNull();
    expect(result.periodStats.onLeaveTodayRate).toBeNull();
    expect(result.periodStats.utilisation).toBeNull();
    expect(result.periodStats.averageBalance).toBeNull();
    expect(result.periodStats.avgOvertimePerEmployee).toBeNull();
  });

  it('computes a real rate when there is a denominator', async () => {
    const hub = makeHub({
      leave: [
        leaveRow({
          id: '1',
          startDate: day('2026-08-03'),
          endDate: day('2026-08-03'),
        }),
        leaveRow({
          id: '2',
          startDate: day('2026-08-04'),
          endDate: day('2026-08-04'),
          status: RequestStatus.REJECTED,
        }),
      ],
    });
    const result = await hub.getHubSummary('month', '2026-08-15', HR);
    expect(result.periodStats.approvalRate).toBe(50);
  });
});

describe('balances', () => {
  it('derives remaining from the three columns it is made of', async () => {
    const hub = makeHub({
      balances: [
        {
          leaveTypeKey: 'Annual Leave',
          allocated: 300,
          used: 120,
          carriedOver: 30,
          employees: 10,
        },
      ],
    });
    const result = await hub.getHubSummary('month', '2026-08-15', HR);
    expect(result.balance).toMatchObject({
      allocated: 300,
      used: 120,
      carriedOver: 30,
      remaining: 210,
    });
    // 120 of 330.
    expect(result.balance.utilisation).toBe(36.4);
  });
});

describe('overtime', () => {
  it('counts APPROVED hours only, but every status as a request', async () => {
    // One mistaken forty-hour submission must not move the number the whole
    // company is judged on. The queue is still a queue.
    const hub = makeHub({
      overtime: [
        {
          employeeId: 'e1',
          date: day('2026-08-05'),
          hours: 4,
          status: RequestStatus.APPROVED,
          name: 'Ravi',
        },
        {
          employeeId: 'e2',
          date: day('2026-08-06'),
          hours: 40,
          status: RequestStatus.PENDING,
          name: 'Anil',
        },
      ],
    });

    const result = await hub.getHubSummary('month', '2026-08-15', HR);
    expect(result.periodStats.overtimeHours).toBe(4);
    expect(result.periodStats.overtimeRequests).toBe(2);
    expect(result.periodStats.overtimeEmployees).toBe(1);
  });

  it('drops the panel rather than drawing zeros when overtime is switched off', async () => {
    // "Nobody worked late" and "this company does not track overtime" are
    // different claims.
    const hub = makeHub({ overtimeEnabled: false });
    const result = await hub.getHubSummary('month', '2026-08-15', HR);
    expect(result.overtime.enabled).toBe(false);
    expect(result.overtime.totalHours).toBe(0);
  });

  it('averages over the employees WITH overtime, not over headcount', async () => {
    const hub = makeHub({
      headcount: 100,
      overtime: [
        {
          employeeId: 'e1',
          date: day('2026-08-05'),
          hours: 6,
          status: RequestStatus.APPROVED,
          name: 'Ravi',
        },
        {
          employeeId: 'e2',
          date: day('2026-08-06'),
          hours: 4,
          status: RequestStatus.APPROVED,
          name: 'Anil',
        },
      ],
    });
    const result = await hub.getHubSummary('month', '2026-08-15', HR);
    // "The average person did 0.1 hours" is not the sentence anybody wanted.
    expect(result.periodStats.avgOvertimePerEmployee).toBe(5);
  });
});

describe('the attention strip', () => {
  it('carries a capped sample of names beside the true count', async () => {
    const leave = Array.from({ length: 20 }, (_, i) =>
      leaveRow({
        id: `p${i}`,
        employeeId: `emp-${i}`,
        name: `Person ${i}`,
        startDate: day('2026-08-10'),
        endDate: day('2026-08-10'),
        status: RequestStatus.PENDING,
      }),
    );
    const hub = makeHub({ leave });

    const result = await hub.getHubSummary('month', '2026-08-15', HR);
    // A named sample is not a count: `count` is the true total.
    expect(result.attention.pending.count).toBe(20);
    expect(result.attention.pending.names).toHaveLength(12);
  });
});
