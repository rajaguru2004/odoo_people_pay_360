import { Test, TestingModule } from '@nestjs/testing';
import { PayrollsService } from './payrolls.service';
import { PrismaService } from '../prisma/prisma.service';
import { HolidaysService } from '../holidays/holidays.service';
import { OvertimeService } from '../overtime/overtime.service';
import { SalaryComponentsService } from '../salary-components/salary-components.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { OvertimePolicyService } from '../overtime-policy/overtime-policy.service';
import { AuditService } from '../audit/audit.service';
import {
  DEFAULT_PAYROLL_FEATURES,
  PayrollFeaturesService,
} from './payroll-features.service';
import { PayrollItemLinesService } from './payroll-item-lines.service';
import { DeductionCarryForwardService } from './deduction-carry-forward.service';

/**
 * Overtime → payroll integration for the Singapore rules (shift 08:00–17:00):
 *
 *   - overtimePay = Σ hours × hourlyRate × rate, where
 *       hourlyRate = baseSalary / (workDays × workHoursPerDay) = base / 160,
 *       rate = DOUBLE|DOUBLE_LATE → 2.0, LATE|REGULAR → 1.5.
 *   - foodAllowance is summed onto the item.
 *   - Food allowance is TAXABLE (rides in gross) — proven comparatively: adding
 *     food raises tax, so net rises by LESS than the food amount (the inverse of
 *     the non-taxable reimbursement in payrolls-reimbursement.spec.ts).
 *
 * Prisma and collaborators are mocked; the real calculation engine runs. CPF is
 * not exercised here (no contract → insurance 0); the seed proves full CPF/tax.
 */
