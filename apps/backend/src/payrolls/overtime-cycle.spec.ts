import { Test, TestingModule } from '@nestjs/testing';
import { PayrollsService } from './payrolls.service';
import { PrismaService } from '../prisma/prisma.service';
import { HolidaysService } from '../holidays/holidays.service';
import { OvertimePolicyService } from '../overtime-policy/overtime-policy.service';
import { OvertimeService } from '../overtime/overtime.service';
import { SalaryComponentsService } from '../salary-components/salary-components.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { AuditService } from '../audit/audit.service';
import {
  DEFAULT_PAYROLL_FEATURES,
  PayrollFeaturesService,
} from './payroll-features.service';
import { PayrollItemLinesService } from './payroll-item-lines.service';
import { DeductionCarryForwardService } from './deduction-carry-forward.service';

/**
 * FULL OVERTIME CYCLE — verifies the flow exactly as described by the business:
 *
 *   1. Employee works past the normal shift end   → hours are NORMAL (REGULAR) OT.
 *   2. Once the OT end time crosses the late OT threshold, the WHOLE request is
 *      classified LATE and every one of its hours is paid at the higher
 *      `lateRate` multiplier configured in Overtime Settings (salary "multiplies").
 *   3. Money only reaches the payroll AFTER a manager APPROVES the request —
 *      PENDING / REJECTED overtime is never paid.
 *
 * To make the multiplier visible, this suite deliberately sets DISTINCT rates:
 *   regularRate 1.5  →  lateRate 2.0  →  doubleRate 3.0
 * so a LATE hour pays strictly more than a REGULAR hour of the same length.
 *
 * hourlyRate = baseSalary / (workDays × workHoursPerDay) = base / (20 × 8) = base / 160.
 * With base 3200 → hourlyRate = S$20/h.
 */
