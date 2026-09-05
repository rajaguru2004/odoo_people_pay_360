import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { AdvanceLoansService } from './advance-loans.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { HolidaysService } from '../holidays/holidays.service';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import { LoanScheduleService } from './loan-schedule.service';
import { LoanAccessService } from './loan-access.service';
import { LoanEligibilityService } from './loan-eligibility.service';
import { LoanNotificationService } from './loan-notification.service';
import { LoanSettlementService } from './loan-settlement.service';
import { LoanLifecycleService } from './loan-lifecycle.service';
import { AuditService } from '../audit/audit.service';

/**
 * Unit coverage for the advance/loan approval rules — the logic unique to this
 * module on top of the shared reimbursement-style workflow:
 *   - LOAN approve sets installments + per-cycle installmentAmount
 *   - LOAN approve enforces the configurable installment ceiling
 *   - ADVANCE approve blocks amounts over the configured % of monthly pay
 *   - PENDING-only race guard on approve
 */
describe('AdvanceLoansService — approval rules', () => {
  let service: AdvanceLoansService;
  let prisma: any;
  let settingsMap: Record<string, string>;
  let holidays: any;
  let engine: any;
  let schedules: any;
  let notifications: any;
  let loanNotifications: any;
  let eligibility: any;

  const DEPT_ID = 'dept-1';
  const HR = { id: 'user-hr', role: 'HR_MANAGER', employeeId: 'emp-hr', departmentId: null };
  /** The same approver, but the request is their own. */
  const SELF = { id: 'user-self', role: 'HR_MANAGER', employeeId: 'emp-1', departmentId: null };

  const pending = (overrides: any = {}) => ({
    id: 'req-1',
    employeeId: 'emp-1',
    type: 'ADVANCE',
    amount: 40000,
    amountRepaid: 0,
    installments: 1,
    status: 'PENDING',
    attachments: [],
    deductions: [],
    employee: {
      id: 'emp-1',
      employeeCode: 'TRS001',
      fullName: 'Raja Guru R',
      email: 'raja@x.com',
      departmentId: DEPT_ID,
      department: { id: DEPT_ID, name: 'Engineering' },
    },
    approver: null,
    ...overrides,
  });

  beforeEach(async () => {
    settingsMap = {
      advance_loan_enabled: 'true',
      advance_loan_approver_roles: 'HR_MANAGER,ADMIN',
      advance_loan_max_installments: '12',
      advance_max_percent_of_salary: '100',
    };

    prisma = {
      employee: { findUnique: jest.fn().mockResolvedValue({ baseSalary: 50000 }) },
      salaryComponent: { findMany: jest.fn().mockResolvedValue([]) },
      // References are minted with `nextval` on a real sequence, so a raw
      // query is the only path — counting rows could not survive fifty
      // concurrent approvals.
      $queryRaw: jest.fn().mockResolvedValue([{ seq: BigInt(1) }]),
      advanceLoanRequest: {
        findUnique: jest.fn().mockResolvedValue(pending()),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve(pending({ ...data, id: 'req-1' })),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(pending({ status: 'CANCELLED' })),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ employee: { fullName: 'HR' } }),
        findFirst: jest.fn().mockResolvedValue({ id: 'user-emp' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'user-hr' }]),
      },
    };

    const mail = {
      sendAdvanceLoanApproved: jest.fn().mockResolvedValue(undefined),
      sendAdvanceLoanRejected: jest.fn().mockResolvedValue(undefined),
    };
    const settings = {
      getSetting: jest
        .fn()
        .mockImplementation((k: string, fb: string) =>
          Promise.resolve(settingsMap[k] ?? fb),
        ),
    };
    notifications = { notifyUser: jest.fn().mockResolvedValue(undefined) };
    // Forwards exactly as the real `LoanNotificationService.send()` does, so
    // the §17 cases below keep asserting the words and the deep link that
    // actually reach the notifier rather than a mock's own shape.
    loanNotifications = {
      notifyOnce: jest.fn(async (args: any) => {
        const rest = args.meta === undefined ? [] : [args.meta];
        await notifications.notifyUser(
          args.recipientUserId,
          args.title,
          args.message,
          args.type ?? 'INFO',
          args.link,
          ...rest,
        );
        return true;
      }),
      retryFailed: jest.fn(),
      history: jest.fn(),
    };
    // Only consulted for daily-wage employees, whose ceiling is rate x work days.
    holidays = { getWorkDaysInMonth: jest.fn().mockResolvedValue(26) };

    engine = {
      initiate: jest.fn().mockResolvedValue({ engaged: false, finalized: false }),
      decide: jest.fn().mockResolvedValue({ engaged: false, finalized: false }),
      abandon: jest.fn().mockResolvedValue(undefined),
    };
    schedules = { generate: jest.fn().mockResolvedValue(undefined) };
    eligibility = {
      evaluate: jest.fn().mockResolvedValue({ eligible: true, checks: [] }),
      firstFailure: jest.fn().mockReturnValue(undefined),
    };
    // applyApproved() also books a DISBURSEMENT row; without this the
    // best-effort catch swallows a TypeError and logs noise.
    prisma.loanTransaction = { create: jest.fn().mockResolvedValue({}) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AdvanceLoansService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: mail },
        { provide: SystemSettingsService, useValue: settings },
        { provide: NotificationsService, useValue: notifications },
        { provide: HolidaysService, useValue: holidays },
        // No active ADVANCE_LOAN workflow => engine NOT engaged => the legacy
        // single-approver path, which is what these cases assert.
        { provide: ApprovalEngineService, useValue: engine },
        { provide: LoanScheduleService, useValue: schedules },
        {
          provide: LoanAccessService,
          useValue: { assertCanViewLoan: jest.fn().mockResolvedValue(undefined) },
        },
        // Eligibility passes by default; the gate itself has its own spec.
        { provide: LoanEligibilityService, useValue: eligibility },
        // The dedupe log. These cases assert WHO is told and with what words,
        // which `notifyOnce` forwards verbatim — the dedupe itself is proved
        // over HTTP, where a real unique index exists.
        { provide: LoanNotificationService, useValue: loanNotifications },
      ],
    }).compile();

    service = moduleRef.get(AdvanceLoansService);
  });

  const approveData = () =>
    prisma.advanceLoanRequest.updateMany.mock.calls[0][0].data;

  it('LOAN: stores approver-set installments and the derived per-cycle amount', async () => {
    prisma.advanceLoanRequest.findUnique.mockResolvedValue(
      pending({ type: 'LOAN', amount: 12000, installments: 1 }),
    );

    await service.approve('req-1', HR, { installments: 4 });

    expect(approveData()).toMatchObject({
      status: 'APPROVED',
      installments: 4,
      installmentAmount: 3000, // 12000 / 4
    });
  });

  it('LOAN: rejects an installment count above the configured maximum', async () => {
    prisma.advanceLoanRequest.findUnique.mockResolvedValue(
      pending({ type: 'LOAN', amount: 12000 }),
    );

    await expect(
      service.approve('req-1', HR, { installments: 20 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.advanceLoanRequest.updateMany).not.toHaveBeenCalled();
  });

  it('ADVANCE: blocks an amount above the configured % of monthly pay', async () => {
    // proxy = base 50000, cap = 100% => 50000; request 60000 is over.
    prisma.advanceLoanRequest.findUnique.mockResolvedValue(
      pending({ type: 'ADVANCE', amount: 60000 }),
    );

    await expect(service.approve('req-1', HR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.advanceLoanRequest.updateMany).not.toHaveBeenCalled();
  });

  it('ADVANCE: approves within the limit as a single full-amount installment', async () => {
    prisma.advanceLoanRequest.findUnique.mockResolvedValue(
      pending({ type: 'ADVANCE', amount: 40000 }),
    );

    await service.approve('req-1', HR);

    expect(approveData()).toMatchObject({
      status: 'APPROVED',
      installments: 1,
      installmentAmount: 40000,
    });
  });

  it('ADVANCE: uses active earning salary components as the affordability proxy when present', async () => {
    // Components sum to 30000 (< base 50000); cap becomes 30000, so 40000 is blocked.
    prisma.salaryComponent.findMany.mockResolvedValue([
      { amount: 20000 },
      { amount: 10000 },
    ]);
    prisma.advanceLoanRequest.findUnique.mockResolvedValue(
      pending({ type: 'ADVANCE', amount: 40000 }),
    );

    await expect(service.approve('req-1', HR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  /**
   * For a daily-wage employee both baseSalary and every salary component are
   * PER-DAY figures, so treating either as "monthly net" gated a 500/day worker
   * against a ceiling of 500 and rejected any meaningful advance.
   */
  describe('ADVANCE: daily-wage affordability ceiling', () => {
    const daily = (baseSalary: number) =>
      prisma.employee.findUnique.mockResolvedValue({
        baseSalary,
        salaryType: 'DAILY',
        branchId: 'branch-1',
      });

    it('scales the day rate by the month’s working days', async () => {
      daily(500); // 500 x 26 work days = 13,000 ceiling
      prisma.advanceLoanRequest.findUnique.mockResolvedValue(
        pending({ type: 'ADVANCE', amount: 12000 }),
      );

      await service.approve('req-1', HR);

      expect(approveData()).toMatchObject({ status: 'APPROVED' });
      expect(holidays.getWorkDaysInMonth).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        'branch-1',
      );
    });

    it('still blocks an amount above the scaled ceiling', async () => {
      daily(500); // ceiling 13,000
      prisma.advanceLoanRequest.findUnique.mockResolvedValue(
        pending({ type: 'ADVANCE', amount: 20000 }),
      );

      await expect(service.approve('req-1', HR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('per-day salary components are scaled the same way', async () => {
      daily(500);
      prisma.salaryComponent.findMany.mockResolvedValue([
        { amount: 400 },
        { amount: 100 },
      ]); // 500/day -> 13,000 ceiling, same as the base rate
      prisma.advanceLoanRequest.findUnique.mockResolvedValue(
        pending({ type: 'ADVANCE', amount: 12000 }),
      );

      await service.approve('req-1', HR);
      expect(approveData()).toMatchObject({ status: 'APPROVED' });
    });

    it('a MONTHLY employee never consults the work-day calendar', async () => {
      prisma.advanceLoanRequest.findUnique.mockResolvedValue(
        pending({ type: 'ADVANCE', amount: 40000 }),
      );
      await service.approve('req-1', HR);
      expect(holidays.getWorkDaysInMonth).not.toHaveBeenCalled();
    });
  });

  /**
   * §18 — every other concurrency guard in this module (casVersion, the
   * idempotency-key guard, assertNoRunInFlight) answers 409. Approve and reject
   * answered 400, so a client retrying on 409 told the late approver they had
   * typed something invalid.
   */
  describe('§18 concurrency loss answers 409, not 400', () => {
    it('approve: a request already decided by another approver conflicts', async () => {
      prisma.advanceLoanRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.approve('req-1', HR)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('reject: same shape, same status', async () => {
      prisma.advanceLoanRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.reject('req-1', HR, { remarks: 'no' } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('the message is unchanged, so only the status code moves', async () => {
      prisma.advanceLoanRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.approve('req-1', HR)).rejects.toThrow(
        'This request has already been processed by another approver',
      );
    });
  });

  /**
   * §5 — there was no self-approval rule at all. `assertApprover` checked role
   * membership and MANAGER department scope and nothing else, and the two
   * surfaces disagreed: `findPending` did not exclude the caller, so an
   * approver's own request sat in their own queue with a live Approve button.
   */
  describe('§5 an approver may not decide their own request', () => {
    it('refuses a self-approval by a fully privileged approver', async () => {
      await expect(service.approve('req-1', SELF)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.advanceLoanRequest.updateMany).not.toHaveBeenCalled();
    });

    it('names the reason', async () => {
      await expect(service.approve('req-1', SELF)).rejects.toThrow(
        'You cannot decide your own advance/loan request. Another approver must review it.',
      );
    });

    it('refuses a self-rejection too', async () => {
      await expect(
        service.reject('req-1', SELF, { remarks: 'withdrawn' } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.advanceLoanRequest.updateMany).not.toHaveBeenCalled();
    });

    it('the rule is asserted BEFORE the approval engine is consulted', async () => {
      // Otherwise an engine-driven chain could record a self-decision as a
      // satisfied step even though the legacy gate would have refused it.
      await expect(service.approve('req-1', SELF)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(engine.decide).not.toHaveBeenCalled();
    });

    it('a foreign request is still decidable by the same approver', async () => {
      await service.approve('req-1', HR);
      expect(approveData()).toMatchObject({ status: 'APPROVED' });
    });

    it('findPending excludes the caller\u2019s own requests, so the queue agrees with the rule', async () => {
      await service.findPending(HR);

      expect(prisma.advanceLoanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'PENDING',
            employeeId: { not: 'emp-hr' },
          }),
        }),
      );
    });

    it('an approver with no employee record is not excluded by an undefined id', async () => {
      await service.findPending({ id: 'user-x', role: 'ADMIN' });

      const where = prisma.advanceLoanRequest.findMany.mock.calls[0][0].where;
      expect(where.employeeId).toBeUndefined();
    });
  });

  /**
   * §15 — EMPLOYEE_ACTIVE and NOT_AFTER_RESIGNATION were evaluated only at
   * create. A request filed before someone resigned could be approved after
   * they had gone, minting a schedule against a departed employee.
   */
  describe('§15 employee eligibility is re-checked at approval', () => {
    const failing = (code: string, extra: any = {}) =>
      eligibility.evaluate.mockResolvedValue({
        eligible: false,
        checks: [{ code, label: code, status: 'FAIL', ...extra }],
      });

    it('refuses an approval for an employee who is no longer active', async () => {
      failing('EMPLOYEE_ACTIVE', { actual: 'INACTIVE' });

      await expect(service.approve('req-1', HR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.advanceLoanRequest.updateMany).not.toHaveBeenCalled();
    });

    it('names the reason', async () => {
      failing('EMPLOYEE_ACTIVE', { actual: 'INACTIVE' });

      await expect(service.approve('req-1', HR)).rejects.toThrow(
        'Cannot approve this request: the employee is no longer active (status INACTIVE). Eligibility is re-checked at approval time.',
      );
    });

    it('refuses an approval dated after the last working day', async () => {
      failing('NOT_AFTER_RESIGNATION', { limit: '2026-01-31' });

      await expect(service.approve('req-1', HR)).rejects.toThrow(
        "Cannot approve this request: the employee's last working day (2026-01-31) has passed. Eligibility is re-checked at approval time.",
      );
    });

    it('no schedule and no DISBURSEMENT row is created for a departed employee', async () => {
      failing('EMPLOYEE_ACTIVE', { actual: 'TERMINATED' });

      await expect(service.approve('req-1', HR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(schedules.generate).not.toHaveBeenCalled();
      expect(prisma.loanTransaction.create).not.toHaveBeenCalled();
    });

    it('only the employee-state rules are re-run — a failing MAX_ACTIVE_LOANS does not block', async () => {
      // The request being approved is itself non-terminal, so it counts
      // against the very cap it was created under. Re-running the whole set
      // would refuse every approval.
      failing('MAX_ACTIVE_LOANS', { limit: 2, actual: 2 });

      await service.approve('req-1', HR);
      expect(approveData()).toMatchObject({ status: 'APPROVED' });
    });

    it('a WARN on an employee-state rule is not a refusal', async () => {
      eligibility.evaluate.mockResolvedValue({
        eligible: true,
        checks: [{ code: 'EMPLOYEE_ACTIVE', status: 'WARN' }],
      });

      await service.approve('req-1', HR);
      expect(approveData()).toMatchObject({ status: 'APPROVED' });
    });
  });

  /**
   * §7 — cancel checked `status !== 'PENDING'` and then issued a bare
   * `update({ where: { id } })`, so a cancel that read PENDING before a
   * concurrent approval committed buried an APPROVED loan that already had a
   * schedule and a DISBURSEMENT ledger row under a terminal CANCELLED.
   */
  describe('§7 cancel is a compare-and-set', () => {
    it('writes through updateMany guarded on status = PENDING', async () => {
      await service.cancel('req-1', 'emp-1');

      expect(prisma.advanceLoanRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'req-1', status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      expect(prisma.advanceLoanRequest.update).not.toHaveBeenCalled();
    });

    it('loses the race with the same shape approve/reject use', async () => {
      prisma.advanceLoanRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.cancel('req-1', 'emp-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.cancel('req-1', 'emp-1')).rejects.toThrow(
        'This request has already been processed by another approver',
      );
    });

    it('does not abandon the approval chain for a cancel that lost', async () => {
      prisma.advanceLoanRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.cancel('req-1', 'emp-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(engine.abandon).not.toHaveBeenCalled();
    });

    it('abandons the chain once the cancel has won', async () => {
      await service.cancel('req-1', 'emp-1');
      expect(engine.abandon).toHaveBeenCalledWith('ADVANCE_LOAN', 'req-1');
    });

    it('still refuses someone else\u2019s request', async () => {
      await expect(service.cancel('req-1', 'emp-other')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.advanceLoanRequest.updateMany).not.toHaveBeenCalled();
    });
  });

  /**
   * §17 — every loan notice carried the module constant, so an approver with
   * three pending requests was told only that "one of them" is new.
   */
  describe('§17 notifications carry the loan they are about', () => {
    it('the approver fan-out links to the request', async () => {
      await service.create('emp-1', {
        type: 'ADVANCE',
        amount: 1000,
      } as any);

      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'user-hr',
        expect.any(String),
        expect.any(String),
        'INFO',
        '/dashboard/advance-loans/req-1',
      );
    });

    it('the decision notice links to the decided request', async () => {
      await service.approve('req-1', HR);

      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'user-emp',
        expect.stringContaining('approved'),
        expect.any(String),
        'INFO',
        '/dashboard/advance-loans/req-1',
        expect.objectContaining({ waTemplate: 'loan_decision' }),
      );
    });

    it('a rejection notice links to the same request', async () => {
      await service.reject('req-1', HR, { remarks: 'no budget' } as any);

      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'user-emp',
        expect.stringContaining('rejected'),
        expect.any(String),
        'INFO',
        '/dashboard/advance-loans/req-1',
        expect.any(Object),
      );
    });
  });

  /**
   * §25 — the snapshot columns exist so a loan can be reported on after its
   * employee row is archived, but only the importer wrote them.
   */
  describe('§18 the security deposit a product requires is actually taken', () => {
    /** A product that demands security, with everything else neutral. */
    const secured = {
      id: 'type-sec',
      name: 'Vehicle loan',
      requiresSecurity: true,
      interestMethod: 'NONE',
      interestRate: 0,
      deductionFrequency: 'MONTHLY',
      gracePeriods: 0,
      graceMode: 'NONE',
      processingFeePercent: 0,
      processingFeeFlat: 0,
      processingFeeMode: 'DEDUCT_FROM_DISBURSEMENT',
      employerSubsidyPercent: 0,
      priority: 100,
      category: 'LOAN',
      isActive: true,
    };

    beforeEach(() => {
      prisma.loanType = { findFirst: jest.fn().mockResolvedValue(secured) };
    });

    it('writes the deposit as a percentage of the principal', async () => {
      settingsMap.loan_security_deposit_percent = '10';

      await service.create('emp-1', {
        type: 'LOAN',
        amount: 20000,
        installments: 12,
        loanTypeId: 'type-sec',
      } as any);

      // `securityDeposit` is a v2 column nothing had ever written — not the
      // importer, not create() — so a product could require security and no
      // security was ever recorded against the loan.
      expect(prisma.advanceLoanRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ securityDeposit: 2000 }),
        }),
      );
    });

    it('refuses the filing when the product needs security and the rule is 0%', async () => {
      settingsMap.loan_security_deposit_percent = '0';

      await expect(
        service.create('emp-1', {
          type: 'LOAN',
          amount: 20000,
          installments: 12,
          loanTypeId: 'type-sec',
        } as any),
      ).rejects.toThrow(/loan_security_deposit_percent is 0/);

      // Refused, not filed with a deposit of nothing: a zero here would read as
      // "security taken" on every report that shows the column.
      expect(prisma.advanceLoanRequest.create).not.toHaveBeenCalled();
    });

    it('leaves the deposit at zero for a product that does not require one', async () => {
      settingsMap.loan_security_deposit_percent = '10';
      prisma.loanType.findFirst.mockResolvedValue({ ...secured, requiresSecurity: false });

      await service.create('emp-1', {
        type: 'LOAN',
        amount: 20000,
        installments: 12,
        loanTypeId: 'type-sec',
      } as any);

      expect(prisma.advanceLoanRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ securityDeposit: 0 }),
        }),
      );
    });
  });

  describe('§25 the native create path writes the employee snapshot', () => {
    it('stores the code and the name as they were at filing time', async () => {
      prisma.employee.findUnique.mockResolvedValue({
        id: 'emp-1',
        employeeCode: 'TRS001',
        fullName: 'Raja Guru R',
        baseSalary: 50000,
        branchId: 'branch-1',
      });

      await service.create('emp-1', { type: 'ADVANCE', amount: 1000 } as any);

      expect(prisma.advanceLoanRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            employeeCodeSnapshot: 'TRS001',
            employeeNameSnapshot: 'Raja Guru R',
          }),
        }),
      );
    });
  });
});

