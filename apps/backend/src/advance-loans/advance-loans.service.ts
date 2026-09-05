import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import {
  managerDeptScope,
  isDeptInManagerScope,
} from '../common/services/manager-scope.util';
import { LOAN_DEBT_STATUSES } from './loan.types';
import type {
  LoanDeductionFrequency,
  LoanGraceMode,
  LoanInterestMethod,
  LoanProcessingFeeMode,
} from '@prisma/client';
import { roundMoney } from '../common/utils/money.util';
import { CreateAdvanceLoanDto } from './dto/create-advance-loan.dto';
import {
  DisburseLoanDto,
  UpdateAdvanceLoanDto,
} from './dto/update-advance-loan.dto';
import { ApproveAdvanceLoanDto } from './dto/approve-advance-loan.dto';
import { RejectAdvanceLoanDto } from './dto/reject-advance-loan.dto';
import { MailService } from '../mail/mail.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { HolidaysService } from '../holidays/holidays.service';
import { isDailyWage } from '../payrolls/payroll-earnings.util';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import { LoanScheduleService } from './loan-schedule.service';
import { LoanAccessService } from './loan-access.service';
import { LoanEligibilityService } from './loan-eligibility.service';
import { LoanNotificationService } from './loan-notification.service';
import { LOAN_TERMINAL_STATUSES } from './loan.types';

const LINK = '/dashboard/advance-loans';

/**
 * Deep link to ONE request.
 *
 * Every loan notification used to carry the bare module constant, so an
 * approver holding three pending requests was told only that "one of them" is
 * new, and two loans closed in the same window produced two indistinguishable
 * rows. `notifyUser` already takes a link — it was simply never given a useful
 * one.
 */
const loanLink = (requestId: string) => `${LINK}/${requestId}`;

/**
 * Eligibility rules re-evaluated at APPROVAL time as well as at create.
 *
 * Deliberately a SUBSET. Re-running the whole set would refuse every approval:
 * `MAX_ACTIVE_LOANS` counts the very request being approved (it is non-terminal
 * from the moment it is filed) and `DUPLICATE_REFERENCE` would match itself.
 * What must not go stale between filing and approval is the EMPLOYEE'S OWN
 * STATE — whether they are still here.
 */
const APPROVAL_RECHECK_CODES: readonly string[] = [
  'EMPLOYEE_ACTIVE',
  'NOT_AFTER_RESIGNATION',
];

