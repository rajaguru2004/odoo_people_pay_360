import { Test, TestingModule } from '@nestjs/testing';
import { PayrollsService } from './payrolls.service';
import { PrismaService } from '../prisma/prisma.service';
import { BudgetCommitmentService } from '../budgets/budget-commitment.service';
import { HolidaysService } from '../holidays/holidays.service';
import { OvertimeService } from '../overtime/overtime.service';
import { SalaryComponentsService } from '../salary-components/salary-components.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { OvertimePolicyService } from '../overtime-policy/overtime-policy.service';
import { AuditService } from '../audit/audit.service';
import { GarnishmentsService } from '../garnishments/garnishments.service';
import { GratuityService } from '../gratuity/gratuity.service';
import { LeaveEncashmentService } from '../leave-encashment/leave-encashment.service';
import { EmployeeRecoveriesService } from '../employee-recoveries/employee-recoveries.service';
import {
  DEFAULT_PAYROLL_FEATURES,
  PayrollFeaturesService,
} from './payroll-features.service';
import { PayrollItemLinesService } from './payroll-item-lines.service';

/**
 * Daily-wage (salaryType = DAILY) payroll, end to end through the real
 * calculation engine with Prisma mocked.
 *
 * A daily-wage employee carries a PER-DAY rate in `baseSalary`. The engine must:
 *  - pay `rate × days actually present` (no LOP, no pay for rest days/holidays,
 *    no cap at the month's nominal work days),
 *  - price an overtime hour at `rate / hoursPerDay` — NOT
 *    `rate / (workDays × hoursPerDay)`, which was the bug: a 30/day worker's
 *    overtime hour was worth 0.14 instead of 3.75,
 *  - honour the admin toggle that exempts daily-wage staff from the statutory
 *    (PF / ESI / professional tax / income tax) pipeline,
 *  - leave MONTHLY employees byte-identical to before.
 */
