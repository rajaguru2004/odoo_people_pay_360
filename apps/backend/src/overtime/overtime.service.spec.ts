import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OvertimeService } from './overtime.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import { NotificationsService } from '../notifications/notifications.service';
import { HolidaysService } from '../holidays/holidays.service';
import { OvertimePolicyService } from '../overtime-policy/overtime-policy.service';
import { AuditService } from '../audit/audit.service';

// Engine disengaged => approve/reject take the legacy single-approver path,
// which is what these breakdown tests exercise.
const engineMock = () => ({
  initiate: jest.fn().mockResolvedValue({ engaged: false, finalized: false }),
  decide: jest.fn().mockResolvedValue({ engaged: false, finalized: false }),
});
const notifyMock = () => ({ notifyUser: jest.fn(), notifyUsers: jest.fn() });

// Holidays engine: no holidays; rest day = Sunday (getUTCDay()===0), matching the
// pre-policy default. Tests override isHoliday to exercise holiday classification.
const holidaysMock = () => ({
  isHoliday: jest.fn().mockResolvedValue(false),
  isWeeklyOff: jest
    .fn()
    .mockImplementation((d: Date) => Promise.resolve(d.getUTCDay() === 0)),
});

// Policy engine disengaged: the effective config is the legacy global config,
// so these classification tests keep exercising the global overtime settings.
const otPolicyMock = (settings: any) => ({
  resolveOvertimeConfig: jest.fn().mockImplementation(async () => ({
    ...(await settings.getOvertimeConfig()),
    eligible: true,
    holidayBehavior: 'STANDARD',
    dayEndBoundary: null,
    policyId: null,
    policyName: null,
  })),
});

/**
 * Classification coverage for the Singapore overtime rules (shift 08:00–17:00):
 *
 *   1.8  Food allowance — none for OT 17:00–22:00; paid once OT ends after 22:00.
 *   1.11 Double OT       — 2× on Sundays / Public Holidays; 1.5× weekday after 17:00.
 *
 * Plus the Step-1 daily-cap fix: a full rest-day shift (9h) is accepted on a
 * double-OT day but rejected on a normal weekday.
 *
 * Prisma / Mail / SystemSettings are mocked; the real create() logic runs.
 */
