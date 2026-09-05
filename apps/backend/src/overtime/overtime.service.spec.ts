import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { OvertimeService } from './overtime.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import { AttendanceCalendarService } from '../attendances/attendance-calendar.service';
import { OvertimePolicyService } from '../overtime-policy/overtime-policy.service';

/**
 * A rate card with both premium tiers filled in. The thresholds are wall clocks
 * read as UTC, matching how overtime times are stored.
 */
const CFG = {
  enabled: true,
  lateThreshold: '22:00',
  foodAllowanceEnabled: true,
  foodAllowanceThreshold: '22:00',
  foodAllowanceAmount: 15,
  regularRate: 1.5,
  lateRate: 1.5,
  doubleOtEnabled: true,
  doubleRate: 2,
  sunday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
  holiday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
  shiftEndTime: '17:00',
  doubleFoodAllowanceAnyTime: false,
  doubleOtAllowAnytime: true,
  maxHoursPerDay: 8,
  maxHoursPerDoubleDay: 12,
  maxHoursPerMonth: 40,
  maxHoursPerYear: 200,
  requireManagerApproval: true,
  allowEmployeeSubmit: true,
  eligible: true,
  holidayBehavior: 'STANDARD' as const,
  dayEndBoundary: null,
  policyId: null,
  policyName: null,
};

const EMPLOYEE_CARD = {
  id: 'emp-1',
  employeeCode: 'E1',
  firstName: 'Amal',
  lastName: 'Said',
  workEmail: 'amal@example.com',
  personalEmail: null,
  departmentId: 'dep-1',
  branchId: null,
  overtimePolicyId: null,
  department: { id: 'dep-1', name: 'Operations' },
};

/**
 * The chain is disengaged throughout, so approve and reject take the
 * single-approver path — which is the path these breakdown cases exercise.
 */
const engineMock = () => ({
  initiate: jest.fn().mockResolvedValue({ engaged: false, finalized: false }),
  decide: jest.fn().mockResolvedValue({ engaged: false, finalized: false }),
  abandon: jest.fn().mockResolvedValue(undefined),
  isChainParticipant: jest.fn().mockResolvedValue(false),
  trailFor: jest.fn().mockResolvedValue({ engaged: false, canAct: false }),
});

/** Sunday (ISO 7) is the weekly rest day; no holidays unless a test adds one. */
const calendarMock = () => ({
  branchConfigs: jest.fn().mockResolvedValue(new Map()),
  holidayIndex: jest.fn().mockResolvedValue(new Map()),
  configFor: jest.fn().mockReturnValue({ weeklyOffDays: [7] }),
  holidayOn: jest.fn().mockReturnValue(null),
});

const policyMock = (cfg: Record<string, unknown> = {}) => ({
  resolveOvertimeConfig: jest.fn().mockResolvedValue({ ...CFG, ...cfg }),
  configForPolicyId: jest.fn().mockResolvedValue({ ...CFG, ...cfg }),
});

const settingsMock = () => ({
  get: jest.fn().mockResolvedValue('08:00'), // attendance_office_start
});

type WriteArgs = { data: Record<string, unknown> };

/**
 * A create/update stub that keeps the payload it was handed. Reading it back
 * from `mock.calls` costs an `any` at every assertion, and these tests are
 * entirely about what gets written.
 */
function writeSpy(sink: {
  last: Record<string, unknown>;
  all: Record<string, unknown>[];
}) {
  return jest.fn((args: WriteArgs) => {
    sink.last = args.data;
    sink.all.push(args.data);
    return Promise.resolve({
      id: 'ot-1',
      ...args.data,
      employee: EMPLOYEE_CARD,
    });
  });
}

