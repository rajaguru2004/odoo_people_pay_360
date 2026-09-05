import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { LibraryType } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemSettingsService } from '../system-settings/system-settings.service';
import type { Principal } from '../auth/auth.service';
import { LeaveBalancesService } from './leave-balances.service';
import { writtenData, writtenRows } from '../common/testing/prisma-mock.util';

const YEAR = new Date().getUTCFullYear();

const HR: Principal = {
  id: 'user-hr',
  email: 'hr@peoplepay360.com',
  role: 'HR_MANAGER',
  employeeId: 'emp-hr',
  departmentId: 'dept-hr',
  branchId: 'branch-1',
};

const SELF: Principal = {
  id: 'user-self',
  email: 'fatma@peoplepay360.com',
  role: 'EMPLOYEE',
  employeeId: 'emp-1',
  departmentId: 'dept-hr',
  branchId: 'branch-1',
};

const OUTSIDER: Principal = {
  id: 'user-other',
  email: 'other@peoplepay360.com',
  role: 'EMPLOYEE',
  employeeId: 'emp-other',
  departmentId: 'dept-it',
  branchId: 'branch-1',
};

const TYPES = [
  {
    label: 'Annual Leave',
    defaultDays: 30,
    affectsBalance: true,
    genderRestriction: null as string | null,
  },
  {
    label: 'Sick Leave',
    defaultDays: 30,
    affectsBalance: true,
    genderRestriction: null as string | null,
  },
  {
    label: 'Maternity Leave',
    defaultDays: 98,
    affectsBalance: true,
    genderRestriction: 'FEMALE' as string | null,
  },
  {
    label: 'Unpaid Leave',
    defaultDays: 0,
    affectsBalance: false,
    genderRestriction: null as string | null,
  },
];

function makeHarness(
  options: {
    employee?: Record<string, unknown> | null;
    headline?: Record<string, unknown> | null;
    typeBalances?: Array<Record<string, unknown>>;
    typeBalance?: Record<string, unknown> | null;
    accrualDone?: Array<{ employeeId: string }>;
  } = {},
) {
  const typeBalances = options.typeBalances ?? [];

  const leaveTypeBalance = {
    findUnique: jest
      .fn()
      .mockResolvedValue(
        options.typeBalance === undefined ? null : options.typeBalance,
      ),
    findMany: jest.fn().mockResolvedValue(typeBalances),
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
    create: jest.fn(({ data }: { data: object }) =>
      Promise.resolve({ id: 'ltb-new', used: 0, carriedOver: 0, ...data }),
    ),
    update: jest.fn(({ data }: { data: object }) => Promise.resolve(data)),
    upsert: jest.fn(({ create }: { create: Record<string, unknown> }) =>
      Promise.resolve({
        id: 'ltb-upserted',
        used: 0,
        carriedOver: 0,
        ...(options.typeBalance ?? create),
      }),
    ),
    groupBy: jest.fn().mockResolvedValue([]),
  };

  const leaveBalance = {
    findUnique: jest.fn().mockResolvedValue(
      options.headline === undefined
        ? {
            id: 'lb-1',
            employeeId: 'emp-1',
            year: YEAR,
            annualLeave: 30,
            sickLeave: 30,
            usedAnnual: 4,
            usedSick: 0,
            carriedOver: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : options.headline,
    ),
    upsert: jest.fn().mockResolvedValue({ id: 'lb-1' }),
    update: jest.fn(({ data }: { data: object }) => Promise.resolve(data)),
    create: jest.fn().mockResolvedValue({ id: 'lb-1' }),
  };

  const prisma = {
    leaveBalance,
    leaveTypeBalance,
    leaveAccrualHistory: {
      findMany: jest.fn().mockResolvedValue(options.accrualDone ?? []),
      create: jest.fn().mockResolvedValue({ id: 'lah-1' }),
    },
    libraryItem: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          TYPES.filter(
            (t) =>
              where.libraryType === LibraryType.LEAVE_TYPE &&
              (where.affectsBalance === undefined ||
                t.affectsBalance === where.affectsBalance),
          ),
        ),
      ),
      findFirst: jest.fn(({ where }: { where: { label?: string } }) =>
        Promise.resolve(TYPES.find((t) => t.label === where.label) ?? null),
      ),
    },
    employee: {
      findUnique: jest.fn().mockResolvedValue(
        options.employee === undefined
          ? {
              id: 'emp-1',
              gender: 'Female',
              departmentId: 'dept-hr',
              supervisorId: 'emp-boss',
            }
          : options.employee,
      ),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(10),
    },
    department: { findMany: jest.fn().mockResolvedValue([]) },
    company: {
      findFirst: jest.fn().mockResolvedValue({ timezone: 'Asia/Muscat' }),
    },
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (client: unknown) => unknown)({
            leaveBalance,
            leaveTypeBalance,
            leaveAccrualHistory: {
              create: jest.fn().mockResolvedValue({ id: 'lah-1' }),
            },
          }),
    ),
  };

  const settings = {
    get: jest.fn().mockResolvedValue('Asia/Muscat'),
  } as unknown as SystemSettingsService;

  return {
    service: new LeaveBalancesService(
      prisma as unknown as PrismaService,
      settings,
    ),
    prisma,
    leaveTypeBalance,
    leaveBalance,
  };
}

