import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  AttendanceSource,
  AttendanceStatus,
  RequestStatus,
} from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemSettingsService } from '../system-settings/system-settings.service';
import type { Principal } from '../auth/auth.service';
import type { LeaveBalancesService } from '../leave-balances/leave-balances.service';
import { LeaveRequestsService } from './leave-requests.service';
import type { WorkingDaysService } from './working-days.service';
import {
  callArg,
  writtenData,
  writtenRows,
} from '../common/testing/prisma-mock.util';

const day = (key: string) => new Date(`${key}T00:00:00.000Z`);

const EMPLOYEE = {
  id: 'emp-1',
  employeeCode: 'EMP-0005',
  firstName: 'Fatma',
  lastName: 'Al Rashdi',
  avatarUrl: null,
  position: 'HR Officer',
  gender: 'Female',
  branchId: 'branch-1',
  departmentId: 'dept-hr',
  supervisorId: 'emp-boss',
  status: 'ACTIVE',
  department: { id: 'dept-hr', name: 'Human Resources' },
  branch: { id: 'branch-1', code: 'HQ', name: 'Head Office' },
  supervisor: { id: 'emp-boss', firstName: 'Khalid', lastName: 'Al Harthy' },
};

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

const SUPERVISOR: Principal = {
  id: 'user-boss',
  email: 'boss@peoplepay360.com',
  role: 'EMPLOYEE',
  employeeId: 'emp-boss',
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

const ANNUAL = {
  id: 'lt-annual',
  label: 'Annual Leave',
  affectsBalance: true,
  requiresNoticeDays: 0,
  genderRestriction: null as string | null,
  defaultDays: 30,
};

const PENDING_ROW = {
  id: 'lr-1',
  employeeId: 'emp-1',
  leaveType: 'Annual Leave',
  startDate: day('2026-08-24'),
  endDate: day('2026-08-26'),
  totalDays: 3,
  reason: 'Family visit',
  status: RequestStatus.PENDING,
  approverId: null,
  approvedAt: null,
  rejectedReason: null,
  createdAt: day('2026-08-01'),
  updatedAt: day('2026-08-01'),
  employee: EMPLOYEE,
  approver: null,
  attachments: [],
};

function makeHarness(
  options: {
    leaveType?: typeof ANNUAL | null;
    overlapping?: Record<string, unknown> | null;
    workingDates?: Date[];
    remaining?: number | null;
    stored?: Record<string, unknown>;
    deductThrows?: Error;
    attendanceCreated?: number;
  } = {},
) {
  const workingDates = options.workingDates ?? [
    day('2026-08-24'),
    day('2026-08-25'),
    day('2026-08-26'),
  ];

  const leaveRequest = {
    findFirst: jest.fn().mockResolvedValue(options.overlapping ?? null),
    findUnique: jest.fn().mockResolvedValue(options.stored ?? PENDING_ROW),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...PENDING_ROW, ...data }),
    ),
    update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...PENDING_ROW, ...(options.stored ?? {}), ...data }),
    ),
    groupBy: jest.fn().mockResolvedValue([]),
  };

  const attendance = {
    createMany: jest.fn().mockResolvedValue({
      count: options.attendanceCreated ?? workingDates.length,
    }),
  };

  const tx = { leaveRequest, attendance };

  const prisma = {
    leaveRequest,
    attendance,
    libraryItem: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.leaveType === undefined ? ANNUAL : options.leaveType,
        ),
    },
    leaveTypeBalance: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.remaining === null
            ? null
            : { allocated: options.remaining ?? 30, used: 0, carriedOver: 0 },
        ),
    },
    employee: {
      findUnique: jest.fn().mockResolvedValue(EMPLOYEE),
      findMany: jest.fn().mockResolvedValue([]),
    },
    department: { findMany: jest.fn().mockResolvedValue([]) },
    company: {
      findFirst: jest.fn().mockResolvedValue({ timezone: 'Asia/Muscat' }),
    },
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (client: unknown) => unknown)(tx),
    ),
  };

  const balances = {
    deductDays: jest.fn(() =>
      options.deductThrows
        ? Promise.reject(options.deductThrows)
        : Promise.resolve(undefined),
    ),
    addDays: jest.fn(),
  } as unknown as LeaveBalancesService;

  const workingDaysService = {
    getWorkDaysBetween: jest.fn().mockResolvedValue(workingDates.length),
    getWorkingDatesBetween: jest.fn().mockResolvedValue(workingDates),
  } as unknown as WorkingDaysService;

  const settings = {
    get: jest.fn().mockResolvedValue('Asia/Muscat'),
  } as unknown as SystemSettingsService;

  return {
    service: new LeaveRequestsService(
      prisma as unknown as PrismaService,
      balances,
      workingDaysService,
      settings,
    ),
    prisma,
    balances: balances as unknown as { deductDays: jest.Mock },
    leaveRequest,
    attendance,
  };
}