describe('OvertimeService — how a submitted request is classified', () => {
  let service: OvertimeService;
  let prisma: {
    employee: { findUnique: jest.Mock };
    overtimeRequest: {
      findFirst: jest.Mock;
      aggregate: jest.Mock;
      create: jest.Mock;
    };
    systemSetting: { findUnique: jest.Mock };
  };
  let calendar: ReturnType<typeof calendarMock>;
  let otPolicy: ReturnType<typeof policyMock>;
  const written = {
    last: {} as Record<string, unknown>,
    all: [] as Record<string, unknown>[],
  };

  const build = async (cfg: Record<string, unknown> = {}) => {
    written.last = {};
    written.all = [];
    prisma = {
      employee: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'emp-1',
          branchId: null,
          overtimePolicyId: null,
          employmentType: null,
        }),
      },
      overtimeRequest: {
        findFirst: jest.fn().mockResolvedValue(null),
        aggregate: jest.fn().mockResolvedValue({ _sum: { hours: 0 } }),
        create: writeSpy(written),
      },
      // No stored overrides, so every overtime setting takes its default.
      systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    calendar = calendarMock();
    otPolicy = policyMock(cfg);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        OvertimeService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemSettingsService, useValue: settingsMock() },
        { provide: ApprovalEngineService, useValue: engineMock() },
        { provide: AttendanceCalendarService, useValue: calendar },
        { provide: OvertimePolicyService, useValue: otPolicy },
      ],
    }).compile();
    service = moduleRef.get(OvertimeService);
  };

  beforeEach(() => build());

  // Times carry `Z` so the service's UTC reads land on the intended hour in
  // whatever timezone the runner happens to be in.
  const dto = (date: string, startH: number, endH: number, hours: number) => ({
    date: `${date}T00:00:00Z`,
    startTime: `${date}T${String(startH).padStart(2, '0')}:00:00Z`,
    endTime: `${date}T${String(endH).padStart(2, '0')}:00:00Z`,
    hours,
    reason: 'Closed the month-end run',
  });
  const created = () => written.last;

  it('is REGULAR with no food allowance for 17:00-19:00 on a weekday', async () => {
    await service.create('emp-1', dto('2026-08-04', 17, 19, 2), UserRole.ADMIN);
    expect(created()).toMatchObject({ otType: 'REGULAR', foodAllowance: 0 });
  });

  it('is LATE with a food allowance once the window runs past 22:00', async () => {
    await service.create('emp-1', dto('2026-08-04', 17, 23, 6), UserRole.ADMIN);
    expect(created()).toMatchObject({ otType: 'LATE', foodAllowance: 15 });
  });

  it('treats an end exactly on the threshold as still regular', async () => {
    await service.create('emp-1', dto('2026-08-04', 17, 22, 5), UserRole.ADMIN);
    expect(created()).toMatchObject({ otType: 'REGULAR', foodAllowance: 0 });
  });

  it('splits 17:00-23:00 into five regular hours and one late hour', async () => {
    await service.create('emp-1', dto('2026-08-04', 17, 23, 6), UserRole.ADMIN);
    expect(created()).toMatchObject({
      hours: 6,
      regularHours: 5,
      lateHours: 1,
      doubleHours: 0,
      doubleLateHours: 0,
    });
  });

  it('reads an end at or before the start as crossing midnight', async () => {
    await service.create(
      'emp-1',
      {
        date: '2026-08-04T00:00:00Z',
        startTime: '2026-08-04T22:00:00Z',
        endTime: '2026-08-04T02:00:00Z',
        hours: 4,
        reason: 'Overnight cutover',
      },
      UserRole.ADMIN,
    );
    // The default 23:59 boundary trims the window at the end of the day.
    expect(created()).toMatchObject({ otType: 'LATE', hours: 1.98 });
  });

  it('pays a rest-day shift on the double tier', async () => {
    // 16 August 2026 is a Sunday, which the branch calendar marks as rest.
    await service.create('emp-1', dto('2026-08-16', 8, 17, 9), UserRole.ADMIN);
    expect(created()).toMatchObject({
      otType: 'DOUBLE',
      dayType: 'SUNDAY',
      doubleHours: 9,
      doubleLateHours: 0,
      regularHours: 0,
    });
  });

  it('reports both double buckets for a rest-day window crossing the threshold', async () => {
    // 16 August 2026 is a Sunday. 18:00-23:00 against a 22:00 double-day
    // threshold is four hours at the double rate and one at the double-late
    // rate, and the two are paid differently.
    await service.create('emp-1', dto('2026-08-16', 18, 23, 5), UserRole.ADMIN);
    expect(created()).toMatchObject({
      otType: 'DOUBLE_LATE',
      dayType: 'SUNDAY',
      hours: 5,
      doubleHours: 4,
      doubleLateHours: 1,
      regularHours: 0,
      lateHours: 0,
    });
  });

  it('pays a holiday evening on the double late tier, with food', async () => {
    calendar.holidayOn.mockReturnValue({
      id: 'h1',
      name: 'National Day',
      branchId: null,
    });
    await service.create('emp-1', dto('2026-08-04', 17, 23, 6), UserRole.ADMIN);
    expect(created()).toMatchObject({
      otType: 'DOUBLE_LATE',
      dayType: 'HOLIDAY',
      foodAllowance: 15,
    });
  });

  it('treats a holiday as an ordinary day when the policy says IGNORE', async () => {
    await build({ holidayBehavior: 'IGNORE' });
    calendar.holidayOn.mockReturnValue({
      id: 'h1',
      name: 'National Day',
      branchId: null,
    });
    await service.create('emp-1', dto('2026-08-04', 17, 19, 2), UserRole.ADMIN);
    expect(created()).toMatchObject({ otType: 'REGULAR', dayType: 'WEEKDAY' });
    // The holiday index is never even consulted for an IGNORE policy.
    expect(calendar.holidayOn).not.toHaveBeenCalled();
  });

  it('refuses a request when the policy marks the employee ineligible', async () => {
    await build({ eligible: false });
    await expect(
      service.create('emp-1', dto('2026-08-04', 17, 19, 2), UserRole.ADMIN),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps the LATE tier but pays nothing when the food allowance is off', async () => {
    await build({ foodAllowanceEnabled: false });
    await service.create('emp-1', dto('2026-08-04', 17, 23, 6), UserRole.ADMIN);
    expect(created()).toMatchObject({ otType: 'LATE', foodAllowance: 0 });
  });

  it('judges the food allowance on its own threshold, not the pay tier', async () => {
    await build({ foodAllowanceThreshold: '21:00' });
    await service.create('emp-1', dto('2026-08-04', 17, 21, 4), UserRole.ADMIN);
    // 17:00-21:30 is still the regular tier, but it is past the meal threshold.
    written.last = {};
    written.all = [];
    await service.create(
      'emp-1',
      {
        date: '2026-08-04T00:00:00Z',
        startTime: '2026-08-04T17:00:00Z',
        endTime: '2026-08-04T21:30:00Z',
        hours: 4.5,
        reason: 'Stock count',
      },
      UserRole.ADMIN,
    );
    expect(created()).toMatchObject({ otType: 'REGULAR', foodAllowance: 15 });
  });

  it('rejects a nine-hour weekday request against the weekday cap', async () => {
    await expect(
      service.create('emp-1', dto('2026-08-04', 14, 23, 9), UserRole.ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects overtime that starts inside the working day', async () => {
    await expect(
      service.create('emp-1', dto('2026-08-04', 10, 14, 4), UserRole.ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a second request for a date that already has one', async () => {
    prisma.overtimeRequest.findFirst.mockResolvedValue({ id: 'ot-0' });
    await expect(
      service.create('emp-1', dto('2026-08-04', 17, 19, 2), UserRole.ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects hours that disagree with the window by more than a tenth', async () => {
    await expect(
      service.create('emp-1', dto('2026-08-04', 17, 19, 4), UserRole.ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an employee submission while the policy has it switched off', async () => {
    await build({ allowEmployeeSubmit: false });
    await expect(
      service.create('emp-1', dto('2026-08-04', 17, 19, 2), UserRole.EMPLOYEE),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('OvertimeService — approval freezes a fresh breakdown', () => {
  let service: OvertimeService;
  let prisma: {
    employee: { findUnique: jest.Mock };
    overtimeRequest: { findUnique: jest.Mock; update: jest.Mock };
    systemSetting: { findUnique: jest.Mock };
  };
  let otPolicy: ReturnType<typeof policyMock>;
  const written = {
    last: {} as Record<string, unknown>,
    all: [] as Record<string, unknown>[],
  };

  const build = async (cfg: Record<string, unknown> = {}) => {
    written.last = {};
    written.all = [];
    prisma = {
      employee: {
        findUnique: jest.fn().mockResolvedValue({
          branchId: null,
          overtimePolicyId: null,
          employmentType: null,
          departmentId: 'dep-1',
        }),
      },
      overtimeRequest: {
        // The stored row is stale: persisted as REGULAR with no allowance, but
        // the window it holds is LATE with a meal under the current rules.
        findUnique: jest.fn().mockResolvedValue({
          id: 'ot-1',
          employeeId: 'emp-1',
          status: 'PENDING',
          date: new Date('2026-08-19T00:00:00Z'),
          startTime: new Date('2026-08-19T18:00:00Z'),
          endTime: new Date('2026-08-19T23:00:00Z'),
          otType: 'REGULAR',
          regularHours: 5,
          lateHours: 0,
          doubleHours: 0,
          foodAllowance: 0,
          siteAllowance: 0,
          foodAllowanceOverride: null,
          originalStartTime: null,
          overtimePolicyId: null,
          hours: 5,
          updatedAt: new Date('2026-08-19T10:00:00Z'),
          employee: EMPLOYEE_CARD,
        }),
        update: writeSpy(written),
      },
      systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    otPolicy = policyMock(cfg);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        OvertimeService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemSettingsService, useValue: settingsMock() },
        { provide: ApprovalEngineService, useValue: engineMock() },
        { provide: AttendanceCalendarService, useValue: calendarMock() },
        { provide: OvertimePolicyService, useValue: otPolicy },
      ],
    }).compile();
    service = moduleRef.get(OvertimeService);
  };

  const principal = {
    id: 'user-1',
    email: 'hr@example.com',
    role: UserRole.ADMIN,
    employeeId: 'emp-9',
    departmentId: null,
    branchId: null,
  };

  it('recomputes the tier split and the allowance from the current rules', async () => {
    await build();
    await service.approve('ot-1', 'user-1', principal);
    const persisted = written.last;
    expect(persisted).toMatchObject({
      status: 'APPROVED',
      otType: 'LATE',
      regularHours: 4, // 18:00-22:00
      lateHours: 1, //   22:00-23:00
      doubleHours: 0,
      hours: 5,
      foodAllowance: 15,
    });
  });

  it('freezes both double buckets when the window crosses the threshold', async () => {
    await build();
    // Move the stored window onto Sunday 16 August 2026, keeping everything
    // else about the row as it was.
    const stored = (await prisma.overtimeRequest.findUnique({})) as Record<
      string,
      unknown
    >;
    prisma.overtimeRequest.findUnique.mockResolvedValue({
      ...stored,
      date: new Date('2026-08-16T00:00:00Z'),
      startTime: new Date('2026-08-16T18:00:00Z'),
      endTime: new Date('2026-08-16T23:00:00Z'),
    });

    await service.approve('ot-1', 'user-1', principal);
    expect(written.last).toMatchObject({
      status: 'APPROVED',
      otType: 'DOUBLE_LATE',
      dayType: 'SUNDAY',
      hours: 5,
      doubleHours: 4, // 18:00-22:00 at the double rate
      doubleLateHours: 1, // 22:00-23:00 at the double-late rate
      regularHours: 0,
      lateHours: 0,
    });
  });

  it('never names siteAllowance, which has nothing to recompute it from', async () => {
    await build();
    await service.approve('ot-1', 'user-1', principal);
    const persisted = written.last;
    expect(persisted).not.toHaveProperty('siteAllowance');
  });

  it('refuses once the resolved policy has turned the employee ineligible', async () => {
    await build({ eligible: false });
    await expect(
      service.approve('ot-1', 'user-1', principal),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('OvertimeService — approver corrections', () => {
  let service: OvertimeService;
  let auditLog: { create: jest.Mock };
  const written = {
    last: {} as Record<string, unknown>,
    all: [] as Record<string, unknown>[],
  };

  /** The edit is written first, the approval second. */
  const edit = () => written.all[0];

  beforeEach(async () => {
    written.last = {};
    written.all = [];
    auditLog = { create: jest.fn().mockResolvedValue({}) };

    const prisma = {
      employee: {
        findUnique: jest.fn().mockResolvedValue({
          branchId: null,
          overtimePolicyId: null,
          employmentType: null,
          departmentId: 'dep-1',
        }),
      },
      overtimeRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ot-1',
          employeeId: 'emp-1',
          status: 'PENDING',
          date: new Date('2026-08-19T00:00:00Z'),
          startTime: new Date('2026-08-19T18:00:00Z'),
          endTime: new Date('2026-08-19T23:00:00Z'),
          otType: 'LATE',
          regularHours: 4,
          lateHours: 1,
          doubleHours: 0,
          doubleLateHours: 0,
          hours: 5,
          foodAllowance: 0,
          siteAllowance: 0,
          siteAllowanceNote: null,
          foodAllowanceOverride: null,
          originalStartTime: null,
          overtimePolicyId: null,
          approverNote: null,
          updatedAt: new Date('2026-08-19T10:00:00Z'),
          employee: EMPLOYEE_CARD,
        }),
        update: writeSpy(written),
        aggregate: jest.fn().mockResolvedValue({ _sum: { hours: 0 } }),
      },
      // Only the site-allowance switch is turned on; every other overtime
      // setting falls back to its default.
      systemSetting: {
        findUnique: jest.fn(({ where }: { where: { key: string } }) =>
          Promise.resolve(
            where.key === 'overtime_site_allowance_enabled'
              ? { value: 'true' }
              : null,
          ),
        ),
      },
      auditLog,
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        OvertimeService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemSettingsService, useValue: settingsMock() },
        { provide: ApprovalEngineService, useValue: engineMock() },
        { provide: AttendanceCalendarService, useValue: calendarMock() },
        { provide: OvertimePolicyService, useValue: policyMock() },
      ],
    }).compile();
    service = moduleRef.get(OvertimeService);
  });

  const principal = {
    id: 'user-1',
    email: 'hr@example.com',
    role: UserRole.ADMIN,
    employeeId: 'emp-9',
    departmentId: null,
    branchId: null,
  };

  it('stores the grounds for a site allowance beside the amount', async () => {
    await service.approve('ot-1', 'user-1', principal, {
      siteAllowance: 5,
      siteAllowanceNote: 'Offshore platform, night access',
    });
    expect(edit()).toMatchObject({
      siteAllowance: 5,
      siteAllowanceNote: 'Offshore platform, night access',
    });
  });

  it('grants zero when a note arrives without an amount', async () => {
    await service.approve('ot-1', 'user-1', principal, {
      siteAllowanceNote: 'Recorded, but nothing is owed',
    });
    expect(edit()).toMatchObject({
      siteAllowance: 0,
      siteAllowanceNote: 'Recorded, but nothing is owed',
    });
  });

  it('clears the note when the allowance is set without one', async () => {
    await service.approve('ot-1', 'user-1', principal, { siteAllowance: 3 });
    expect(edit()).toMatchObject({ siteAllowance: 3, siteAllowanceNote: null });
  });

  it('carries the note into the audit trail on both sides of the edit', async () => {
    await service.approve('ot-1', 'user-1', principal, {
      siteAllowance: 5,
      siteAllowanceNote: 'Offshore platform, night access',
    });
    const entries = auditLog.create.mock.calls.flat() as {
      data: { metadata: { before: unknown; after: unknown } };
    }[];
    const entry = entries[0];
    expect(entry.data.metadata.before).toMatchObject({
      siteAllowanceNote: null,
    });
    expect(entry.data.metadata.after).toMatchObject({
      siteAllowanceNote: 'Offshore platform, night access',
    });
  });

  it('leaves the site allowance untouched on a plain approve', async () => {
    await service.approve('ot-1', 'user-1', principal);
    // Nothing was edited, so the only write is the approval — and it never
    // names siteAllowance, which has nothing to recompute it from.
    expect(written.all).toHaveLength(1);
    expect(written.all[0]).not.toHaveProperty('siteAllowanceNote');
  });
});