describe('OvertimeService — request classification (SG rules)', () => {
  let service: OvertimeService;
  let prisma: any;
  let settings: any;
  let holidays: any;
  let otPolicy: any;

  const CFG = {
    enabled: true,
    lateThreshold: '22:00Z',
    foodAllowanceEnabled: true,
    foodAllowanceThreshold: '22:00Z',
    foodAllowanceAmount: 150,
    regularRate: 1.5,
    lateRate: 1.5,
    doubleOtEnabled: true,
    doubleRate: 2,
    shiftEndTime: '17:00Z',
    doubleFoodAllowanceAnyTime: false,
    doubleOtAllowAnytime: true,
    maxHoursPerDay: 8,
    maxHoursPerDoubleDay: 12,
    maxHoursPerMonth: 40,
    maxHoursPerYear: 200,
    requireManagerApproval: true,
    allowEmployeeSubmit: true,
  };

  beforeEach(async () => {
    prisma = {
      employee: { findUnique: jest.fn().mockResolvedValue({ id: 'emp-1' }) },
      overtimeRequest: {
        findFirst: jest.fn().mockResolvedValue(null), // no existing request for the date
        aggregate: jest.fn().mockResolvedValue({ _sum: { hours: 0 } }), // monthly/yearly totals
        create: jest.fn().mockImplementation(async (args: any) => ({ id: 'ot-1', ...args.data })),
      },
      holiday: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    settings = {
      getOvertimeConfig: jest.fn().mockResolvedValue({ ...CFG }),
      getSetting: jest.fn().mockImplementation((key: string) => {
        if (key === 'attendance_day_end_time') return Promise.resolve('23:59');
        return Promise.resolve('08:00'); // office_start_time
      }),
    };
    holidays = holidaysMock();
    otPolicy = otPolicyMock(settings);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        OvertimeService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: {} },
        { provide: SystemSettingsService, useValue: settings },
        { provide: ApprovalEngineService, useValue: engineMock() },
        { provide: NotificationsService, useValue: notifyMock() },
        { provide: HolidaysService, useValue: holidays },
        { provide: OvertimePolicyService, useValue: otPolicy },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(OvertimeService);
  });

  // Build a same-day OT DTO. Times are UTC wall-clock (`Z`) so the service's
  // getUTCDay()/getUTCHours() reads yield the intended day and hours in ANY
  // runner timezone.
  const dto = (date: string, startH: number, endH: number, hours: number) => ({
    date: `${date}T12:00:00Z`,
    startTime: `${date}T${String(startH).padStart(2, '0')}:00:00Z`,
    endTime: `${date}T${String(endH).padStart(2, '0')}:00:00Z`,
    hours,
    reason: 'test',
  });
  const created = () => prisma.overtimeRequest.create.mock.calls[0][0].data;

  it('REGULAR: weekday 17:00–19:00 → REGULAR, no food', async () => {
    await service.create('emp-1', dto('2026-08-04', 17, 19, 2), 'ADMIN');
    expect(created()).toMatchObject({ otType: 'REGULAR', foodAllowance: 0 });
  });

  it('LATE: weekday 17:00–23:00 (ends after 22:00) → LATE + food', async () => {
    await service.create('emp-1', dto('2026-08-19', 17, 23, 6), 'ADMIN');
    expect(created()).toMatchObject({ otType: 'LATE', foodAllowance: 150 });
  });

  it('boundary: weekday 17:00–22:00 (ends exactly at 22:00) → REGULAR, no food', async () => {
    await service.create('emp-1', dto('2026-08-19', 17, 22, 5), 'ADMIN');
    expect(created()).toMatchObject({ otType: 'REGULAR', foodAllowance: 0 });
  });

  // ── Overnight shift crossing midnight (same-calendar-date payload) ─────────
  it('OVERNIGHT: end time <= start time on the same date is treated as crossing midnight, not rejected', async () => {
    // 23:00 -> 02:00 "next day", but sent on the SAME calendar date, exactly
    // how a naive client (or the old buggy frontend) would build the payload.
    await expect(
      service.create('emp-1', dto('2026-08-19', 23, 2, 3), 'ADMIN'),
    ).resolves.toBeDefined();
    // Default attendance_day_end_time (23:59) clamps the rolled-forward
    // 02:00-next-day end back to 23:59 the same night, so only ~0.98h of the
    // 3h requested is actually payable — clamped, not rejected outright.
    expect(created()).toMatchObject({
      otType: 'LATE',
      regularHours: 0,
      lateHours: 0.98,
      hours: 0.98,
      foodAllowance: 150,
    });
  });

  it('DOUBLE: Sunday full shift 08:00–17:00 → DOUBLE (2×), no food', async () => {
    await service.create('emp-1', dto('2026-08-16', 8, 17, 9), 'ADMIN');
    expect(created()).toMatchObject({ otType: 'DOUBLE', foodAllowance: 0 });
  });

  it('DOUBLE_LATE: public holiday 17:00–23:00 → DOUBLE_LATE (2×) + food', async () => {
    holidays.isHoliday.mockResolvedValue(true); // Aug 10 is a holiday (branch-aware)
    await service.create('emp-1', dto('2026-08-10', 17, 23, 6), 'ADMIN');
    expect(created()).toMatchObject({ otType: 'DOUBLE_LATE', foodAllowance: 150 });
  });

  // ── Overtime Policy: holidayBehavior ────────────────────────────────────────
  it('STANDARD policy: holiday 17:00–19:00 → DOUBLE (holiday premium)', async () => {
    holidays.isHoliday.mockResolvedValue(true); // Aug 10 is a holiday
    await service.create('emp-1', dto('2026-08-10', 17, 19, 2), 'ADMIN');
    expect(created()).toMatchObject({ otType: 'DOUBLE', dayType: 'HOLIDAY' });
  });

  it('IGNORE policy (daily-wage): a National Holiday is treated as an ordinary weekday', async () => {
    // Aug 10 2026 IS a holiday, but the resolved policy ignores holidays.
    holidays.isHoliday.mockResolvedValue(true);
    otPolicy.resolveOvertimeConfig.mockResolvedValue({
      ...CFG,
      eligible: true,
      holidayBehavior: 'IGNORE',
      dayEndBoundary: null,
      policyId: 'daily-wage',
      policyName: 'Daily Wage OT',
    });
    await service.create('emp-1', dto('2026-08-10', 17, 19, 2), 'ADMIN');
    // No holiday premium: classified WEEKDAY, paid at the regular weekday tier,
    // and the governing policy is snapshotted on the row.
    expect(created()).toMatchObject({
      otType: 'REGULAR',
      dayType: 'WEEKDAY',
      regularHours: 2,
      doubleHours: 0,
      overtimePolicyId: 'daily-wage',
    });
    // isHoliday() is never consulted when the policy ignores holidays.
    expect(holidays.isHoliday).not.toHaveBeenCalled();
  });

  it('blocks overtime when the resolved policy marks the employee ineligible', async () => {
    otPolicy.resolveOvertimeConfig.mockResolvedValue({
      ...CFG,
      eligible: false,
      holidayBehavior: 'STANDARD',
      dayEndBoundary: null,
      policyId: 'no-ot',
      policyName: 'No OT',
    });
    await expect(
      service.create('emp-1', dto('2026-08-04', 17, 19, 2), 'ADMIN'),
    ).rejects.toThrow(/not eligible/i);
  });

  it('food disabled: late weekday OT stays LATE but foodAllowance 0', async () => {
    settings.getOvertimeConfig.mockResolvedValue({ ...CFG, foodAllowanceEnabled: false });
    await service.create('emp-1', dto('2026-08-19', 17, 23, 6), 'ADMIN');
    expect(created()).toMatchObject({ otType: 'LATE', foodAllowance: 0 });
  });

  // ── Configurable food-allowance threshold (decoupled from pay-rate late threshold) ──
  it('food threshold 21:00: weekday 17:00–21:30 (past food threshold, before late) → REGULAR pay tier but food paid', async () => {
    settings.getOvertimeConfig.mockResolvedValue({ ...CFG, foodAllowanceThreshold: '21:00' });
    // ends 21:30 — before the 22:00 late pay-rate threshold, after the 21:00 food threshold
    await service.create('emp-1', {
      date: '2026-08-19T12:00:00Z',
      startTime: '2026-08-19T17:00:00Z',
      endTime: '2026-08-19T21:30:00Z',
      hours: 4.5,
      reason: 'test',
    }, 'ADMIN');
    expect(created()).toMatchObject({ otType: 'REGULAR', foodAllowance: 150 });
  });

  it('food threshold 23:00: weekday 17:00–22:30 (past late, before food threshold) → LATE pay tier but no food', async () => {
    settings.getOvertimeConfig.mockResolvedValue({ ...CFG, foodAllowanceThreshold: '23:00' });
    // ends 22:30 — after the 22:00 late pay-rate threshold, before the 23:00 food threshold
    await service.create('emp-1', {
      date: '2026-08-19T12:00:00Z',
      startTime: '2026-08-19T17:00:00Z',
      endTime: '2026-08-19T22:30:00Z',
      hours: 5.5,
      reason: 'test',
    }, 'ADMIN');
    expect(created()).toMatchObject({ otType: 'LATE', foodAllowance: 0 });
  });

  it('food threshold boundary: ends exactly at threshold → no food (strictly after required)', async () => {
    settings.getOvertimeConfig.mockResolvedValue({ ...CFG, foodAllowanceThreshold: '21:00' });
    await service.create('emp-1', {
      date: '2026-08-19T12:00:00Z',
      startTime: '2026-08-19T17:00:00Z',
      endTime: '2026-08-19T21:00:00Z',
      hours: 4,
      reason: 'test',
    }, 'ADMIN');
    expect(created()).toMatchObject({ foodAllowance: 0 });
  });

  it('falls back to 22:00 on unset/blank food threshold', async () => {
    settings.getOvertimeConfig.mockResolvedValue({ ...CFG, foodAllowanceThreshold: '' });
    await service.create('emp-1', dto('2026-08-19', 17, 23, 6), 'ADMIN');
    expect(created()).toMatchObject({ otType: 'LATE', foodAllowance: 150 });
  });

  // ── Per-tier hour split (regular portion vs late portion) ───────────────────
  it('SPLIT: weekday 17:00–23:00, late threshold 22:00 → 5h regular + 1h late', async () => {
    await service.create('emp-1', dto('2026-08-19', 17, 23, 6), 'ADMIN');
    expect(created()).toMatchObject({
      otType: 'LATE',
      regularHours: 5, // 17:00–22:00
      lateHours: 1, //   22:00–23:00
      doubleHours: 0,
      hours: 6,
      foodAllowance: 150,
    });
  });

  it('SPLIT: weekday 17:00–21:00 fully before threshold → 4h regular, 0 late', async () => {
    await service.create('emp-1', dto('2026-08-19', 17, 21, 4), 'ADMIN');
    expect(created()).toMatchObject({
      otType: 'REGULAR',
      regularHours: 4,
      lateHours: 0,
      hours: 4,
    });
  });

  it('SPLIT: weekday starting after threshold 22:00–23:30 → 0 regular, 1.5 late', async () => {
    await service.create('emp-1', {
      date: '2026-08-19T12:00:00Z',
      startTime: '2026-08-19T22:00:00Z',
      endTime: '2026-08-19T23:30:00Z',
      hours: 1.5,
      reason: 'test',
    }, 'ADMIN');
    expect(created()).toMatchObject({ regularHours: 0, lateHours: 1.5, hours: 1.5 });
  });

  it('SPLIT: double-OT day puts all clamped hours in the double bucket', async () => {
    await service.create('emp-1', dto('2026-08-16', 8, 17, 9), 'ADMIN'); // Sunday
    expect(created()).toMatchObject({
      otType: 'DOUBLE',
      regularHours: 0,
      lateHours: 0,
      doubleHours: 9,
      hours: 9,
    });
  });

  // ── Attendance day boundary clamp ───────────────────────────────────────────
  it('BOUNDARY: boundary 23:00 trims a 20:00–24:00 shift to 20:00–23:00Z', async () => {
    settings.getSetting.mockImplementation((key: string) =>
      key === 'attendance_day_end_time'
        ? Promise.resolve('23:00')
        : Promise.resolve('08:00'),
    );
    // ends at 24:00 (00:00 next day); boundary 23:00 clamps it.
    await service.create('emp-1', {
      date: '2026-08-19T12:00:00Z',
      startTime: '2026-08-19T20:00:00Z',
      endTime: '2026-08-20T00:00:00Z',
      hours: 4,
      reason: 'test',
    }, 'ADMIN');
    // 20:00–22:00 regular (2h), 22:00–23:00 late (1h); the 23:00–24:00 hour is dropped.
    expect(created()).toMatchObject({
      regularHours: 2,
      lateHours: 1,
      hours: 3, // clamped, not the requested 4
    });
  });

  it('BOUNDARY: after-midnight boundary 02:00 keeps overnight hours on the same attendance day', async () => {
    settings.getSetting.mockImplementation((key: string) =>
      key === 'attendance_day_end_time'
        ? Promise.resolve('02:00')
        : Promise.resolve('08:00'),
    );
    // 22:00 → 01:00 next day; boundary 02:00 (next calendar day) → nothing trimmed.
    await service.create('emp-1', {
      date: '2026-08-19T12:00:00Z',
      startTime: '2026-08-19T22:00:00Z',
      endTime: '2026-08-20T01:00:00Z',
      hours: 3,
      reason: 'test',
    }, 'ADMIN');
    expect(created()).toMatchObject({ regularHours: 0, lateHours: 3, hours: 3 });
  });

  // ── Step-1 daily-cap fix ────────────────────────────────────────────────────
  it('rejects a 9h weekday OT — over the 8h weekday cap', async () => {
    await expect(
      service.create(
        'emp-1',
        {
          date: '2026-08-04T12:00:00Z', // Tuesday (local)
          startTime: '2026-08-04T18:00:00Z',
          endTime: '2026-08-05T03:00:00Z', // outside work hours, so the CAP is what rejects it
          hours: 9,
          reason: 'test',
        },
        'ADMIN',
      ),
    ).rejects.toThrow(/Daily overtime limit exceeded \(8h\)/);
  });

  it('accepts a 9h Sunday OT — under the 12h double-day cap', async () => {
    await service.create('emp-1', dto('2026-08-16', 8, 17, 9), 'ADMIN');
    expect(created()).toMatchObject({ otType: 'DOUBLE' });
  });
});