describe('Overtime full cycle — normal → late-multiplier → payroll after approval', () => {
  let service: PayrollsService;
  let prisma: any;
  let settings: any;
  let holidays: any;

  const MONTH = 8;
  const YEAR = 2026;
  const WORK_DAYS = 20;

  const PAYROLL_CFG = {
    country: 'SG',
    currency: 'SGD',
    currencySymbol: 'S$',
    workHoursPerDay: 8,
    workDaysPerWeek: 5,
    overtimeRate: 1.5,
    pfEnabled: false,
    pfEmployeeRate: 0,
    pfEmployerRate: 0,
    pfSalaryCap: 0,
    pfOnFullSalary: false,
    professionalTaxEnabled: false,
    professionalTaxSlabs: [] as any[],
    taxRegime: 'progressive',
    standardDeduction: 0,
    personalDeductionMonthly: 0,
    taxBrackets: [{ limit: 999999999, rate: 0.0 }], // no tax → net == gross for clean assertions
    taxCalculationPeriod: 'annual' as const,
    taxRebateEnabled: false,
    taxRebateLimit: 0,
    cessEnabled: false,
    cessRate: 0,
    esiEnabled: false,
    esiEmployeeRate: 0,
    esiEmployerRate: 0,
    esiSalaryCap: 0,
    basicSalaryPercentage: 100,
  };

  // Distinct multipliers so REGULAR vs LATE vs DOUBLE are numerically separable.
  const OT_CFG = { regularRate: 1.5, lateRate: 2.0, doubleRate: 3.0 };

  const fullMonthAttendance = () =>
    Array.from({ length: WORK_DAYS }, (_, i) => ({
      status: 'PRESENT',
      date: new Date(Date.UTC(YEAR, MONTH - 1, i + 1)),
    }));

  const employee = (id: string, baseSalary: number) => ({
    id,
    baseSalary,
    contracts: [],
    attendances: fullMonthAttendance(),
    rewards: [],
    disciplines: [],
    leaveRequests: [],
  });

  beforeEach(async () => {
    prisma = {
      payroll: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      payrollItem: {
        createMany: jest.fn().mockResolvedValue({}),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      payrollBatchMember: { findMany: jest.fn() },
      // The carry-forward ledger. `updateItem` clears any prior OUTSTANDING row
      // for the same origin before writing a new one, so the mock needs
      // deleteMany even in suites that never open a shortfall.
      payrollCarryForward: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      // Itemisation is OFF in these suites, so nothing writes lines. Present so
      // a stray call fails loudly as an assertion rather than a TypeError.
      payrollItemLine: {
        createMany: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      employee: { findMany: jest.fn() },
      salaryComponent: { findMany: jest.fn().mockResolvedValue([]) },
      overtimeRequest: { findMany: jest.fn().mockResolvedValue([]) },
      reimbursement: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      advanceLoanRequest: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      advanceLoanDeduction: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      attendance: {
        groupBy: jest.fn().mockImplementation(async (args: any) =>
          (args?.where?.employeeId?.in ?? []).map((employeeId: string) => ({
            employeeId,
            _count: { _all: WORK_DAYS },
          })),
        ),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest
        .fn()
        .mockImplementation(async (arg: any) =>
          typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
        ),
    };

    settings = {
      getPayrollConfig: jest.fn().mockResolvedValue(PAYROLL_CFG),
      getOvertimeConfig: jest.fn().mockResolvedValue(OT_CFG),
      getSetting: jest.fn().mockResolvedValue(''),
    };

    holidays = { getWorkDaysInMonth: jest.fn().mockResolvedValue(WORK_DAYS) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PayrollsService,
        // Payroll writes its own named audit verbs (PAYROLL_SUBMITTED,
        // PAYROLL_LOCKED …) because the global interceptor derives the action
        // from the HTTP verb and would record every transition as CREATE.
        // AuditService swallows its own errors, so a no-op stub is faithful.
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        {
          provide: OvertimePolicyService,
          useValue: {
            configForPolicyId: jest.fn().mockImplementation(async () => ({
              ...(await settings.getOvertimeConfig()),
              eligible: true,
              holidayBehavior: 'STANDARD',
              dayEndBoundary: null,
              policyId: null,
              policyName: null,
            })),
          },
        },
        // Every payroll extension ships OFF. DEFAULT_PAYROLL_FEATURES is the
        // inert state, so these suites keep asserting the base engine.
        {
          provide: PayrollFeaturesService,
          useValue: {
            resolve: jest.fn().mockResolvedValue(DEFAULT_PAYROLL_FEATURES),
          },
        },
        {
          provide: PayrollItemLinesService,
          useValue: {
            buildAndPersist: jest.fn(),
            rebuildForItem: jest.fn(),
            deleteForItem: jest.fn(),
          },
        },
        {
          // Deduction balances an earlier run could not take. No fixture has
          // one, so the loader returns an empty map rather than undefined —
          // create() pre-seeds every employee id and would otherwise read a
          // missing entry as a missing employee.
          provide: DeductionCarryForwardService,
          useValue: {
            loadForEmployees: jest.fn().mockResolvedValue(new Map()),
            persistRecovery: jest.fn(),
            reverseForPayroll: jest.fn(),
            markOutstandingAsReceivable: jest.fn().mockResolvedValue(0),
          },
        },
        { provide: HolidaysService, useValue: holidays },
        { provide: OvertimeService, useValue: {} },
        { provide: SalaryComponentsService, useValue: {} },
        { provide: SystemSettingsService, useValue: settings },
        { provide: NotificationsService, useValue: { notifyUser: jest.fn() } },
        // Payroll submit/approve/reject and the payslip-ready fan-out route through
        // the dispatcher; these suites assert money, so it is stubbed.
        { provide: NotificationDispatcher, useValue: { dispatch: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(PayrollsService);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const createdItems = () =>
    prisma.payrollItem.createMany.mock.calls[0][0].data as any[];

  const primeCreate = (employees: any[]) => {
    prisma.payroll.findFirst.mockResolvedValue(null);
    prisma.employee.findMany.mockResolvedValue(employees);
    prisma.payroll.create.mockResolvedValue({ id: 'pay-1' });
    prisma.payrollItem.findMany.mockResolvedValue(
      employees.map((e) => ({ id: `item-${e.id}`, employeeId: e.id })),
    );
    prisma.payroll.update.mockResolvedValue({});
  };

  it('STEP 1+2: same 2h, REGULAR pays 1.5×, LATE pays 2.0× — the late hours multiply', async () => {
    // Two identical S$20/h employees, each with a single 2h OT request.
    // The only difference is the tier: one ended before the late threshold, one after.
    primeCreate([employee('emp-reg', 3200), employee('emp-late', 3200)]);
    prisma.overtimeRequest.findMany.mockResolvedValue([
      { id: 'r1', employeeId: 'emp-reg', otType: 'REGULAR', hours: 2, foodAllowance: 0 },
      { id: 'l1', employeeId: 'emp-late', otType: 'LATE', hours: 2, foodAllowance: 0 },
    ]);

    await service.create({ month: MONTH, year: YEAR } as any);
    const reg = createdItems().find((i) => i.employeeId === 'emp-reg');
    const late = createdItems().find((i) => i.employeeId === 'emp-late');

    expect(reg.overtimePay).toBe(60); // 2 × 20 × 1.5
    expect(late.overtimePay).toBe(80); // 2 × 20 × 2.0  ← salary multiplied by lateRate
    expect(late.overtimePay).toBeGreaterThan(reg.overtimePay);
  });

  it('SPLIT: one 17:00–23:00 request bills 5h regular + 1h late, NOT 6h all-late', async () => {
    // Persisted per-tier buckets drive payroll: (5×1.5 + 1×2.0) × S$20/h = S$190.
    // The old whole-request-late behaviour would have charged 6×2.0×20 = S$240.
    primeCreate([employee('emp-split', 3200)]);
    prisma.overtimeRequest.findMany.mockResolvedValue([
      {
        id: 's1',
        employeeId: 'emp-split',
        otType: 'LATE',
        hours: 6,
        regularHours: 5,
        lateHours: 1,
        doubleHours: 0,
        foodAllowance: 0,
      },
    ]);

    await service.create({ month: MONTH, year: YEAR } as any);
    const s = createdItems().find((i) => i.employeeId === 'emp-split');
    expect(s.overtimeHours).toBe(6);
    expect(s.overtimePay).toBe(190); // 5×20×1.5 + 1×20×2.0
  });

  it('LEGACY: a pre-split row (buckets 0, hours>0) falls back to single-tier by otType', async () => {
    primeCreate([employee('emp-legacy', 3200)]);
    prisma.overtimeRequest.findMany.mockResolvedValue([
      // No bucket columns → reconstruct from otType='LATE' → all 6h at lateRate.
      { id: 'lg1', employeeId: 'emp-legacy', otType: 'LATE', hours: 6, foodAllowance: 0 },
    ]);

    await service.create({ month: MONTH, year: YEAR } as any);
    const l = createdItems().find((i) => i.employeeId === 'emp-legacy');
    expect(l.overtimeHours).toBe(6);
    expect(l.overtimePay).toBe(240); // 6×20×2.0 (legacy whole-late)
  });

  it('STEP 2: DOUBLE (rest day / holiday) pays the highest 3.0× multiplier', async () => {
    primeCreate([employee('emp-dbl', 3200)]);
    prisma.overtimeRequest.findMany.mockResolvedValue([
      { id: 'd1', employeeId: 'emp-dbl', otType: 'DOUBLE_LATE', hours: 2, foodAllowance: 0 },
    ]);

    await service.create({ month: MONTH, year: YEAR } as any);
    const dbl = createdItems().find((i) => i.employeeId === 'emp-dbl');
    expect(dbl.overtimePay).toBe(120); // 2 × 20 × 3.0
  });

  it('STEP 3: only APPROVED overtime reaches payroll (PENDING/REJECTED excluded by query)', async () => {
    primeCreate([employee('emp-x', 3200)]);
    await service.create({ month: MONTH, year: YEAR } as any);

    // The engine only ever asks the DB for APPROVED requests in the month window.
    expect(prisma.overtimeRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'APPROVED' }),
      }),
    );
  });

  it('STEP 3: an employee whose only OT is unapproved is paid ZERO overtime', async () => {
    // Simulate the DB honouring the status:'APPROVED' filter — this employee's
    // OT was still PENDING, so findMany returns nothing for them.
    primeCreate([employee('emp-pending', 3200)]);
    prisma.overtimeRequest.findMany.mockResolvedValue([]); // nothing APPROVED

    await service.create({ month: MONTH, year: YEAR } as any);
    const p = createdItems().find((i) => i.employeeId === 'emp-pending');
    expect(p.overtimeHours).toBe(0);
    expect(p.overtimePay).toBe(0);
  });
});
