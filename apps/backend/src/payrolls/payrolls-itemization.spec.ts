import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PayrollsService } from './payrolls.service';
import { PrismaService } from '../prisma/prisma.service';
import { BudgetCommitmentService } from '../budgets/budget-commitment.service';
import { HolidaysService } from '../holidays/holidays.service';
import { OvertimePolicyService } from '../overtime-policy/overtime-policy.service';
import { OvertimeService } from '../overtime/overtime.service';
import { SalaryComponentsService } from '../salary-components/salary-components.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { LoanPolicyService, DEFAULT_LOAN_POLICY } from '../advance-loans/loan-policy.service';
import { LoanRecoveryService } from '../advance-loans/loan-recovery.service';
import { AuditService } from '../audit/audit.service';
import { GarnishmentsService } from '../garnishments/garnishments.service';
import { LoanNotificationService } from '../advance-loans/loan-notification.service';
import { LoanScheduleService } from '../advance-loans/loan-schedule.service';
import { GratuityService } from '../gratuity/gratuity.service';
import { LeaveEncashmentService } from '../leave-encashment/leave-encashment.service';
import { EmployeeRecoveriesService } from '../employee-recoveries/employee-recoveries.service';
import {
  DEFAULT_PAYROLL_FEATURES,
  PayrollFeaturesService,
} from './payroll-features.service';
import { PayrollItemLinesService } from './payroll-item-lines.service';

/**
 * Payslip itemisation, with the feature ON.
 *
 * Everything else in this family runs with the switch off and proves the
 * engine is unchanged. This suite is the other half: that when it IS on, the
 * lines written actually explain the payslip.
 *
 * The property under test is the one the whole design rests on — for every
 * bucket, `sum(lines where bucket = b) == payroll_items.b`. It is checked
 * against the persisted `createMany` payload rather than a recomputation,
 * because the point is that the breakdown agrees with what the employee is
 * paid, not with what the builder thought it should be.
 *
 * Prisma and collaborators are mocked; the real engine and the real
 * PayrollItemLinesService run.
 */