describe('OvertimeService — approve() recomputes breakdown from current settings', () => {
  let service: OvertimeService;
  let prisma: any;
  let settings: any;
  let holidays: any;

  const CFG = {
    enabled: true,
    lateThreshold: '22:00',
    foodAllowanceEnabled: true,
    foodAllowanceThreshold: '22:00',
    foodAllowanceAmount: 150,
    regularRate: 1.5,
    lateRate: 2,
    doubleOtEnabled: true,
    doubleRate: 2,
    shiftEndTime: '17:00',
    doubleFoodAllowanceAnyTime: false,
    doubleOtAllowAnytime: true,
    maxHoursPerDay: 8,
    maxHoursPerDoubleDay: 12,
    maxHoursPerMonth: 40,
    maxHoursPerYear: 200,
    requireManagerApproval: true,
    allowEmployeeSubmit: true,
  };

  beforeEach(async () => {
    prisma = {
      // Stored request is STALE: persisted as REGULAR with no food, but the
      // window (18:00–23:00) is actually LATE + food under current rules.
      overtimeRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ot-1',
          employeeId: 'emp-1',
          status: 'PENDING',
          date: new Date('2026-08-19T00:00:00Z'), // Wednesday
          startTime: new Date('2026-08-19T18:00:00Z'),
          endTime: new Date('2026-08-19T23:00:00Z'),
          otType: 'REGULAR',
          regularHours: 5,
          lateHours: 0,
          doubleHours: 0,
          foodAllowance: 0,
          hours: 5,
          employee: { branchId: null, email: 'e@x.com', fullName: 'E' },
        }),
        update: jest.fn().mockImplementation(async (args: any) => ({ id: 'ot-1', ...args.data })),
      },
      employee: {
        findUnique: jest.fn().mockResolvedValue({
          branchId: null,
          employmentType: 'MONTHLY',
          overtimePolicyId: null,
        }),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ employee: { fullName: 'Mgr' } }) },
    };
    settings = {
      getOvertimeConfig: jest.fn().mockResolvedValue({ ...CFG }),
      getSetting: jest.fn().mockImplementation((key: string) =>
        key === 'attendance_day_end_time' ? Promise.resolve('23:59') : Promise.resolve('08:00'),
      ),
    };
    holidays = holidaysMock();
    const mail = { sendOvertimeApproved: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        OvertimeService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: mail },
        { provide: SystemSettingsService, useValue: settings },
        { provide: ApprovalEngineService, useValue: engineMock() },
        { provide: NotificationsService, useValue: notifyMock() },
        { provide: HolidaysService, useValue: holidays },
        { provide: OvertimePolicyService, useValue: otPolicyMock(settings) },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(OvertimeService);
  });

  it('persists the corrected LATE + food breakdown on approval', async () => {
    await service.approve('ot-1', 'approver-1', { role: 'ADMIN' });
    const persisted = prisma.overtimeRequest.update.mock.calls[0][0].data;
    expect(persisted).toMatchObject({
      status: 'APPROVED',
      otType: 'LATE',
      regularHours: 4, // 18:00–22:00
      lateHours: 1, //   22:00–23:00
      doubleHours: 0,
      hours: 5,
      foodAllowance: 150,
    });
  });
});