describe('initBalance', () => {
  it('allocates every balance-affecting type the employee is eligible for', async () => {
    const { service, leaveTypeBalance } = makeHarness({
      typeBalances: [
        {
          id: 'a',
          employeeId: 'emp-1',
          year: YEAR,
          leaveTypeKey: 'Annual Leave',
          allocated: 30,
          used: 0,
          carriedOver: 0,
        },
      ],
    });

    await service.initBalance('emp-1', YEAR);

    const rows = writtenRows(leaveTypeBalance.createMany);
    // Unpaid Leave affects no balance, so it gets no row at all.
    expect(rows.map((r) => r.leaveTypeKey)).toEqual([
      'Annual Leave',
      'Sick Leave',
      'Maternity Leave',
    ]);
  });

  it('leaves out a type the employee could never take', async () => {
    // 98 days of maternity on a male employee is leave nobody can use, inflating
    // every company total that sums the column.
    const { service, leaveTypeBalance } = makeHarness({
      employee: {
        id: 'emp-2',
        gender: 'Male',
        departmentId: null,
        supervisorId: null,
      },
      typeBalances: [],
    });

    await service.initBalance('emp-2', YEAR);

    const rows = writtenRows(leaveTypeBalance.createMany);
    expect(rows.map((r) => r.leaveTypeKey)).toEqual([
      'Annual Leave',
      'Sick Leave',
    ]);
  });

  it('refuses a year that is not a year', async () => {
    const { service } = makeHarness();
    await expect(
      service.initBalance('emp-1', Number.NaN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('getBalance', () => {
  it('derives remaining from the three columns rather than storing a fourth', async () => {
    const { service } = makeHarness({
      typeBalances: [
        {
          id: 'a',
          employeeId: 'emp-1',
          year: YEAR,
          leaveTypeKey: 'Annual Leave',
          allocated: 30,
          used: 4,
          carriedOver: 5,
        },
      ],
    });

    const result = await service.getBalance('emp-1', YEAR, HR);
    expect(result.data.leaveTypeBalances[0].remaining).toBe(31);
    expect(result.data.remainingAnnual).toBe(31);
  });

  it('refuses a colleague reading somebody else entitlement', async () => {
    // The door LOOKS like a read and is not: it materialises rows. Unguarded, a
    // caller could create balance rows for the whole company by walking ids.
    const { service } = makeHarness();
    await expect(
      service.getBalance('emp-1', YEAR, OUTSIDER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets the employee read their own', async () => {
    const { service } = makeHarness();
    await expect(
      service.getBalance('emp-1', YEAR, SELF),
    ).resolves.toBeDefined();
  });
});

describe('deductDays', () => {
  it('refuses to spend more than is left', async () => {
    const { service } = makeHarness({
      typeBalance: {
        id: 'ltb-1',
        allocated: 5,
        used: 3,
        carriedOver: 0,
      },
    });
    // Two left, three asked for. The caller — leave approval — depends on this
    // throwing rather than clamping.
    await expect(
      service.deductDays('emp-1', 3, 'Annual Leave', YEAR),
    ).rejects.toThrow(/Insufficient Annual Leave balance/);
  });

  it('spends the days when there are enough', async () => {
    const { service, leaveTypeBalance } = makeHarness({
      typeBalance: { id: 'ltb-1', allocated: 30, used: 4, carriedOver: 5 },
    });

    await service.deductDays('emp-1', 3, 'Annual Leave', YEAR);

    expect(writtenData(leaveTypeBalance.update)).toEqual({ used: 7 });
  });

  it('is a no-op for a type that affects no balance', async () => {
    // Unpaid leave is still approved and still writes attendance; it simply
    // costs no entitlement.
    const { service, leaveTypeBalance } = makeHarness();
    await service.deductDays('emp-1', 3, 'Unpaid Leave', YEAR);
    expect(leaveTypeBalance.upsert).not.toHaveBeenCalled();
  });

  it('keeps the headline column in step with the per-type row', async () => {
    const { service, leaveBalance } = makeHarness({
      typeBalance: { id: 'ltb-1', allocated: 30, used: 4, carriedOver: 5 },
    });

    await service.deductDays('emp-1', 3, 'Annual Leave', YEAR);

    expect(writtenData(leaveBalance.update)).toEqual({
      usedAnnual: 7,
    });
  });
});

describe('addDays', () => {
  it('floors used at zero rather than letting it go negative', async () => {
    // A negative `used` silently inflates the remaining balance, and the
    // inflation survives into next year's carry-forward.
    const { service, leaveTypeBalance } = makeHarness({
      typeBalance: { id: 'ltb-1', allocated: 30, used: 2, carriedOver: 0 },
    });

    await service.addDays('emp-1', 5, 'Annual Leave', YEAR);

    expect(writtenData(leaveTypeBalance.update)).toEqual({ used: 0 });
  });
});

describe('updateBalance', () => {
  it('refuses an empty body instead of answering 200 for nothing', async () => {
    const { service } = makeHarness();
    await expect(
      service.updateBalance('emp-1', YEAR, undefined, undefined),
    ).rejects.toThrow(/at least one of annualLeave or sickLeave/);
  });
});

describe('the monthly accrual', () => {
  it('skips an employee already credited for the company month', async () => {
    // Idempotence is in the history table, so a restart on the 1st cannot credit
    // the month twice.
    const { service, prisma } = makeHarness({
      accrualDone: [{ employeeId: 'emp-1' }],
    });
    prisma.employee.findMany.mockResolvedValue([
      { id: 'emp-1', employeeCode: 'EMP-0001' },
      { id: 'emp-2', employeeCode: 'EMP-0002' },
    ]);

    const result = await service.accrueLeaveForAllEmployees();
    expect(result.data.skipped).toBe(1);
    expect(result.data.credited).toBe(1);
  });
});

describe('getCompanyLeaveOverview', () => {
  it('reports a null utilisation when there was nothing to divide by', async () => {
    const { service, prisma } = makeHarness();
    prisma.leaveTypeBalance.groupBy.mockResolvedValue([
      {
        leaveTypeKey: 'Study Leave',
        _sum: { allocated: 0, used: 0, carriedOver: 0 },
        _count: { employeeId: 0 },
      },
    ]);

    const result = await service.getCompanyLeaveOverview(YEAR);
    expect(result.data.leaveTypes[0].utilisation).toBeNull();
  });
});
