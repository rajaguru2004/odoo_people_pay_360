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
import {
  resolvedFromGlobal,
  type ResolvedOvertimeConfig,
} from '../overtime-policy/overtime-policy.types';
import { OvertimeService } from './overtime.service';

/**
 * The approver edit: correcting a request while approving it.
 *
 * Two properties are load-bearing and both are covered here:
 *
 *  • the correction is PERSISTED BEFORE the decision, so the finalize step
 *    recomputes from the corrected window rather than the filed one;
 *  • the food-allowance override is NULLABLE, because "did not touch it" and
 *    "set it to zero" are different facts.
 */

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

const UPDATED_AT = new Date('2026-08-20T11:04:22.581Z');

const STORED = {
  id: 'ot-1',
  employeeId: 'emp-1',
  date: new Date('2026-08-19T00:00:00.000Z'),
  startTime: new Date('2026-08-19T17:00:00.000Z'),
  endTime: new Date('2026-08-19T21:00:00.000Z'),
  hours: 4,
  regularHours: 4,
  lateHours: 0,
  doubleHours: 0,
  doubleLateHours: 0,
  dayType: OvertimeDayType.WEEKDAY,
  otType: OvertimeType.REGULAR,
  foodAllowance: 0,
  siteAllowance: 5,
  foodAllowanceOverride: null as number | null,
  approverNote: null,
  originalStartTime: null as Date | null,
  originalEndTime: null as Date | null,
  overtimePolicyId: null,
  status: RequestStatus.PENDING,
  updatedAt: UPDATED_AT,
  employee: EMPLOYEE,
};

async function baseConfig(
  overrides: Partial<ResolvedOvertimeConfig> = {},
): Promise<ResolvedOvertimeConfig> {
  const settings = {
    get: (key: string) => Promise.resolve(OVERTIME_SETTING_DEFAULTS[key]),
  } as unknown as SystemSettingsService;
  return {
    ...resolvedFromGlobal(await loadOvertimeConfig(settings)),
    maxHoursPerDay: 8,
    ...overrides,
  };
}

function makeHarness(options: {
  cfg: ResolvedOvertimeConfig;
  stored?: Record<string, unknown>;
  monthlyHours?: number;
}) {
  let current = { ...STORED, ...(options.stored ?? {}) };

  const overtimeRequest = {
    findUnique: jest.fn(() => Promise.resolve(current)),
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      // The real update returns the NEW row, and the finalize step re-reads it.
      // Mirroring that is the only way the ordering property is testable.
      current = { ...current, ...data };
      return Promise.resolve({ ...current, employee: EMPLOYEE });
    }),
    aggregate: jest
      .fn()
      .mockResolvedValue({ _sum: { hours: options.monthlyHours ?? 0 } }),
  };

  const prisma = {
    overtimeRequest,
    employee: { findUnique: jest.fn().mockResolvedValue(EMPLOYEE) },
    department: { findMany: jest.fn().mockResolvedValue([]) },
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
    isHoliday: jest.fn().mockResolvedValue(false),
    isWeeklyOff: jest.fn().mockResolvedValue(false),
  } as unknown as WorkingDaysService;

  return {
    service: new OvertimeService(
      prisma as unknown as PrismaService,
      policies,
      systemSettings,
      workingDays,
    ),
    overtimeRequest,
    row: () => current,
  };
}

