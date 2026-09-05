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
 * The detail screen's server-computed preview.
 *
 * It exists because the browser cannot answer the question: the figure depends
 * on the employee's overtime policy and on the branch-aware day classification,
 * neither of which the page has. A client-side recompute reads the global
 * settings, so a request the server classified LATE with a food allowance
 * rendered REGULAR with a blank allowance on the very page that decides it.
 *
 * A PENDING request previews what approval WILL persist. A DECIDED one shows the
 * FROZEN numbers, monetized by the policy snapshot the row carries — recomputing
 * those would show an approver a figure that no longer matches the payslip.
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

const SELF: Principal = {
  id: 'user-self',
  email: 'ravi@peoplepay360.com',
  role: 'EMPLOYEE',
  employeeId: 'emp-1',
  departmentId: 'dept-ops',
  branchId: 'branch-1',
};

async function config(
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

const ROW = {
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
  foodAllowanceOverride: null as number | null,
  overtimePolicyId: null as string | null,
  status: RequestStatus.PENDING,
  updatedAt: new Date('2026-08-20T11:04:22.581Z'),
  employee: EMPLOYEE,
};

function makeService(options: {
  row: Record<string, unknown>;
  liveConfig: ResolvedOvertimeConfig;
  snapshotConfig?: ResolvedOvertimeConfig;
  isWeeklyOff?: boolean;
  isHoliday?: boolean;
  resolveThrows?: boolean;
}) {
  const prisma = {
    overtimeRequest: {
      findUnique: jest.fn().mockResolvedValue(options.row),
    },
    employee: { findUnique: jest.fn().mockResolvedValue(EMPLOYEE) },
    department: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;

  const policies = {
    resolveOvertimeConfig: jest.fn(() =>
      options.resolveThrows
        ? Promise.reject(new Error('policy lookup failed'))
        : Promise.resolve(options.liveConfig),
    ),
    configForPolicyId: jest
      .fn()
      .mockResolvedValue(options.snapshotConfig ?? options.liveConfig),
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

  return new OvertimeService(prisma, policies, systemSettings, workingDays);
}

describe('a pending request', () => {
  it('previews what approval would persist, with the rates that pay it', async () => {
    const service = makeService({ row: ROW, liveConfig: await config() });
    const detail = (await service.findOne('ot-1', HR, {
      withPreview: true,
    })) as { preview: Record<string, unknown> };

    expect(detail.preview).toMatchObject({
      hours: 6,
      regularHours: 5,
      lateHours: 1,
      otType: OvertimeType.LATE,
      foodAllowance: 3,
      siteAllowance: 5,
      isDoubleOtDay: false,
      regularRate: 1.25,
      lateRate: 1.5,
    });
  });

  it('classifies a rest day and uses that tier rates', async () => {
    const service = makeService({
      row: ROW,
      liveConfig: await config(),
      isWeeklyOff: true,
    });
    const detail = (await service.findOne('ot-1', HR, {
      withPreview: true,
    })) as { preview: Record<string, unknown> };

    expect(detail.preview).toMatchObject({
      dayType: OvertimeDayType.SUNDAY,
      isDoubleOtDay: true,
      doubleHours: 5,
      doubleLateHours: 1,
      regularHours: 0,
      doubleRate: 2,
      doubleLateRate: 2,
    });
  });

  it('shows an override rather than the policy figure', async () => {
    // The page must show what will actually be paid.
    const service = makeService({
      row: { ...ROW, foodAllowanceOverride: 0 },
      liveConfig: await config(),
    });
    const detail = (await service.findOne('ot-1', HR, {
      withPreview: true,
    })) as { preview: Record<string, unknown> };

    expect(detail.preview.foodAllowance).toBe(0);
    expect(detail.preview.foodAllowanceOverride).toBe(0);
  });
});

describe('a decided request', () => {
  it('shows the FROZEN numbers, not a recompute under current rules', async () => {
    // The live config here would classify the window differently. An approver
    // shown that figure would be reading something that does not match the
    // payslip.
    const service = makeService({
      row: {
        ...ROW,
        status: RequestStatus.APPROVED,
        overtimePolicyId: 'policy-old',
        regularHours: 4,
        lateHours: 2,
        hours: 6,
      },
      liveConfig: await config({ lateThreshold: '18:00' }),
      snapshotConfig: await config({
        policyId: 'policy-old',
        policyName: 'Old',
      }),
    });

    const detail = (await service.findOne('ot-1', HR, {
      withPreview: true,
    })) as { preview: Record<string, unknown> };

    expect(detail.preview).toMatchObject({
      regularHours: 4,
      lateHours: 2,
      policyId: 'policy-old',
      policyName: 'Old',
    });
  });

  it('rebuilds a single bucket from otType for a row that predates the split', async () => {
    const service = makeService({
      row: {
        ...ROW,
        status: RequestStatus.APPROVED,
        regularHours: 0,
        lateHours: 0,
        doubleHours: 0,
        doubleLateHours: 0,
        hours: 6,
        otType: OvertimeType.LATE,
      },
      liveConfig: await config(),
    });

    const detail = (await service.findOne('ot-1', HR, {
      withPreview: true,
    })) as { preview: Record<string, unknown> };

    // Four zeroes would render as "you were paid for nothing".
    expect(detail.preview.lateHours).toBe(6);
    expect(detail.preview.regularHours).toBe(0);
  });
});

describe('failure and access', () => {
  it('degrades the preview to null rather than losing the request', async () => {
    const service = makeService({
      row: ROW,
      liveConfig: await config(),
      resolveThrows: true,
    });
    const detail = (await service.findOne('ot-1', HR, {
      withPreview: true,
    })) as { id: string; preview: unknown };

    expect(detail.id).toBe('ot-1');
    expect(detail.preview).toBeNull();
  });

  it('lets the employee read their own', async () => {
    const service = makeService({ row: ROW, liveConfig: await config() });
    await expect(service.findOne('ot-1', SELF)).resolves.toBeDefined();
  });

  it('refuses a colleague with no relationship to it', async () => {
    const service = makeService({ row: ROW, liveConfig: await config() });
    await expect(
      service.findOne('ot-1', {
        id: 'user-other',
        email: 'other@peoplepay360.com',
        role: 'EMPLOYEE',
        employeeId: 'emp-other',
        departmentId: 'dept-it',
        branchId: 'branch-1',
      }),
    ).rejects.toThrow(/do not have permission/);
  });
});