@Injectable()
export class AdvanceLoansService {
  private readonly logger = new Logger(AdvanceLoansService.name);

  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
    private settingsService: SystemSettingsService,
    private notifications: NotificationsService,
    private holidaysService: HolidaysService,
    private engine: ApprovalEngineService,
    private schedules: LoanScheduleService,
    private access: LoanAccessService,
    private eligibility: LoanEligibilityService,
    private loanNotifications: LoanNotificationService,
  ) {}

  private employeeInclude = {
    employee: {
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        departmentId: true,
        branchId: true,
        department: { select: { id: true, name: true } },
      },
    },
    approver: {
      select: {
        id: true,
        email: true,
        employee: { select: { fullName: true } },
      },
    },
    deductions: {
      orderBy: { createdAt: 'desc' as const },
    },
    attachments: {
      where: { deletedAt: null },
      orderBy: { uploadedAt: 'desc' as const },
    },
  };

  /**
   * LIST include. Deliberately lighter than `employeeInclude`: the full
   * deductions array is the dominant cost on a list page — at 100k loans x 12
   * instalments that is over a million rows for one screen — and the list only
   * ever renders `attachments.length`. The detail route keeps the full arrays.
   */
  private listInclude = {
    employee: {
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        departmentId: true,
        branchId: true,
        department: { select: { id: true, name: true } },
      },
    },
    approver: {
      select: {
        id: true,
        email: true,
        employee: { select: { fullName: true } },
      },
    },
    attachments: {
      where: { deletedAt: null },
      select: { id: true },
    },
  };

  /**
   * BigInt attachment sizes are not JSON-serializable — convert to Number.
   * Also surface a derived outstanding balance for the UI.
   */
  private serialize(request: any) {
    if (!request) return request;
    const amount = Number(request.amount);
    const amountRepaid = Number(request.amountRepaid || 0);
    return {
      ...request,
      outstandingBalance: Math.max(0, amount - amountRepaid),
      attachments: request.attachments?.map((a: any) => ({
        ...a,
        fileSize:
          a.fileSize !== null && a.fileSize !== undefined
            ? Number(a.fileSize)
            : null,
      })),
    };
  }

  /** Roles allowed to approve, as configured in Settings → Advance & Loan. */
  private async getApproverRoles(): Promise<string[]> {
    const raw = await this.settingsService.getSetting(
      'advance_loan_approver_roles',
      'HR_MANAGER,ADMIN',
    );
    return raw
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  }

  /**
   * Nobody decides their own request.
   *
   * This rule did not exist. `assertApprover` checked role membership and
   * MANAGER department scope and nothing else, so an HR_MANAGER could approve
   * their own loan outright — and `findPending` did not exclude the caller, so
   * their own request sat in their own queue with a live Approve button while
   * the row-detail modal quietly disagreed.
   *
   * It is asserted in `decide()` BEFORE the approval engine is consulted, so it
   * binds the engine-driven chain and the legacy single-approver fallback
   * alike, and repeated inside `assertApprover()` so no future caller of that
   * gate can route around it.
   */
  private assertNotSelfDecision(user: any, request: { employeeId: string }) {
    if (user?.employeeId && request.employeeId === user.employeeId) {
      throw new ForbiddenException(
        'You cannot decide your own advance/loan request. Another approver must review it.',
      );
    }
  }

  /**
   * Configurable approver check — must live in the service because the static
   * @Roles decorator cannot read DB-backed settings. MANAGER approvers are
   * scoped to their own department, and no approver of any role may decide
   * their own request.
   */
  private async assertApprover(
    user: any,
    request: { employeeId: string; employee?: { departmentId?: string | null } },
  ) {
    const roles = await this.getApproverRoles();
    if (!roles.includes(user.role)) {
      throw new ForbiddenException(
        'Your role is not configured to approve advance/loan requests',
      );
    }
    if (
      user.role === 'MANAGER' &&
      !isDeptInManagerScope(user, request.employee?.departmentId ?? null)
    ) {
      throw new ForbiddenException(
        'You can only review requests from your own department',
      );
    }
    this.assertNotSelfDecision(user, request);
  }

  /**
   * Re-assert the employee-state eligibility rules at approval time.
   *
   * `EMPLOYEE_ACTIVE` and `NOT_AFTER_RESIGNATION` were evaluated only at
   * create, while `applyApproved` re-checked the instalment range and the
   * advance cap — so a request filed before someone resigned could be approved
   * after they had gone, minting a schedule and a DISBURSEMENT row against a
   * departed employee. The gate itself is not duplicated here: the same
   * `LoanEligibilityService.evaluate` runs, and only its verdict on the
   * employee-state rules is consulted.
   */
  private async assertStillEligibleAtApproval(
    request: any,
    monthlyNet: number,
  ) {
    const result = await this.eligibility.evaluate({
      employeeId: request.employeeId,
      amount: Number(request.amount),
      installments: request.installments ?? 1,
      type: request.type,
      monthlyNet,
    });

    const failed = (result?.checks ?? []).find(
      (c: any) => c.status === 'FAIL' && APPROVAL_RECHECK_CODES.includes(c.code),
    );
    if (!failed) return;

    const reason =
      failed.code === 'EMPLOYEE_ACTIVE'
        ? `the employee is no longer active (status ${failed.actual ?? 'unknown'})`
        : `the employee's last working day (${failed.limit ?? 'unknown'}) has passed`;

    throw new BadRequestException(
      `Cannot approve this request: ${reason}. Eligibility is re-checked at approval time.`,
    );
  }

  /**
   * Best available proxy for the employee's monthly net pay, used to gate
   * over-sized advances at approval time. Prefer the sum of active earning
   * salary components; fall back to the contract base salary.
   *
   * For daily-wage staff BOTH of those are per-day figures — a day rate and
   * per-day components — so they are scaled up by the month's working days.
   * Without that, an employee on 500/day was gated against a "monthly salary"
   * of 500 and every meaningful advance was rejected.
   */
  private async getMonthlyNetProxy(employeeId: string): Promise<number> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { baseSalary: true, salaryType: true, branchId: true },
    });
    const components = await this.prisma.salaryComponent.findMany({
      where: {
        employeeId,
        isActive: true,
        componentType: { not: 'PAYROLL_CONFIG' },
      },
      select: { amount: true },
    });
    const componentsTotal = components.reduce(
      (sum, c) => sum + Number(c.amount),
      0,
    );
    const perPeriod =
      componentsTotal > 0 ? componentsTotal : Number(employee?.baseSalary || 0);

    if (!isDailyWage(employee?.salaryType)) return perPeriod;

    // Same work-day source payroll uses, so the ceiling matches what the
    // employee can actually earn in the month being drawn against.
    const now = new Date();
    const workDays = await this.holidaysService.getWorkDaysInMonth(
      now.getUTCMonth() + 1,
      now.getUTCFullYear(),
      employee?.branchId ?? undefined,
    );
    return perPeriod * Math.max(0, workDays);
  }

  /**
   * The terms a new request is filed on.
   *
   * One resolver, three sources, in strict order: **what was asked for**, then
   * **the product**, then the **`loan_default_*` setting**. Before this, none of
   * the three could reach a natively created loan — the DTO had no term fields,
   * `LoanType` was wired to nothing, and the five `loan_default_*` keys were
   * seeded and read by no code at all, so every API-filed loan was
   * `NONE / 0 / MONTHLY` from the Prisma column defaults whatever anyone asked
   * for.
   *
   * Resolved at FILING rather than at approval on purpose: these are the terms
   * shown to the requester in the eligibility panel and on the product line, and
   * terms that could still move between showing and agreeing are not terms.
   */
  private async resolveTerms(
    dto: CreateAdvanceLoanDto,
    product: { [k: string]: any } | null,
    amount: number,
  ) {
    const setting = (key: string, fallback: string) =>
      this.settingsService.getSetting(key, fallback);

    // The same kill-switch `LoanScheduleService.generate()` obeys. Honoured
    // here as a COERCION rather than a refusal, matching the generator: a
    // deployment with interest off is stating a policy about new agreements,
    // and the loan must not SAY 8% while its schedule charges nothing.
    const interestEnabled = (await setting('loan_interest_enabled', 'false')) === 'true';

    const method = interestEnabled
      ? ((dto.interestMethod ??
          product?.interestMethod ??
          (await setting('loan_default_interest_method', 'NONE'))) as string)
      : 'NONE';

    const rawRate =
      dto.interestRate ??
      (product ? Number(product.interestRate) : undefined) ??
      Number(await setting('loan_default_interest_rate', '0'));
    const rate = interestEnabled && method !== 'NONE' ? Number(rawRate) : 0;

    // A method with no rate is interest-free with extra steps, and a rate with
    // no method is a number the engine ignores. Both are refused here rather
    // than written and silently dropped.
    if (method !== 'NONE' && rate <= 0) {
      throw new BadRequestException(
        `Interest method ${method} needs a rate above 0. Leave the method as NONE for an interest-free loan.`,
      );
    }
    if (method === 'NONE' && dto.interestRate != null && dto.interestRate > 0) {
      throw new BadRequestException(
        interestEnabled
          ? 'An interest rate was given but the interest method is NONE.'
          : 'Interest is switched off in this system, so a rate cannot be applied. Turn on loan_interest_enabled first.',
      );
    }

    const frequency = (dto.deductionFrequency ??
      product?.deductionFrequency ??
      (await setting('loan_default_frequency', 'MONTHLY'))) as string;

    const gracePeriods =
      dto.gracePeriods ?? product?.gracePeriods ?? 0;
    // `loan_grace_mode` is seeded as MORATORIUM_FULL and read by nothing — the
    // engine has no graceMode parameter at all, and `gracePeriods` alone shifts
    // the first due date. The column is written so the request records what was
    // agreed; it changes no arithmetic until the engine implements the modes.
    const graceMode =
      product?.graceMode ??
      (gracePeriods > 0 ? await setting('loan_grace_mode', 'MORATORIUM_FULL') : 'NONE');

    // Security deposit.
    //
    // `AdvanceLoanRequest.securityDeposit` has existed since v2 and NOTHING has
    // ever written it — not the importer, not create(). `LoanType` carries only
    // `requiresSecurity`, a boolean, so the product can say that security is
    // required and cannot say how much: the amount lives in
    // `loan_security_deposit_percent`, one company-wide rule rather than a
    // number typed per request, because a deposit an employee chooses is not a
    // deposit.
    //
    // A product that requires security while the rule is 0% is REFUSED rather
    // than filed with a zero deposit. Silently writing 0 is exactly the
    // "setting an admin can see does nothing" failure this module already has a
    // register of — and here it would also hand the borrower a loan whose
    // security was never taken.
    let securityDeposit = 0;
    if (product?.requiresSecurity) {
      const percent = Number(await setting('loan_security_deposit_percent', '0'));
      if (!Number.isFinite(percent) || percent <= 0) {
        throw new BadRequestException(
          `${product.name ?? 'This loan product'} requires a security deposit, but ` +
            `loan_security_deposit_percent is 0. Set it before filing against this product.`,
        );
      }
      securityDeposit = roundMoney((amount * percent) / 100);
    }

    return {
      interestMethod: method as LoanInterestMethod,
      interestRate: rate,
      deductionFrequency: frequency as LoanDeductionFrequency,
      gracePeriods,
      graceMode: (gracePeriods > 0 ? graceMode : 'NONE') as LoanGraceMode,
      // Fees, subsidy, security and recovery priority come from the product
      // only: they are the employer's terms, not the requester's, so there is
      // no DTO field for them by design.
      processingFee: product
        ? roundMoney(
            (amount * Number(product.processingFeePercent)) / 100 +
              Number(product.processingFeeFlat),
          )
        : 0,
      processingFeeMode: (product?.processingFeeMode ??
        'DEDUCT_FROM_DISBURSEMENT') as LoanProcessingFeeMode,
      employerSubsidyPercent: product ? product.employerSubsidyPercent : 0,
      securityDeposit,
      priority: product?.priority ?? 100,
    };
  }

  /**
   * Mint the human-readable reference a loan is known by.
   *
   * `loan_reference_prefix` was seeded (default `LN`) and read by nothing:
   * `referenceNo` was set ONLY by the importer, despite the schema comment
   * claiming it is "minted on first v2 touch". So a natively created loan had
   * no reference at all, the `DUPLICATE_REFERENCE` eligibility rule could never
   * fire for one, and support had nothing to quote back to an employee.
   *
   * Format is `<PREFIX>-<YYYYMM>-<seq>`, the sequence being per prefix+month so
   * two loans filed in the same month cannot collide and the number stays short
   * enough to read aloud. The column is `@unique`, so the retry below is the
   * real guard: two simultaneous filings can compute the same sequence, and the
   * loser retries rather than failing the request.
   */
  private async mintReference(when: Date): Promise<string> {
    const prefix = (
      await this.settingsService.getSetting('loan_reference_prefix', 'LN')
    )
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 10) || 'LN';

    const period = `${when.getUTCFullYear()}${String(when.getUTCMonth() + 1).padStart(2, '0')}`;

    // `nextval`, not `COUNT(*) + 1`.
    //
    // Counting is not a sequence, it is a guess: fifty approvals filed at once
    // all count the same total, compute the same number, and forty-nine lose on
    // the `reference_no` unique index. A bounded retry rescued a racing PAIR
    // and could not rescue fifty, because the retries re-count and collide
    // again. `nextval` is atomic and never returns a value twice.
    const [{ seq }] = await this.prisma.$queryRaw<{ seq: bigint }[]>`
      SELECT nextval('loan_reference_seq') AS seq
    `;
    return `${prefix}-${period}-${String(Number(seq)).padStart(4, '0')}`;
  }

  /**
   * When the loan takes effect.
   *
   * Two settings finally get read here. `advance_loan_allow_backdated_days`
   * (seeded 30) bounds how far back a correction may reach; the employee's own
   * joining date bounds it absolutely, because a loan cannot precede the
   * employment it is recovered from. Note the eligibility service already had a
   * `NOT_BEFORE_JOINING` rule and it compared the joining date against *today*
   * rather than against any requested date — there was no requested date to
   * compare with.
   *
   * Future-dating is allowed within the same window: a loan agreed now and
   * starting next cycle is an ordinary thing to record, and the schedule is
   * built from this anchor.
   */
  private async resolveEffectiveDate(
    dto: CreateAdvanceLoanDto,
    employee: { startDate: Date | null },
  ): Promise<Date> {
    const today = new Date();
    const todayUtc = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    if (!dto.effectiveDate) return todayUtc;

    const [y, m, d] = dto.effectiveDate.split('-').map(Number);
    const asked = new Date(Date.UTC(y, m - 1, d));
    // `2026-02-31` parses as 3 March in every Date implementation, so the
    // round-trip is the only way to refuse an impossible day.
    if (
      asked.getUTCFullYear() !== y ||
      asked.getUTCMonth() !== m - 1 ||
      asked.getUTCDate() !== d
    ) {
      throw new BadRequestException(
        `${dto.effectiveDate} is not a real calendar date.`,
      );
    }

    const windowDays = Number(
      await this.settingsService.getSetting('advance_loan_allow_backdated_days', '30'),
    );
    const days = Number.isFinite(windowDays) ? Math.max(0, windowDays) : 30;
    const deltaDays = Math.round(
      (todayUtc.getTime() - asked.getTime()) / 86_400_000,
    );

    if (deltaDays > days) {
      throw new BadRequestException(
        days === 0
          ? 'This loan cannot be backdated. Set the start date to today or later.'
          : `A loan can be backdated by at most ${days} day(s); ${dto.effectiveDate} is ${deltaDays} day(s) ago.`,
      );
    }
    if (-deltaDays > days) {
      throw new BadRequestException(
        `A loan can start at most ${days} day(s) ahead; ${dto.effectiveDate} is ${-deltaDays} day(s) away.`,
      );
    }
    if (employee.startDate && asked < new Date(employee.startDate)) {
      throw new BadRequestException(
        `A loan cannot start before the employee joined (${new Date(employee.startDate).toISOString().slice(0, 10)}).`,
      );
    }

    return asked;
  }

  /**
   * File a request.
   *
   * `onBehalfOf` is set only by the on-behalf route: HR filing for somebody who
   * cannot file for themselves (no portal account, or a paper form). It is
   * recorded rather than disguised — `createdOnBehalfBy` and
   * `approvalSource = 'ON_BEHALF'` exist for exactly this and were written by
   * nothing, which is why the BULK IMPORTER became the only way to create a
   * loan for an arbitrary employee and ended up the de-facto factory for half
   * this module's states.
   */
  /**
   * Create the request, retrying if two filings mint the same reference.
   *
   * `mintReference` counts existing references and adds one, so two concurrent
   * creates in the same month compute the SAME number and the second loses on
   * the unique index. The comment there always said the loser retries; this is
   * the retry, and without it a simultaneous filing answered 500 — which is how
   * the browser concurrency suite found it, because every backend e2e run is
   * serial and could not.
   *
   * Bounded: after a few collisions something else is wrong, and a 500 with a
   * real stack is better than a loop.
   */
  private async createWithReference(
    args: Parameters<PrismaService['advanceLoanRequest']['create']>[0],
    when: Date,
  ) {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.advanceLoanRequest.create(args);
      } catch (err) {
        const isRefClash =
          (err as { code?: string })?.code === 'P2002' &&
          String((err as any)?.meta?.target ?? '').includes('reference_no');
        if (!isRefClash || attempt >= MAX_ATTEMPTS) throw err;
        (args.data as Record<string, unknown>).referenceNo =
          await this.mintReference(when);
      }
    }
  }

  async create(
    employeeId: string,
    dto: CreateAdvanceLoanDto,
    onBehalfOf?: { userId: string },
  ) {
    const enabled = await this.settingsService.getSetting(
      'advance_loan_enabled',
      'true',
    );
    if (enabled === 'false') {
      throw new BadRequestException(
        'Salary Advance & Loan module is disabled',
      );
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Branch guard: a scoped caller cannot create a request for an
    // out-of-branch employee (create is not auto-scoped for relation models).
    assertInBranch(employee.branchId);

    if (!['ADVANCE', 'LOAN'].includes(dto.type)) {
      throw new BadRequestException('Invalid request type');
    }

    // The product, when one was chosen. `findFirst` rather than `findUnique`
    // so the branch predicate applies: a product scoped to another branch must
    // read as absent, not as forbidden.
    const product = dto.loanTypeId
      ? await this.prisma.loanType.findFirst({ where: { id: dto.loanTypeId } })
      : null;
    if (dto.loanTypeId && !product) {
      throw new NotFoundException('Loan product not found');
    }
    if (product && !product.isActive) {
      throw new BadRequestException(
        `${product.name} is no longer offered. Choose another product.`,
      );
    }
    // A product declares which flow it belongs to. Filing an ADVANCE under a
    // LOAN product would inherit an amortised schedule for something the
    // advance flow recovers in a single deduction.
    if (product && product.category !== dto.type) {
      throw new BadRequestException(
        `${product.name} is a ${product.category.toLowerCase()} product and cannot be used for a ${dto.type.toLowerCase()} request.`,
      );
    }

    // Advances are always recovered in a single cycle; only loans carry a
    // proposed installment count into approval. The product's own default is
    // the fallback when the requester did not state one — that is what
    // `defaultInstallments` is for.
    const installments =
      dto.type === 'LOAN'
        ? (dto.installments ?? product?.defaultInstallments ?? 1)
        : 1;

    // Same gate the approver, the on-behalf path and the importer use, so a
    // request that could not be created here cannot appear by another route.
    const check = await this.eligibility.evaluate({
      employeeId,
      amount: Number(dto.amount),
      installments,
      type: dto.type,
      loanTypeId: product?.id ?? null,
      monthlyNet: await this.getMonthlyNetProxy(employeeId),
    });
    const failure = this.eligibility.firstFailure(check);
    if (failure) {
      throw new BadRequestException(
        failure.detail ??
          `${failure.label} (limit ${failure.limit ?? 'n/a'}, actual ${failure.actual ?? 'n/a'})`,
      );
    }

    const effectiveDate = await this.resolveEffectiveDate(dto, employee);
    const terms = await this.resolveTerms(dto, product, Number(dto.amount));

    const request = await this.createWithReference({
      data: {
        employeeId,
        type: dto.type,
        amount: dto.amount,
        reason: dto.reason ?? null,
        installments,
        status: dto.draft ? 'DRAFT' : 'PENDING',
        loanTypeId: product?.id ?? null,
        // The terms, fixed at filing. Editing the product afterwards changes
        // what the NEXT request inherits and nothing about this one.
        ...terms,
        effectiveDate,
        referenceNo: await this.mintReference(effectiveDate),
        ...(onBehalfOf
          ? {
              createdOnBehalfBy: onBehalfOf.userId,
              approvalSource: 'ON_BEHALF',
            }
          : {}),
        // Identity snapshot, taken at filing time.
        //
        // These columns exist so a loan can still be reported on after its
        // employee row is archived, but only the importer ever wrote them — a
        // natively filed loan left both NULL and reporting fell back to a live
        // join, which is precisely the dependency the snapshot removes.
        employeeCodeSnapshot: employee.employeeCode,
        employeeNameSnapshot: employee.fullName,
      },
      include: this.employeeInclude,
    }, effectiveDate);

    // A draft is not in anyone's queue yet: no approval chain, no fan-out. It
    // becomes a real request at `submit`, which re-runs the same gate.
    if (dto.draft) {
      return this.serialize(request);
    }

    // Engage the configurable approval chain when one is active. Unlike
    // travel.service.ts, a NOT-engaged engine does NOT mean "approve now" —
    // that would auto-approve every loan whenever the kill-switch is off. It
    // means "fall back to the legacy single-approver path".
    const init = await this.engine
      .initiate('ADVANCE_LOAN' as any, request.id, employeeId, undefined)
      .catch((err) => {
        this.logger.error(
          `Approval chain initiation failed for loan ${request.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return { engaged: false, finalized: false } as any;
      });

    if (!init.engaged) {
      await this.notifyApprovers(request);
    }

    return this.serialize(request);
  }

  /**
   * What-if eligibility, for the request form. Persists nothing, so it is safe
   * to call on every keystroke (debounced) — and it lives on a controller with
   * no @AuditResource so it does not write an audit row per call.
   */
  async checkEligibility(args: {
    employeeId: string;
    amount: number;
    installments?: number;
    type?: string;
  }) {
    const result = await this.eligibility.evaluate({
      ...args,
      monthlyNet: await this.getMonthlyNetProxy(args.employeeId),
    });
    return { success: true, data: result };
  }

  /**
   * Fan out an in-app notification to every user of the configured approver
   * roles. MANAGER recipients only when they belong to the requester's
   * department (matching pending-queue visibility).
   */
  private async notifyApprovers(request: any) {
    try {
      const roles = await this.getApproverRoles();
      if (roles.length === 0) return;

      const nonManagerRoles = roles.filter((r) => r !== 'MANAGER');
      const or: any[] = [];
      if (nonManagerRoles.length > 0) {
        or.push({ role: { in: nonManagerRoles } });
      }
      if (roles.includes('MANAGER') && request.employee?.departmentId) {
        or.push({
          role: 'MANAGER',
          employee: { departmentId: request.employee.departmentId },
        });
      }
      if (or.length === 0) return;

      const approvers = await this.prisma.user.findMany({
        where: { isActive: true, OR: or },
        select: { id: true },
      });
      const label = request.type === 'LOAN' ? 'loan' : 'salary advance';
      await Promise.all(
        approvers.map((a) =>
          // Through the log, so a re-filed or retried notice cannot reach the
          // same approver twice about the same request.
          this.loanNotifications.notifyOnce({
            requestId: request.id,
            event: 'LOAN_SUBMITTED',
            recipientUserId: a.id,
            title: `New ${label} request`,
            message: `${request.employee.fullName} requested a ${label} of ${Number(request.amount)}.`,
            // The request this notice is about, not the module index.
            link: loanLink(request.id),
          }),
        ),
      );
    } catch {
      // Notification failure must not block the request itself.
    }
  }

  /** Notify the requesting employee's user account of a decision. */
  private async notifyRequester(
    employeeId: string,
    requestId: string,
    title: string,
    message: string,
    waData?: Record<string, unknown>,
    event = 'LOAN_DECISION',
  ) {
    try {
      const user = await this.prisma.user.findFirst({
        where: { employeeId },
        select: { id: true },
      });
      if (user) {
        // 'INFO' cannot discriminate a loan decision from any other info
        // notification, so the WhatsApp template is named explicitly — and the
        // link names the decided request, so two decisions in the same window
        // are not two indistinguishable rows.
        await this.loanNotifications.notifyOnce({
          requestId,
          event,
          recipientUserId: user.id,
          title,
          message,
          link: loanLink(requestId),
          meta: {
            waTemplate: 'loan_decision',
            waData,
          },
        });
      }
    } catch {
      // Non-fatal.
    }
  }

  /**
   * List requests.
   *
   * Pagination is OPT-IN: pass `page`/`limit` for the `{data, meta, summary}`
   * envelope, omit them for the bare array the existing frontend expects. That
   * lets the API grow a bound without a lock-step frontend release — a stale
   * bundle against a changed shape renders an empty list with NO error, which
   * is worse than being unbounded.
   */
  async findAll(
    status?: string,
    employeeId?: string,
    type?: string,
    page?: number,
    limit?: number,
    search?: string,
  ) {
    const where: any = {};
    // CSV so a caller can ask for several statuses at once.
    if (status) {
      const parts = status.split(',').map((p) => p.trim()).filter(Boolean);
      where.status = parts.length > 1 ? { in: parts } : parts[0];
    }
    if (employeeId) where.employeeId = employeeId;
    if (type) where.type = type;

    // Free-text search across the three things someone actually types when
    // hunting for a request: who it belongs to, their code, and the reference.
    //
    // It has to run in the QUERY, not over the returned page. A client-side
    // filter on a paginated list searches only the rows already fetched, so
    // "no results" would mean "not on this page" — the kind of wrong answer a
    // user cannot tell apart from a right one.
    const term = search?.trim();
    if (term) {
      where.OR = [
        { referenceNo: { contains: term, mode: 'insensitive' } },
        { employee: { fullName: { contains: term, mode: 'insensitive' } } },
        { employee: { employeeCode: { contains: term, mode: 'insensitive' } } },
      ];
    }

    const paginated = page !== undefined || limit !== undefined;

    if (!paginated) {
      const rows = await this.prisma.advanceLoanRequest.findMany({
        where,
        include: this.listInclude,
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((r) => this.serialize(r));
    }

    const take = Math.min(Math.max(1, limit ?? 25), 200);
    const currentPage = Math.max(1, page ?? 1);

    /**
     * The same filter, narrowed to statuses where a balance can exist.
     *
     * Intersection, not replacement: filtering the list to REJECTED must report
     * zero outstanding, because none of those rows is debt — not the balance of
     * the entire book.
     */
    const requested: string[] | null =
      where.status === undefined
        ? null
        : typeof where.status === 'string'
          ? [where.status]
          : (where.status.in ?? null);

    const debtStatuses = requested
      ? requested.filter((s) => (LOAN_DEBT_STATUSES as string[]).includes(s))
      : [...LOAN_DEBT_STATUSES];

    const debtWhere = { ...where, status: { in: debtStatuses } };

    const [rows, total, agg, debtAgg] = await Promise.all([
      this.prisma.advanceLoanRequest.findMany({
        where,
        include: this.listInclude,
        orderBy: { createdAt: 'desc' },
        skip: (currentPage - 1) * take,
        take,
      }),
      this.prisma.advanceLoanRequest.count({ where }),
      this.prisma.advanceLoanRequest.aggregate({
        where,
        _sum: { amount: true },
      }),
      // Outstanding is aggregated over a NARROWER set than principal.
      //
      // `amount - amountRepaid` across every matched row counts a REJECTED or
      // PENDING request's full principal as money owed, when no money ever
      // moved — a filter on "Rejected / written off" reported the whole
      // rejected amount as outstanding debt. It also ignored write-offs and
      // waivers, which reduce the balance without being repayments.
      //
      // The status condition must be INTERSECTED with the caller's filter, not
      // substituted for it: overwriting `status` makes every filtered view
      // report the whole book's balance.
      this.prisma.advanceLoanRequest.aggregate({
        where: debtWhere,
        _sum: {
          amount: true,
          amountRepaid: true,
          writtenOffAmount: true,
          waivedAmount: true,
        },
      }),
    ]);

    const totalPrincipal = Number(agg._sum.amount ?? 0);
    const d = debtAgg._sum;
    const totalOutstanding =
      Number(d.amount ?? 0) -
      Number(d.amountRepaid ?? 0) -
      Number(d.writtenOffAmount ?? 0) -
      Number(d.waivedAmount ?? 0);

    return {
      success: true,
      data: rows.map((r) => this.serialize(r)),
      meta: {
        total,
        page: currentPage,
        limit: take,
        totalPages: Math.ceil(total / take),
      },
      summary: {
        count: total,
        totalPrincipal,
        totalOutstanding: Math.max(0, roundMoney(totalOutstanding)),
      },
    };
  }

  /**
   * Pending queue for the current approver. Enforces the configured approver
   * roles (Settings checkboxes) and department scope for MANAGER.
   */
  async findPending(user: any) {
    const roles = await this.getApproverRoles();
    if (!roles.includes(user.role)) {
      throw new ForbiddenException(
        'Your role is not configured to approve advance/loan requests',
      );
    }

    const where: any = { status: 'PENDING' };

    // The queue must agree with the rule. An approver may not decide their own
    // request (see assertNotSelfDecision), so it must not be offered to them
    // here either — it used to appear in their own queue with a live Approve
    // button that the row-detail modal then refused.
    if (user?.employeeId) {
      where.employeeId = { not: user.employeeId };
    }

    if (user.role === 'MANAGER') {
      const deptIds = managerDeptScope(user);
      if (deptIds.length === 0) return [];
      where.employee = { departmentId: { in: deptIds } };
    }

    const rows = await this.prisma.advanceLoanRequest.findMany({
      where,
      include: this.employeeInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.serialize(r));
  }

  async findByEmployee(employeeId: string) {
    return this.findAll(undefined, employeeId);
  }

  async findOne(id: string, user?: any) {
    const request = await this.prisma.advanceLoanRequest.findUnique({
      where: { id },
      include: this.employeeInclude,
    });

    if (!request) {
      throw new NotFoundException('Advance/loan request not found');
    }

    // Object-level branch guard: findUnique bypasses the auto-scoping middleware,
    // so a foreign-branch id would otherwise be readable/actionable by id.
    assertInBranch(request.employee.branchId);

    // Single source of truth for the view predicate. It used to be written
    // inline here and simply NOT repeated on the attachments route, which is
    // exactly how that hole opened.
    if (user) {
      await this.access.assertCanViewLoan(request, user);
    }

    return this.serialize(request);
  }

  /**
   * Route a decision through the configurable approval engine, falling back to
   * the legacy single-approver path when the engine is not engaged.
   *
   * ONE deliberate deviation from travel.service.ts: it treats `!engaged` as
   * "approve now". Copying that here would auto-approve every loan the moment
   * the kill-switch is off — i.e. by default. Loans keep the legacy human
   * approver on `!engaged`, and only auto-apply when the engine ran a chain
   * that resolved to nobody (`engaged && finalized`).
   */
  async decide(
    id: string,
    user: any,
    decision: 'APPROVE' | 'REJECT',
    dto?: ApproveAdvanceLoanDto & RejectAdvanceLoanDto,
  ) {
    const request = await this.findOne(id);
    if (request.status !== 'PENDING') {
      throw new BadRequestException(
        `Cannot decide a request that is already ${String(request.status).toLowerCase()}`,
      );
    }

    // Before the engine, so the rule binds every path out of this method — the
    // engine's own step could otherwise record a self-decision as satisfied.
    this.assertNotSelfDecision(user, request);

    const result = await this.engine.decide(
      'ADVANCE_LOAN' as any,
      id,
      request.employeeId,
      user,
      decision,
      dto?.remarks,
    );

    if (!result.engaged) {
      await this.assertApprover(user, request);
    }

    if (decision === 'REJECT' && (!result.engaged || result.finalized)) {
      return this.applyRejected(id, user, dto as RejectAdvanceLoanDto);
    }
    if (decision === 'APPROVE' && (!result.engaged || result.finalized)) {
      return this.applyApproved(id, user, dto as ApproveAdvanceLoanDto);
    }

    return {
      success: true,
      message: 'Decision recorded. Awaiting the next approval step.',
      data: { id, status: 'PENDING' },
    };
  }

  async approve(id: string, user: any, dto?: ApproveAdvanceLoanDto) {
    return this.decide(id, user, 'APPROVE', dto as any);
  }

  /** Everything that happens once a request is FINALLY approved. */
  private async applyApproved(
    id: string,
    user: any,
    dto?: ApproveAdvanceLoanDto,
  ) {
    const request = await this.findOne(id);

    // The employee's own state is re-checked HERE, not only at create: the
    // request may have waited in the queue long enough for them to leave.
    const monthlyNet = await this.getMonthlyNetProxy(request.employeeId);
    await this.assertStillEligibleAtApproval(request, monthlyNet);

    const amount = Number(request.amount);
    let installments = 1;
    let installmentAmount = amount;

    // The product this request was filed under, if any. Read for its
    // instalment ceiling only: the TERMS were fixed at filing (`resolveTerms`),
    // because a term that can still move between being shown and being agreed
    // is not a term.
    const product = request.loanTypeId
      ? await this.prisma.loanType.findFirst({ where: { id: request.loanTypeId } })
      : null;

    if (request.type === 'LOAN') {
      installments = dto?.installments ?? request.installments ?? 1;
      const settingMax =
        parseInt(
          await this.settingsService.getSetting(
            'advance_loan_max_installments',
            '12',
          ),
          10,
        ) || 12;
      // Stricter wins. A product cannot lift the company ceiling, and the
      // company ceiling cannot lengthen a product that runs shorter.
      const maxInstallments = product
        ? Math.min(settingMax, product.maxInstallments)
        : settingMax;
      if (
        !Number.isInteger(installments) ||
        installments < 1 ||
        installments > maxInstallments
      ) {
        throw new BadRequestException(
          `Installments must be a whole number between 1 and ${maxInstallments}`,
        );
      }
      installmentAmount = Math.round(amount / installments);
    } else {
      // Advance affordability gate — block anything above the configured share
      // of the employee's monthly pay; large amounts must go through a loan.
      const proxy = monthlyNet;
      const pct =
        parseFloat(
          await this.settingsService.getSetting(
            'advance_max_percent_of_salary',
            '100',
          ),
        ) || 100;
      const cap = proxy * (pct / 100);
      if (proxy > 0 && amount > cap) {
        throw new BadRequestException(
          `Advance amount (${Math.round(amount)}) exceeds ${pct}% of the employee's monthly pay (max ${Math.round(cap)}). Please raise a loan instead.`,
        );
      }
    }

    // Race guard: two approvers clicking simultaneously — only the first
    // PENDING→APPROVED transition wins.
    const result = await this.prisma.advanceLoanRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        installments,
        installmentAmount,
        approverId: user.id,
        approvedAt: new Date(),
        approverRemarks: dto?.remarks ?? null,
        // Only when stated: an omitted priority must leave whatever the
        // product (or the default of 100) already put on the request.
        ...(dto?.priority != null ? { priority: dto.priority } : {}),
      },
    });
    if (result.count === 0) {
      // 409, not 400. Every other concurrency guard in this module —
      // casVersion, the idempotency-key guard, assertNoRunInFlight — answers
      // Conflict, and a client that retries on 409 was instead telling the late
      // approver they had typed something invalid.
      throw new ConflictException(
        'This request has already been processed by another approver',
      );
    }

    // Build the amortization plan. Best-effort on purpose: a schedule failure
    // must not strand an already-approved request in a half-decided state, and
    // the recovery planner falls back to the legacy installmentAmount bridge
    // for any loan that has no schedule rows.
    try {
      await this.schedules.generate(id);
      await this.prisma.loanTransaction.create({
        data: {
          requestId: id,
          type: 'DISBURSEMENT',
          transactionDate: new Date(),
          amount,
          principalComponent: amount,
          narration: 'Approved',
          createdById: user?.id ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `Schedule generation failed for loan ${id}; the legacy instalment bridge will be used: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Keep the legacy bridge column honest.
    //
    // `installmentAmount` was computed above as `round(amount / n)` — integer
    // division that ignores interest, fees and grace entirely. It is still what
    // the pre-v2 recovery path reads and what the approval email quotes, so an
    // interest-bearing loan told the borrower an instalment its own schedule
    // never charges.
    //
    // Deliberately in its OWN try/catch, after the ledger write rather than
    // between it and `generate()`: a failure here must not cost the loan its
    // DISBURSEMENT row. Ordered by version DESC rather than computed as `+1`
    // because `generate()` owns the version bump.
    try {
      const firstRow = await this.prisma.loanSchedule.findFirst({
        where: { requestId: id },
        orderBy: [{ version: 'desc' }, { installmentNo: 'asc' }],
        select: { emiAmount: true },
      });
      if (firstRow && Number(firstRow.emiAmount) !== installmentAmount) {
        installmentAmount = Number(firstRow.emiAmount);
        await this.prisma.advanceLoanRequest.update({
          where: { id },
          data: { installmentAmount },
        });
      }
    } catch (err) {
      this.logger.warn(
        `Could not sync the instalment bridge for loan ${id} from its schedule: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const approver = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { employee: { select: { fullName: true } } },
    });
    const approverName = approver?.employee?.fullName || 'Approver';
    const label = request.type === 'LOAN' ? 'Loan' : 'Salary advance';

    // Fire-and-forget: a slow or unavailable SMTP must never block (or fail) the
    // decision. Awaiting here previously stalled the response until the SMTP
    // connection timed out.
    void this.mailService
      .sendAdvanceLoanApproved(request.employee.email, {
        employeeName: request.employee.fullName,
        type: request.type,
        amount: amount.toFixed(2),
        installments,
        installmentAmount: Number(installmentAmount).toFixed(2),
        approverName,
        remarks: dto?.remarks,
      })
      .catch(() => {});

    const repayNote =
      request.type === 'LOAN'
        ? `It will be recovered over ${installments} payroll cycle(s) of ~${Number(installmentAmount)} each.`
        : 'It will be deducted from your upcoming payroll.';
    await this.notifyRequester(
      request.employeeId,
      id,
      `${label} approved`,
      `Your ${label.toLowerCase()} of ${amount} was approved. ${repayNote}`,
      { requestType: label, amount, status: 'APPROVED' },
      // Distinct events, so an approval and a rejection are two rows rather
      // than one that dedupes the other away.
      'LOAN_APPROVED',
    );

    return this.findOne(id);
  }

  /**
   * Edit a request.
   *
   * There was no edit route at all, so a mistyped amount meant cancel and
   * re-file — losing the queue position, the attachments and the audit thread.
   *
   * What may be changed narrows as the loan hardens:
   *
   *  - **DRAFT / PENDING** — anything on the DTO. Nobody has agreed to it yet.
   *  - **APPROVED / DISBURSED / ACTIVE** — only `reason` and `priority`, and
   *    only with a stated reason. Everything else is a term somebody accepted;
   *    changing those is a RESTRUCTURE, which goes through the lifecycle
   *    operations and their approval gate rather than through a quiet PATCH.
   *  - **Terminal** — nothing. The loan is over.
   *
   * `expectedUpdatedAt` is an optional compare-and-set: two people editing the
   * same pending request otherwise silently overwrite each other, and the loser
   * never learns their change was lost.
   */
  async update(
    id: string,
    user: any,
    dto: UpdateAdvanceLoanDto & { expectedUpdatedAt?: string },
  ) {
    const request = await this.findOne(id, user);

    const isPrivileged = ['ADMIN', 'HR_MANAGER'].includes(user?.role);
    const isOwner = request.employeeId === user?.employeeId;
    if (!isPrivileged && !isOwner) {
      throw new ForbiddenException('You can only edit your own request');
    }

    if (LOAN_TERMINAL_STATUSES.includes(request.status as any)) {
      throw new BadRequestException(
        `This request is ${request.status.toLowerCase()} and can no longer be edited.`,
      );
    }

    const editable = ['DRAFT', 'PENDING'].includes(request.status);

    // The fields a live loan will accept. `reason` is documentation and
    // `priority` is a recovery decision, not a term of the agreement.
    const LIVE_FIELDS = ['reason', 'priority', 'reason_for_change'];
    const asked = Object.keys(dto).filter(
      (k) => (dto as Record<string, unknown>)[k] !== undefined,
    );

    if (!editable) {
      const refused = asked.filter((k) => !LIVE_FIELDS.includes(k));
      if (refused.length > 0) {
        throw new BadRequestException(
          `This loan has already been approved, so ${refused.join(', ')} can no longer be changed here. ` +
            `Use a restructure — prepay, skip or reschedule — so the change is planned and audited.`,
        );
      }
      if (!dto.reason_for_change) {
        throw new BadRequestException(
          'Changing a live loan needs a reason, because it alters an agreement that has already been accepted.',
        );
      }
    }

    if (dto.priority !== undefined && !isPrivileged) {
      throw new ForbiddenException(
        'Recovery priority decides which debt yields to which, so only HR or an administrator may set it.',
      );
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: request.employeeId },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    if (asked.length === 0) {
      // Judged on what the CALLER asked for, not on what the write would
      // contain: re-resolving the terms below always produces fields, so an
      // empty PATCH would otherwise look like a change and answer 200.
      throw new BadRequestException('Nothing to change.');
    }

    const data: Record<string, unknown> = {};

    if (editable) {
      const product =
        dto.loanTypeId === undefined
          ? request.loanTypeId
            ? await this.prisma.loanType.findFirst({ where: { id: request.loanTypeId } })
            : null
          : dto.loanTypeId
            ? await this.prisma.loanType.findFirst({ where: { id: dto.loanTypeId } })
            : null;
      if (dto.loanTypeId && !product) {
        throw new NotFoundException('Loan product not found');
      }

      const amount = dto.amount ?? Number(request.amount);
      const installments =
        request.type === 'LOAN'
          ? (dto.installments ?? request.installments ?? 1)
          : 1;

      if (dto.effectiveDate !== undefined) {
        data.effectiveDate = await this.resolveEffectiveDate(
          { effectiveDate: dto.effectiveDate } as CreateAdvanceLoanDto,
          employee,
        );
      }
      if (dto.loanTypeId !== undefined) data.loanTypeId = dto.loanTypeId || null;
      if (dto.amount !== undefined) data.amount = dto.amount;
      if (request.type === 'LOAN' && dto.installments !== undefined) {
        data.installments = dto.installments;
      }

      // The edited request has to pass the SAME gate it passed to be created.
      // Without this, editing is a way to reach an amount the create path
      // refuses — which is precisely the hole the importer already had.
      const terms = await this.resolveTerms(
        {
          ...(dto as any),
          type: request.type as any,
          amount,
        } as CreateAdvanceLoanDto,
        product,
        amount,
      );
      // The product's own priority is part of its terms, so it lands here —
      // but an explicit `priority` on the DTO is a deliberate override and is
      // applied afterwards, or the resolver would silently undo it.
      Object.assign(data, terms);

      const check = await this.eligibility.evaluate({
        employeeId: request.employeeId,
        amount,
        installments,
        type: request.type,
        loanTypeId: (data.loanTypeId as string) ?? request.loanTypeId ?? null,
        monthlyNet: await this.getMonthlyNetProxy(request.employeeId),
      });
      const failure = this.eligibility.firstFailure(check);
      if (failure) {
        throw new BadRequestException(
          failure.detail ??
            `${failure.label} (limit ${failure.limit ?? 'n/a'}, actual ${failure.actual ?? 'n/a'})`,
        );
      }
    }

    // Applied last, so neither is overwritten by the resolved terms above.
    if (dto.reason !== undefined) data.reason = dto.reason || null;
    if (dto.priority !== undefined) data.priority = dto.priority;

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Nothing to change.');
    }

    // Compare-and-set. Two editors on one pending request otherwise overwrite
    // each other in silence, and the loser never learns their change was lost.
    const where: Record<string, unknown> = { id };
    if (dto.expectedUpdatedAt) {
      where.updatedAt = new Date(dto.expectedUpdatedAt);
    }
    const result = await this.prisma.advanceLoanRequest.updateMany({
      where: where as any,
      data,
    });
    if (result.count === 0) {
      throw new ConflictException(
        'This request was changed by somebody else while you were editing it. Reload and try again.',
      );
    }

    return this.findOne(id, user);
  }

  /**
   * Record that the money actually left the company.
   *
   * `DRAFT` and `DISBURSED` were in `LOAN_STATUSES` and in the database CHECK
   * constraint, and no code ever wrote either: approval posted the
   * `DISBURSEMENT` ledger row and left the loan `APPROVED`, so "approved but
   * not yet paid out" was a state the product could not express — the very
   * state a finance team spends its week in.
   *
   * Deliberately a SEPARATE step rather than a rewrite of approval: approval
   * still plans the loan and writes its ledger row, so every existing flow and
   * every pre-v2 row keeps working. Disbursing adds the date the money moved,
   * what was actually paid out, and — when that date differs from the agreed
   * start — a schedule rebuilt from reality.
   */
  async disburse(id: string, user: any, dto: DisburseLoanDto = {}) {
    const request = await this.findOne(id, user);

    if (request.status !== 'APPROVED') {
      throw new BadRequestException(
        request.status === 'DISBURSED'
          ? 'This loan has already been disbursed.'
          : `Only an approved loan can be disbursed; this one is ${request.status.toLowerCase()}.`,
      );
    }

    // Normalised to UTC midnight, both sides. `new Date()` carries a time of
    // day, so comparing it against midnight-today made every same-day
    // disbursement look like a future one — the default path refused itself.
    const now = new Date();
    const todayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const when = dto.disbursementDate
      ? new Date(`${dto.disbursementDate}T00:00:00.000Z`)
      : todayUtc;
    if (Number.isNaN(when.getTime())) {
      throw new BadRequestException('disbursementDate is not a real calendar date.');
    }
    if (when.getTime() > todayUtc.getTime()) {
      // A future payout has not happened yet, and recording it as though it had
      // starts interest accruing on money the employee does not have.
      throw new BadRequestException('A disbursement cannot be dated in the future.');
    }

    const principal = Number(request.amount);
    const fee = Number(request.processingFee ?? 0);
    // A fee taken at source reduces what is HANDED OVER, never what is owed.
    const defaultPaid =
      request.processingFeeMode === 'DEDUCT_FROM_DISBURSEMENT'
        ? roundMoney(principal - fee)
        : principal;
    const disbursedAmount = dto.disbursedAmount ?? defaultPaid;
    if (disbursedAmount > principal) {
      throw new BadRequestException(
        `The disbursed amount cannot exceed the ${principal} principal of this loan.`,
      );
    }

    const result = await this.prisma.advanceLoanRequest.updateMany({
      where: { id, status: 'APPROVED' },
      data: {
        status: 'DISBURSED',
        disbursementDate: when,
        disbursedAmount,
      },
    });
    if (result.count === 0) {
      throw new ConflictException(
        'This loan was disbursed by somebody else while you were working on it.',
      );
    }

    // Re-plan from the date the money actually moved, when that is not the date
    // it was agreed for. Best-effort, like approval's own generation: a
    // schedule failure must not strand a loan that has genuinely been paid out.
    const agreed = request.effectiveDate
      ? new Date(request.effectiveDate).toISOString().slice(0, 10)
      : null;
    if (agreed !== when.toISOString().slice(0, 10)) {
      try {
        await this.schedules.generate(id);
      } catch (err) {
        this.logger.error(
          `Loan ${id} disbursed but the schedule could not be rebuilt from ${when.toISOString().slice(0, 10)}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    await this.prisma.loanTransaction
      .create({
        data: {
          requestId: id,
          type: 'ADJUSTMENT',
          transactionDate: when,
          amount: disbursedAmount,
          principalComponent: 0,
          narration: `Disbursed ${disbursedAmount}${dto.reference ? ` (${dto.reference})` : ''}`,
          reference: dto.reference ?? null,
          createdById: user?.id ?? null,
        },
      })
      .catch(() => undefined);

    await this.notifyRequester(
      request.employeeId,
      id,
      `${request.type === 'LOAN' ? 'Loan' : 'Salary advance'} paid out`,
      `${disbursedAmount} has been paid out${dto.reference ? ` (reference ${dto.reference})` : ''}.`,
      { status: 'DISBURSED', amount: disbursedAmount },
      'LOAN_DISBURSED',
    );

    return this.findOne(id, user);
  }

  /**
   * Move a DRAFT to PENDING.
   *
   * `DRAFT` was rendered by the list screen and filterable in its toolbar, and
   * nothing could create one — so the status existed as a promise the product
   * did not keep. A draft is re-checked against eligibility at SUBMIT rather
   * than only at save: it may have sat for weeks, and the rules it passed when
   * it was drafted are not the rules it is judged by now.
   */
  async submit(id: string, user: any) {
    const request = await this.findOne(id, user);

    if (request.status !== 'DRAFT') {
      throw new BadRequestException(
        `Only a draft can be submitted; this request is ${request.status.toLowerCase()}.`,
      );
    }
    if (request.employeeId !== user?.employeeId &&
        !['ADMIN', 'HR_MANAGER'].includes(user?.role)) {
      throw new ForbiddenException('You can only submit your own draft');
    }

    const check = await this.eligibility.evaluate({
      employeeId: request.employeeId,
      amount: Number(request.amount),
      installments: request.installments ?? 1,
      type: request.type,
      loanTypeId: request.loanTypeId,
      monthlyNet: await this.getMonthlyNetProxy(request.employeeId),
    });
    const failure = this.eligibility.firstFailure(check);
    if (failure) {
      throw new BadRequestException(
        failure.detail ??
          `${failure.label} (limit ${failure.limit ?? 'n/a'}, actual ${failure.actual ?? 'n/a'})`,
      );
    }

    const result = await this.prisma.advanceLoanRequest.updateMany({
      where: { id, status: 'DRAFT' },
      data: { status: 'PENDING' },
    });
    if (result.count === 0) {
      throw new ConflictException('This draft was already submitted.');
    }

    const full = await this.prisma.advanceLoanRequest.findUnique({
      where: { id },
      include: this.employeeInclude,
    });
    const init = await this.engine
      .initiate('ADVANCE_LOAN' as any, id, request.employeeId, undefined)
      .catch(() => ({ engaged: false }) as any);
    if (!init.engaged) await this.notifyApprovers(full);

    return this.findOne(id, user);
  }

  async reject(id: string, user: any, dto: RejectAdvanceLoanDto) {
    return this.decide(id, user, 'REJECT', dto as any);
  }

  /** Everything that happens once a request is FINALLY rejected. */
  private async applyRejected(id: string, user: any, dto: RejectAdvanceLoanDto) {
    const request = await this.findOne(id);

    const result = await this.prisma.advanceLoanRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        approverId: user.id,
        approvedAt: new Date(),
        rejectedReason: dto.remarks,
      },
    });
    if (result.count === 0) {
      // 409, not 400. Every other concurrency guard in this module —
      // casVersion, the idempotency-key guard, assertNoRunInFlight — answers
      // Conflict, and a client that retries on 409 was instead telling the late
      // approver they had typed something invalid.
      throw new ConflictException(
        'This request has already been processed by another approver',
      );
    }

    const approver = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { employee: { select: { fullName: true } } },
    });
    const approverName = approver?.employee?.fullName || 'Approver';
    const label = request.type === 'LOAN' ? 'Loan' : 'Salary advance';

    // Fire-and-forget (see approve): never block the decision on SMTP.
    void this.mailService
      .sendAdvanceLoanRejected(request.employee.email, {
        employeeName: request.employee.fullName,
        type: request.type,
        amount: Number(request.amount).toFixed(2),
        approverName,
        reason: dto.remarks,
      })
      .catch(() => {});

    await this.notifyRequester(
      request.employeeId,
      id,
      `${label} rejected`,
      `Your ${label.toLowerCase()} of ${Number(request.amount)} was rejected: ${dto.remarks}`,
      { requestType: label, amount: Number(request.amount), status: 'REJECTED' },
      'LOAN_REJECTED',
    );

    return this.findOne(id);
  }

  async cancel(id: string, employeeId: string) {
    const request = await this.findOne(id);

    if (request.employeeId !== employeeId) {
      throw new ForbiddenException(
        'You do not have permission to cancel this request',
      );
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException('Only pending requests can be cancelled');
    }

    /**
     * Compare-and-set, exactly as approve/reject do.
     *
     * The status read above is only a fast, well-worded refusal; this is the
     * write that actually decides. A bare `update({ where: { id } })` let a
     * cancel that read PENDING before a concurrent approval committed overwrite
     * an APPROVED loan — one that already had a generated schedule and a
     * DISBURSEMENT ledger row — with CANCELLED, a terminal status the recovery
     * planner never selects. Money disbursed, never collected.
     */
    const result = await this.prisma.advanceLoanRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    if (result.count === 0) {
      throw new ConflictException(
        'This request has already been processed by another approver',
      );
    }

    // Only once the cancel has actually won. Abandoning the chain for a request
    // that stayed PENDING would strip it from every approver's queue while
    // leaving it undecided.
    await this.engine.abandon('ADVANCE_LOAN' as any, id).catch(() => {});

    return this.prisma.advanceLoanRequest.findUnique({ where: { id } });
  }
}
