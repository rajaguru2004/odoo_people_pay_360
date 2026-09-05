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
import { GratuityService } from '../gratuity/gratuity.service';
import { LeaveEncashmentService } from '../leave-encashment/leave-encashment.service';
import { EmployeeRecoveriesService } from '../employee-recoveries/employee-recoveries.service';
import {
  DEFAULT_PAYROLL_FEATURES,
  PayrollFeaturesService,
} from './payroll-features.service';
import { PayrollItemLinesService } from './payroll-item-lines.service';
import { LoanNotificationService } from '../advance-loans/loan-notification.service';
import { LoanScheduleService } from '../advance-loans/loan-schedule.service';

/**
 * Money invariants a wage file depends on. Each test here locks down a bug that
 * was live before the WPS work:
 *
 *   1. baseSalary, bonus and foodAllowance were returned UNROUNDED and left for
 *      Postgres to round on write, so the STORED components did not sum to the
 *      STORED net. A wage-file validator re-derives the header total from the
 *      detail rows, so a row that disagrees with itself is a rejected file.
 *   2. updateItem() had no zero floor (unlike create()), so an HR edit raising
 *      `deduction` above gross persisted a NEGATIVE netSalary. In a fixed-width
 *      wage file the minus sign shifts every subsequent field on the row.
 *   3. payrolls.total_amount was accumulated with `+=` on a JS float, so the run
 *      total could disagree with the sum of its own items.
 *
 * The reconciliation identity asserted throughout is the one the file relies on:
 *
 *   baseSalary + allowances + bonus + overtimePay + foodAllowance
 *     - deduction - insurance - tax + reimbursement - advanceLoanDeduction
 *   == netSalary                                        (unless floored at 0)
 *
 * Prisma and collaborators are mocked; the real calculation engine runs.
 */
