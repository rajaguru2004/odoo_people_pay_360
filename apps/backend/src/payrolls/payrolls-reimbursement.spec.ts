import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
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
 * End-to-end style coverage of the reimbursement ↔ payroll integration:
 *
 *   create():
 *     - picks up APPROVED, not-yet-linked reimbursements and stores the sum on
 *       the employee's payroll item
 *     - NON-TAXABLE proof: two employees identical except for a reimbursement
 *       must have identical tax/insurance and net salaries differing by exactly
 *       the reimbursement amount
 *     - links the included reimbursement rows to their payroll item
 *       (double-inclusion guard) with a re-guarded updateMany
 *   updateItem():
 *     - re-derives net from the stored (non-editable) reimbursement column
 *   lockPayroll():
 *     - atomically flips linked APPROVED reimbursements to PAID
 *   createRevision():
 *     - copies the reimbursement AND foodAllowance amounts onto the new items
 *       without re-linking rows (so a revision can never double-pay)
 *
 * Prisma and collaborators are mocked; the real calculation engine runs.
 */
describe('PayrollsService — reimbursement integration', () => {
  let service: PayrollsService;
  let prisma: any;
  let settings: any;
  let holidays: any;

  const MONTH = 6;
  const YEAR = 2026;
  const WORK_DAYS = 22;
  const REIMB_AMOUNT = 2500;

  // Deterministic payroll config: PF on, PT flat ₹200 slab, 10% flat monthly
  // tax bracket — exact values don't matter because the non-taxable proof is
  // comparative (control employee vs reimbursed employee).
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
    esiEnabled: false,
    esiEmployeeRate: 0,
    esiEmployerRate: 0,
    esiSalaryCap: 0,
    basicSalaryPercentage: 40,
    gratuityEnabled: false,
    gratuityRate: 0,
  };

  const fullMonthAttendance = () =>
    Array.from({ length: WORK_DAYS }, (_, i) => ({
      status: 'PRESENT',
      date: new Date(Date.UTC(YEAR, MONTH - 1, i + 1)),
    }));

  const employee = (id: string) => ({
    id,
    baseSalary: 50000,
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
        // applyLock() flips the status with a compare-and-set inside the
        // transaction; count > 0 means this caller won the race.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
      user: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
      // Advisory locks / FOR UPDATE row locks in applyLock(). No-op here.
      $executeRaw: jest.fn().mockResolvedValue(0),
      // Supports both Prisma transaction forms: array of ops and callback(tx).
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
        { provide: HolidaysService, useValue: holidays },
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── create() ──────────────────────────────────────────────────────────────
  describe('create', () => {
    const primeCreate = () => {
      prisma.payroll.findFirst.mockResolvedValue(null); // no existing cycle
      prisma.employee.findMany.mockResolvedValue([
        employee('emp-control'),
        employee('emp-reimbursed'),
      ]);
      // Only the second employee has an approved, unlinked reimbursement.
      prisma.reimbursement.findMany.mockResolvedValue([
        { id: 'r1', employeeId: 'emp-reimbursed', amount: REIMB_AMOUNT },
      ]);
      prisma.payroll.create.mockResolvedValue({ id: 'pay-1' });
      // IDs of the freshly created items (queried after createMany for linking).
      prisma.payrollItem.findMany.mockResolvedValue([
        { id: 'item-control', employeeId: 'emp-control' },
        { id: 'item-reimbursed', employeeId: 'emp-reimbursed' },
      ]);
      prisma.payroll.update.mockResolvedValue({});
    };

    const createdItems = () =>
      prisma.payrollItem.createMany.mock.calls[0][0].data as any[];

    it('queries only APPROVED reimbursements that are not linked to a payroll item yet', async () => {
      primeCreate();
      await service.create({ month: MONTH, year: YEAR } as any);
      expect(prisma.reimbursement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'APPROVED',
            payrollItemId: null,
          }),
        }),
      );
    });

    it('stores the reimbursement sum on the right item and 0 on others', async () => {
      primeCreate();
      await service.create({ month: MONTH, year: YEAR } as any);
      const items = createdItems();
      const control = items.find((i) => i.employeeId === 'emp-control');
      const reimbursed = items.find((i) => i.employeeId === 'emp-reimbursed');
      expect(control.reimbursement).toBe(0);
      expect(reimbursed.reimbursement).toBe(REIMB_AMOUNT);
    });

    it('sums multiple approved reimbursements for the same employee', async () => {
      primeCreate();
      prisma.reimbursement.findMany.mockResolvedValue([
        { id: 'r1', employeeId: 'emp-reimbursed', amount: 1000 },
        { id: 'r2', employeeId: 'emp-reimbursed', amount: 1500 },
      ]);
      await service.create({ month: MONTH, year: YEAR } as any);
      const reimbursed = createdItems().find(
        (i) => i.employeeId === 'emp-reimbursed',
      );
      expect(reimbursed.reimbursement).toBe(2500);
    });

    it('NON-TAXABLE proof: identical employees differ only by net (+amount); tax and PF stay equal', async () => {
      primeCreate();
      await service.create({ month: MONTH, year: YEAR } as any);
      const items = createdItems();
      const control = items.find((i) => i.employeeId === 'emp-control');
      const reimbursed = items.find((i) => i.employeeId === 'emp-reimbursed');

      // Statutory bases untouched — the reimbursement never entered gross.
      expect(reimbursed.tax).toBe(control.tax);
      expect(reimbursed.insurance).toBe(control.insurance);
      expect(reimbursed.deduction).toBe(control.deduction);
      // Net increased by exactly the reimbursement, nothing more.
      expect(reimbursed.netSalary - control.netSalary).toBe(REIMB_AMOUNT);
    });

    it('includes the reimbursement in the payroll totalAmount', async () => {
      primeCreate();
      await service.create({ month: MONTH, year: YEAR } as any);
      const items = createdItems();
      const expectedTotal = items.reduce((s, i) => s + i.netSalary, 0);
      // The run total is accumulated as a Prisma.Decimal (a float `+=` across
      // hundreds of rows drifts before it reaches the Decimal column), so compare
      // the VALUE rather than the representation.
      const [{ data }] = prisma.payroll.update.mock.calls.at(-1);
      expect(Number(data.totalAmount)).toBe(expectedTotal);
    });

    it('links included reimbursements to their payroll item with a re-guarded updateMany', async () => {
      primeCreate();
      await service.create({ month: MONTH, year: YEAR } as any);
      expect(prisma.reimbursement.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.reimbursement.updateMany).toHaveBeenCalledWith({
        // The status/null conditions re-guard against a concurrent run linking first.
        where: { id: { in: ['r1'] }, status: 'APPROVED', payrollItemId: null },
        data: { payrollItemId: 'item-reimbursed' },
      });
    });

    it('creates items and links inside one transaction', async () => {
      primeCreate();
      await service.create({ month: MONTH, year: YEAR } as any);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('performs no linking when no reimbursements are pending', async () => {
      primeCreate();
      prisma.reimbursement.findMany.mockResolvedValue([]);
      await service.create({ month: MONTH, year: YEAR } as any);
      expect(prisma.reimbursement.updateMany).not.toHaveBeenCalled();
      const items = createdItems();
      expect(items.every((i) => i.reimbursement === 0)).toBe(true);
    });

    it('still creates the payroll when the reimbursement lookup fails (soft dependency)', async () => {
      primeCreate();
      prisma.reimbursement.findMany.mockRejectedValue(new Error('db hiccup'));
      await expect(
        service.create({ month: MONTH, year: YEAR } as any),
      ).resolves.toMatchObject({ success: true });
      const items = createdItems();
      expect(items.every((i) => i.reimbursement === 0)).toBe(true);
    });
  });

  // ── updateItem() ────────────────────────────────────────────────────────────
  describe('updateItem', () => {
    const primeUpdateItem = (reimbursement: number) => {
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
        baseSalary: 50000,
        workDays: WORK_DAYS,
        allowances: 0,
        bonus: 0,
        deduction: 0,
        overtimeHours: 0,
        overtimePay: 0,
        foodAllowance: 0,
        reimbursement,
        employee: { id: 'emp-1' },
      });
      prisma.payrollItem.update.mockResolvedValue({});
      prisma.payrollItem.findMany.mockResolvedValue([]);
      prisma.payroll.update.mockResolvedValue({});
    };

    const updatedData = () => prisma.payrollItem.update.mock.calls[0][0].data;

    it('adds the stored reimbursement to net after deductions, leaving tax unchanged', async () => {
      primeUpdateItem(0);
      await service.updateItem('pay-1', 'item-1', { bonus: 1000 } as any);
      const control = updatedData();

      jest.clearAllMocks();
      primeUpdateItem(REIMB_AMOUNT);
      await service.updateItem('pay-1', 'item-1', { bonus: 1000 } as any);
      const withReimbursement = updatedData();

      expect(withReimbursement.tax).toBe(control.tax);
      expect(withReimbursement.insurance).toBe(control.insurance);
      expect(withReimbursement.netSalary - control.netSalary).toBe(
        REIMB_AMOUNT,
      );
    });
  });

  // ── lockPayroll() ───────────────────────────────────────────────────────────
  describe('lockPayroll', () => {
    it('rejects locking a payroll that is not APPROVED', async () => {
      prisma.payroll.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'DRAFT',
      });
      await expect(
        service.lockPayroll('pay-1', 'user-admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.reimbursement.updateMany).not.toHaveBeenCalled();
    });

    it('finalize() is an alias — it cannot lock a DRAFT payroll either', async () => {
      // finalize() used to be a SECOND lock path: it moved any status to LOCKED
      // writing only finalizedAt/By, so it skipped the reimbursement, advance/loan
      // and budget settlement below. It was also the only path the web UI called,
      // so in practice LOCKED meant nothing. It now delegates to lockPayroll.
      prisma.payroll.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'DRAFT',
      });
      await expect(
        service.finalize('pay-1', 'user-admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.payroll.update).not.toHaveBeenCalled();
      expect(prisma.reimbursement.updateMany).not.toHaveBeenCalled();
    });

    it('finalize() on an APPROVED payroll performs the full lock side effects', async () => {
      prisma.payroll.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'APPROVED',
      });
      prisma.payroll.update.mockResolvedValue({ id: 'pay-1', status: 'LOCKED' });

      await service.finalize('pay-1', 'user-admin');

      // The discriminator the WPS pre-flight relies on: lockedAt is written only
      // by the real lock path, never by the old finalize shortcut.
      expect(prisma.payroll.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'LOCKED',
            lockedBy: 'user-admin',
            lockedAt: expect.any(Date),
          }),
        }),
      );
      expect(prisma.reimbursement.updateMany).toHaveBeenCalled();
    });

    it('locks and flips the linked APPROVED reimbursements to PAID in one transaction', async () => {
      prisma.payroll.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'APPROVED',
      });
      prisma.payroll.update.mockResolvedValue({
        id: 'pay-1',
        status: 'LOCKED',
      });

      const result = await service.lockPayroll('pay-1', 'user-admin');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // Compare-and-set: the WHERE carries the allowed source statuses, so a
      // concurrent lock loses the race instead of double-flipping the ledger.
      expect(prisma.payroll.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pay-1', status: { in: ['APPROVED'] } },
          data: expect.objectContaining({
            status: 'LOCKED',
            lockedBy: 'user-admin',
          }),
        }),
      );
      // Only rows linked to THIS payroll's items flip — and only APPROVED ones,
      // so a revision lock (whose items carry no links) flips nothing twice.
      expect(prisma.reimbursement.updateMany).toHaveBeenCalledWith({
        where: { status: 'APPROVED', payrollItem: { payrollId: 'pay-1' } },
        data: { status: 'PAID', paidAt: expect.any(Date) },
      });
      expect(result).toMatchObject({ success: true });
    });
  });

  // ── createRevision() ────────────────────────────────────────────────────────
  describe('createRevision', () => {
    it('copies foodAllowance and reimbursement amounts onto the new items without re-linking', async () => {
      prisma.payroll.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'LOCKED',
        month: MONTH,
        year: YEAR,
        version: 1,
        totalAmount: 100000,
        items: [
          {
            employeeId: 'emp-1',
            baseSalary: 50000,
            workDays: WORK_DAYS,
            actualWorkDays: WORK_DAYS,
            allowances: 0,
            bonus: 0,
            deduction: 0,
            overtimeHours: 0,
            overtimePay: 0,
            foodAllowance: 300,
            reimbursement: REIMB_AMOUNT,
            insurance: 1800,
            tax: 0,
            netSalary: 51000,
            notes: null,
          },
        ],
      });
      prisma.payroll.create.mockResolvedValue({ id: 'pay-2', version: 2 });

      await service.createRevision('pay-1', 'user-admin', { reason: 'fix' });

      const copied = prisma.payrollItem.createMany.mock.calls[0][0].data[0];
      // Regression guard: the copy map previously dropped foodAllowance.
      expect(copied.foodAllowance).toBe(300);
      expect(copied.reimbursement).toBe(REIMB_AMOUNT);
      // Amounts are copied but rows are never re-linked to the new payroll —
      // the PAID reimbursements stay attached to the LOCKED v1 items.
      expect(prisma.reimbursement.updateMany).not.toHaveBeenCalled();
    });

    it('refuses to revise a non-LOCKED payroll', async () => {
      prisma.payroll.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'DRAFT',
        items: [],
      });
      await expect(
        service.createRevision('pay-1', 'user-admin', { reason: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