describe('the correction is written before the decision', () => {
  it('recomputes the buckets from the CORRECTED window, not the filed one', async () => {
    const { service, overtimeRequest } = makeHarness({
      cfg: await baseConfig(),
    });

    await service.approve('ot-1', HR, {
      startTime: '2026-08-19T17:00:00Z',
      endTime: '2026-08-19T23:00:00Z',
      approverNote: 'Gate log shows 23:00.',
    });

    const [editCall, finalizeCall] = overtimeRequest.update.mock.calls as Array<
      [{ data: Record<string, any> }]
    >;
    // First write: the times and the note. The tier buckets are deliberately
    // absent — they are derived, and the finalize step owns them.
    expect((editCall[0].data.endTime as Date).toISOString()).toBe(
      '2026-08-19T23:00:00.000Z',
    );
    expect(editCall[0].data.regularHours).toBeUndefined();

    // Second write: the decision, priced against the corrected six hours.
    expect(finalizeCall[0].data.status).toBe(RequestStatus.APPROVED);
    expect(finalizeCall[0].data.hours).toBe(6);
    expect(finalizeCall[0].data.regularHours).toBe(5);
    expect(finalizeCall[0].data.lateHours).toBe(1);
    expect(finalizeCall[0].data.otType).toBe(OvertimeType.LATE);
  });

  it('snapshots what the employee filed, on the FIRST edit only', async () => {
    const { service, overtimeRequest } = makeHarness({
      cfg: await baseConfig(),
    });

    await service.approve('ot-1', HR, { endTime: '2026-08-19T22:00:00Z' });

    const editCall = overtimeRequest.update.mock.calls[0][0].data as Record<
      string,
      Date
    >;
    expect(editCall.originalStartTime.toISOString()).toBe(
      '2026-08-19T17:00:00.000Z',
    );
    expect(editCall.originalEndTime.toISOString()).toBe(
      '2026-08-19T21:00:00.000Z',
    );
  });

  it('leaves an existing snapshot alone on a second edit', async () => {
    // Otherwise a second approver's correction overwrites the original with an
    // already-edited value, and what the employee actually filed is gone.
    const { service, overtimeRequest } = makeHarness({
      cfg: await baseConfig(),
      stored: {
        originalStartTime: new Date('2026-08-19T16:00:00.000Z'),
        originalEndTime: new Date('2026-08-19T20:00:00.000Z'),
      },
    });

    await service.approve('ot-1', HR, { endTime: '2026-08-19T22:00:00Z' });

    expect(
      overtimeRequest.update.mock.calls[0][0].data.originalStartTime,
    ).toBeUndefined();
  });

  it('does not write an edit at all for a plain approve', async () => {
    const { service, overtimeRequest } = makeHarness({
      cfg: await baseConfig(),
    });
    await service.approve('ot-1', HR);
    expect(overtimeRequest.update).toHaveBeenCalledTimes(1);
    expect(overtimeRequest.update.mock.calls[0][0].data.status).toBe(
      RequestStatus.APPROVED,
    );
  });
});

describe('the food-allowance override', () => {
  it('records a 0 rather than treating it as absent', async () => {
    const { service, overtimeRequest } = makeHarness({
      cfg: await baseConfig(),
    });

    await service.approve('ot-1', HR, {
      startTime: '2026-08-19T17:00:00Z',
      endTime: '2026-08-19T23:00:00Z',
      foodAllowance: 0,
    });

    const editCall = overtimeRequest.update.mock.calls[0][0].data;
    expect(editCall.foodAllowanceOverride).toBe(0);

    // And it survives the recompute, which would otherwise have granted 3.
    const finalizeCall = overtimeRequest.update.mock.calls[1][0].data;
    expect(finalizeCall.foodAllowance).toBe(0);
  });

  it('refuses an override when the policy pays no food allowance at all', async () => {
    // Overriding it there would be inventing a payment the policy does not have.
    const { service } = makeHarness({
      cfg: await baseConfig({ foodAllowanceEnabled: false }),
    });
    await expect(
      service.approve('ot-1', HR, { foodAllowance: 5 }),
    ).rejects.toThrow(/Food allowance is disabled/);
  });
});

describe('the site allowance', () => {
  it('is refused while the company has it switched off', async () => {
    const { service } = makeHarness({ cfg: await baseConfig() });
    await expect(
      service.approve('ot-1', HR, { siteAllowance: 5 }),
    ).rejects.toThrow(/Site allowance is disabled/);
  });

  it('is capped, with 0 meaning no ceiling', async () => {
    const capped = makeHarness({
      cfg: await baseConfig({
        siteAllowanceEnabled: true,
        siteAllowanceMax: 10,
      }),
    });
    await expect(
      capped.service.approve('ot-1', HR, { siteAllowance: 25 }),
    ).rejects.toThrow(/exceeds the maximum of 10/);

    const uncapped = makeHarness({
      cfg: await baseConfig({
        siteAllowanceEnabled: true,
        siteAllowanceMax: 0,
      }),
    });
    await expect(
      uncapped.service.approve('ot-1', HR, { siteAllowance: 25 }),
    ).resolves.toBeDefined();
  });

  it('survives the approval recompute untouched', async () => {
    const { service, overtimeRequest } = makeHarness({
      cfg: await baseConfig({ siteAllowanceEnabled: true }),
    });

    await service.approve('ot-1', HR, {
      siteAllowance: 25,
      siteAllowanceNote: 'Offshore rig',
    });

    expect(overtimeRequest.update.mock.calls[0][0].data.siteAllowance).toBe(25);
    // The finalize payload must never name it, or every approval zeroes it.
    expect(
      'siteAllowance' in overtimeRequest.update.mock.calls[1][0].data,
    ).toBe(false);
  });
});