describe('PayrollsService — payslip itemisation (feature ON)', () => {
  let service: PayrollsService;
  let prisma: any;
  let settings: any;
  let featureOverrides: Record<string, unknown>;

  const MONTH = 6;
  const YEAR = 2026;
  const WORK_DAYS = 22;

  /**
   * Deliberately awkward numbers. A base salary of 47,333 over 22 days makes the
   * per-day rate non-terminating, so proration produces values with more decimal
   * places than the Decimal(12,2) columns hold — exactly the case that used to
   * break reconciliation. PF/PT/tax are on so every deduction path contributes.
   */
  const CFG = {
    country: 'IN',
    currency: 'INR',
    currencySymbol: '₹',
    workHoursPerDay: 8,
    workDaysPerWeek: 5,
    overtimeRate: 1.5,
    pfEnabled: true,
    pfEmployeeRate: 0.12,
    pfEmployerRate: 0.12,
    pfSalaryCap: 15000,
    pfOnFullSalary: false,
    professionalTaxEnabled: true,
    professionalTaxSlabs: [{ upTo: 999999999, tax: 200 }],
    taxRegime: 'new',
    standardDeduction: 0,
    personalDeductionMonthly: 0,
    taxBrackets: [{ limit: 999999999, rate: 0.1 }],
    taxCalculationPeriod: 'monthly' as const,
    taxRebateEnabled: false,
    taxRebateLimit: 0,
    cessEnabled: false,
    cessRate: 0,
    esiEnabled: true,
    esiEmployeeRate: 0.0075,
    esiEmployerRate: 0.0325,
    esiSalaryCap: 21000,
    basicSalaryPercentage: 40,
    gratuityEnabled: false,
    gratuityRate: 0,
  };

  /** `presentDays` short of WORK_DAYS forces LOP, and therefore proration. */
  const attendance = (presentDays: number) =>
    Array.from({ length: presentDays }, (_, i) => ({
      status: 'PRESENT',
      date: new Date(Date.UTC(YEAR, MONTH - 1, i + 1)),
    }));

  const employee = (id: string, baseSalary: number, presentDays: number) => ({
    id,
    baseSalary,
    contracts: [],
    attendances: attendance(presentDays),
    rewards: [],
    disciplines: [],
    leaveRequests: [],
  });

  /** The identity the wage file relies on, computed off a persisted row. */
  const reconcile = (row: any) =>
    Number(row.baseSalary) +
    Number(row.allowances) +
    Number(row.bonus) +
    Number(row.overtimePay) +
    Number(row.foodAllowance) -
    Number(row.deduction) -
    Number(row.insurance) -
    Number(row.tax) +
    Number(row.reimbursement) -
    Number(row.advanceLoanDeduction);

  /** True when `n` needs no more than 2 decimal places. */
  const isAtStoredPrecision = (n: unknown) =>
    new Prisma.Decimal(Number(n)).decimalPlaces() <= 2;

  beforeEach(async () => {
    featureOverrides = { itemLinesEnabled: true };
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
        update: jest.fn().mockResolvedValue({}),
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
      getPayrollConfig: jest.fn().mockResolvedValue(CFG),
      getOvertimeConfig: jest
        .fn()
        .mockResolvedValue({ regularRate: 1.5, lateRate: 1.5, doubleRate: 2 }),
      getSetting: jest.fn().mockResolvedValue(''),
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
        // Both reached from the loan ladder, which every payroll run walks
        // whether or not these fixtures hold a loan.
        {
          provide: LoanNotificationService,
          useValue: { notifyOnce: jest.fn().mockResolvedValue(true) },
        },
        {
          // Only reached when deferralMode is EXTEND_TENURE, which these
          // fixtures leave at the CARRY_FORWARD default.
          provide: LoanScheduleService,
          useValue: { regenerate: jest.fn().mockResolvedValue(undefined) },
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
            resolve: jest
              .fn()
              .mockResolvedValue({ ...DEFAULT_PAYROLL_FEATURES, ...featureOverrides }),
          },
        },
        // The REAL service, so the reconciliation gate actually runs.
        PayrollItemLinesService,
        // Loan recovery is planned inside create(). The policy is stubbed to the
        // hardcoded defaults (v2 kill-switch OFF) so these suites assert the
        // LEGACY recovery behaviour, unchanged.
        {
          provide: LoanPolicyService,
          useValue: { resolve: jest.fn().mockResolvedValue(DEFAULT_LOAN_POLICY) },
        },
        { provide: LoanRecoveryService, useValue: new LoanRecoveryService(prisma as any) },
        { provide: PrismaService, useValue: prisma },
        {
          provide: HolidaysService,
          useValue: {
            getWorkDaysInMonth: jest.fn().mockResolvedValue(WORK_DAYS),
            // Used by workDaysWithinEmployment (G31): a joiner mid-period is
            // paid for the days they were actually employed, and the days
            // before their start date are not counted as absence.
            getWorkingDatesBetween: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: OvertimeService, useValue: {} },
        { provide: SalaryComponentsService, useValue: {} },
        { provide: SystemSettingsService, useValue: settings },
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
        { provide: NotificationsService, useValue: { notifyUser: jest.fn() } },
        // Payroll submit/approve/reject and the payslip-ready fan-out route through
        // the dispatcher; these suites assert money, so it is stubbed.
        { provide: NotificationDispatcher, useValue: { dispatch: jest.fn() } },
        {
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

  const createdItems = () =>
    prisma.payrollItem.createMany.mock.calls[0][0].data as any[];

  /** Turn the feature off on the already-built service. */
  const disableItemisation = () => {
    (service as any).features.resolve = jest
      .fn()
      .mockResolvedValue({ ...DEFAULT_PAYROLL_FEATURES, itemLinesEnabled: false });
  };

  /** Every line the run persisted, flattened across createMany calls. */
  const writtenLines = () =>
    (prisma.payrollItemLine.createMany.mock.calls as any[][]).flatMap(
      (c) => c[0].data as any[],
    );

  const linesFor = (itemId: string) =>
    writtenLines().filter((l) => l.payrollItemId === itemId);

  const sumByBucket = (lines: any[], bucket: string) =>
    Math.round(
      lines
        .filter((l) => l.bucket === bucket)
        .reduce((a, l) => a + Number(l.amount), 0) * 100,
    ) / 100;

  /** Wire the mock so the post-insert re-read returns what was inserted. */
  const primeCreate = (employees: any[], components: any[] = []) => {
    prisma.employee.findMany.mockResolvedValue(employees);
    prisma.salaryComponent.findMany.mockResolvedValue(components);
    prisma.payrollItem.createMany.mockImplementation(async (args: any) => {
      const rows = args.data.map((d: any, i: number) => ({
        ...d,
        id: `item-${i}`,
      }));
      prisma.payrollItem.findMany.mockResolvedValue(rows);
      return { count: rows.length };
    });
  };

  const run = () =>
    service.create({ month: MONTH, year: YEAR, branchId: undefined } as any);

  describe('the lines reconcile to the columns', () => {
    it('splits an aggregate allowance into the components behind it', async () => {
      primeCreate(
        [employee('emp-1', 47333.33, WORK_DAYS)],
        [
          { employeeId: 'emp-1', componentType: 'BASIC', amount: 30000, isActive: true, effectiveDate: new Date(Date.UTC(2020, 0, 1)) },
          { employeeId: 'emp-1', componentType: 'HOUSING', amount: 8000, isActive: true, effectiveDate: new Date(Date.UTC(2020, 0, 1)) },
          { employeeId: 'emp-1', componentType: 'TRANSPORT', amount: 2000, isActive: true, effectiveDate: new Date(Date.UTC(2020, 0, 1)) },
        ],
      );
      await run();

      const lines = linesFor('item-0');
      const allowanceCodes = lines
        .filter((l) => l.bucket === 'allowances')
        .map((l) => l.code);
      // The whole point: "what is my allowance made of" is answerable.
      expect(allowanceCodes).toEqual(['HOUSING', 'TRANSPORT']);

      const item = createdItems()[0];
      expect(sumByBucket(lines, 'allowances')).toBe(
        Math.round(Number(item.allowances) * 100) / 100,
      );
    });

    it('holds for every bucket on a prorated payslip', async () => {
      // 19 of 22 days: every component is scaled by a non-terminating factor,
      // which is the case where per-line rounding can miss the column.
      primeCreate(
        [employee('emp-1', 47333.33, 19)],
        [
          { employeeId: 'emp-1', componentType: 'BASIC', amount: 30000, isActive: true, effectiveDate: new Date(Date.UTC(2020, 0, 1)) },
          { employeeId: 'emp-1', componentType: 'HOUSING', amount: 8000, isActive: true, effectiveDate: new Date(Date.UTC(2020, 0, 1)) },
          { employeeId: 'emp-1', componentType: 'PHONE', amount: 555.55, isActive: true, effectiveDate: new Date(Date.UTC(2020, 0, 1)) },
        ],
      );
      await run();

      const item = createdItems()[0];
      const lines = linesFor('item-0');
      for (const bucket of [
        'baseSalary',
        'allowances',
        'deduction',
        'insurance',
        'tax',
      ]) {
        expect({
          bucket,
          lines: sumByBucket(lines, bucket),
        }).toEqual({
          bucket,
          lines: Math.round(Number((item as any)[bucket]) * 100) / 100,
        });
      }
    });

    it('separates PF from ESI, which the insurance column cannot', async () => {
      // PF needs an active, non-exempt contract — `shouldPayInsurance` waives it
      // for probation, seasonal, short fixed terms and part-timers — so the
      // fixture carries one. Without it the column would hold ESI alone and the
      // split would be untestable.
      primeCreate([
        {
          ...employee('emp-1', 20000, WORK_DAYS),
          contracts: [
            {
              status: 'ACTIVE',
              contractType: 'PERMANENT',
              workType: 'FULL_TIME',
              workHoursPerWeek: 40,
            },
          ],
        },
      ]);
      await run();
      const codes = linesFor('item-0')
        .filter((l) => l.bucket === 'insurance')
        .map((l) => l.code);
      expect(codes).toEqual(['PF', 'ESI']);
    });

    it('separates income tax from professional tax', async () => {
      primeCreate([employee('emp-1', 47333.33, WORK_DAYS)]);
      await run();
      const codes = linesFor('item-0')
        .filter((l) => l.bucket === 'tax')
        .map((l) => l.code);
      expect(codes).toEqual(['INCOME_TAX', 'PROFESSIONAL_TAX']);
    });

    it('names loss of pay, which the engine folds into earned salary', async () => {
      primeCreate([employee('emp-1', 47333.33, 19)]);
      await run();
      const lop = linesFor('item-0').find((l) => l.code === 'LOP');
      expect(lop).toBeDefined();
      expect(lop.category).toBe('DEDUCTION');
      expect(Number(lop.amount)).toBeGreaterThan(0);
    });
  });

  describe('the shape of a line', () => {
    it('carries a positive amount and the sign in the category', async () => {
      primeCreate([employee('emp-1', 47333.33, 19)]);
      await run();
      const lines = linesFor('item-0');
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) {
        expect(Number(l.amount)).toBeGreaterThanOrEqual(0);
        expect(['EARNING', 'DEDUCTION']).toContain(l.category);
      }
    });

    it('orders lines deterministically', async () => {
      primeCreate([employee('emp-1', 47333.33, 19)]);
      await run();
      const orders = linesFor('item-0').map((l) => l.displayOrder);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
      expect(new Set(orders).size).toBe(orders.length);
    });
  });

  describe('with the switch off', () => {
    it('writes no lines at all', async () => {
      disableItemisation();
      primeCreate([employee('emp-1', 47333.33, 19)]);
      await run();
      expect(prisma.payrollItemLine.createMany).not.toHaveBeenCalled();
    });

    it('produces the same money either way', async () => {
      primeCreate([employee('emp-1', 47333.33, 19)]);
      await run();
      const withLines = createdItems()[0];

      jest.clearAllMocks();
      disableItemisation();
      primeCreate([employee('emp-1', 47333.33, 19)]);
      await run();
      const withoutLines = createdItems()[0];

      // Itemisation explains the payslip; it must never change it.
      expect(withoutLines).toEqual(withLines);
    });
  });
});