/**
 * Unit coverage for the exit-settlement service.
 *
 * It lives here rather than in a file of its own because the two services are
 * fixed together: `settle()` used to apply its decisions in a loop with NO
 * surrounding transaction and create the `LoanSettlement` row only afterwards,
 * so a refusal on a later decision left the earlier ones applied with no
 * settlement record — and therefore nothing for `reverseSettlement()` to
 * restore from.
 */
describe('LoanSettlementService — atomicity and audit', () => {
  let service: LoanSettlementService;
  let prisma: any;
  let lifecycle: any;
  let audit: any;
  let schedules: any;
  let tx: any;

  const LOANS = [
    {
      id: 'loan-1',
      type: 'LOAN',
      referenceNo: 'LN-1',
      status: 'ACTIVE',
      amount: 1000,
      amountRepaid: 0,
      writtenOffAmount: 0,
      waivedAmount: 0,
      outstandingInterest: 0,
    },
    {
      id: 'loan-2',
      type: 'ADVANCE',
      referenceNo: 'AD-2',
      status: 'ACTIVE',
      amount: 500,
      amountRepaid: 0,
      writtenOffAmount: 0,
      waivedAmount: 0,
      outstandingInterest: 0,
    },
  ];

  const preRow = (l: any) => ({
    id: l.id,
    status: l.status,
    amountRepaid: 0,
    writtenOffAmount: 0,
    waivedAmount: 0,
    outstandingPrincipal: l.amount,
    outstandingInterest: 0,
    settlementMode: null,
    closureType: null,
    closedAt: null,
    version: 1,
  });

  /** Only the loans a test declares are outstanding. */
  const outstanding = (ids: string[]) => {
    const rows = LOANS.filter((l) => ids.includes(l.id));
    prisma.advanceLoanRequest.findMany.mockImplementation((args: any) =>
      // `snapshot()` is the only caller that selects `version`.
      Promise.resolve(
        args?.select?.version ? rows.map(preRow) : (rows as any),
      ),
    );
  };

  beforeEach(async () => {
    tx = {
      advanceLoanRequest: { update: jest.fn().mockResolvedValue({}) },
      loanTransaction: { create: jest.fn().mockResolvedValue({}) },
      loanSettlement: { update: jest.fn().mockResolvedValue({}) },
    };

    prisma = {
      employee: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'emp-1', branchId: 'branch-1' }),
      },
      advanceLoanRequest: { findMany: jest.fn() },
      loanSettlement: {
        create: jest.fn().mockResolvedValue({ id: 'settle-1' }),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
    };
    outstanding(['loan-1', 'loan-2']);

    lifecycle = {
      waive: jest.fn().mockResolvedValue({}),
      writeOff: jest.fn().mockResolvedValue({}),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    // §1: interest comes from the LIVE PLAN. Nothing has accrued by default,
    // which is what a freshly disbursed loan looks like.
    schedules = {
      accruedUnpaidInterest: jest.fn().mockResolvedValue(0),
      creditAccruedInterest: jest
        .fn()
        .mockImplementation((_id: string, amount: number) =>
          Promise.resolve(amount),
        ),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        LoanSettlementService,
        { provide: PrismaService, useValue: prisma },
        { provide: LoanLifecycleService, useValue: lifecycle },
        { provide: AuditService, useValue: audit },
        { provide: LoanScheduleService, useValue: schedules },
      ],
    }).compile();

    service = moduleRef.get(LoanSettlementService);
  });

  const USER = { id: 'user-hr', role: 'HR_MANAGER' };

  /**
   * §1 surviving on the exit path.
   *
   * `outstandingInterest` has been redefined as employee-borne interest ACCRUED
   * and unpaid; the live schedule is the source of truth and the column is only
   * a cache — one the importer still fills with the loan's whole LIFETIME
   * interest. This service used to quote straight off that column, so a final
   * settlement billed a departing employee for interest on instalments that had
   * not happened yet.
   */
  describe('§1 the settlement quote derives interest, never reads the cache', () => {
    it('a freshly disbursed interest-bearing loan is quoted at principal only', async () => {
      outstanding(['loan-1']);
      // Nothing due yet: the live plan has earned nothing.
      schedules.accruedUnpaidInterest.mockResolvedValue(0);

      const q = await service.quote('emp-1');

      expect(q.loans[0]).toMatchObject({
        loanId: 'loan-1',
        principal: 1000,
        interest: 0,
        total: 1000,
      });
      expect(q.totalOutstanding).toBe(1000);
    });

    it('the stale lifetime figure in the column is never consulted', async () => {
      outstanding(['loan-1']);

      await service.quote('emp-1');

      // The importer parks a lifetime total there; selecting it at all is the
      // bug. The plan is asked instead.
      const select =
        prisma.advanceLoanRequest.findMany.mock.calls[0][0].select;
      expect(select.outstandingInterest).toBeUndefined();
      expect(schedules.accruedUnpaidInterest).toHaveBeenCalledWith(
        'loan-1',
        {},
        undefined,
      );
    });

    it('interest that HAS accrued is still quoted', async () => {
      outstanding(['loan-1']);
      schedules.accruedUnpaidInterest.mockResolvedValue(40);

      const q = await service.quote('emp-1');

      expect(q.loans[0]).toMatchObject({
        principal: 1000,
        interest: 40,
        total: 1040,
      });
    });

    it('a recovery on a loan with nothing accrued is applied entirely to principal', async () => {
      outstanding(['loan-1']);
      schedules.accruedUnpaidInterest.mockResolvedValue(0);

      await service.settle('emp-1', USER, {
        decisions: [{ loanId: 'loan-1', action: 'PARTIAL', amount: 1000 }],
      });

      expect(tx.advanceLoanRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            amountRepaid: { increment: 1000 },
            interestPaid: { increment: 0 },
            status: 'SETTLED',
          }),
        }),
      );
      expect(tx.loanTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            principalComponent: 1000,
            interestComponent: 0,
          }),
        }),
      );
    });

    it('collected interest is stamped onto the instalments it came from, so a rebuild cannot re-bill it', async () => {
      outstanding(['loan-1']);
      // 40 accrued on a 1000 principal => 1040 outstanding.
      schedules.accruedUnpaidInterest.mockResolvedValue(40);

      await service.settle('emp-1', USER, {
        decisions: [{ loanId: 'loan-1', action: 'PARTIAL', amount: 1040 }],
      });

      expect(schedules.creditAccruedInterest).toHaveBeenCalledWith(
        'loan-1',
        40,
        expect.objectContaining({ note: expect.stringContaining('settlement') }),
        tx,
      );
      expect(tx.loanTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            interestComponent: 40,
            principalComponent: 1000,
          }),
        }),
      );
    });

    it('the cached column is refreshed FROM the plan after the credit, not by arithmetic', async () => {
      outstanding(['loan-1']);
      schedules.accruedUnpaidInterest
        // quote() — the plan is costed off this one figure...
        .mockResolvedValueOnce(40)
        // ...and this is the post-credit re-read inside the transaction.
        .mockResolvedValue(0);

      await service.settle('emp-1', USER, {
        decisions: [{ loanId: 'loan-1', action: 'PARTIAL', amount: 1040 }],
      });

      const data = tx.advanceLoanRequest.update.mock.calls[0][0].data;
      expect(data.outstandingInterest).toBe(0);
      // The credit must land before the cache is re-derived, or the refresh
      // reports interest that has just been settled.
      expect(
        schedules.creditAccruedInterest.mock.invocationCallOrder[0],
      ).toBeLessThan(
        schedules.accruedUnpaidInterest.mock.invocationCallOrder.slice(-1)[0],
      );
    });

    it('nothing is credited when no interest was collected', async () => {
      outstanding(['loan-1']);
      schedules.accruedUnpaidInterest.mockResolvedValue(0);

      await service.settle('emp-1', USER, {
        decisions: [{ loanId: 'loan-1', action: 'PARTIAL', amount: 400 }],
      });

      expect(schedules.creditAccruedInterest).not.toHaveBeenCalled();
    });

    it('a settlement quote taken again after settling does not re-bill the interest', async () => {
      outstanding(['loan-1']);
      schedules.accruedUnpaidInterest.mockResolvedValue(40);

      await service.settle('emp-1', USER, {
        decisions: [{ loanId: 'loan-1', action: 'PARTIAL', amount: 1040 }],
      });

      // creditAccruedInterest is what makes the second read return 0; proving
      // the call happened for the FULL collected amount is what proves the
      // double charge is gone.
      const [, credited] = schedules.creditAccruedInterest.mock.calls[0];
      expect(credited).toBe(40);
    });
  });

  describe('§3 the whole decision set is validated before anything is applied', () => {
    it('a decision naming a foreign loan refuses with nothing applied', async () => {
      // The reproduced case: CARRY_AS_RECEIVABLE followed by a foreign loanId
      // used to return 400 and leave the first loan permanently in RECEIVABLE.
      outstanding(['loan-1']);

      await expect(
        service.settle('emp-1', USER, {
          decisions: [
            { loanId: 'loan-1', action: 'CARRY_AS_RECEIVABLE' },
            { loanId: 'loan-foreign', action: 'WAIVE', amount: 10 },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.loanSettlement.create).not.toHaveBeenCalled();
      expect(tx.advanceLoanRequest.update).not.toHaveBeenCalled();
      expect(lifecycle.waive).not.toHaveBeenCalled();
    });

    it('an over-sized recovery is caught before the earlier decisions run', async () => {
      await expect(
        service.settle('emp-1', USER, {
          decisions: [
            { loanId: 'loan-1', action: 'CARRY_AS_RECEIVABLE' },
            { loanId: 'loan-2', action: 'PARTIAL', amount: 5000 },
          ],
        }),
      ).rejects.toThrow(
        'Recovery of 5000 exceeds the 500 outstanding on loan AD-2',
      );

      expect(prisma.loanSettlement.create).not.toHaveBeenCalled();
      expect(tx.advanceLoanRequest.update).not.toHaveBeenCalled();
    });

    it('a waiver above the outstanding balance is caught up front, not by the lifecycle mid-loop', async () => {
      await expect(
        service.settle('emp-1', USER, {
          decisions: [
            { loanId: 'loan-1', action: 'CARRY_AS_RECEIVABLE' },
            { loanId: 'loan-2', action: 'WAIVE', amount: 900 },
          ],
        }),
      ).rejects.toThrow('Waiver of 900 exceeds the 500 outstanding on loan AD-2');

      expect(lifecycle.waive).not.toHaveBeenCalled();
      expect(prisma.loanSettlement.create).not.toHaveBeenCalled();
    });

    it('an unknown action refuses before anything is applied', async () => {
      await expect(
        service.settle('emp-1', USER, {
          decisions: [
            { loanId: 'loan-1', action: 'CARRY_AS_RECEIVABLE' },
            { loanId: 'loan-2', action: 'TELEPORT' as any },
          ],
        }),
      ).rejects.toThrow('Unknown settlement action: TELEPORT');

      expect(prisma.loanSettlement.create).not.toHaveBeenCalled();
    });

    it('naming the same loan twice is refused — both would apply against one opening balance', async () => {
      outstanding(['loan-1']);

      await expect(
        service.settle('emp-1', USER, {
          decisions: [
            { loanId: 'loan-1', action: 'PARTIAL', amount: 600 },
            { loanId: 'loan-1', action: 'PARTIAL', amount: 600 },
          ],
        }),
      ).rejects.toThrow('Loan LN-1 has more than one settlement decision');

      expect(prisma.loanSettlement.create).not.toHaveBeenCalled();
    });
  });

  describe('§3 a failure during apply leaves nothing half-settled', () => {
    it('the settlement record — the undo record — is written BEFORE the first effect', async () => {
      await service.settle('emp-1', USER, {
        decisions: [
          { loanId: 'loan-1', action: 'CARRY_AS_RECEIVABLE' },
          { loanId: 'loan-2', action: 'CARRY_AS_RECEIVABLE' },
        ],
      });

      const createOrder =
        prisma.loanSettlement.create.mock.invocationCallOrder[0];
      const applyOrder = prisma.$transaction.mock.invocationCallOrder[0];
      expect(createOrder).toBeLessThan(applyOrder);

      // ...and it carries the pre-state, so a crash mid-apply is reversible.
      const data = prisma.loanSettlement.create.mock.calls[0][0].data;
      expect(data.decisionsJson.preState).toHaveLength(2);
    });

    it('a refusal the plan cannot foresee rolls the delegated effects back', async () => {
      // A waiver applies, then the transaction this service owns fails. The
      // waiver lives in the lifecycle service's own transaction and cannot be
      // rolled back by ours, so it is compensated instead.
      prisma.$transaction.mockImplementationOnce(() =>
        Promise.reject(new Error('deadlock detected')),
      );

      await expect(
        service.settle('emp-1', USER, {
          decisions: [
            { loanId: 'loan-2', action: 'WAIVE', amount: 500 },
            { loanId: 'loan-1', action: 'CARRY_AS_RECEIVABLE' },
          ],
        }),
      ).rejects.toThrow('deadlock detected');

      expect(lifecycle.waive).toHaveBeenCalled();

      // Every named loan is put back exactly where it was...
      const restored = tx.advanceLoanRequest.update.mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(restored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            where: { id: 'loan-2' },
            data: expect.objectContaining({
              status: 'ACTIVE',
              waivedAmount: 0,
            }),
          }),
        ]),
      );

      // ...and the settlement is marked reversed rather than left looking live.
      expect(tx.loanSettlement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'settle-1' },
          data: expect.objectContaining({
            reversalReason: expect.stringContaining('Automatic rollback'),
          }),
        }),
      );
    });

    it('a role refusal from the delegated write-off rolls back too', async () => {
      lifecycle.writeOff.mockRejectedValue(
        new ForbiddenException('Your role is not permitted'),
      );

      await expect(
        service.settle('emp-1', USER, {
          decisions: [
            { loanId: 'loan-1', action: 'CARRY_AS_RECEIVABLE' },
            { loanId: 'loan-2', action: 'WRITE_OFF' },
          ],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(tx.loanSettlement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reversedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('the original error is re-thrown, not the rollback outcome', async () => {
      prisma.$transaction
        .mockImplementationOnce(() => Promise.reject(new Error('original')))
        .mockImplementationOnce(() => Promise.reject(new Error('rollback also failed')));

      await expect(
        service.settle('emp-1', USER, {
          decisions: [
            { loanId: 'loan-1', action: 'CARRY_AS_RECEIVABLE' },
            { loanId: 'loan-2', action: 'CARRY_AS_RECEIVABLE' },
          ],
        }),
      ).rejects.toThrow('original');
    });
  });

  describe('§3 the effects this service owns share ONE transaction', () => {
    it('every direct decision is applied through the same tx client', async () => {
      await service.settle('emp-1', USER, {
        decisions: [
          { loanId: 'loan-1', action: 'CARRY_AS_RECEIVABLE' },
          { loanId: 'loan-2', action: 'PARTIAL', amount: 500 },
        ],
      });

      // One interactive transaction, not one per decision.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.advanceLoanRequest.update).toHaveBeenCalledTimes(2);
      expect(tx.loanTransaction.create).toHaveBeenCalledTimes(1);
    });

    it('a write-off is costed at the amount actually applied (principal only)', async () => {
      outstanding(['loan-1']);

      await service.settle('emp-1', USER, {
        decisions: [{ loanId: 'loan-1', action: 'WRITE_OFF' }],
      });

      expect(lifecycle.writeOff).toHaveBeenCalledWith(
        'loan-1',
        USER,
        expect.objectContaining({ amount: 1000 }),
      );
      expect(prisma.loanSettlement.create.mock.calls[0][0].data.writtenOff).toBe(
        1000,
      );
    });
  });

  /**
   * §9 — settlement rows were written under `resourceType: 'LoanSettlement'`
   * keyed by the settlement id, while the controller interceptor writes
   * 'AdvanceLoan'. Neither query found the other's rows, so "this loan's
   * history" came back with half of it missing and no sign of the rest.
   */
  describe('§9 the audit trail is answerable from one resourceType', () => {
    const rows = (type: string) =>
      audit.log.mock.calls
        .map((c: any[]) => c[0])
        .filter((r: any) => r.resourceType === type);

    it('every settled loan gets its own AdvanceLoan row', async () => {
      await service.settle('emp-1', USER, {
        decisions: [
          { loanId: 'loan-1', action: 'CARRY_AS_RECEIVABLE' },
          { loanId: 'loan-2', action: 'PARTIAL', amount: 500 },
        ],
      });

      expect(rows('AdvanceLoan').map((r: any) => r.resourceId)).toEqual([
        'loan-1',
        'loan-2',
      ]);
      expect(rows('AdvanceLoan')[0].newData).toMatchObject({
        settlementId: 'settle-1',
        action: 'CARRY_AS_RECEIVABLE',
      });
    });

    it('nothing is written under the orphaned AdvanceLoanRequest type', async () => {
      await service.settle('emp-1', USER, {
        decisions: [
          { loanId: 'loan-1', action: 'CARRY_AS_RECEIVABLE' },
          { loanId: 'loan-2', action: 'CARRY_AS_RECEIVABLE' },
        ],
      });

      expect(rows('AdvanceLoanRequest')).toHaveLength(0);
    });

    it('the settlement-scoped row is kept — it is a different resource', async () => {
      await service.settle('emp-1', USER, {
        decisions: [
          { loanId: 'loan-1', action: 'CARRY_AS_RECEIVABLE' },
          { loanId: 'loan-2', action: 'CARRY_AS_RECEIVABLE' },
        ],
      });

      expect(rows('LoanSettlement')).toEqual([
        expect.objectContaining({
          action: 'LOAN_SETTLEMENT_DECIDED',
          resourceId: 'settle-1',
        }),
      ]);
    });

    it('a reversal writes a row per restored loan as well as the settlement row', async () => {
      prisma.loanSettlement.findUnique.mockResolvedValue({
        id: 'settle-1',
        reversedAt: null,
        decisionsJson: { preState: LOANS.map(preRow) },
      });

      await service.reverseSettlement('settle-1', USER, { reason: 'wrong sheet' });

      expect(rows('AdvanceLoan').map((r: any) => r.resourceId)).toEqual([
        'loan-1',
        'loan-2',
      ]);
      expect(rows('LoanSettlement')).toHaveLength(1);
    });
  });
});
