import { Test, TestingModule } from '@nestjs/testing';
import { OvertimeService } from '../overtime/overtime.service';
import { OvertimePolicyService } from './overtime-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import { NotificationsService } from '../notifications/notifications.service';
import { HolidaysService } from '../holidays/holidays.service';
import { AuditService } from '../audit/audit.service';

/**
 * Integration: the REAL OvertimePolicyService drives resolution (not mocked), so
 * this proves the full wiring — employee.employmentType → policy → holiday
 * classification → snapshot — for the client requirement (daily-wage OT ignores
 * National Holidays while everyone else keeps the holiday premium).
 */
const GLOBAL = {
  enabled: true,
  lateThreshold: '22:00',
  foodAllowanceEnabled: true,
  foodAllowanceThreshold: '22:00',
  foodAllowanceAmount: 150,
  regularRate: 1.5,
  lateRate: 1.5,
  doubleOtEnabled: true,
  doubleRate: 2,
  sunday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
  holiday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
  shiftEndTime: '17:00',
  doubleFoodAllowanceAnyTime: false,
  doubleOtAllowAnytime: true,
  maxHoursPerDay: 4,
  maxHoursPerDoubleDay: 12,
  maxHoursPerMonth: 30,
  maxHoursPerYear: 200,
  requireManagerApproval: true,
  allowEmployeeSubmit: true,
};

const DAILY_WAGE_POLICY = {
  id: 'dw', name: 'Daily Wage OT', isActive: true, isDefault: false,
  employmentType: 'Daily Wage', schemaVersion: 1, rules: { holidayBehavior: 'IGNORE' },
};
const COMPANY_DEFAULT = {
  id: 'cd', name: 'Company Default', isActive: true, isDefault: true,
  employmentType: null, schemaVersion: 1, rules: { holidayBehavior: 'STANDARD' },
};

const EMPLOYEES: Record<string, any> = {
  'e-dw': { id: 'e-dw', branchId: null, employmentType: 'Daily Wage', overtimePolicyId: null, baseSalary: 3200 },
  'e-std': { id: 'e-std', branchId: null, employmentType: 'Monthly', overtimePolicyId: null, baseSalary: 3200 },
};

describe('Overtime Policy — end-to-end classification (real resolver)', () => {
  let overtime: OvertimeService;
  let prisma: any;
  let holidays: any;

  beforeEach(async () => {
    prisma = {
      employee: {
        findUnique: jest.fn().mockImplementation(async (a: any) => EMPLOYEES[a.where.id] ?? null),
      },
      overtimePolicy: {
        findFirst: jest.fn().mockImplementation(async (a: any) => {
          if (a.where.id) return null; // no direct override in these cases
          if (a.where.employmentType === 'Daily Wage') return DAILY_WAGE_POLICY;
          if (a.where.employmentType) return null; // e.g. 'Monthly' — no targeted policy
          if (a.where.isDefault) return COMPANY_DEFAULT;
          return null;
        }),
      },
      overtimeRequest: {
        findFirst: jest.fn().mockResolvedValue(null), // no existing request for the date
        aggregate: jest.fn().mockResolvedValue({ _sum: { hours: 0 } }),
        create: jest.fn().mockImplementation(async (a: any) => ({ id: 'ot-1', ...a.data })),
      },
    };
    holidays = {
      isHoliday: jest.fn().mockResolvedValue(true), // Aug 10 2026 IS a national holiday
      isWeeklyOff: jest.fn().mockResolvedValue(false), // Monday, not a rest day
    };
    const settings = {
      getOvertimeConfig: jest.fn().mockResolvedValue({ ...GLOBAL }),
      getSetting: jest.fn().mockImplementation((k: string) =>
        Promise.resolve(k === 'attendance_day_end_time' ? '23:59' : '08:00'),
      ),
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        OvertimeService,
        OvertimePolicyService, // <-- real resolver
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: { sendOvertimeApproved: jest.fn() } },
        { provide: SystemSettingsService, useValue: settings },
        { provide: ApprovalEngineService, useValue: { initiate: jest.fn().mockResolvedValue({ engaged: false, finalized: false }) } },
        { provide: NotificationsService, useValue: { notifyUser: jest.fn(), notifyUsers: jest.fn() } },
        { provide: HolidaysService, useValue: holidays },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    overtime = mod.get(OvertimeService);
  });

  const dto = (startH: number, endH: number, hours: number) => ({
    date: '2026-08-10T12:00:00Z',
    startTime: `2026-08-10T${String(startH).padStart(2, '0')}:00:00Z`,
    endTime: `2026-08-10T${String(endH).padStart(2, '0')}:00:00Z`,
    hours,
    reason: 'holiday OT',
  });
  const created = () => prisma.overtimeRequest.create.mock.calls[0][0].data;

  it('daily-wage employee: holiday OT is classified as an ordinary weekday, snapshotting the daily-wage policy', async () => {
    await overtime.create('e-dw', dto(17, 19, 2), 'ADMIN');
    expect(created()).toMatchObject({
      dayType: 'WEEKDAY',
      otType: 'REGULAR',
      regularHours: 2,
      doubleHours: 0,
      overtimePolicyId: 'dw',
    });
    // The IGNORE policy short-circuits the holiday lookup entirely.
    expect(holidays.isHoliday).not.toHaveBeenCalled();
  });

  it('standard (monthly) employee, same holiday: classified as HOLIDAY (double), snapshotting Company Default', async () => {
    await overtime.create('e-std', dto(17, 19, 2), 'ADMIN');
    expect(created()).toMatchObject({
      dayType: 'HOLIDAY',
      otType: 'DOUBLE',
      doubleHours: 2,
      overtimePolicyId: 'cd',
    });
    expect(holidays.isHoliday).toHaveBeenCalledWith(expect.any(Date), undefined);
  });
});