describe('PayrollsService — overtime & food-allowance integration (SG)', () => {
  let service: PayrollsService;
  let prisma: any;
  let settings: any;
  let holidays: any;
  let otPolicy: any;

  const MONTH = 8;
  const YEAR = 2026;
  const WORK_DAYS = 20; // Aug 2026 with Sun+Sat off, minus the Aug 10 holiday
  // hourlyRate = base / (WORK_DAYS × workHoursPerDay) = base / 160

  const CFG = {
    country: 'SG',
    currency: 'SGD',
    currencySymbol: 'S$',
    workHoursPerDay: 8,
    workDaysPerWeek: 5,
    overtimeRate: 1.5,
    pfEnabled: true,
    pfEmployeeRate: 0.2,
    pfEmployerRate: 0.17,
    pfSalaryCap: 6800,
    pfOnFullSalary: false,
    professionalTaxEnabled: false,
    professionalTaxSlabs: [] as any[],
    taxRegime: 'progressive',
    standardDeduction: 0,
    personalDeductionMonthly: 0,
    taxBrackets: [
      { limit: 20000, rate: 0.0 },
      { limit: 30000, rate: 0.02 },
      { limit: 40000, rate: 0.035 },
      { limit: 80000, rate: 0.07 },
      { limit: 120000, rate: 0.115 },
      { limit: 160000, rate: 0.15 },
      { limit: 200000, rate: 0.18 },
      { limit: 240000, rate: 0.19 },
      { limit: 280000, rate: 0.195 },
      { limit: 320000, rate: 0.2 },
      { limit: 999999999, rate: 0.22 },
    ],
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
        // Report every queried employee as having attendance (avoids the
        // "attendance not processed" guard); count is irrelevant to OT pay.
        groupBy: jest.fn().mockImplementation(async (args: any) =>
          (args?.where?.employeeId?.in ?? []).map((employeeId: string) => ({
            employeeId,
            _count: { _all: WORK_DAYS },
          })),
        ),
      },
      user: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest
        .fn()
        .mockImplementation(async (arg: any) =>
          typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
        ),
    };

    settings = {
      getPayrollConfig: jest.fn().mockResolvedValue(CFG),
      getOvertimeConfig: jest.fn().mockResolvedValue({
        regularRate: 1.5,
        lateRate: 1.5,
        doubleRate: 2,
      }),
      getSetting: jest.fn().mockResolvedValue(''),
    };

    holidays = {
      getWorkDaysInMonth: jest.fn().mockResolvedValue(WORK_DAYS),
      // Used by workDaysWithinEmployment (G31): a joiner mid-period is paid
      // only for days actually employed, and the days before their start
      // date are not counted as absence.
      getWorkingDatesBetween: jest.fn().mockResolvedValue([]),
    };

    // Default: every row resolves to the legacy global overtime config (policyId
    // null), so monetization matches pre-feature behaviour. Individual tests
    // override configForPolicyId to prove per-policy (snapshot) monetization.
    otPolicy = {
      configForPolicyId: jest.fn().mockImplementation(async () => ({
        ...(await settings.getOvertimeConfig()),
        eligible: true,
        holidayBehavior: 'STANDARD',
        dayEndBoundary: null,
        policyId: null,
        policyName: null,
      })),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PayrollsService,
        // Payroll writes its own named audit verbs (PAYROLL_SUBMITTED,
        // PAYROLL_LOCKED …) because the global interceptor derives the action
        // from the HTTP verb and would record every transition as CREATE.
        // AuditService swallows its own errors, so a no-op stub is faithful.
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
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
        { provide: OvertimePolicyService, useValue: otPolicy },
        { provide: AuditService, useValue: { log: jest.fn() } },
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

  describe('overtime pay & food aggregation', () => {
    beforeEach(() => {
      primeCreate([employee('emp-a', 3200), employee('emp-b', 4000)]);
      prisma.overtimeRequest.findMany.mockResolvedValue([
        { id: 'a1', employeeId: 'emp-a', otType: 'REGULAR', hours: 2, foodAllowance: 0 },
        { id: 'a2', employeeId: 'emp-a', otType: 'DOUBLE', hours: 9, foodAllowance: 0 },
        { id: 'b1', employeeId: 'emp-b', otType: 'LATE', hours: 6, foodAllowance: 150 },
        { id: 'b2', employeeId: 'emp-b', otType: 'DOUBLE_LATE', hours: 6, foodAllowance: 150 },
      ]);
    });

    it('employee A (S$20/h): REGULAR 2h + DOUBLE 9h → 11h, S$420 OT pay, S$0 food', async () => {
      await service.create({ month: MONTH, year: YEAR } as any);
      const a = createdItems().find((i) => i.employeeId === 'emp-a');
      expect(a.overtimeHours).toBe(11);
      expect(a.overtimePay).toBe(420); // 2×20×1.5 + 9×20×2.0
      expect(a.foodAllowance).toBe(0);
    });

    it('employee B (S$25/h): LATE 6h + DOUBLE_LATE 6h → 12h, S$525 OT pay, S$300 food', async () => {
      await service.create({ month: MONTH, year: YEAR } as any);
      const b = createdItems().find((i) => i.employeeId === 'emp-b');
      expect(b.overtimeHours).toBe(12);
      expect(b.overtimePay).toBe(525); // 6×25×1.5 + 6×25×2.0
      expect(b.foodAllowance).toBe(300); // 150 + 150
    });

    it('only APPROVED overtime inside the month window is queried', async () => {
      await service.create({ month: MONTH, year: YEAR } as any);
      expect(prisma.overtimeRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'APPROVED' }),
        }),
      );
    });
  });

  describe('per-policy monetization (snapshot on the row)', () => {
    it('two rows with different policy snapshots are paid at their own rates', async () => {
      primeCreate([employee('emp-dw', 3200), employee('emp-std', 3200)]);
      // hourlyRate = 3200 / 160 = S$20/h
      prisma.overtimeRequest.findMany.mockResolvedValue([
        { id: 'dw', employeeId: 'emp-dw', overtimePolicyId: 'daily-wage', otType: 'REGULAR', hours: 3, regularHours: 3, lateHours: 0, doubleHours: 0, doubleLateHours: 0, foodAllowance: 0 },
        { id: 'std', employeeId: 'emp-std', overtimePolicyId: 'standard', otType: 'REGULAR', hours: 3, regularHours: 3, lateHours: 0, doubleHours: 0, doubleLateHours: 0, foodAllowance: 0 },
      ]);
      // Daily-wage policy pays 1.25×; standard pays 1.5× — resolved by snapshot id.
      otPolicy.configForPolicyId.mockImplementation(async (id: string) => ({
        regularRate: id === 'daily-wage' ? 1.25 : 1.5,
        lateRate: 1.5, doubleRate: 2,
        sunday: { regularRate: 2, lateRate: 2 }, holiday: { regularRate: 2, lateRate: 2 },
      }));

      await service.create({ month: MONTH, year: YEAR } as any);
      const dw = createdItems().find((i) => i.employeeId === 'emp-dw');
      const std = createdItems().find((i) => i.employeeId === 'emp-std');
      expect(dw.overtimePay).toBe(75); // 3 × 20 × 1.25
      expect(std.overtimePay).toBe(90); // 3 × 20 × 1.5
      expect(otPolicy.configForPolicyId).toHaveBeenCalledWith('daily-wage');
      expect(otPolicy.configForPolicyId).toHaveBeenCalledWith('standard');
    });

    it('a null snapshot (pre-migration row) resolves the legacy global config', async () => {
      primeCreate([employee('emp-legacy', 3200)]);
      prisma.overtimeRequest.findMany.mockResolvedValue([
        { id: 'r', employeeId: 'emp-legacy', overtimePolicyId: null, otType: 'REGULAR', hours: 2, regularHours: 2, lateHours: 0, doubleHours: 0, doubleLateHours: 0, foodAllowance: 0 },
      ]);
      await service.create({ month: MONTH, year: YEAR } as any);
      const it0 = createdItems().find((i) => i.employeeId === 'emp-legacy');
      expect(it0.overtimePay).toBe(60); // 2 × 20 × 1.5 (global default)
      expect(otPolicy.configForPolicyId).toHaveBeenCalledWith(null);
    });

    it('resolves each distinct policy at most once per run (memoized)', async () => {
      primeCreate([employee('emp-1', 3200), employee('emp-2', 3200)]);
      prisma.overtimeRequest.findMany.mockResolvedValue([
        { id: 'r1', employeeId: 'emp-1', overtimePolicyId: 'P', otType: 'REGULAR', hours: 1, regularHours: 1, lateHours: 0, doubleHours: 0, doubleLateHours: 0, foodAllowance: 0 },
        { id: 'r2', employeeId: 'emp-2', overtimePolicyId: 'P', otType: 'REGULAR', hours: 1, regularHours: 1, lateHours: 0, doubleHours: 0, doubleLateHours: 0, foodAllowance: 0 },
      ]);
      await service.create({ month: MONTH, year: YEAR } as any);
      const pCalls = otPolicy.configForPolicyId.mock.calls.filter((c: any[]) => c[0] === 'P');
      expect(pCalls.length).toBe(1); // per-run cache
    });
  });

  describe('per-day-type double tiers (Sunday vs Holiday)', () => {
    beforeEach(() => {
      settings.getOvertimeConfig.mockResolvedValue({
        regularRate: 1.5,
        lateRate: 1.5,
        doubleRate: 2, // legacy fallback
        sunday: { regularRate: 2.0, lateRate: 2.5 },
        holiday: { regularRate: 2.5, lateRate: 3.0 },
      });
    });

    it('pays Sunday tiers from cfg.sunday and Holiday tiers from cfg.holiday', async () => {
      primeCreate([employee('emp-sun', 3200), employee('emp-hol', 3200)]);
      // hourlyRate = 3200 / 160 = S$20/h
      prisma.overtimeRequest.findMany.mockResolvedValue([
        // Sunday: 2h double-regular + 3h double-late
        {
          id: 's1', employeeId: 'emp-sun', otType: 'DOUBLE_LATE', dayType: 'SUNDAY',
          hours: 5, regularHours: 0, lateHours: 0, doubleHours: 2, doubleLateHours: 3, foodAllowance: 0,
        },
        // Holiday: 2h double-regular + 3h double-late
        {
          id: 'h1', employeeId: 'emp-hol', otType: 'DOUBLE_LATE', dayType: 'HOLIDAY',
          hours: 5, regularHours: 0, lateHours: 0, doubleHours: 2, doubleLateHours: 3, foodAllowance: 0,
        },
      ]);

      await service.create({ month: MONTH, year: YEAR } as any);
      const sun = createdItems().find((i) => i.employeeId === 'emp-sun');
      const hol = createdItems().find((i) => i.employeeId === 'emp-hol');

      // Sunday: (2×2.0 + 3×2.5) × 20 = (4 + 7.5) × 20 = 230
      expect(sun.overtimePay).toBe(230);
      // Holiday: (2×2.5 + 3×3.0) × 20 = (5 + 9) × 20 = 280
      expect(hol.overtimePay).toBe(280);
    });

    it('legacy DOUBLE row without dayType still pays at the flat doubleRate', async () => {
      primeCreate([employee('emp-legacy', 3200)]);
      prisma.overtimeRequest.findMany.mockResolvedValue([
        // Pre-migration row: only otType + hours, no buckets, no dayType.
        { id: 'l1', employeeId: 'emp-legacy', otType: 'DOUBLE', hours: 9, foodAllowance: 0 },
      ]);

      await service.create({ month: MONTH, year: YEAR } as any);
      const legacy = createdItems().find((i) => i.employeeId === 'emp-legacy');
      // 9 × doubleRate(2) × 20 = 360 — unchanged from before the feature.
      expect(legacy.overtimePay).toBe(360);
    });
  });

  describe('food allowance is TAXABLE (rides in gross)', () => {
    it('adding food raises tax, so net rises by less than the food amount', async () => {
      // Two identical employees; only the food rows differ.
      primeCreate([employee('emp-ctrl', 4000), employee('emp-food', 4000)]);
      prisma.overtimeRequest.findMany.mockResolvedValue([
        { id: 'c1', employeeId: 'emp-ctrl', otType: 'LATE', hours: 6, foodAllowance: 0 },
        { id: 'f1', employeeId: 'emp-food', otType: 'LATE', hours: 6, foodAllowance: 150 },
      ]);

      await service.create({ month: MONTH, year: YEAR } as any);
      const items = createdItems();
      const ctrl = items.find((i) => i.employeeId === 'emp-ctrl');
      const food = items.find((i) => i.employeeId === 'emp-food');

      expect(food.overtimePay).toBe(ctrl.overtimePay); // same OT pay
      expect(food.foodAllowance - ctrl.foodAllowance).toBe(150);
      expect(food.tax).toBeGreaterThan(ctrl.tax); // food entered the tax base
      const netGain = food.netSalary - ctrl.netSalary;
      expect(netGain).toBeGreaterThan(0);
      expect(netGain).toBeLessThan(150); // taxed → less than the full food amount
    });
  });

  /**
   * Site allowance is granted per request by the approver, not derived from any
   * policy. Payroll only ever SUMS it, and it must reach the item under its own
   * name — folding it into `foodAllowance` would leave the payslip unable to say
   * what it is paying for.
   */
  describe('site allowance', () => {
    it('sums onto its own column, separate from the food allowance', async () => {
      primeCreate([employee('emp-site', 4000)]);
      prisma.overtimeRequest.findMany.mockResolvedValue([
        { id: 's1', employeeId: 'emp-site', otType: 'LATE', hours: 6, foodAllowance: 150, siteAllowance: 25 },
        { id: 's2', employeeId: 'emp-site', otType: 'LATE', hours: 4, foodAllowance: 150, siteAllowance: 10 },
      ]);

      await service.create({ month: MONTH, year: YEAR } as any);
      const item = createdItems().find((i) => i.employeeId === 'emp-site');

      expect(item.siteAllowance).toBe(35);
      expect(item.foodAllowance).toBe(300);
    });

    it('is absent from rows that never had one', async () => {
      primeCreate([employee('emp-none', 4000)]);
      prisma.overtimeRequest.findMany.mockResolvedValue([
        { id: 'n1', employeeId: 'emp-none', otType: 'REGULAR', hours: 2, foodAllowance: 0 },
      ]);

      await service.create({ month: MONTH, year: YEAR } as any);
      const item = createdItems().find((i) => i.employeeId === 'emp-none');

      expect(item.siteAllowance).toBe(0);
    });

    it('is TAXABLE, like the food allowance it sits beside', async () => {
      primeCreate([employee('emp-c2', 4000), employee('emp-s2', 4000)]);
      prisma.overtimeRequest.findMany.mockResolvedValue([
        { id: 'c2', employeeId: 'emp-c2', otType: 'LATE', hours: 6, foodAllowance: 0, siteAllowance: 0 },
        { id: 'x2', employeeId: 'emp-s2', otType: 'LATE', hours: 6, foodAllowance: 0, siteAllowance: 150 },
      ]);

      await service.create({ month: MONTH, year: YEAR } as any);
      const items = createdItems();
      const ctrl = items.find((i) => i.employeeId === 'emp-c2');
      const site = items.find((i) => i.employeeId === 'emp-s2');

      expect(site.overtimePay).toBe(ctrl.overtimePay);
      expect(site.siteAllowance - ctrl.siteAllowance).toBe(150);
      expect(site.tax).toBeGreaterThan(ctrl.tax);
      const netGain = site.netSalary - ctrl.netSalary;
      expect(netGain).toBeGreaterThan(0);
      expect(netGain).toBeLessThan(150);
    });
  });
});
