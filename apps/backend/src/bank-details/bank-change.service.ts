import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { getBranchContext, runWithBranchBypass } from '../common/branch/branch-context';
import { PayrollStatus } from '@prisma/client';
import {
  CreateBankChangeRequestDto,
  MigrateBankDetailDto,
} from './dto/bank-change.dto';
import { BankingConfigService } from './banking-config.service';
import {
  BankingFieldDef,
  branchAllowedCountries,
  maskBankingData,
  normalizeCountry,
  validateBankingData,
} from './banking-fields.util';
import { maskAccount } from './iban.util';

/**
 * Employee bank details as a change-request workflow. A submission never mutates
 * the employee record — it creates a BankChangeRequest routed through the shared
 * ApprovalEngine. Only on final approval does the app write a new active,
 * versioned EmployeeBankDetail (the single source of truth payroll + WPS read).
 */
@Injectable()
export class BankChangeService {
  // Payroll runs that are not yet terminal (LOCKED) or discarded (REJECTED) lock
  // bank edits, so an in-flight run always pays the details it was built with.
  private static readonly PAYROLL_IN_PROGRESS: PayrollStatus[] = [
    PayrollStatus.DRAFT,
    PayrollStatus.PENDING_APPROVAL,
    PayrollStatus.APPROVED,
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly engine: ApprovalEngineService,
    private readonly config: BankingConfigService,
  ) {}

  /**
   * Validate a submitted data map against a bank's country config. Returns the
   * fields + normalized values, or throws 400 with per-field errors.
   */
  private async validateAgainstConfig(
    country: string,
    data: Record<string, string>,
    expectedBankCode?: string | null,
  ): Promise<{ fields: BankingFieldDef[]; normalized: Record<string, string> }> {
    const fields = await this.config.getFieldsForCountry(country);
    if (fields.length === 0) {
      throw new BadRequestException(
        `No banking field configuration exists for country ${country}. Configure it first.`,
      );
    }
    const res = validateBankingData(
      country,
      data ?? {},
      fields,
      expectedBankCode,
    );
    if (!res.valid) {
      throw new BadRequestException({
        message: 'Bank details validation failed',
        errors: res.errors,
      });
    }
    return { fields, normalized: res.normalized };
  }

  /** Convenience scalar columns kept in sync from the dynamic data (back-compat). */
  private legacyColumns(data: Record<string, string>) {
    return {
      iban: data.iban ?? null,
      accountNumber: data.accountNumber ?? null,
      accountHolderName: data.accountHolderName ?? null,
    };
  }

  // ── Read API for payroll / WPS ────────────────────────────────────────────

  /** The single active bank detail for an employee (source of truth), bank joined. */
  async getActiveBankDetail(employeeId: string) {
    return this.prisma.employeeBankDetail.findFirst({
      where: { employeeId, isActive: true },
      include: { bank: true },
    });
  }

  /** Admin/HR view of another employee's current detail — branch-scoped. */
  async adminCurrentForEmployee(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, branchId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertInBranch(employee.branchId);
    return this.currentForEmployee(employeeId);
  }

  /**
   * ESS view. Returns:
   *  - `country`  : the employee's BRANCH country (ISO-2) — drives the form,
   *  - `fields`   : the field schema for that branch country (form rendering),
   *  - `detail`   : the current approved detail, displayed against its OWN bank's
   *                 country fields (which may differ if the branch country changed),
   *  - `pendingRequestId`.
   */
  async currentForEmployee(employeeId: string) {
    if (!employeeId) {
      throw new ForbiddenException('No employee is linked to this account');
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { branch: { select: { country: true, bankingCountries: true } } },
    });
    const allowedCountries = branchAllowedCountries(employee?.branch);

    const [detail, pending] = await Promise.all([
      this.getActiveBankDetail(employeeId),
      this.prisma.bankChangeRequest.findFirst({
        where: { employeeId, status: 'PENDING' },
        select: { id: true },
      }),
    ]);