/**
 * Eligibility is a per-policy gate, and it is re-evaluated at approval — a
 * policy edit (or a reassignment) between submission and approval must not let
 * an ineligible employee's hours reach payroll.
 */
describe('OvertimeService — eligibility is re-checked at approval', () => {
  let service: OvertimeService;
  let prisma: any;
  let otPolicy: any;

  beforeEach(async () => {
    prisma = {
      overtimeRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ot-1',
          employeeId: 'emp-1',
          status: 'PENDING',
          date: new Date('2026-08-19T00:00:00Z'),
          startTime: new Date('2026-08-19T18:00:00Z'),
          endTime: new Date('2026-08-19T20:00:00Z'),
          hours: 2,
          employee: { branchId: null, email: 'e@x.com', fullName: 'E' },
        }),
        update: jest.fn().mockImplementation(async (args: any) => ({ id: 'ot-1', ...args.data })),
      },
      employee: {
        findUnique: jest.fn().mockResolvedValue({
          branchId: null,
          employmentType: 'Daily Wage',
          overtimePolicyId: null,
        }),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ employee: { fullName: 'Mgr' } }) },
    };
    const settings = {
      getOvertimeConfig: jest.fn().mockResolvedValue({
        enabled: true,
        lateThreshold: '22:00',
        foodAllowanceEnabled: false,
        foodAllowanceThreshold: '22:00',
        foodAllowanceAmount: 0,
        regularRate: 1.5,
        lateRate: 2,
        doubleOtEnabled: true,
        doubleRate: 2,
        shiftEndTime: '17:00',
        doubleFoodAllowanceAnyTime: false,
        doubleOtAllowAnytime: true,
        maxHoursPerDay: 8,
        maxHoursPerDoubleDay: 12,
        maxHoursPerMonth: 40,
        maxHoursPerYear: 200,
        requireManagerApproval: true,
        allowEmployeeSubmit: true,
      }),
      getSetting: jest.fn().mockResolvedValue('23:59'),
    };
    otPolicy = otPolicyMock(settings);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        OvertimeService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: { sendOvertimeApproved: jest.fn() } },
        { provide: SystemSettingsService, useValue: settings },
        { provide: ApprovalEngineService, useValue: engineMock() },
        { provide: NotificationsService, useValue: notifyMock() },
        { provide: HolidaysService, useValue: holidaysMock() },
        { provide: OvertimePolicyService, useValue: otPolicy },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(OvertimeService);
  });

  it('rejects approval once the resolved policy turns ineligible', async () => {
    otPolicy.resolveOvertimeConfig.mockResolvedValue({
      eligible: false,
      holidayBehavior: 'STANDARD',
      dayEndBoundary: null,
      policyId: 'p-ineligible',
      policyName: 'No OT',
    });
    await expect(
      service.approve('ot-1', 'approver-1', { role: 'ADMIN' }),
    ).rejects.toThrow(/no longer eligible/i);
    expect(prisma.overtimeRequest.update).not.toHaveBeenCalled();
  });

  it('approves normally while the policy stays eligible', async () => {
    await service.approve('ot-1', 'approver-1', { role: 'ADMIN' });
    expect(prisma.overtimeRequest.update.mock.calls[0][0].data.status).toBe(
      'APPROVED',
    );
  });
});