describe('validating the correction', () => {
  it('refuses a window that clamps to nothing', async () => {
    // An approver who moves a shift past the day boundary would otherwise
    // approve a request worth zero hours, and nobody finds out until the payslip.
    const { service } = makeHarness({
      cfg: await baseConfig({ dayEndBoundary: '18:00' }),
    });
    await expect(
      service.approve('ot-1', HR, {
        startTime: '2026-08-19T19:00:00Z',
        endTime: '2026-08-19T21:00:00Z',
      }),
    ).rejects.toThrow(/no payable overtime hours/);
  });

  it('holds the approver to the same outside-work-hours rule as the employee', async () => {
    const { service } = makeHarness({ cfg: await baseConfig() });
    await expect(
      service.approve('ot-1', HR, {
        startTime: '2026-08-19T14:00:00Z',
        endTime: '2026-08-19T21:00:00Z',
      }),
    ).rejects.toThrow(/outside regular working hours/);
  });

  it('refuses a correction above the daily cap', async () => {
    const { service } = makeHarness({
      cfg: await baseConfig({ maxHoursPerDay: 4 }),
    });
    await expect(
      service.approve('ot-1', HR, { endTime: '2026-08-19T23:00:00Z' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('excludes the row under edit from the period caps', async () => {
    // The row is itself PENDING and already inside the sum, so counting it would
    // charge the employee twice and refuse an edit that LOWERS the hours.
    const { service } = makeHarness({
      cfg: await baseConfig(),
      // 28 already filed this month, of which this request's 4 are part.
      monthlyHours: 28,
    });
    await expect(
      service.approve('ot-1', HR, { endTime: '2026-08-19T19:00:00Z' }),
    ).resolves.toBeDefined();
  });

  it('refuses an edit made against a stale version', async () => {
    // Two approvers can hold the same request open, and last-write-wins would let
    // one silently discard the other's correction.
    const { service } = makeHarness({ cfg: await baseConfig() });
    await expect(
      service.approve('ot-1', HR, {
        endTime: '2026-08-19T22:00:00Z',
        expectedUpdatedAt: '2026-08-20T10:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('accepts an edit made against the current version', async () => {
    const { service } = makeHarness({ cfg: await baseConfig() });
    await expect(
      service.approve('ot-1', HR, {
        endTime: '2026-08-19T22:00:00Z',
        expectedUpdatedAt: UPDATED_AT.toISOString(),
      }),
    ).resolves.toBeDefined();
  });

  it('refuses every edit while the company has approver edits switched off', async () => {
    const { service } = makeHarness({
      cfg: await baseConfig({ approverEditEnabled: false }),
    });
    await expect(
      service.approve('ot-1', HR, { endTime: '2026-08-19T22:00:00Z' }),
    ).rejects.toThrow(/Editing an overtime request/);
    // …but a plain approve still works.
    const plain = makeHarness({
      cfg: await baseConfig({ approverEditEnabled: false }),
    });
    await expect(plain.service.approve('ot-1', HR)).resolves.toBeDefined();
  });
});

describe('previewApproverEdit', () => {
  it('writes nothing and returns what the correction would produce', async () => {
    const { service, overtimeRequest } = makeHarness({
      cfg: await baseConfig(),
    });

    const preview = await service.previewApproverEdit(
      'ot-1',
      { endTime: '2026-08-19T23:00:00Z' },
      HR,
    );

    expect(overtimeRequest.update).not.toHaveBeenCalled();
    expect(preview).toMatchObject({
      hours: 6,
      regularHours: 5,
      lateHours: 1,
      otType: OvertimeType.LATE,
      foodAllowance: 3,
      // Carried, never recomputed.
      siteAllowance: 5,
      regularRate: 1.25,
      lateRate: 1.5,
    });
  });

  it('refuses a caller who could not approve the request either', async () => {
    const { service } = makeHarness({ cfg: await baseConfig() });
    await expect(
      service.previewApproverEdit(
        'ot-1',
        { endTime: '2026-08-19T23:00:00Z' },
        {
          id: 'user-other',
          email: 'other@peoplepay360.com',
          role: 'EMPLOYEE',
          employeeId: 'emp-other',
          departmentId: 'dept-it',
          branchId: 'branch-1',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
