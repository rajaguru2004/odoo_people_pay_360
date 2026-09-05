import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { OvertimeDayType, OvertimeType, RequestStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemSettingsService } from '../system-settings/system-settings.service';
import type { Principal } from '../auth/auth.service';
import type { WorkingDaysService } from '../leave-requests/working-days.service';
import type { OvertimePolicyService } from '../overtime-policy/overtime-policy.service';
import {
  OVERTIME_SETTING_DEFAULTS,
  loadOvertimeConfig,
} from '../overtime-policy/overtime-config';
import { resolvedFromGlobal } from '../overtime-policy/overtime-policy.types';
import type { ResolvedOvertimeConfig } from '../overtime-policy/overtime-policy.types';
import { OvertimeService } from './overtime.service';
import { writtenData } from '../common/testing/prisma-mock.util';

const EMPLOYEE = {
  id: 'emp-1',
  employeeCode: 'EMP-0011',
  firstName: 'Ravi',
  lastName: 'Kumar',
  avatarUrl: null,
  position: 'Shift Supervisor',
  branchId: 'branch-1',
  departmentId: 'dept-ops',
  supervisorId: 'emp-boss',
  employmentType: null,
  overtimePolicyId: null,
  department: { id: 'dept-ops', name: 'Operations' },
  branch: { id: 'branch-1', code: 'SOH', name: 'Sohar' },
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
  email: 'ravi@peoplepay360.com',
  role: 'EMPLOYEE',
  employeeId: 'emp-1',
  departmentId: 'dept-ops',
  branchId: 'branch-1',
};

const SUPERVISOR: Principal = {
  id: 'user-boss',
  email: 'boss@peoplepay360.com',
  role: 'EMPLOYEE',
  employeeId: 'emp-boss',
  departmentId: 'dept-ops',
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

/** The shipped global configuration, with no policy attached. */
async function baseConfig(
  overrides: Partial<ResolvedOvertimeConfig> = {},
): Promise<ResolvedOvertimeConfig> {
  const settings = {
    get: (key: string) => Promise.resolve(OVERTIME_SETTING_DEFAULTS[key]),
  } as unknown as SystemSettingsService;
  return {
    ...resolvedFromGlobal(await loadOvertimeConfig(settings)),
    ...overrides,
  };
}

interface Harness {
  service: OvertimeService;
  prisma: {
    overtimeRequest: Record<string, jest.Mock>;
    employee: Record<string, jest.Mock>;
    department: Record<string, jest.Mock>;
  };
}

function makeHarness(options: {
  cfg: ResolvedOvertimeConfig;
  existingRequest?: Record<string, unknown> | null;
  storedRequest?: Record<string, unknown> | null;
  monthlyHours?: number;
  isHoliday?: boolean;
  isWeeklyOff?: boolean;
}): Harness {
  const overtimeRequest = {
    findFirst: jest.fn().mockResolvedValue(options.existingRequest ?? null),
    findUnique: jest.fn().mockResolvedValue(options.storedRequest ?? null),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn(({ data }: { data: object }) =>
      Promise.resolve({ id: 'ot-new', ...data, employee: EMPLOYEE }),
    ),
    update: jest.fn(({ data }: { data: object }) =>
      Promise.resolve({
        ...(options.storedRequest ?? {}),
        ...data,
        employee: EMPLOYEE,
      }),
    ),
    aggregate: jest
      .fn()
      .mockResolvedValue({ _sum: { hours: options.monthlyHours ?? 0 } }),
    groupBy: jest.fn().mockResolvedValue([]),
  };

  const prisma = {
    overtimeRequest,
    employee: {
      findUnique: jest.fn().mockResolvedValue(EMPLOYEE),
      findMany: jest.fn().mockResolvedValue([]),
    },
    department: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : Promise.resolve(ops),
    ),
  };

  const policies = {
    resolveOvertimeConfig: jest.fn().mockResolvedValue(options.cfg),
    configForPolicyId: jest.fn().mockResolvedValue(options.cfg),
  } as unknown as OvertimePolicyService;

  const systemSettings = {
    get: jest.fn((key: string) =>
      Promise.resolve(
        key === 'attendance_office_start'
          ? '08:00'
          : OVERTIME_SETTING_DEFAULTS[key],
      ),
    ),
  } as unknown as SystemSettingsService;

  const workingDays = {
    isHoliday: jest.fn().mockResolvedValue(options.isHoliday ?? false),
    isWeeklyOff: jest.fn().mockResolvedValue(options.isWeeklyOff ?? false),
  } as unknown as WorkingDaysService;

  return {
    service: new OvertimeService(
      prisma as unknown as PrismaService,
      policies,
      systemSettings,
      workingDays,
    ),
    prisma: prisma,
  };
}

