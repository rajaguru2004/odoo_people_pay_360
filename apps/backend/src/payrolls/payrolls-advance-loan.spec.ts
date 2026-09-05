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
 * End-to-end style coverage of the salary-advance / loan ↔ payroll integration.
 *
 *   create():
 *     - only picks APPROVED requests with an outstanding balance and NO in-flight
 *       (PENDING) ledger row — the re-run / double-charge guard
 *     - an ADVANCE recovers in full; a LOAN recovers min(installment, outstanding)
 *     - the recovery is a post-tax DEDUCTION: two identical employees differing
 *       only by an advance have equal tax/PF and net differing by exactly the
 *       recovered amount
 *     - writes a PENDING ledger row linked to the payroll item
 *   lockPayroll():
 *     - flips the ledger rows to PAID, advances amountRepaid, and marks a
 *       fully-recovered request COMPLETED
 *
 * Prisma and collaborators are mocked; the real calculation engine runs.
 */
describe('PayrollsService — advance/loan integration', () => {
  let service: PayrollsService;
  let prisma: any;
  let settings: any;
  let holidays: any;
  let notifications: any;
  let loanPolicy: any;

  const MONTH = 6;
  const YEAR = 2026;
  const WORK_DAYS = 22;

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
        create: jest.fn().mockResolvedValue({ id: 'pay-1' }),
        update: jest.fn().mockResolvedValue({}),
        // applyLock() flips the status with a compare-and-set inside the
        // transaction; count > 0 means this caller won the race.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
        update: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        // create() reconciles the payslip against what was actually inserted,
        // so a concurrent run that lost the unique index cannot leave money
        // withheld with no ledger row behind it.
        aggregate: jest.fn().mockImplementation(async () => ({
          _sum: { amount: null },
        })),
      },
      // Lock projects the PLAN from the ledger and mirrors each recovery into
      // the money ledger.
      loanSchedule: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      loanTransaction: {
        createMany: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
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
      // Advisory locks / FOR UPDATE row locks in applyLock(). No-op here; the
      // real behaviour is covered by the concurrency e2e suite.
      $executeRaw: jest.fn().mockResolvedValue(0),
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

    holidays = { getWorkDaysInMonth: jest.fn().mockResolvedValue(WORK_DAYS) };
    notifications = { notifyUser: jest.fn() };
    // v2 kill-switch OFF by default: these cases assert the LEGACY behaviour.
    loanPolicy = { resolve: jest.fn().mockResolvedValue(DEFAULT_LOAN_POLICY) };

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
        { provide: LoanPolicyService, useValue: loanPolicy },
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
        { provide: NotificationsService, useValue: notifications },
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

  afterEach(() => jest.restoreAllMocks());

  /** Read back the payroll items handed to createMany. */
  const createdItems = () => prisma.payrollItem.createMany.mock.calls[0][0].data;
  const itemFor = (id: string) =>
    createdItems().find((i: any) => i.employeeId === id);

  describe('create() — deduction selection & net effect', () => {
    it('only queries recoverable requests with no PENDING ledger row and no active hold', async () => {
      prisma.employee.findMany.mockResolvedValue([employee('e1')]);
      await service.create({ month: MONTH, year: YEAR } as any);

      // APPROVED stays in the recoverable set on purpose: every pre-v2 row sits
      // in it, so the v2 rollout needs no data migration.
      expect(prisma.advanceLoanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            // OVERDUE joined the set when delinquency became a real status:
            // a loan being behind is the reason to keep collecting, not to
            // stop. Excluding it would make the flag quietly forgive the debt.
            status: { in: ['APPROVED', 'DISBURSED', 'ACTIVE', 'OVERDUE'] },
            deductions: { none: { status: 'PENDING' } },
            OR: [{ holdUntil: null }, { holdUntil: { lt: expect.any(Date) } }],
          }),
        }),
      );
    });

    it('deducts a salary advance in full and stores it on the payroll item', async () => {
      prisma.employee.findMany.mockResolvedValue([employee('e1')]);
      prisma.advanceLoanRequest.findMany.mockResolvedValue([
        { id: 'r1', employeeId: 'e1', type: 'ADVANCE', amount: 3000, amountRepaid: 0, installmentAmount: 3000 },
      ]);

      await service.create({ month: MONTH, year: YEAR } as any);

      expect(itemFor('e1').advanceLoanDeduction).toBe(3000);
    });

    it('deducts only one installment for a loan (not the full principal)', async () => {
      prisma.employee.findMany.mockResolvedValue([employee('e1')]);
      prisma.advanceLoanRequest.findMany.mockResolvedValue([
        { id: 'r1', employeeId: 'e1', type: 'LOAN', amount: 12000, amountRepaid: 0, installmentAmount: 3000 },
      ]);

      await service.create({ month: MONTH, year: YEAR } as any);

      expect(itemFor('e1').advanceLoanDeduction).toBe(3000);
    });

    it('caps the last loan installment at the outstanding balance', async () => {
      prisma.employee.findMany.mockResolvedValue([employee('e1')]);
      prisma.advanceLoanRequest.findMany.mockResolvedValue([
        // outstanding = 12000 - 10000 = 2000, installment 3000 -> deduct 2000
        { id: 'r1', employeeId: 'e1', type: 'LOAN', amount: 12000, amountRepaid: 10000, installmentAmount: 3000 },
      ]);

      await service.create({ month: MONTH, year: YEAR } as any);

      expect(itemFor('e1').advanceLoanDeduction).toBe(2000);
    });

    it('DEDUCTION proof: two identical employees differ in net by exactly the advance; tax and PF stay equal', async () => {
      prisma.employee.findMany.mockResolvedValue([employee('e1'), employee('e2')]);
      prisma.advanceLoanRequest.findMany.mockResolvedValue([
        { id: 'r1', employeeId: 'e2', type: 'ADVANCE', amount: 4000, amountRepaid: 0, installmentAmount: 4000 },
      ]);

      await service.create({ month: MONTH, year: YEAR } as any);

      const control = itemFor('e1');
      const deducted = itemFor('e2');
      expect(deducted.tax).toBe(control.tax);
      expect(deducted.insurance).toBe(control.insurance);
      expect(control.netSalary - deducted.netSalary).toBe(4000);
    });

    it('writes a PENDING ledger row linked to the payroll item', async () => {
      prisma.employee.findMany.mockResolvedValue([employee('e1')]);
      prisma.advanceLoanRequest.findMany.mockResolvedValue([
        { id: 'r1', employeeId: 'e1', type: 'LOAN', amount: 12000, amountRepaid: 0, installmentAmount: 3000 },
      ]);
      // The link step reads back the created items to attach the ledger.
      prisma.payrollItem.findMany.mockResolvedValue([{ id: 'item-1', employeeId: 'e1' }]);

      await service.create({ month: MONTH, year: YEAR } as any);

      // A legacy loan has no schedule rows, so the ledger row carries no
      // scheduleId and the whole amount is principal (there was no interest
      // engine before v2). skipDuplicates lets a concurrent run lose at the
      // partial unique index instead of failing the payroll.
      expect(prisma.advanceLoanDeduction.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            requestId: 'r1',
            scheduleId: null,
            payrollItemId: 'item-1',
            amount: 3000,
            principalComponent: 3000,
            interestComponent: 0,
            feeComponent: 0,
            plannedAmount: 3000,
            shortfallAmount: 0,
            outcome: 'FULL',
            month: MONTH,
            year: YEAR,
            status: 'PENDING',
          }),
        ],
        skipDuplicates: true,
      });
    });

    it('still creates the payroll when the advance/loan lookup fails, with v2 OFF (legacy soft dependency)', async () => {
      prisma.employee.findMany.mockResolvedValue([employee('e1')]);
      prisma.advanceLoanRequest.findMany.mockRejectedValue(new Error('db down'));

      await expect(
        service.create({ month: MONTH, year: YEAR } as any),
      ).resolves.toBeDefined();
      expect(itemFor('e1').advanceLoanDeduction).toBe(0);
    });

    it('REFUSES to generate a payroll when recovery planning fails and v2 is ON', async () => {
      // Silently producing a payroll that under-deducts is the defect the
      // failure policy exists to stop. v2 ON + FAIL (the default) blocks it.
      loanPolicy.resolve.mockResolvedValue({
        ...DEFAULT_LOAN_POLICY,
        moduleV2Enabled: true,
        recoveryFailurePolicy: 'FAIL',
      });
      prisma.employee.findMany.mockResolvedValue([employee('e1')]);
      prisma.advanceLoanRequest.findMany.mockRejectedValue(new Error('db down'));

      await expect(
        service.create({ month: MONTH, year: YEAR } as any),
      ).rejects.toThrow(/Loan recovery planning failed/);
    });
  });

  describe('lockPayroll() — finalize repayment', () => {
    it('flips ledger rows to PAID, advances the balance, and completes a fully-repaid request', async () => {
      prisma.payroll.findUnique.mockResolvedValue({ id: 'pay-1', status: 'APPROVED' });
      prisma.payroll.update.mockResolvedValue({ id: 'pay-1', status: 'LOCKED' });
      // One advance installment recovered in this payroll.
      prisma.advanceLoanDeduction.findMany.mockResolvedValue([
        { requestId: 'r1', amount: 3000 },
      ]);
      // After the transaction increments the balance, the request is fully repaid.
      prisma.advanceLoanRequest.findMany.mockResolvedValue([
        { id: 'r1', type: 'ADVANCE', amount: 3000, amountRepaid: 3000, employeeId: 'e1', status: 'APPROVED' },
      ]);

      const result = await service.lockPayroll('pay-1', 'user-admin');

      // Ledger PENDING -> PAID only for this payroll's rows.
      expect(prisma.advanceLoanDeduction.updateMany).toHaveBeenCalledWith({
        where: { status: 'PENDING', payrollItem: { payrollId: 'pay-1' } },
        data: { status: 'PAID' },
      });
      // Repaid balance advanced by the recovered sum.
      expect(prisma.advanceLoanRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'r1' },
          // amountRepaid tracks PRINCIPAL; interest and fees have their own
          // counters, so the payload carries more than one key now.
          data: expect.objectContaining({ amountRepaid: { increment: 3000 } }),
        }),
      );
      // Fully-repaid request marked COMPLETED.
      expect(prisma.advanceLoanRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'r1' },
          data: expect.objectContaining({ status: 'COMPLETED' }),
        }),
      );
      expect(result).toMatchObject({ success: true });
    });

    it('does not complete a loan that still has a balance outstanding', async () => {
      prisma.payroll.findUnique.mockResolvedValue({ id: 'pay-1', status: 'APPROVED' });
      prisma.payroll.update.mockResolvedValue({ id: 'pay-1', status: 'LOCKED' });
      prisma.advanceLoanDeduction.findMany.mockResolvedValue([
        { requestId: 'r1', amount: 3000 },
      ]);
      // Loan still owes 6000 of 12000 after this installment.
      prisma.advanceLoanRequest.findMany.mockResolvedValue([
        { id: 'r1', type: 'LOAN', amount: 12000, amountRepaid: 6000, employeeId: 'e1', status: 'APPROVED' },
      ]);

      await service.lockPayroll('pay-1', 'user-admin');

      // Balance advanced...
      expect(prisma.advanceLoanRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amountRepaid: { increment: 3000 } }),
        }),
      );
      // ...but never marked COMPLETED.
      expect(prisma.advanceLoanRequest.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'COMPLETED' }),
        }),
      );
    });

    it('rejects locking a payroll that is not APPROVED', async () => {
      prisma.payroll.findUnique.mockResolvedValue({ id: 'pay-1', status: 'DRAFT' });
      await expect(
        service.lockPayroll('pay-1', 'user-admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.advanceLoanDeduction.updateMany).not.toHaveBeenCalled();
    });
  });
});