describe('PayrollsService — money invariants', () => {
  let service: PayrollsService;
  let prisma: any;
  let settings: any;

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
        // Loan recovery is planned inside create(). The policy is stubbed to the
        // hardcoded defaults (v2 kill-switch OFF) so these suites assert the
        // LEGACY recovery behaviour, unchanged.
        {
          provide: LoanPolicyService,
          useValue: { resolve: jest.fn().mockResolvedValue(DEFAULT_LOAN_POLICY) },
        },
        { provide: LoanRecoveryService, useValue: new LoanRecoveryService(prisma as any) },
        // The loan notification log. Payroll only tells a borrower their loan
        // is fully repaid, and does it once per cycle through this.
        {
          provide: LoanNotificationService,
          useValue: { notifyOnce: jest.fn().mockResolvedValue(true) },
        },
        // Court orders. No employee in these fixtures has one, so the rung is
        // empty and the loan arithmetic below is unchanged — which is the
        // point: adding the rung must not move money where there is no order.
        {
          // Only reached when deferralMode is EXTEND_TENURE, which these
          // fixtures leave at the CARRY_FORWARD default.
          provide: LoanScheduleService,
          useValue: { regenerate: jest.fn().mockResolvedValue(undefined) },
        },
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

  // ── create() ────────────────────────────────────────────────────────────────
  describe('create', () => {
    /** Salaries and absence counts chosen so every row prorates unevenly. */
    const PRORATED = [
      { id: 'emp-a', baseSalary: 47333, presentDays: 19 },
      { id: 'emp-b', baseSalary: 31777, presentDays: 21 },
      { id: 'emp-c', baseSalary: 8999, presentDays: 7 },
      { id: 'emp-d', baseSalary: 50000, presentDays: WORK_DAYS },
    ];

    const primeCreate = () => {
      prisma.employee.findMany.mockResolvedValue(
        PRORATED.map((e) => employee(e.id, e.baseSalary, e.presentDays)),
      );
    };

    it('persists every money column at the stored precision (2dp)', async () => {
      primeCreate();
      await service.create({ month: MONTH, year: YEAR } as any);

      const MONEY_COLUMNS = [
        'baseSalary',
        'allowances',
        'bonus',
        'deduction',
        'overtimePay',
        'foodAllowance',
        'reimbursement',
        'advanceLoanDeduction',
        'insurance',
        'tax',
        'netSalary',
      ];

      for (const item of createdItems()) {
        for (const col of MONEY_COLUMNS) {
          expect({ col, value: item[col] }).toMatchObject({
            col,
            value: expect.anything(),
          });
          expect(isAtStoredPrecision(item[col])).toBe(true);
        }
      }
    });

    it('stored components reconcile to stored net on every prorated row', async () => {
      primeCreate();
      await service.create({ month: MONTH, year: YEAR } as any);

      const items = createdItems();
      expect(items).toHaveLength(PRORATED.length);
      for (const item of items) {
        // Rounded to 2dp to absorb IEEE-754 noise in the test's own addition,
        // not to hide a discrepancy: a real mismatch was whole cents.
        expect(Number(reconcile(item).toFixed(2))).toBe(
          Number(Number(item.netSalary).toFixed(2)),
        );
      }
    });

    it('run total equals the exact sum of the item net salaries', async () => {
      primeCreate();
      await service.create({ month: MONTH, year: YEAR } as any);

      const expected = createdItems().reduce(
        (sum, i) => sum.add(new Prisma.Decimal(i.netSalary)),
        new Prisma.Decimal(0),
      );
      const [{ data }] = prisma.payroll.update.mock.calls.at(-1);
      expect(new Prisma.Decimal(data.totalAmount).equals(expected)).toBe(true);
    });

    it('never persists a negative net salary', async () => {
      primeCreate();
      await service.create({ month: MONTH, year: YEAR } as any);
      for (const item of createdItems()) {
        expect(Number(item.netSalary)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ── updateItem() ────────────────────────────────────────────────────────────
  describe('updateItem', () => {
    const primeUpdateItem = (overrides: Record<string, unknown> = {}) => {
      prisma.payroll.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'DRAFT',
        month: MONTH,
        year: YEAR,
      });
      prisma.payrollItem.findUnique.mockResolvedValue({
        id: 'item-1',
        payrollId: 'pay-1',
        employeeId: 'emp-1',
        baseSalary: 47333.33,
        workDays: WORK_DAYS,
        allowances: 0,
        bonus: 0,
        deduction: 0,
        overtimeHours: 0,
        overtimePay: 0,
        foodAllowance: 0,
        reimbursement: 0,
        advanceLoanDeduction: 0,
        employee: { id: 'emp-1', baseSalary: 47333.33 },
        ...overrides,
      });
    };

    const updatedData = () => prisma.payrollItem.update.mock.calls[0][0].data;

    it('floors net at zero when a deduction exceeds gross', async () => {
      primeUpdateItem();
      // Deduction far above gross — the case that used to persist a negative net.
      await service.updateItem('pay-1', 'item-1', {
        deduction: 999_999,
      } as any);
      expect(Number(updatedData().netSalary)).toBe(0);
    });

    it('reconciles components to net after an edit', async () => {
      primeUpdateItem();
      await service.updateItem('pay-1', 'item-1', {
        allowances: 1234.56,
        bonus: 777.77,
        deduction: 321.99,
      } as any);

      const data = updatedData();
      // updateItem persists only the columns it recomputes; the untouched ones
      // come from the stored row it read.
      const row = {
        baseSalary: 47333.33,
        reimbursement: 0,
        advanceLoanDeduction: 0,
        ...data,
      };
      expect(Number(reconcile(row).toFixed(2))).toBe(
        Number(Number(data.netSalary).toFixed(2)),
      );
    });

    it('persists the recomputed columns at the stored precision (2dp)', async () => {
      primeUpdateItem();
      await service.updateItem('pay-1', 'item-1', {
        allowances: 1234.567,
        bonus: 89.019,
      } as any);

      const data = updatedData();
      for (const col of [
        'allowances',
        'bonus',
        'deduction',
        'overtimePay',
        'foodAllowance',
        'insurance',
        'tax',
        'netSalary',
      ]) {
        expect(isAtStoredPrecision(data[col])).toBe(true);
      }
    });

    it('is idempotent: re-running the same edit does not drift the net', async () => {
      primeUpdateItem();
      await service.updateItem('pay-1', 'item-1', { bonus: 1000 } as any);
      const first = updatedData();

      jest.clearAllMocks();
      // Feed the persisted result back in, as a second no-op edit would.
      primeUpdateItem({
        allowances: first.allowances,
        bonus: first.bonus,
        deduction: first.deduction,
        overtimePay: first.overtimePay,
        foodAllowance: first.foodAllowance,
      });
      await service.updateItem('pay-1', 'item-1', { bonus: 1000 } as any);

      expect(Number(updatedData().netSalary)).toBe(Number(first.netSalary));
    });
  });
});