const filing = {
  leaveType: 'Annual Leave',
  startDate: '2026-08-24',
  endDate: '2026-08-26',
  reason: 'Family visit',
};

describe('create', () => {
  it('prices the request in WORKING days, not calendar days', async () => {
    // Thursday to Sunday in Muscat costs two days, not four. The number is
    // stored so a branch that changes its working week next quarter does not
    // re-price leave somebody has already taken.
    const { service, leaveRequest } = makeHarness({
      workingDates: [day('2026-08-27'), day('2026-08-30')],
    });

    await service.create(
      { ...filing, startDate: '2026-08-27', endDate: '2026-08-30' },
      SELF,
    );

    expect(writtenData(leaveRequest.create).totalDays).toBe(2);
  });

  it('refuses a range whose every day is already a non-working day', async () => {
    // Approving it would deduct nothing and write no attendance: a request that
    // means nothing, filed in good faith.
    const { service } = makeHarness({ workingDates: [] });
    await expect(service.create(filing, SELF)).rejects.toThrow(
      /already a non-working day/,
    );
  });

  it('refuses an unknown leave type rather than storing it', async () => {
    // `LeaveRequest.leaveType` and `LeaveTypeBalance.leaveTypeKey` have to be
    // the same string, or the balance is never found at all.
    const { service } = makeHarness({ leaveType: null });
    await expect(
      service.create({ ...filing, leaveType: 'Sabbatical' }, SELF),
    ).rejects.toThrow(/not an available leave type/);
  });

  it('refuses an overlapping request', async () => {
    const { service } = makeHarness({
      overlapping: {
        id: 'lr-old',
        startDate: day('2026-08-25'),
        endDate: day('2026-08-28'),
      },
    });
    await expect(service.create(filing, SELF)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses a gender-restricted type the employee cannot take', async () => {
    const { service } = makeHarness({
      leaveType: {
        ...ANNUAL,
        label: 'Paternity Leave',
        genderRestriction: 'MALE',
      },
    });
    await expect(
      service.create({ ...filing, leaveType: 'Paternity Leave' }, SELF),
    ).rejects.toThrow(/only available to male employees/);
  });

  it('refuses a request that breaks the balance', async () => {
    const { service } = makeHarness({ remaining: 2 });
    await expect(service.create(filing, SELF)).rejects.toThrow(
      /Insufficient Annual Leave balance/,
    );
  });

  it('treats a missing balance row as the library default, not as zero', async () => {
    // No row means the year was never initialised — not that the employee is
    // entitled to nothing.
    const { service } = makeHarness({ remaining: null });
    await expect(service.create(filing, SELF)).resolves.toBeDefined();
  });

  it('lets unpaid leave through without touching a balance', async () => {
    const { service, prisma } = makeHarness({
      leaveType: { ...ANNUAL, label: 'Unpaid Leave', affectsBalance: false },
    });
    await service.create({ ...filing, leaveType: 'Unpaid Leave' }, SELF);
    expect(prisma.leaveTypeBalance.findUnique).not.toHaveBeenCalled();
  });

  it('enforces the notice period against the company clock', async () => {
    const { service } = makeHarness({
      leaveType: { ...ANNUAL, requiresNoticeDays: 3 },
    });
    // A start date in the past cannot possibly satisfy three days of notice.
    await expect(
      service.create(
        { ...filing, startDate: '2020-01-01', endDate: '2020-01-03' },
        SELF,
      ),
    ).rejects.toThrow(/needs at least 3 day\(s\) notice/);
  });

  it('refuses an employee filing on somebody else behalf', async () => {
    // Without this the days come out of the colleague's balance, with ON_LEAVE
    // attendance written against their name.
    const { service } = makeHarness();
    await expect(
      service.create({ ...filing, employeeId: 'emp-other' }, SELF),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets HR file on behalf of an employee', async () => {
    const { service } = makeHarness();
    await expect(
      service.create({ ...filing, employeeId: 'emp-1' }, HR),
    ).resolves.toBeDefined();
  });
});

describe('approve', () => {
  it('deducts BEFORE it writes APPROVED', async () => {
    // Nothing is reserved at filing, so two pending requests can each have
    // passed the filing check against the same days. Status-first left the row
    // APPROVED with attendance written and nothing deducted, reported to the
    // caller as a 400.
    const { service, balances, leaveRequest } = makeHarness();

    await service.approve('lr-1', HR, 'Enjoy it.');

    const deductOrder = balances.deductDays.mock.invocationCallOrder[0];
    const updateOrder = leaveRequest.update.mock.invocationCallOrder[0];
    expect(deductOrder).toBeLessThan(updateOrder);
  });

  it('leaves the request PENDING when the balance is short', async () => {
    const { service, leaveRequest, attendance } = makeHarness({
      deductThrows: new BadRequestException(
        'Insufficient Annual Leave balance',
      ),
    });

    await expect(service.approve('lr-1', HR)).rejects.toThrow(/Insufficient/);
    expect(leaveRequest.update).not.toHaveBeenCalled();
    expect(attendance.createMany).not.toHaveBeenCalled();
  });

  it('writes one ON_LEAVE attendance row per working day, stamped with the branch', async () => {
    const { service, attendance } = makeHarness();

    await service.approve('lr-1', HR);

    const rows = writtenRows(attendance.createMany);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      employeeId: 'emp-1',
      // Without the branch these rows carry a null and every branch-filtered
      // view loses them while payroll still counts them.
      branchId: 'branch-1',
      status: AttendanceStatus.ON_LEAVE,
      // SYSTEM, not MANUAL: nobody typed these times. MANUAL is reserved for a
      // human decision an import must not overwrite.
      source: AttendanceSource.SYSTEM,
      workHours: 0,
    });
    expect(
      callArg<{ skipDuplicates: boolean }>(attendance.createMany)
        .skipDuplicates,
    ).toBe(true);
  });

  it('reports the days it skipped rather than swallowing them', async () => {
    // A day the employee actually clocked keeps its own record — but the
    // approver has to be told, or a day of approved leave has no ON_LEAVE row
    // behind it and nobody knows.
    const { service } = makeHarness({ attendanceCreated: 2 });

    const result = await service.approve('lr-1', HR);

    expect(result.meta).toEqual({ attendanceCreated: 2, attendanceSkipped: 1 });
    expect(result.message).toMatch(
      /1 day\(s\) already had an attendance record/,
    );
  });

  it('admits the supervisor named on the employee record', async () => {
    const { service } = makeHarness();
    await expect(service.approve('lr-1', SUPERVISOR)).resolves.toBeDefined();
  });

  it('refuses a colleague with no relationship to the request', async () => {
    const { service } = makeHarness();
    await expect(service.approve('lr-1', OUTSIDER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses the employee approving their own', async () => {
    const { service } = makeHarness();
    await expect(service.approve('lr-1', SELF)).rejects.toThrow(
      /cannot decide your own/,
    );
  });

  it('refuses a request that is not pending', async () => {
    const { service } = makeHarness({
      stored: { ...PENDING_ROW, status: RequestStatus.REJECTED },
    });
    await expect(service.approve('lr-1', HR)).rejects.toThrow(
      /already rejected/,
    );
  });
});

describe('reject and cancel', () => {
  it('records the reason on a rejection', async () => {
    const { service, leaveRequest } = makeHarness();
    await service.reject('lr-1', HR, 'Two people are already off that week');
    expect(writtenData(leaveRequest.update)).toMatchObject({
      status: RequestStatus.REJECTED,
      rejectedReason: 'Two people are already off that week',
      approverId: HR.id,
    });
  });

  it('lets the filer withdraw their own pending request', async () => {
    const { service, leaveRequest } = makeHarness();
    await service.cancel('lr-1', SELF);
    expect(writtenData(leaveRequest.update).status).toBe(
      RequestStatus.CANCELLED,
    );
  });

  it('refuses to withdraw somebody else request', async () => {
    const { service } = makeHarness();
    await expect(service.cancel('lr-1', OUTSIDER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses to withdraw an approved request', async () => {
    // It has already moved the balance and written attendance. Undoing that is a
    // different act with a different name.
    const { service } = makeHarness({
      stored: { ...PENDING_ROW, status: RequestStatus.APPROVED },
    });
    await expect(service.cancel('lr-1', SELF)).rejects.toThrow(
      /already approved and cannot be withdrawn/,
    );
  });
});

describe('findOne', () => {
  it('lets the employee read their own', async () => {
    const { service } = makeHarness();
    await expect(service.findOne('lr-1', SELF)).resolves.toBeDefined();
  });

  it('refuses a colleague walking ids', async () => {
    const { service } = makeHarness();
    await expect(service.findOne('lr-1', OUTSIDER)).rejects.toThrow(
      /do not have permission/,
    );
  });
});