const filing = {
  date: '2026-08-19',
  startTime: '2026-08-19T17:30:00Z',
  endTime: '2026-08-19T21:30:00Z',
  hours: 4,
  reason: 'Line 3 changeover ran long',
};

describe('create', () => {
  it('files a request and splits the window into the payable tiers', async () => {
    const { service, prisma } = makeHarness({ cfg: await baseConfig() });

    await service.create('emp-1', filing, HR);

    const written = writtenData(prisma.overtimeRequest.create, 0);
    expect(written.hours).toBe(4);
    expect(written.regularHours).toBe(4);
    expect(written.lateHours).toBe(0);
    expect(written.otType).toBe(OvertimeType.REGULAR);
    expect(written.dayType).toBe(OvertimeDayType.WEEKDAY);
    expect(written.status).toBe(RequestStatus.PENDING);
  });

  it('splits 17:00–23:00 into regular and late rather than one rate', async () => {
    const { service, prisma } = makeHarness({
      cfg: await baseConfig({ maxHoursPerDay: 6 }),
    });

    await service.create(
      'emp-1',
      {
        ...filing,
        startTime: '2026-08-19T17:00:00Z',
        endTime: '2026-08-19T23:00:00Z',
        hours: 6,
      },
      HR,
    );

    const written = writtenData(prisma.overtimeRequest.create, 0);
    expect(written.regularHours).toBe(5);
    expect(written.lateHours).toBe(1);
    expect(written.otType).toBe(OvertimeType.LATE);
    // Past the food threshold, so the allowance is granted.
    expect(written.foodAllowance).toBe(3);
  });

  it('refuses a typed figure that disagrees with the window', async () => {
    const { service } = makeHarness({ cfg: await baseConfig() });
    await expect(
      service.create('emp-1', { ...filing, hours: 6 }, HR),
    ).rejects.toThrow(/Hours do not match/);
  });

  it('reads an end at or before the start as crossing midnight', async () => {
    // The company closes its attendance day at 02:00, which the noon rule puts
    // on the FOLLOWING calendar day — so an overnight shift is counted whole.
    const { service, prisma } = makeHarness({
      cfg: await baseConfig({ dayEndBoundary: '02:00' }),
    });

    await service.create(
      'emp-1',
      {
        ...filing,
        startTime: '2026-08-19T22:00:00Z',
        endTime: '2026-08-19T01:00:00Z',
        hours: 3,
      },
      HR,
    );

    const written = writtenData(prisma.overtimeRequest.create, 0);
    expect(written.hours).toBe(3);
    expect(written.lateHours).toBe(3);
  });

  it('clamps an overnight shift at the day boundary the company set', async () => {
    // 23:59 is a SAME-day boundary, so the hour past midnight is not payable and
    // the request is worth 1.98h rather than the three that were worked.
    const { service, prisma } = makeHarness({ cfg: await baseConfig() });

    await service.create(
      'emp-1',
      {
        ...filing,
        startTime: '2026-08-19T22:00:00Z',
        endTime: '2026-08-19T01:00:00Z',
        hours: 3,
      },
      HR,
    );

    expect(writtenData(prisma.overtimeRequest.create, 0).hours).toBe(1.98);
  });

  it('refuses overtime that starts inside the working day', async () => {
    // Otherwise an ordinary paid hour is claimed twice — once as salary and
    // once as overtime.
    const { service } = makeHarness({ cfg: await baseConfig() });
    await expect(
      service.create(
        'emp-1',
        {
          ...filing,
          startTime: '2026-08-19T14:00:00Z',
          endTime: '2026-08-19T18:00:00Z',
          hours: 4,
        },
        HR,
      ),
    ).rejects.toThrow(/outside regular working hours/);
  });

  it('applies the rest-day cap on a weekly-off day, not the weekday one', async () => {
    const { service, prisma } = makeHarness({
      cfg: await baseConfig(),
      isWeeklyOff: true,
    });

    // Eight hours would break the 4h weekday cap and sits comfortably inside
    // the 12h rest-day cap.
    await service.create(
      'emp-1',
      {
        ...filing,
        startTime: '2026-08-21T08:00:00Z',
        endTime: '2026-08-21T16:00:00Z',
        hours: 8,
      },
      HR,
    );

    const written = writtenData(prisma.overtimeRequest.create, 0);
    expect(written.dayType).toBe(OvertimeDayType.SUNDAY);
    expect(written.doubleHours).toBe(8);
    expect(written.regularHours).toBe(0);
  });

  it('classifies a holiday as HOLIDAY even when it is also a rest day', async () => {
    const { service, prisma } = makeHarness({
      cfg: await baseConfig(),
      isHoliday: true,
      isWeeklyOff: true,
    });

    await service.create(
      'emp-1',
      {
        ...filing,
        startTime: '2026-11-18T08:00:00Z',
        endTime: '2026-11-18T12:00:00Z',
        hours: 4,
      },
      HR,
    );

    expect(writtenData(prisma.overtimeRequest.create, 0).dayType).toBe(
      OvertimeDayType.HOLIDAY,
    );
  });

  it('treats a holiday as an ordinary day when the policy says IGNORE', async () => {
    const { service, prisma } = makeHarness({
      cfg: await baseConfig({ holidayBehavior: 'IGNORE' }),
      isHoliday: true,
    });

    await service.create('emp-1', filing, HR);

    expect(writtenData(prisma.overtimeRequest.create, 0).dayType).toBe(
      OvertimeDayType.WEEKDAY,
    );
  });

  it('counts PENDING hours towards the monthly cap', async () => {
    // Two pending requests that each fit under the cap can together break it.
    const { service } = makeHarness({
      cfg: await baseConfig(),
      monthlyHours: 28,
    });
    await expect(service.create('emp-1', filing, HR)).rejects.toThrow(
      /Monthly overtime limit exceeded/,
    );
  });

  it('refuses a second request for the same date', async () => {
    const { service } = makeHarness({
      cfg: await baseConfig(),
      existingRequest: { id: 'ot-existing' },
    });
    await expect(service.create('emp-1', filing, HR)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses an employee who is not eligible under their policy', async () => {
    const { service } = makeHarness({
      cfg: await baseConfig({ eligible: false }),
    });
    await expect(service.create('emp-1', filing, HR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses self-submission when the company has turned it off', async () => {
    const { service } = makeHarness({
      cfg: await baseConfig({ allowEmployeeSubmit: false }),
    });
    await expect(service.create('emp-1', filing, SELF)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // An HR caller recording it on their behalf is still allowed.
    await expect(service.create('emp-1', filing, HR)).resolves.toBeDefined();
  });

  it('says what to do when the caller has no employee record', async () => {
    const { service } = makeHarness({ cfg: await baseConfig() });
    await expect(service.create(null, filing, HR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: 'ot-1',
  employeeId: 'emp-1',
  date: new Date('2026-08-19T00:00:00.000Z'),
  startTime: new Date('2026-08-19T17:00:00.000Z'),
  endTime: new Date('2026-08-19T23:00:00.000Z'),
  hours: 6,
  regularHours: 5,
  lateHours: 1,
  doubleHours: 0,
  doubleLateHours: 0,
  dayType: OvertimeDayType.WEEKDAY,
  otType: OvertimeType.LATE,
  foodAllowance: 3,
  siteAllowance: 5,
  foodAllowanceOverride: null,
  originalStartTime: null,
  originalEndTime: null,
  overtimePolicyId: null,
  status: RequestStatus.PENDING,
  updatedAt: new Date('2026-08-20T11:04:22.581Z'),
  employee: EMPLOYEE,
  ...over,
});

describe('approve', () => {
  it('recomputes the buckets from the stored window', async () => {
    const { service, prisma } = makeHarness({
      cfg: await baseConfig(),
      storedRequest: pendingRow(),
    });

    await service.approve('ot-1', HR);

    const written = writtenData(prisma.overtimeRequest.update, 0);
    expect(written.status).toBe(RequestStatus.APPROVED);
    expect(written.regularHours).toBe(5);
    expect(written.lateHours).toBe(1);
    expect(written.approverId).toBe(HR.id);
  });

  it('never names siteAllowance in the finalize payload', async () => {
    // It is approver-granted with nothing to recompute it from, so naming it
    // here would zero it on every approval.
    const { service, prisma } = makeHarness({
      cfg: await baseConfig(),
      storedRequest: pendingRow(),
    });

    await service.approve('ot-1', HR);

    const written = writtenData(prisma.overtimeRequest.update, 0);
    expect('siteAllowance' in written).toBe(false);
  });

  it('honours a food-allowance override of 0', async () => {
    // Null is "nobody touched it"; 0 is a decision. Reading the column for
    // truthiness would silently replace the approver's 0 with the policy figure.
    const { service, prisma } = makeHarness({
      cfg: await baseConfig(),
      storedRequest: pendingRow({ foodAllowanceOverride: 0 }),
    });

    await service.approve('ot-1', HR);

    expect(writtenData(prisma.overtimeRequest.update, 0).foodAllowance).toBe(0);
  });

  it('lets the policy compute the allowance when nobody overrode it', async () => {
    const { service, prisma } = makeHarness({
      cfg: await baseConfig(),
      storedRequest: pendingRow({ foodAllowanceOverride: null }),
    });

    await service.approve('ot-1', HR);

    expect(writtenData(prisma.overtimeRequest.update, 0).foodAllowance).toBe(3);
  });

  it('re-checks eligibility at approval, not only at filing', async () => {
    const { service } = makeHarness({
      cfg: await baseConfig({ eligible: false }),
      storedRequest: pendingRow(),
    });
    await expect(service.approve('ot-1', HR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses a request that is not pending', async () => {
    const { service } = makeHarness({
      cfg: await baseConfig(),
      storedRequest: pendingRow({ status: RequestStatus.APPROVED }),
    });
    await expect(service.approve('ot-1', HR)).rejects.toThrow(
      /already approved/,
    );
  });
});

describe('who may decide', () => {
  it('admits the supervisor named on the employee record', async () => {
    // The single-approver model. A supervisor usually holds no elevated role, so
    // without this the person the system asks to decide cannot decide.
    const { service } = makeHarness({
      cfg: await baseConfig(),
      storedRequest: pendingRow(),
    });
    await expect(service.approve('ot-1', SUPERVISOR)).resolves.toBeDefined();
  });

  it('refuses a colleague with no relationship to the request', async () => {
    const { service } = makeHarness({
      cfg: await baseConfig(),
      storedRequest: pendingRow(),
    });
    await expect(service.approve('ot-1', OUTSIDER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses the employee approving their own', async () => {
    // An approval is a second pair of eyes or it is nothing.
    const { service } = makeHarness({
      cfg: await baseConfig(),
      storedRequest: pendingRow(),
    });
    await expect(service.approve('ot-1', SELF)).rejects.toThrow(
      /cannot decide your own/,
    );
  });
});

describe('cancel', () => {
  it('lets the filer withdraw a pending request', async () => {
    const { service, prisma } = makeHarness({
      cfg: await baseConfig(),
      storedRequest: pendingRow(),
    });
    await service.cancel('ot-1', SELF);
    expect(writtenData(prisma.overtimeRequest.update, 0).status).toBe(
      RequestStatus.CANCELLED,
    );
  });

  it('refuses somebody else', async () => {
    const { service } = makeHarness({
      cfg: await baseConfig(),
      storedRequest: pendingRow(),
    });
    await expect(service.cancel('ot-1', OUTSIDER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses a request that has already been decided', async () => {
    const { service } = makeHarness({
      cfg: await baseConfig(),
      storedRequest: pendingRow({ status: RequestStatus.APPROVED }),
    });
    await expect(service.cancel('ot-1', SELF)).rejects.toThrow(
      /no longer be withdrawn/,
    );
  });
});