describe('PayrollsService — daily-wage (salaryType = DAILY)', () => {
  let service: PayrollsService;
  let prisma: any;
  let settings: any;
  let holidays: any;
  let otPolicy: any;

  const MONTH = 8;
  const YEAR = 2026;
  const WORK_DAYS = 26; // 6-day week
  const DAILY_RATE = 30;

  /** Statutory pipeline entirely off, so gross → net is a clean identity. */
  const CFG_NO_STATUTORY = {
    country: 'OM',
    currency: 'OMR',
    currencySymbol: 'OMR',
    workHoursPerDay: 8,
    workDaysPerWeek: 6,
    overtimeRate: 1.5,
    pfEnabled: false,
    pfEmployeeRate: 0,
    pfEmployerRate: 0,
    pfSalaryCap: 0,
    pfOnFullSalary: false,
    professionalTaxEnabled: false,
    professionalTaxSlabs: [] as any[],
    taxRegime: 'none',
    standardDeduction: 0,
    personalDeductionMonthly: 0,
    taxBrackets: [] as any[],
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
    gratuityEnabled: false,
    gratuityRate: 0,
    dailyWageStatutoryDeductions: true,
  };

  const presentDays = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      status: 'PRESENT',
      date: new Date(Date.UTC(YEAR, MONTH - 1, i + 1)),
    }));

  const employee = (over: Record<string, any> = {}) => ({
    id: 'emp-dw',
    branchId: null,
    salaryType: 'DAILY',
    baseSalary: DAILY_RATE,
    contracts: [],
    attendances: presentDays(22),
    rewards: [],
    disciplines: [],
    leaveRequests: [],
    ...over,
  });

  beforeEach(async () => {
    prisma = {
      payroll: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'pay-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      payrollItem: {
        createMany: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
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
      attendance: {
        groupBy: jest.fn().mockImplementation(async (args: any) =>
          (args?.where?.employeeId?.in ?? []).map((employeeId: string) => ({
            employeeId,
            _count: { _all: WORK_DAYS },
          })),
        ),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      // LEAVE_TYPE rows drive which leave types are unpaid. Only the unpaid ones
      // are queried, so an empty result means "everything is paid".
      libraryItem: {
        // create() selects ALL leave types and partitions them in code, so the
        // double must carry isPaid explicitly rather than relying on the query
        // having filtered isPaid: false.
        findMany: jest.fn().mockResolvedValue([
          { label: 'Leave Without Pay', isPaid: false },
        ]),
      },
      $transaction: jest
        .fn()
        .mockImplementation(async (arg: any) =>
          typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
        ),
    };

    settings = {
      getPayrollConfig: jest.fn().mockResolvedValue(CFG_NO_STATUTORY),
      getOvertimeConfig: jest
        .fn()
        .mockResolvedValue({ regularRate: 1.5, lateRate: 2, doubleRate: 2 }),
      getSetting: jest.fn().mockResolvedValue(''),
    };

    holidays = {
      getWorkDaysInMonth: jest.fn().mockResolvedValue(WORK_DAYS),
      // Used by workDaysWithinEmployment (G31): a joiner mid-period is paid
      // only for days actually employed, and the days before their start
      // date are not counted as absence.
      getWorkingDatesBetween: jest.fn().mockResolvedValue([]),
      // Only reached when payroll_daily_wage_pay_holidays is on.
      getPaidHolidayDatesInMonth: jest.fn().mockResolvedValue([]),
    };

    otPolicy = {
      configForPolicyId: jest.fn().mockResolvedValue({
        regularRate: 1.5,
        lateRate: 2,
        doubleRate: 2,
        sunday: { regularRate: 2, lateRate: 2 },
        holiday: { regularRate: 2, lateRate: 2 },
      }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PayrollsService,
        // Payroll writes its own named audit verbs (PAYROLL_SUBMITTED,
        // PAYROLL_LOCKED …) because the global interceptor derives the action
        // from the HTTP verb and would record every transition as CREATE.
        // AuditService swallows its own errors, so a no-op stub is faithful.
        { provide: AuditService, useValue: { log: jest.fn() } },
        // No court orders and no carried shortfalls: the loaders return empty
        // maps rather than undefined, because create() pre-seeds every employee
        // id and would otherwise read a missing entry as a missing employee.
        // End-of-service is OFF in these suites, so nothing accrues. Stubbed
        // rather than real because the provision is a separate ledger and these
        // suites assert the payslip.
        // Leave encashment is OFF in these suites; the loader returns an empty
        // map rather than undefined because create() pre-seeds every id.
        {
          provide: EmployeeRecoveriesService,
          useValue: {
            loadForPayroll: jest.fn().mockResolvedValue(new Map()),
            persistAllocation: jest.fn(),
            reverseForPayroll: jest.fn().mockResolvedValue(0),
          },
        },
        {
          provide: LeaveEncashmentService,
          useValue: {
            loadForPayroll: jest.fn().mockResolvedValue(new Map()),
            linkToItem: jest.fn(),
            settleForPayroll: jest.fn().mockResolvedValue(0),
            reverseForPayroll: jest.fn().mockResolvedValue(0),
          },
        },
        {
          provide: GratuityService,
          useValue: {
            accrueForPayroll: jest.fn().mockResolvedValue({ accrued: 0, skipped: 0 }),
            reverseForPayroll: jest.fn().mockResolvedValue(0),
            settledAccrualCount: jest.fn().mockResolvedValue(0),
          },
        },
        {
          provide: GarnishmentsService,
          useValue: {
            loadForPayroll: jest.fn().mockResolvedValue(new Map()),
            loadDeductionCarryForwards: jest.fn().mockResolvedValue(new Map()),
            persistAllocation: jest.fn(),
            persistDeductionRecovery: jest.fn(),
            reverseForPayroll: jest.fn(),
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
        { provide: PrismaService, useValue: prisma },
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
        {
          // Budgeting is observational — it must never change payroll figures.
          provide: BudgetCommitmentService,
          useValue: {
            realizeMany: jest.fn().mockResolvedValue(0),
            commit: jest.fn(),
            release: jest.fn(),
            realize: jest.fn(),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(PayrollsService);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const run = async (employees: any[]) => {
    prisma.employee.findMany.mockResolvedValue(employees);
    prisma.payrollItem.findMany.mockResolvedValue(
      employees.map((e) => ({ id: `item-${e.id}`, employeeId: e.id })),
    );
    await service.create({ month: MONTH, year: YEAR } as any);
    return prisma.payrollItem.createMany.mock.calls[0][0].data as any[];
  };

  describe('earnings', () => {
    it('pays daily rate × days present, not one month at the day rate', async () => {
      const [item] = await run([employee()]);
      expect(item.baseSalary).toBe(660); // 30 × 22
      expect(item.netSalary).toBe(660);
      // The pre-fix behaviour paid the bare day rate for the whole month.
      expect(item.baseSalary).not.toBe(DAILY_RATE);
    });

    it('absence is simply unpaid — no LOP deduction line', async () => {
      const [item] = await run([
        employee({ attendances: presentDays(10) }),
      ]);
      expect(item.baseSalary).toBe(300); // 30 × 10
      expect(item.deduction).toBe(0); // no LOP for 16 missing days
      expect(item.notes).toContain('10 day(s) worked');
      expect(item.notes).not.toContain('Loss of Pay');
    });

    it('days worked beyond the month’s work days are paid (rest-day work)', async () => {
      const [item] = await run([
        employee({ attendances: presentDays(28) }), // 28 > WORK_DAYS 26
      ]);
      expect(item.baseSalary).toBe(840); // 30 × 28
      expect(item.actualWorkDays).toBe(28);
    });

    it('paid leave earns nothing — only PRESENT days are paid', async () => {
      const item = (
        await run([
          employee({
            attendances: [
              ...presentDays(18),
              {
                status: 'LEAVE',
                date: new Date(Date.UTC(YEAR, MONTH - 1, 20)),
              },
            ],
            leaveRequests: [
              {
                leaveType: 'ANNUAL',
                startDate: new Date(Date.UTC(YEAR, MONTH - 1, 20)),
                endDate: new Date(Date.UTC(YEAR, MONTH - 1, 20)),
              },
            ],
          }),
        ])
      )[0];
      expect(item.baseSalary).toBe(540); // 30 × 18, the leave day is unpaid
    });

    it('no attendance rows for this employee → zero earned, never negative', async () => {
      const [item] = await run([employee({ attendances: [] })]);
      expect(item.baseSalary).toBe(0);
      expect(item.netSalary).toBe(0);
    });

    it('salary components on a daily-wage employee are PER-DAY too', async () => {
      prisma.salaryComponent.findMany.mockResolvedValue([
        { employeeId: 'emp-dw', componentType: 'BASIC', amount: 30 },
        { employeeId: 'emp-dw', componentType: 'SITE_ALLOWANCE', amount: 5 },
      ]);
      const [item] = await run([employee({ attendances: presentDays(20) })]);
      expect(item.baseSalary).toBe(600); // 30 × 20
      expect(item.allowances).toBe(100); // 5 × 20
      expect(item.netSalary).toBe(700); // and NOT 800 (allowances counted once)
    });
  });

  /**
   * Two admin settings can extend what a daily-wage employee is paid for.
   * Both default to false, so the baseline "days actually worked" rule above
   * still holds unless someone deliberately opts in.
   */
  describe('opt-in paid days', () => {
    const withCfg = (over: Record<string, any>) =>
      settings.getPayrollConfig.mockResolvedValue({ ...CFG_NO_STATUTORY, ...over });

    const leaveDay = (day: number, leaveType = 'ANNUAL') => ({
      attendance: { status: 'LEAVE', date: new Date(Date.UTC(YEAR, MONTH - 1, day)) },
      request: {
        leaveType,
        startDate: new Date(Date.UTC(YEAR, MONTH - 1, day)),
        endDate: new Date(Date.UTC(YEAR, MONTH - 1, day)),
      },
    });

    it('paid leave stays unpaid while the setting is off (the default)', async () => {
      const l1 = leaveDay(20);
      const l2 = leaveDay(21);
      const [item] = await run([
        employee({
          attendances: [...presentDays(18), l1.attendance, l2.attendance],
          leaveRequests: [l1.request, l2.request],
        }),
      ]);
      expect(item.baseSalary).toBe(540); // 30 x 18
      expect(item.notes).toContain('18 day(s) worked');
    });

    it('with pay-leave on, approved paid leave earns the day rate', async () => {
      withCfg({ dailyWagePayLeave: true });
      const l1 = leaveDay(20);
      const l2 = leaveDay(21);
      const [item] = await run([
        employee({
          attendances: [...presentDays(18), l1.attendance, l2.attendance],
          leaveRequests: [l1.request, l2.request],
        }),
      ]);
      expect(item.baseSalary).toBe(600); // 30 x (18 + 2)
      expect(item.actualWorkDays).toBe(20);
      expect(item.notes).toContain('20 day(s) paid');
      expect(item.notes).toContain('worked 18, paid leave 2');
    });

    it('an UNPAID leave type still earns nothing, even with pay-leave on', async () => {
      withCfg({ dailyWagePayLeave: true });
      const l = leaveDay(20, 'UNPAID');
      const [item] = await run([
        employee({
          attendances: [...presentDays(18), l.attendance],
          leaveRequests: [l.request],
        }),
      ]);
      expect(item.baseSalary).toBe(540); // 30 x 18
    });

    it('a custom unpaid leave type is resolved from LibraryItem.isPaid, not the literal "UNPAID"', async () => {
      withCfg({ dailyWagePayLeave: true });
      const l = leaveDay(20, 'Leave Without Pay');
      const [item] = await run([
        employee({
          attendances: [...presentDays(18), l.attendance],
          leaveRequests: [l.request],
        }),
      ]);
      expect(item.baseSalary).toBe(540); // 30 x 18 — not paid out
    });

    it('with pay-holidays on, unworked public holidays earn the day rate', async () => {
      withCfg({ dailyWagePayHolidays: true });
      holidays.getPaidHolidayDatesInMonth.mockResolvedValue([
        `${YEAR}-0${MONTH}-25`,
        `${YEAR}-0${MONTH}-26`,
      ]);
      const [item] = await run([
        employee({ attendances: presentDays(20), startDate: new Date(Date.UTC(YEAR, MONTH - 1, 1)) }),
      ]);
      expect(item.baseSalary).toBe(660); // 30 x (20 + 2)
      expect(item.notes).toContain('public holidays 2');
    });

    it('a holiday the employee actually WORKED is paid once, not twice', async () => {
      withCfg({ dailyWagePayHolidays: true });
      // Day 15 is inside presentDays(20) and is also a public holiday.
      holidays.getPaidHolidayDatesInMonth.mockResolvedValue([
        `${YEAR}-0${MONTH}-15`,
        `${YEAR}-0${MONTH}-26`,
      ]);
      const [item] = await run([
        employee({ attendances: presentDays(20), startDate: new Date(Date.UTC(YEAR, MONTH - 1, 1)) }),
      ]);
      expect(item.baseSalary).toBe(630); // 30 x (20 + 1), not 660
    });

    it('holidays before the employee joined are not paid', async () => {
      withCfg({ dailyWagePayHolidays: true });
      holidays.getPaidHolidayDatesInMonth.mockResolvedValue([
        `${YEAR}-0${MONTH}-02`, // before the start date below
        `${YEAR}-0${MONTH}-26`,
      ]);
      const [item] = await run([
        employee({
          attendances: presentDays(20),
          startDate: new Date(Date.UTC(YEAR, MONTH - 1, 10)),
        }),
      ]);
      expect(item.baseSalary).toBe(630); // 30 x (20 + 1)
    });

    it('both settings on are additive', async () => {
      withCfg({ dailyWagePayLeave: true, dailyWagePayHolidays: true });
      holidays.getPaidHolidayDatesInMonth.mockResolvedValue([`${YEAR}-0${MONTH}-26`]);
      const l = leaveDay(21);
      const [item] = await run([
        employee({
          attendances: [...presentDays(18), l.attendance],
          leaveRequests: [l.request],
          startDate: new Date(Date.UTC(YEAR, MONTH - 1, 1)),
        }),
      ]);
      expect(item.baseSalary).toBe(600); // 30 x (18 + 1 leave + 1 holiday)
      expect(item.notes).toContain('worked 18, paid leave 1, public holidays 1');
    });

    it('the holiday lookup is never issued while the setting is off', async () => {
      await run([employee()]);
      expect(holidays.getPaidHolidayDatesInMonth).not.toHaveBeenCalled();
    });
  });

  describe('overtime hourly rate', () => {
    beforeEach(() => {
      prisma.overtimeRequest.findMany.mockResolvedValue([
        {
          id: 'ot-1',
          employeeId: 'emp-dw',
          overtimePolicyId: 'daily-wage-pol',
          otType: 'REGULAR',
          dayType: 'WEEKDAY',
          hours: 4,
          regularHours: 4,
          lateHours: 0,
          doubleHours: 0,
          doubleLateHours: 0,
          foodAllowance: 0,
        },
      ]);
    });

    it('prices an OT hour at dayRate / hoursPerDay', async () => {
      const [item] = await run([employee()]);
      // hourly = 30/8 = 3.75 → 4h × 3.75 × 1.5 = 22.50
      expect(item.overtimeHours).toBe(4);
      expect(item.overtimePay).toBe(22.5);
    });

    it('regression: the monthly formula would have paid ~1/26th of that', async () => {
      const [item] = await run([employee()]);
      const monthlyFormulaPay = 4 * (DAILY_RATE / (WORK_DAYS * 8)) * 1.5;
      expect(monthlyFormulaPay).toBeCloseTo(0.865, 3);
      expect(item.overtimePay / monthlyFormulaPay).toBeCloseTo(WORK_DAYS, 6);
    });

    it('the OT rate does not move when the month has fewer work days', async () => {
      holidays.getWorkDaysInMonth.mockResolvedValue(20);
      const [item] = await run([employee()]);
      expect(item.overtimePay).toBe(22.5);
    });

    it('allowances ride in the daily rate used for overtime', async () => {
      prisma.salaryComponent.findMany.mockResolvedValue([
        { employeeId: 'emp-dw', componentType: 'BASIC', amount: 30 },
        { employeeId: 'emp-dw', componentType: 'SITE_ALLOWANCE', amount: 10 },
      ]);
      const [item] = await run([employee()]);
      // hourly = (30+10)/8 = 5 → 4 × 5 × 1.5 = 30
      expect(item.overtimePay).toBe(30);
    });
  });

  describe('statutory deductions toggle', () => {
    const CFG_WITH_STATUTORY = {
      ...CFG_NO_STATUTORY,
      pfEnabled: true,
      pfEmployeeRate: 0.12,
      pfSalaryCap: 15000,
      esiEnabled: true,
      esiEmployeeRate: 0.0075,
      esiSalaryCap: 21000,
    };

    it('ON (default): daily-wage staff go through PF/ESI like everyone else', async () => {
      settings.getPayrollConfig.mockResolvedValue({
        ...CFG_WITH_STATUTORY,
        dailyWageStatutoryDeductions: true,
      });
      const [item] = await run([
        employee({
          contracts: [
            {
              contractType: 'INDEFINITE',
              workType: 'FULL_TIME',
              workHoursPerWeek: 48,
              startDate: new Date(Date.UTC(YEAR, 0, 1)),
              endDate: null,
            },
          ],
        }),
      ]);
      // PF 12% of 660 = 79.20; ESI 0.75% of 660 = 4.95 → insurance 84.15
      expect(item.insurance).toBe(84.15);
      expect(item.netSalary).toBe(575.85);
    });

    it('OFF: the whole statutory pipeline is skipped for daily-wage staff', async () => {
      settings.getPayrollConfig.mockResolvedValue({
        ...CFG_WITH_STATUTORY,
        dailyWageStatutoryDeductions: false,
      });
      const [item] = await run([
        employee({
          contracts: [
            {
              contractType: 'INDEFINITE',
              workType: 'FULL_TIME',
              workHoursPerWeek: 48,
              startDate: new Date(Date.UTC(YEAR, 0, 1)),
              endDate: null,
            },
          ],
        }),
      ]);
      expect(item.insurance).toBe(0);
      expect(item.tax).toBe(0);
      expect(item.netSalary).toBe(660);
      expect(item.notes).toContain('Statutory deductions waived');
    });

    it('OFF does NOT affect monthly employees', async () => {
      settings.getPayrollConfig.mockResolvedValue({
        ...CFG_WITH_STATUTORY,
        dailyWageStatutoryDeductions: false,
      });
      const [item] = await run([
        employee({
          id: 'emp-monthly',
          salaryType: 'MONTHLY',
          baseSalary: 1000,
          attendances: presentDays(WORK_DAYS),
          contracts: [
            {
              contractType: 'INDEFINITE',
              workType: 'FULL_TIME',
              workHoursPerWeek: 48,
              startDate: new Date(Date.UTC(YEAR, 0, 1)),
              endDate: null,
            },
          ],
        }),
      ]);
      expect(item.insurance).toBeGreaterThan(0);
    });
  });

  describe('MONTHLY employees are unchanged', () => {
    /**
     * The double-credit guard at the service level. A monthly salary already
     * contains paid leave and public holidays; turning the daily-wage settings
     * on must not add them a second time.
     */
    it('the daily-wage paid-day settings do not touch a MONTHLY employee', async () => {
      settings.getPayrollConfig.mockResolvedValue({
        ...CFG_NO_STATUTORY,
        dailyWagePayLeave: true,
        dailyWagePayHolidays: true,
      });
      const withSettingsOn = (
        await run([
          employee({
            id: 'emp-m',
            salaryType: 'MONTHLY',
            baseSalary: 1200,
            attendances: presentDays(20),
            startDate: new Date(Date.UTC(YEAR, MONTH - 1, 1)),
          }),
        ])
      )[0];

      settings.getPayrollConfig.mockResolvedValue(CFG_NO_STATUTORY);
      const withSettingsOff = (
        await run([
          employee({
            id: 'emp-m',
            salaryType: 'MONTHLY',
            baseSalary: 1200,
            attendances: presentDays(20),
            startDate: new Date(Date.UTC(YEAR, MONTH - 1, 1)),
          }),
        ])
      )[0];

      expect(withSettingsOn).toEqual(withSettingsOff);
    });

    it('full month → full salary, no LOP', async () => {
      const [item] = await run([
        employee({
          id: 'emp-m',
          salaryType: 'MONTHLY',
          baseSalary: 1200,
          attendances: presentDays(WORK_DAYS),
        }),
      ]);
      expect(item.baseSalary).toBe(1200);
      expect(item.deduction).toBe(0);
      expect(item.netSalary).toBe(1200);
    });

    it('absence still prorates as LOP', async () => {
      const [item] = await run([
        employee({
          id: 'emp-m',
          salaryType: 'MONTHLY',
          baseSalary: 1300,
          attendances: presentDays(WORK_DAYS - 2),
        }),
      ]);
      expect(item.deduction).toBe(100); // 1300 × 2/26
      expect(item.netSalary).toBe(1200);
      expect(item.notes).toContain('Loss of Pay');
    });

    it('an unset salaryType is treated as MONTHLY', async () => {
      const [item] = await run([
        employee({
          id: 'emp-legacy',
          salaryType: undefined,
          baseSalary: 1200,
          attendances: presentDays(WORK_DAYS),
        }),
      ]);
      expect(item.baseSalary).toBe(1200);
    });

    it('regression: allowances are counted exactly once in gross', async () => {
      prisma.salaryComponent.findMany.mockResolvedValue([
        { employeeId: 'emp-m', componentType: 'BASIC', amount: 1000 },
        { employeeId: 'emp-m', componentType: 'HRA', amount: 200 },
      ]);
      const [item] = await run([
        employee({
          id: 'emp-m',
          salaryType: 'MONTHLY',
          baseSalary: 1200,
          attendances: presentDays(WORK_DAYS),
        }),
      ]);
      expect(item.baseSalary).toBe(1000);
      expect(item.allowances).toBe(200);
      expect(item.netSalary).toBe(1200); // not 1400
    });
  });
});
