import { Test, TestingModule } from '@nestjs/testing';
import { OvertimeService } from './overtime.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import { NotificationsService } from '../notifications/notifications.service';
import { HolidaysService } from '../holidays/holidays.service';
import { OvertimePolicyService } from '../overtime-policy/overtime-policy.service';
import { AuditService } from '../audit/audit.service';

/**
 * Regression: the overtime DETAIL page showed a blank food allowance (and a
 * REGULAR badge) for a request the LIST showed as LATE with an allowance.
 * Cause: the detail screen recomputed the breakdown in the browser from the
 * GLOBAL branding settings, which cannot see the employee's Overtime Policy
 * overrides. GET /overtime/:id now returns the engine's own breakdown, so the
 * two screens read the same rules.
 */
describe('OvertimeService.findOne — server-computed detail preview', () => {
  // Globals: late + food at 22:00, allowance 150. A request ending exactly at
  // 22:00 is REGULAR with no food under these — the wrong answer the browser
  // used to render.
  const GLOBAL_CFG = {
    enabled: true,
    lateThreshold: '22:00',
    foodAllowanceEnabled: true,
    foodAllowanceThreshold: '22:00',
    foodAllowanceAmount: 150,
    regularRate: 1.5,
    lateRate: 1.5,
    doubleOtEnabled: true,
    doubleRate: 2,
    sunday: { regularRate: 2, lateRate: 2.5, lateThreshold: '22:00' },
    holiday: { regularRate: 2, lateRate: 2.5, lateThreshold: '22:00' },
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

  // The employee's policy: late + food from 21:00, allowance S$4 — the rules
  // the server actually applied when it persisted LATE + 4.00.
  const POLICY_CFG = {
    ...GLOBAL_CFG,
    lateThreshold: '21:00',
    foodAllowanceThreshold: '21:00',
    foodAllowanceAmount: 4,
    eligible: true,
    holidayBehavior: 'STANDARD',
    dayEndBoundary: null,
    policyId: 'pol-1',
    policyName: 'Projects Ops',
  };

  const ROW = {
    id: 'ot-1',
    employeeId: 'emp-1',
    status: 'PENDING',
    date: new Date('2026-08-18T00:00:00Z'), // Tuesday
    startTime: new Date('2026-08-18T17:30:00Z'),
    endTime: new Date('2026-08-18T22:00:00Z'),
    hours: 4.5,
    regularHours: 4.5,
    lateHours: 0,
    doubleHours: 0,
    doubleLateHours: 0,
    dayType: 'WEEKDAY',
    foodAllowance: 4,
    otType: 'LATE',
    overtimePolicyId: 'pol-1',
    employee: { id: 'emp-1', branchId: null, departmentId: 'dep-1', email: 'e@x.com', fullName: 'E' },
  };

  const build = async (row: any, opts?: { restDay?: boolean }) => {
    const prisma = {
      overtimeRequest: { findUnique: jest.fn().mockResolvedValue(row) },
      employee: {
        findUnique: jest.fn().mockResolvedValue({
          branchId: null,
          employmentType: 'PERMANENT',
          overtimePolicyId: 'pol-1',
        }),
      },
    };
    const settings = {
      getOvertimeConfig: jest.fn().mockResolvedValue({ ...GLOBAL_CFG }),
      getSetting: jest.fn().mockImplementation((key: string) =>
        key === 'attendance_day_end_time' ? Promise.resolve('23:59') : Promise.resolve('08:00'),
      ),
    };
    const holidays = {
      isHoliday: jest.fn().mockResolvedValue(false),
      isWeeklyOff: jest.fn().mockResolvedValue(!!opts?.restDay),
    };
    const otPolicy = {
      resolveOvertimeConfig: jest.fn().mockResolvedValue({ ...POLICY_CFG }),
      configForPolicyId: jest.fn().mockResolvedValue({ ...POLICY_CFG }),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        OvertimeService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: {} },
        { provide: SystemSettingsService, useValue: settings },
        { provide: ApprovalEngineService, useValue: { isChainParticipant: jest.fn() } },
        { provide: NotificationsService, useValue: { notifyUser: jest.fn() } },
        { provide: HolidaysService, useValue: holidays },
        { provide: OvertimePolicyService, useValue: otPolicy },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    return { service: moduleRef.get(OvertimeService), otPolicy };
  };

  it('PENDING: prices the request with the employee POLICY, not the global settings', async () => {
    const { service } = await build({ ...ROW });
    const res: any = await service.findOne('ot-1', undefined, { withPreview: true });

    // Global rules would say REGULAR / 0 food — the prod symptom.
    expect(res.preview).toMatchObject({
      otType: 'LATE',
      foodAllowance: 4,
      hours: 4.5,
      regularHours: 3.5, // 17:30–21:00
      lateHours: 1, //     21:00–22:00
      policyName: 'Projects Ops',
    });
  });

  it('PENDING: reports the food allowance the list shows for the same request', async () => {
    const { service } = await build({ ...ROW });
    const res: any = await service.findOne('ot-1', undefined, { withPreview: true });
    expect(Number(res.preview.foodAllowance)).toBe(Number(res.foodAllowance));
    expect(res.preview.otType).toBe(res.otType);
  });

  it('APPROVED: returns the FROZEN breakdown, not a fresh recompute', async () => {
    const approved = {
      ...ROW,
      status: 'APPROVED',
      regularHours: 3.5,
      lateHours: 1,
      foodAllowance: 4,
    };
    const { service, otPolicy } = await build(approved);
    const res: any = await service.findOne('ot-1', undefined, { withPreview: true });

    expect(otPolicy.configForPolicyId).toHaveBeenCalledWith('pol-1');
    expect(otPolicy.resolveOvertimeConfig).not.toHaveBeenCalled();
    expect(res.preview).toMatchObject({
      otType: 'LATE',
      regularHours: 3.5,
      lateHours: 1,
      foodAllowance: 4,
    });
  });

  it('APPROVED legacy row: rebuilds the tier bucket from otType when the split columns are 0', async () => {
    const { service } = await build({
      ...ROW,
      status: 'APPROVED',
      regularHours: 0,
      lateHours: 0,
      doubleHours: 0,
      doubleLateHours: 0,
      hours: 4.5,
      otType: 'LATE',
    });
    const res: any = await service.findOne('ot-1', undefined, { withPreview: true });
    expect(res.preview).toMatchObject({ lateHours: 4.5, regularHours: 0 });
  });

  it('rest day: splits into the double buckets and ships each bucket its own multiplier', async () => {
    const { service } = await build(
      {
        ...ROW,
        date: new Date('2026-08-16T00:00:00Z'), // Sunday
        startTime: new Date('2026-08-16T17:30:00Z'),
        endTime: new Date('2026-08-16T22:00:00Z'),
      },
      { restDay: true },
    );
    const res: any = await service.findOne('ot-1', undefined, { withPreview: true });

    // Policy's double late threshold is 22:00 (the Sunday tier is untouched by
    // the policy override), so the whole window sits in the pre-late bucket.
    expect(res.preview).toMatchObject({
      otType: 'DOUBLE',
      dayType: 'SUNDAY',
      isDoubleOtDay: true,
      doubleHours: 4.5,
      doubleLateHours: 0,
      regularHours: 0,
      lateHours: 0,
      doubleRate: 2, // sunday.regularRate — what payrolls pays doubleHours
      doubleLateRate: 2.5, // sunday.lateRate
      foodAllowance: 4, // ends past the policy's 21:00 food threshold
    });
  });

  it('omits the preview unless the caller asks for it', async () => {
    const { service } = await build({ ...ROW });
    const res: any = await service.findOne('ot-1');
    expect(res.preview).toBeUndefined();
  });
});