    let detailOut: any = null;
    if (detail) {
      const dc = detail.bank?.country;
      const detailFields = dc ? await this.config.getFieldsForCountry(dc) : [];
      detailOut = {
        bankId: detail.bankId,
        bankName: detail.bank?.name,
        country: dc,
        values: maskBankingData((detail.data as Record<string, unknown>) ?? {}, detailFields),
        fields: detailFields,
        effectiveFrom: detail.effectiveFrom,
      };
    }

    return {
      success: true,
      data: {
        detail: detailOut,
        // Allowed banking countries for this employee's branch (may be several).
        countries: allowedCountries,
        pendingRequestId: pending?.id ?? null,
      },
    };
  }

  // ── Lock guard ────────────────────────────────────────────────────────────

  /**
   * True while a wage file involving this employee is in flight.
   *
   * The dangerous window is not the milliseconds of generation — it runs from
   * GENERATING until the bank has answered. A detail changed after a file is
   * generated but before it settles means the bank pays the OLD account while our
   * record shows the new one, and nobody can say which is authoritative.
   *
   * Two conditions, because they catch different moments:
   *   • a row for this employee in a GENERATING / GENERATED / SUBMITTED file, and
   *   • any GENERATING file for the branch — rows do not exist yet at that instant,
   *     so without this a change could slip in mid-build.
   *
   * REJECTED rows are deliberately exempt: an employee whose row the bank bounced
   * must be able to fix their details to get into the corrected version. That is
   * the entire point of recording per-row rejections.
   *
   * Runs with the branch filter bypassed: WpsFile and WpsFileRow are branch-scoped,
   * and this guard must see the truth regardless of the calling employee's own
   * (self-service) scope.
   */
  async isWpsGenerating(
    branchId?: string | null,
    employeeId?: string,
  ): Promise<boolean> {
    return runWithBranchBypass(async () => {
      const inFlight = { status: { in: ['GENERATING', 'GENERATED', 'SUBMITTED'] } };

      if (employeeId) {
        const row = await this.prisma.wpsFileRow.findFirst({
          where: {
            employeeId,
            status: { not: 'REJECTED' },
            wpsFile: inFlight,
          },
          select: { id: true },
        });
        if (row) return true;
      }

      const generating = await this.prisma.wpsFile.count({
        where: { status: 'GENERATING', ...(branchId ? { branchId } : {}) },
      });
      return generating > 0;
    });
  }

  /**
   * Throw 409 if a payroll run is in progress or a WPS file is being generated.
   *
   * `exemptFirstTime` skips ONLY the payroll-in-progress half, and only when the
   * employee has no active bank detail at all. That lock exists to stop a
   * destination being CHANGED mid-run — an in-flight run must keep paying the
   * account it was built with. First-time population is not a change: there is no
   * prior destination to preserve, so nothing is protected by refusing it, and the
   * employee simply stays unpayable.
   *
   * Used by migrate() only. Leaving it off for the request path keeps the
   * long-standing behaviour there untouched.
   *
   * The WPS lock is always enforced: once a file has been generated, even adding a
   * first detail disagrees with what we already sent to the bank.
   */
  async assertBankEditable(
    employeeId: string,
    branchId?: string | null,
    opts: { exemptFirstTime?: boolean } = {},
  ) {
    let enforcePayrollLock = true;
    if (opts.exemptFirstTime) {
      const existing = await this.prisma.employeeBankDetail.findFirst({
        where: { employeeId, isActive: true },
        select: { id: true },
      });
      enforcePayrollLock = existing !== null;
    }

    if (enforcePayrollLock) {
      const inProgress = await this.prisma.payrollItem.findFirst({
        where: {
          employeeId,
          payroll: { status: { in: BankChangeService.PAYROLL_IN_PROGRESS } },
        },
        select: { id: true },
      });
      if (inProgress) {
        throw new ConflictException(
          'Bank details are locked while a payroll run is in progress',
        );
      }
    }

    if (await this.isWpsGenerating(branchId, employeeId)) {
      throw new ConflictException(
        'Bank details are locked while a WPS file is being generated',
      );
    }
  }

  // ── Submit a change request ───────────────────────────────────────────────

  async create(dto: CreateBankChangeRequestDto, user: any) {
    const employeeId = this.resolveTargetEmployee(dto.employeeId, user);

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        fullName: true,
        branchId: true,
        branch: { select: { country: true, bankingCountries: true } },
        user: { select: { id: true } },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertInBranch(employee.branchId);

    await this.assertBankEditable(employeeId, employee.branchId);

    const bank = await this.prisma.bank.findUnique({ where: { id: dto.bankId } });
    if (!bank) throw new NotFoundException('Selected bank not found');
    if (!bank.isActive) {
      throw new BadRequestException('Selected bank is inactive');
    }

    // The selected bank must be in the branch's allowed banking countries (when set).
    const allowed = branchAllowedCountries(employee.branch);
    if (allowed.length && !allowed.includes(bank.country.toUpperCase())) {
      throw new BadRequestException(
        `Selected bank is for ${bank.country}, which is not among this branch's allowed banking countries (${allowed.join(', ')})`,
      );
    }

    // Validate the submitted values against the country's configured field schema.
    // Passing bankCode cross-checks the identifier embedded in the IBAN against
    // the bank actually selected.
    const { fields, normalized } = await this.validateAgainstConfig(
      bank.country,
      dto.data,
      bank.bankCode,
    );

    // One pending request per employee (also enforced by a partial unique index).
    const pending = await this.prisma.bankChangeRequest.findFirst({
      where: { employeeId, status: 'PENDING' },
      select: { id: true },
    });
    if (pending) {
      throw new ConflictException(
        'A bank change request is already pending for this employee',
      );
    }

    const current = await this.getActiveBankDetail(employeeId);
    const request = await this.prisma.bankChangeRequest.create({
      data: {
        employeeId,
        bankId: bank.id,
        data: normalized,
        ...this.legacyColumns(normalized),
        status: 'PENDING',
        requestedById: user.id,
        branchId: employee.branchId,
      },
    });

    await this.audit.log({
      userId: user.id,
      action: 'BANK_CHANGE_REQUESTED',
      resourceType: 'BankChangeRequest',
      resourceId: request.id,
      branchId: employee.branchId,
      oldData: current
        ? { bankId: current.bankId, values: maskBankingData(current.data as any, fields) }
        : null,
      newData: { bankId: bank.id, values: maskBankingData(normalized, fields) },
    });

    // Route through the configurable engine. engaged=false (switch off / no
    // workflow) or an all-skipped chain both mean "apply now".
    const init = await this.engine.initiate(
      'BANK_CHANGE',
      request.id,
      employeeId,
      user.id,
    );
    if (!init.engaged || init.finalized) {
      await this.applyApproved(request.id);
      return {
        success: true,
        message: 'Bank details updated.',
        data: { id: request.id, status: 'APPROVED' },
      };
    }

    return {
      success: true,
      message: 'Bank change request submitted for approval.',
      data: { id: request.id, status: 'PENDING' },
    };
  }

  // ── Approve / reject ──────────────────────────────────────────────────────

  async decide(
    requestId: string,
    user: any,
    decision: 'APPROVE' | 'REJECT',
    comment?: string,
  ) {
    const request = await this.getRequestOrThrow(requestId);
    if (request.status !== 'PENDING') {
      throw new BadRequestException(
        `Cannot decide a ${request.status.toLowerCase()} request`,
      );
    }

    const result = await this.engine.decide(
      'BANK_CHANGE',
      requestId,
      request.employeeId,
      user,
      decision,
      comment,
    );

    // engaged=false means no workflow governs it — an ADMIN/HR fallback decision.
    if (!result.engaged) {
      if (user?.role !== 'ADMIN' && user?.role !== 'HR_MANAGER') {
        throw new ForbiddenException('Not permitted to decide this request');
      }
    }

    if (decision === 'REJECT' && (!result.engaged || result.finalized)) {
      return this.applyRejected(requestId, comment);
    }
    if (decision === 'APPROVE' && (!result.engaged || result.finalized)) {
      return this.applyApproved(requestId);
    }

    return {
      success: true,
      message: 'Decision recorded. Awaiting the next approval step.',
      data: { id: requestId, status: 'PENDING' },
    };
  }

  async cancel(requestId: string, user: any) {
    const request = await this.getRequestOrThrow(requestId);
    // Only the requester (or HR/Admin) may withdraw.
    const isOwner = request.employee?.user?.id === user.id;
    if (!isOwner && user?.role !== 'ADMIN' && user?.role !== 'HR_MANAGER') {
      throw new ForbiddenException('Not permitted to cancel this request');
    }
    if (request.status !== 'PENDING') {
      throw new BadRequestException('Only a pending request can be cancelled');
    }
    await this.engine.abandon('BANK_CHANGE', requestId);
    await this.prisma.bankChangeRequest.update({
      where: { id: requestId },
      data: { status: 'CANCELLED', decidedAt: new Date() },
    });
    await this.audit.log({
      userId: user.id,
      action: 'BANK_CHANGE_CANCELLED',
      resourceType: 'BankChangeRequest',
      resourceId: requestId,
      branchId: request.branchId,
    });
    return { success: true, message: 'Request cancelled.' };
  }

  // ── Apply (final side-effects) ────────────────────────────────────────────

  /** Materialize an approved request into a new active, versioned bank detail. */
  private async applyApproved(requestId: string) {
    const request = await this.getRequestOrThrow(requestId);

    // Re-check the guards at apply time — state may have moved during approval.
    await this.assertBankEditable(request.employeeId, request.branchId);
    const bank = await this.prisma.bank.findUnique({ where: { id: request.bankId } });
    if (!bank || !bank.isActive) {
      throw new BadRequestException(
        'Selected bank is no longer active — reject and resubmit',
      );
    }

    const previous = await this.getActiveBankDetail(request.employeeId);
    const data = (request.data as Record<string, string>) ?? {};
    const fields = await this.config.getFieldsForCountry(bank.country);

    await this.prisma.$transaction(async (tx) => {
      await tx.employeeBankDetail.updateMany({
        where: { employeeId: request.employeeId, isActive: true },
        data: { isActive: false },
      });
      await tx.employeeBankDetail.create({
        data: {
          employeeId: request.employeeId,
          bankId: request.bankId,
          data,
          ...this.legacyColumns(data),
          isActive: true,
          source: 'APPROVAL',
          sourceRequestId: request.id,
          branchId: request.branchId,
        },
      });
      await tx.bankChangeRequest.update({
        where: { id: request.id },
        data: { status: 'APPROVED', decidedAt: new Date() },
      });
    });

    await this.audit.log({
      action: 'BANK_DETAIL_UPDATED',
      resourceType: 'EmployeeBankDetail',
      resourceId: request.employeeId,
      branchId: request.branchId,
      oldData: previous
        ? { bankId: previous.bankId, values: maskBankingData(previous.data as any, fields) }
        : null,
      newData: { bankId: request.bankId, values: maskBankingData(data, fields) },
    });

    const uid = request.employee?.user?.id;
    if (uid) {
      await this.notifications
        .notifyUser(
          uid,
          'Bank details approved',
          'Your bank change request was approved and your payment details are updated.',
          'BANK_CHANGE_APPROVED',
          '/dashboard/profile',
        )
        .catch(() => undefined);
    }

    return {
      success: true,
      message: 'Bank details updated.',
      data: { id: request.id, status: 'APPROVED' },
    };
  }

  private async applyRejected(requestId: string, comment?: string) {
    const request = await this.getRequestOrThrow(requestId);
    await this.prisma.bankChangeRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', decidedAt: new Date() },
    });
    const uid = request.employee?.user?.id;
    if (uid) {
      await this.notifications
        .notifyUser(
          uid,
          'Bank details rejected',
          `Your bank change request was rejected${comment ? `: ${comment}` : '.'}`,
          'BANK_CHANGE_REJECTED',
          '/dashboard/profile',
        )
        .catch(() => undefined);
    }
    return { success: true, message: 'Request rejected.' };
  }

  // ── HR migration (legacy free-text → verified Bank Master) ─────────────────

  /**
   * HR manually verifies a legacy free-text record and writes a verified active
   * bank detail directly (bypassing the approval chain). No auto-guessing — HR
   * picks the Bank + types the IBAN.
   */
  async migrate(dto: MigrateBankDetailDto, user: any) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
      select: {
        id: true,
        branchId: true,
        branch: { select: { country: true, bankingCountries: true } },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertInBranch(employee.branchId);

    const bank = await this.prisma.bank.findUnique({ where: { id: dto.bankId } });
    if (!bank || !bank.isActive) {
      throw new BadRequestException('Selected bank not found or inactive');
    }
    const migAllowed = branchAllowedCountries(employee.branch);
    if (migAllowed.length && !migAllowed.includes(bank.country.toUpperCase())) {
      throw new BadRequestException(
        `Selected bank is for ${bank.country}, not among the branch's allowed countries (${migAllowed.join(', ')})`,
      );
    }
    const { fields, normalized } = await this.validateAgainstConfig(
      bank.country,
      dto.data,
      bank.bankCode,
    );

    // Same lock the approval path enforces — this was the one write path that
    // skipped it entirely, so an HR user could swap a destination account through
    // the migration screen while a payroll run was in flight.
    //
    // exemptFirstTime, though: every employee this screen lists has NO active bank
    // detail (that is what makes them a migration candidate), so enforcing the
    // payroll lock unconditionally deadlocked the screen — one open company-wide
    // run blocked onboarding for the entire company, protecting nothing. The lock
    // still applies when migrate() is used to overwrite an existing detail.
    await this.assertBankEditable(dto.employeeId, employee.branchId, {
      exemptFirstTime: true,
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.employeeBankDetail.updateMany({
        where: { employeeId: dto.employeeId, isActive: true },
        data: { isActive: false },
      });
      await tx.employeeBankDetail.create({
        data: {
          employeeId: dto.employeeId,
          bankId: dto.bankId,
          data: normalized,
          ...this.legacyColumns(normalized),
          isActive: true,
          source: 'MIGRATION',
          branchId: employee.branchId,
        },
      });
    });

    await this.audit.log({
      userId: user.id,
      action: 'BANK_DETAIL_MIGRATED',
      resourceType: 'EmployeeBankDetail',
      resourceId: dto.employeeId,
      branchId: employee.branchId,
      newData: { bankId: dto.bankId, values: maskBankingData(normalized, fields) },
    });
    return { success: true, message: 'Bank detail migrated.' };
  }

  /** Employees with legacy free-text bank data and no active EmployeeBankDetail. */
  async migrationCandidates() {
    const rows = await this.prisma.employee.findMany({
      where: {
        status: 'ACTIVE',
        bankDetails: { none: { isActive: true } },
        profile: { bankName: { not: null } },
      },
      select: {
        id: true,
        fullName: true,
        employeeCode: true,
        branchId: true,
        branch: { select: { country: true, bankingCountries: true } },
        profile: {
          select: {
            bankName: true,
            bankBranch: true,
            bankAccountNumber: true,
            bankAccountHolderName: true,
          },
        },
      },
      orderBy: { fullName: 'asc' },
    });
    return {
      success: true,
      data: rows.map((r) => ({
        ...r,
        countries: branchAllowedCountries(r.branch),
      })),
    };
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async listRequests(status?: string, user?: any) {
    // Self-service callers only see their own; HR/Admin see all (branch-scoped).
    const scopeToSelf =
      user && user.role !== 'ADMIN' && user.role !== 'HR_MANAGER';

    // EXPLICIT select, never `include` alone. An `include` with no `select`
    // returns every scalar on the row — which meant this list handed back the
    // `data` JSONB plus the raw iban/accountNumber for every request. Account
    // values are masked here exactly as getRequest() already masks them, and the
    // `data` blob is not projected at all: nothing in the list view needs it, and
    // it is the one field that carries every country's sensitive keys verbatim.
    const rows = await this.prisma.bankChangeRequest.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(scopeToSelf ? { employeeId: user.employeeId } : {}),
      },
      select: {
        id: true,
        employeeId: true,
        status: true,
        bankId: true,
        iban: true,
        accountNumber: true,
        accountHolderName: true,
        createdAt: true,
        decidedAt: true,
        bank: { select: { name: true, country: true } },
        employee: { select: { fullName: true, employeeCode: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      success: true,
      data: rows.map((r) => ({
        ...r,
        iban: maskAccount(r.iban),
        accountNumber: maskAccount(r.accountNumber),
      })),
    };
  }

  /**
   * One bank change request, masked.
   *
   * `user` is required for the ownership check: the route admits all four roles
   * because an employee has to be able to read the request they raised and an
   * approver has to be able to read the one they are deciding. Without the check
   * any authenticated employee could walk request ids and learn who is changing
   * their bank, and to which bank — the values are masked, the identities were
   * not.
   *
   * ADMIN and HR administer the queue; a manager sees their own department; an
   * employee sees their own request; and anyone the approval chain has actually
   * asked to decide may read the one in front of them. That last check is the
   * same `canAct` the approvals inbox computes, so the read and the decision
   * agree about who is involved.
   */
  async getRequest(requestId: string, user?: any) {
    const request = await this.getRequestOrThrow(requestId);

    if (user) {
      const isOwner =
        request.employeeId === user.employeeId ||
        request.employee?.user?.id === user.id;
      const isAdminOrHR = ['ADMIN', 'HR_MANAGER'].includes(user.role);
      const isDeptManager =
        user.role === 'MANAGER' &&
        isDeptInManagerScope(user, request.employee?.departmentId ?? null);
      if (!isOwner && !isAdminOrHR && !isDeptManager) {
        const trail = await this.engine.trailFor(
          'BANK_CHANGE',
          requestId,
          user,
        );
        if (!trail.canAct) {
          throw new ForbiddenException(
            'You do not have permission to view this request',
          );
        }
      }
    }

    const bank = await this.prisma.bank.findUnique({
      where: { id: request.bankId },
      select: { name: true, country: true },
    });
    const fields = bank ? await this.config.getFieldsForCountry(bank.country) : [];
    // Never return raw sensitive values in the general getter — mask via config.
    return {
      success: true,
      data: {
        id: request.id,
        employeeId: request.employeeId,
        status: request.status,
        bankId: request.bankId,
        bankName: bank?.name,
        country: bank?.country,
        values: maskBankingData((request.data as Record<string, unknown>) ?? {}, fields),
        fields,
        createdAt: request.createdAt,
        decidedAt: request.decidedAt,
      },
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private resolveTargetEmployee(explicit: string | undefined, user: any): string {
    const isPrivileged = user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';
    if (explicit && isPrivileged) return explicit;
    // Self-service: ignore any spoofed employeeId and bind to the caller.
    if (!user?.employeeId) {
      throw new ForbiddenException('No employee is linked to this account');
    }
    if (explicit && explicit !== user.employeeId && !isPrivileged) {
      throw new ForbiddenException('You may only change your own bank details');
    }
    return user.employeeId;
  }

  private async getRequestOrThrow(requestId: string) {
    const request = await this.prisma.bankChangeRequest.findUnique({
      where: { id: requestId },
      include: {
        employee: {
          select: { departmentId: true, user: { select: { id: true } } },
        },
      },
    });
    if (!request) throw new NotFoundException('Bank change request not found');
    assertInBranch(request.branchId);
    return request;
  }
}
