import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import { ReimbursementsService } from '../reimbursements/reimbursements.service';
import { AdvanceLoansService } from '../advance-loans/advance-loans.service';
import { BudgetCommitmentService } from '../budgets/budget-commitment.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { getBranchContext } from '../common/branch/branch-context';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { CreateTravelRequestDto } from './dto/create-travel-request.dto';
import { QueryTravelDto } from './dto/query-travel.dto';
import { DecideTravelDto } from './dto/decide-travel.dto';

/** Expense type used for the auto-generated per-diem claim. */
const PER_DIEM_EXPENSE_TYPE = 'Per Diem';
/** BUDGET_CATEGORY label travel spend is attributed to. */
const TRAVEL_BUDGET_CATEGORY = 'Travel';

@Injectable()
export class TravelService {
  private readonly logger = new Logger(TravelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SystemSettingsService,
    private readonly engine: ApprovalEngineService,
    private readonly reimbursements: ReimbursementsService,
    private readonly advanceLoans: AdvanceLoansService,
    private readonly budget: BudgetCommitmentService,
  ) {}

  private readonly include = {
    employee: {
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        departmentId: true,
        branchId: true,
        department: { select: { id: true, name: true } },
        user: { select: { id: true } },
      },
    },
    approver: { select: { id: true, email: true } },
    itinerary: { orderBy: { legOrder: 'asc' as const } },
  };

  private async getOrThrow(id: string) {
    const request = await this.prisma.travelRequest.findUnique({
      where: { id },
      include: this.include,
    });
    if (!request) throw new NotFoundException('Travel request not found');
    // findUnique bypasses the auto-scoping middleware.
    assertInBranch(request.employee.branchId);
    return request;
  }

  /** Inclusive day count — a same-day trip is one per-diem day, not zero. */
  private dayCount(from: Date, to: Date): number {
    const ms = new Date(to).getTime() - new Date(from).getTime();
    return Math.floor(ms / 86_400_000) + 1;
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async create(employeeId: string, dto: CreateTravelRequestDto, user: any) {
    // A kill switch an admin can see must do something. `travel_enabled` was
    // seeded, listed in the settings registry and rendered in the admin UI, and
    // read by nothing — turning Travel off changed nothing at all. Matches the
    // `reimbursement_enabled` / `advance_loan_enabled` precedent.
    const enabled = await this.settings.getSetting('travel_enabled', 'true');
    if (enabled === 'false') {
      throw new BadRequestException('Travel module is disabled');
    }

    // An account with no employee record is an ordinary shape — an HR or ADMIN
    // login that administers but is not itself staff. Without this guard
    // `employeeId` is `undefined` and Prisma throws, so the server reported its
    // own fault for a perfectly valid request.
    if (!employeeId) {
      throw new BadRequestException(
        'Your account is not linked to an employee record, so it cannot raise a travel request',
      );
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, fullName: true, branchId: true, status: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertInBranch(employee.branchId);

    const departureDate = new Date(dto.departureDate);
    const returnDate = new Date(dto.returnDate);
    if (returnDate < departureDate) {
      throw new BadRequestException('Return date cannot be before departure');
    }

    // Per-diem rate is SNAPSHOTTED here, never read live at approval time:
    // LibraryItem.remove() is a hard delete with no referential integrity, and
    // an admin editing the rate must not retroactively change approved trips.
    let perDiemRate: Prisma.Decimal | null = null;
    const destination = await this.prisma.libraryItem.findFirst({
      where: { libraryType: 'PER_DIEM_DESTINATION', label: dto.destination },
      select: { perDiemRate: true },
    });
    if (destination?.perDiemRate) perDiemRate = destination.perDiemRate;

    const perDiemDays = dto.perDiemDays ?? this.dayCount(departureDate, returnDate);

    const request = await this.prisma.travelRequest.create({
      data: {
        employeeId,
        purpose: dto.purpose,
        travelType: dto.travelType,
        destination: dto.destination,
        country: dto.country ?? null,
        departureDate,
        returnDate,
        perDiemRate,
        perDiemDays,
        estimatedCost: dto.estimatedCost,
        advanceAmount: dto.advanceAmount ?? null,
        status: 'PENDING',
        ...(dto.itinerary?.length
          ? {
              itinerary: {
                create: dto.itinerary.map((leg, i) => ({
                  legOrder: i + 1,
                  mode: leg.mode,
                  fromPlace: leg.fromPlace ?? null,
                  toPlace: leg.toPlace ?? null,
                  startAt: new Date(leg.startAt),
                  endAt: leg.endAt ? new Date(leg.endAt) : null,
                  reference: leg.reference ?? null,
                  notes: leg.notes ?? null,
                })),
              },
            }
          : {}),
      },
      include: this.include,
    });

    await this.audit.log({
      userId: user?.id,
      action: 'TRAVEL_REQUESTED',
      resourceType: 'TravelRequest',
      resourceId: request.id,
      newData: {
        destination: dto.destination,
        travelType: dto.travelType,
        estimatedCost: dto.estimatedCost,
      },
      branchId: employee.branchId,
    });

    // Route through the configurable engine.
    //
    // `engaged: false` — the master switch is off, or no active workflow governs
    // TRAVEL — means "no CHAIN governs this", NOT "nobody needs to approve it".
    // It used to mean the latter, copied from the bank-change precedent, and the
    // consequence was that approving a trip is what spends money: a per-diem
    // claim, a real advance in the loans ledger and a budget commitment all
    // fired the moment the form was submitted. Deactivating a workflow did not
    // fall back to manual approval, it fell back to NO approval.
    //
    // Advances & Loans, driven by the same engine, always treated the same
    // answer as "a human still decides". Travel now matches it: the request
    // waits, and `travel_approver_roles` decides who may settle it. An
    // all-skipped chain (`finalized` on initiate) still applies immediately —
    // there the engine really has decided.
    const init = await this.engine.initiate('TRAVEL', request.id, employeeId, user?.id);
    if (init.engaged && init.finalized) {
      return this.applyApproved(request.id, user?.id ?? null);
    }

    if (!init.engaged) {
      await this.notifyLegacyApprovers(request).catch(() => undefined);
    }

    return {
      success: true,
      message: 'Travel request submitted for approval.',
      data: request,
    };
  }

  /**
   * Tell the configured approvers a trip is waiting. Only used on the legacy
   * path — when a chain governs the request the engine notifies the approver of
   * the active step instead.
   */
  private async notifyLegacyApprovers(request: { id: string; destination: string; employeeId: string }) {
    const raw = await this.settings.getSetting(
      'travel_approver_roles',
      'HR_MANAGER,ADMIN',
    );
    const roles = raw.split(',').map((r) => r.trim()).filter(Boolean);
    if (!roles.length) return;

    const employee = await this.prisma.employee.findUnique({
      where: { id: request.employeeId },
      select: { fullName: true },
    });
    const recipients = await this.prisma.user.findMany({
      where: { role: { in: roles }, isActive: true },
      select: { id: true },
    });
    await Promise.all(
      recipients.map((r) =>
        this.notifications
          .create({
            userId: r.id,
            title: 'Travel request awaiting approval',
            message: `${employee?.fullName ?? 'An employee'} has requested a trip to ${request.destination}.`,
            type: 'INFO' as any,
            link: '/dashboard/travel',
          })
          .catch(() => undefined),
      ),
    );
  }

  // ── Decide ────────────────────────────────────────────────────────────────

  async decide(
    id: string,
    user: any,
    decision: 'APPROVE' | 'REJECT',
    dto: DecideTravelDto = {},
  ) {
    const request = await this.getOrThrow(id);
    if (request.status !== 'PENDING') {
      throw new BadRequestException(
        `Cannot decide a ${request.status.toLowerCase()} travel request`,
      );
    }

    const result = await this.engine.decide(
      'TRAVEL',
      id,
      request.employeeId,
      user,
      decision,
      dto.remarks,
    );

    // engaged=false => no chain governs this request; fall back to the legacy
    // single-approver rule, same shape as reimbursements and advance loans.
    if (!result.engaged) {
      await this.assertLegacyApprover(user, request.employee.departmentId);
    }

    if (decision === 'REJECT' && (!result.engaged || result.finalized)) {
      return this.applyRejected(id, user?.id, dto.remarks);
    }
    if (decision === 'APPROVE' && (!result.engaged || result.finalized)) {
      return this.applyApproved(id, user?.id ?? null, dto.remarks);
    }

    return {
      success: true,
      message: 'Decision recorded. Awaiting the next approval step.',
      data: { id, status: 'PENDING' },
    };
  }

  /** Legacy path: approver roles come from a setting, MANAGER scoped to their departments. */
  private async assertLegacyApprover(user: any, departmentId: string | null) {
    const raw = await this.settings.getSetting(
      'travel_approver_roles',
      'HR_MANAGER,ADMIN',
    );
    const roles = raw.split(',').map((r) => r.trim()).filter(Boolean);
    if (!roles.includes(user?.role)) {
      throw new ForbiddenException(
        'Your role is not configured to approve travel requests',
      );
    }
    if (user.role === 'MANAGER' && !isDeptInManagerScope(user, departmentId ?? '')) {
      throw new ForbiddenException(
        'You can only review travel requests from your own department',
      );
    }
  }

  // ── Final side-effects ────────────────────────────────────────────────────

  /**
   * Everything that happens once a trip is actually approved.
   *
   * The approval engine deliberately runs no domain side-effects — this is the
   * caller's half of that contract, and it only ever runs on
   * `finalized && APPROVED` (or when no chain governs the request).
   */
  private async applyApproved(
    id: string,
    approverUserId: string | null,
    remarks?: string,
  ) {
    const request = await this.getOrThrow(id);

    // Claim the transition BEFORE spending anything.
    //
    // `decide()` reads the status and then acts on it, which is a read-then-write
    // with a window in between. Two approvers deciding the same trip at once both
    // saw PENDING, so an approve and a reject could interleave: the approve arm
    // raised the per-diem claim and the advance, and the reject arm then won the
    // status write — leaving a trip that was refused AND paid.
    //
    // A conditional update closes the window: exactly one caller can move the row
    // out of PENDING, and only that caller goes on to spend. This is the guard
    // reimbursements have always had (`updateMany where status:'PENDING'`, then
    // check `count`); travel was the one money path without it.
    const claimed = await this.prisma.travelRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        approverId: approverUserId,
        approvedAt: new Date(),
        approverRemarks: remarks ?? null,
      },
    });
    if (claimed.count === 0) {
      throw new BadRequestException(
        'This travel request has already been decided by another approver',
      );
    }

    const updated = await this.prisma.travelRequest.findUniqueOrThrow({
      where: { id },
      include: this.include,
    });

    // 1. Per-diem becomes an ordinary reimbursement row. This is the whole
    //    "feeds the existing expense module rather than duplicating it" idea:
    //    no travel-expense table, no second payout path.
    // Compare numerically: a Prisma Decimal is an OBJECT, so a rate of 0 is
    // truthy and a bare `if (request.perDiemRate)` would raise a 0.00 claim for
    // every local trip — junk rows in every payroll run.
    if (Number(request.perDiemRate ?? 0) > 0 && (request.perDiemDays ?? 0) > 0) {
      const amount = request.perDiemRate!.mul(request.perDiemDays!);
      try {
        await this.reimbursements.createFromSource({
          employeeId: request.employeeId,
          type: PER_DIEM_EXPENSE_TYPE,
          amount,
          // Per-diem is earned on the trip; date it at departure so it lands in
          // the right payroll month rather than the approval month.
          expenseDate: request.departureDate,
          description: `Per diem — ${request.destination} (${request.perDiemDays} day(s))`,
          sourceType: 'TRAVEL',
          sourceId: request.id,
          budgetCategory: TRAVEL_BUDGET_CATEGORY,
          status: 'APPROVED',
          approverId: approverUserId ?? undefined,
        });
      } catch (e: any) {
        // A failed per-diem claim must not un-approve the trip; HR can raise it
        // manually from the trip screen.
        this.logger.error(
          `Per-diem claim for travel ${id} failed: ${e?.message ?? e}`,
        );
      }
    }

    // 2. A travel advance routes through the EXISTING loans ledger, so it is
    //    recovered from payroll by machinery that already works.
    if (request.advanceAmount && Number(request.advanceAmount) > 0 && !request.advanceLoanId) {
      try {
        const loan = await this.advanceLoans.create(request.employeeId, {
          type: 'ADVANCE',
          amount: Number(request.advanceAmount),
          reason: `Travel advance — ${request.destination} (${request.purpose.slice(0, 80)})`,
          installments: 1,
        } as any);
        const loanId = (loan as any)?.data?.id ?? (loan as any)?.id;
        if (loanId) {
          await this.prisma.travelRequest.update({
            where: { id },
            data: { advanceLoanId: loanId },
          });
        }
      } catch (e: any) {
        this.logger.error(`Travel advance for ${id} failed: ${e?.message ?? e}`);
      }
    }

    // 3. International trip without a current visa for the destination country
    //    => notify HR. Deliberately a NOTIFICATION, not an auto-created record:
    //    a visa needs a document number and issuing authority that nobody has
    //    at trip-approval time, and a fabricated one is worse than none.
    if (request.travelType === 'INTERNATIONAL' && request.country) {
      await this.flagVisaGap(request).catch((e) =>
        this.logger.error(`Visa gap check for travel ${id} failed: ${e.message}`),
      );
    }

    // 4. Commit the money against the budget. Approved-but-unspent spend has to
    //    consume budget now, or Remaining lags reality by a whole payroll cycle.
    //    Never blocks the approval — a missing budget line logs and moves on.
    await this.budget.commit({
      sourceType: 'TRAVEL',
      sourceId: request.id,
      amount: request.estimatedCost,
      departmentId: request.employee.departmentId,
      category: TRAVEL_BUDGET_CATEGORY,
      branchId: request.employee.branchId,
      onDate: request.departureDate,
    });

    await this.audit.log({
      userId: approverUserId ?? undefined,
      action: 'TRAVEL_APPROVED',
      resourceType: 'TravelRequest',
      resourceId: id,
      newData: { destination: request.destination, remarks },
      branchId: getBranchContext()?.effectiveBranchId ?? null,
    });

    if (request.employee.user?.id) {
      await this.notifications
        .create({
          userId: request.employee.user.id,
          title: 'Travel request approved',
          message: `Your trip to ${request.destination} (${request.departureDate.toDateString()}) was approved.`,
          type: 'SUCCESS' as any,
          link: '/dashboard/my-travel',
          // 'SUCCESS' is generic, so the WhatsApp template is named explicitly.
          waTemplate: 'travel_decision',
          waData: {
            destination: request.destination,
            startDate: request.departureDate.toISOString(),
            status: 'APPROVED',
          },
          waDedupeKey: `travel:${id}:approved`,
        })
        .catch(() => undefined);
    }

    return { success: true, message: 'Travel request approved.', data: updated };
  }

  private async applyRejected(id: string, approverUserId?: string, reason?: string) {
    const request = await this.getOrThrow(id);

    // Same conditional claim as the approval path — see `applyApproved`. Without
    // it a rejection could overwrite an approval that had already raised a claim.
    const claimed = await this.prisma.travelRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        approverId: approverUserId ?? null,
        approvedAt: new Date(),
        rejectedReason: reason ?? null,
      },
    });
    if (claimed.count === 0) {
      throw new BadRequestException(
        'This travel request has already been decided by another approver',
      );
    }

    const updated = await this.prisma.travelRequest.findUniqueOrThrow({
      where: { id },
      include: this.include,
    });

    // Rejected money was never going to be spent.
    await this.budget.release('TRAVEL', id, reason ?? 'Travel request rejected');

    await this.audit.log({
      userId: approverUserId,
      action: 'TRAVEL_REJECTED',
      resourceType: 'TravelRequest',
      resourceId: id,
      newData: { reason },
      branchId: getBranchContext()?.effectiveBranchId ?? null,
    });

    if (request.employee.user?.id) {
      await this.notifications
        .create({
          userId: request.employee.user.id,
          title: 'Travel request rejected',
          message: `Your trip to ${request.destination} was rejected.${reason ? ` Reason: ${reason}` : ''}`,
          type: 'ERROR' as any,
          link: '/dashboard/my-travel',
          waTemplate: 'travel_decision',
          waData: { destination: request.destination, status: 'REJECTED' },
          waDedupeKey: `travel:${id}:rejected`,
        })
        .catch(() => undefined);
    }

    return { success: true, message: 'Travel request rejected.', data: updated };
  }

  /** Notify HR when an approved international trip has no current visa for the country. */
  private async flagVisaGap(request: Awaited<ReturnType<TravelService['getOrThrow']>>) {
    const visa = await this.prisma.employeeLegalDocument.findFirst({
      where: {
        employeeId: request.employeeId,
        category: 'VISA',
        country: request.country!,
        isCurrent: true,
        status: 'ACTIVE',
        // A visa expiring before the traveller comes back is no use.
        expiryDate: { gte: request.returnDate },
      },
      select: { id: true },
    });
    if (visa) return;

    const recipients = await this.prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'HR_MANAGER'] }, isActive: true },
      select: { id: true },
    });
    await Promise.all(
      recipients.map((r) =>
        this.notifications
          .create({
            userId: r.id,
            title: 'Visa required for approved travel',
            message: `${request.employee.fullName} is approved to travel to ${request.country} on ${request.departureDate.toDateString()} but has no current visa covering the trip.`,
            type: 'WARNING' as any,
            link: `/dashboard/employees/${request.employeeId}?section=visa`,
          })
          .catch(() => undefined),
      ),
    );
  }

  // ── Cancel ────────────────────────────────────────────────────────────────

  async cancel(id: string, user: any) {
    const request = await this.getOrThrow(id);
    const isOwner = request.employee.user?.id === user?.id;
    if (!isOwner && user?.role !== 'ADMIN' && user?.role !== 'HR_MANAGER') {
      throw new ForbiddenException('Not permitted to cancel this travel request');
    }
    if (!['PENDING', 'APPROVED'].includes(request.status)) {
      throw new BadRequestException(
        `Cannot cancel a ${request.status.toLowerCase()} travel request`,
      );
    }

    await this.engine.abandon('TRAVEL', id);

    // Withdraw the money the trip spawned — but never anything already linked
    // to a payroll item; reversing paid money belongs in payroll.
    const cancelledClaims = await this.reimbursements.cancelBySource('TRAVEL', id);

    const updated = await this.prisma.travelRequest.update({
      where: { id },
      data: { status: 'CANCELLED' },
      include: this.include,
    });

    await this.budget.release('TRAVEL', id, 'Travel request cancelled');

    await this.audit.log({
      userId: user?.id,
      action: 'TRAVEL_CANCELLED',
      resourceType: 'TravelRequest',
      resourceId: id,
      newData: { cancelledClaims },
      branchId: getBranchContext()?.effectiveBranchId ?? null,
    });

    return {
      success: true,
      message: `Travel request cancelled.${cancelledClaims > 0 ? ` ${cancelledClaims} linked claim(s) withdrawn.` : ''}`,
      data: updated,
    };
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async findAll(query: QueryTravelDto, user: any) {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(query.limit ?? 25, 200);

    const where: Prisma.TravelRequestWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.travelType) where.travelType = query.travelType;
    if (query.from || query.to) {
      where.departureDate = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    // Department heads see their own departments only, matching every other
    // manager-facing list.
    if (user?.role === 'MANAGER') {
      const deptIds = (user.managedDepartmentIds ?? []).filter(Boolean);
      if (deptIds.length === 0) return { success: true, data: [], meta: { total: 0, page, limit } };
      where.employee = { departmentId: { in: deptIds } };
    }

    const [rows, total] = await Promise.all([
      this.prisma.travelRequest.findMany({
        where,
        include: this.include,
        orderBy: { departureDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.travelRequest.count({ where }),
    ]);

    return { success: true, data: rows, meta: { total, page, limit } };
  }

  async findByEmployee(employeeId: string) {
    const rows = await this.prisma.travelRequest.findMany({
      where: { employeeId },
      include: this.include,
      orderBy: { departureDate: 'desc' },
    });
    return { success: true, data: rows };
  }

  /**
   * Trip detail plus every claim it spawned, so the money is visible in one place.
   *
   * `user` is required. This used to assert the BRANCH and nothing else — no
   * owner check, no manager-scope check, the two that `decide` performs on the
   * same row — so any employee holding a UUID read a colleague's purpose,
   * destination, cost and the claims the trip raised.
   */
  async findOne(id: string, user?: any) {
    const request = await this.getOrThrow(id);

    if (user) {
      const isOwner = request.employeeId === user.employeeId;
      const isAdminOrHR = ['ADMIN', 'HR_MANAGER'].includes(user.role);
      const isDeptManager =
        user.role === 'MANAGER' &&
        isDeptInManagerScope(user, request.employee?.departmentId ?? '');
      if (!isOwner && !isAdminOrHR && !isDeptManager) {
        throw new ForbiddenException(
          'You do not have permission to view this travel request',
        );
      }
    }

    const claims = await this.reimbursements.findBySource('TRAVEL', id);
    return { success: true, data: { ...request, claims } };
  }

  /**
   * Approved trips overlapping a window — drives the team calendar, so managers
   * can see who is away. Deliberately read-only: a trip is NOT leave and must
   * never write Attendance or LeaveRequest rows, or it would move payroll days.
   */
  async findOnTrip(from: Date, to: Date, departmentIds?: string[]) {
    const rows = await this.prisma.travelRequest.findMany({
      where: {
        // APPROVED only: `COMPLETED` was never written by anything, so listing
        // it here was noise. See TRAVEL_STATUSES for the reasoning.
        status: 'APPROVED',
        departureDate: { lte: to },
        returnDate: { gte: from },
        ...(departmentIds?.length
          ? { employee: { departmentId: { in: departmentIds } } }
          : {}),
      },
      select: {
        id: true,
        destination: true,
        country: true,
        travelType: true,
        departureDate: true,
        returnDate: true,
        employee: {
          select: {
            id: true,
            fullName: true,
            employeeCode: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: { departureDate: 'asc' },
    });
    return { success: true, data: rows };
  }

  /**
   * Trips in flight, and the ones about to be.
   *
   * "On trip" is a date-window question, not a status one — an APPROVED request
   * whose return date has passed is history, and the hub had no honest way to
   * ask for it without inventing a window. This picks the only window that
   * needs no argument: today.
   */
  async stats() {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const in30 = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [pending, onTrip, upcoming] = await Promise.all([
      this.prisma.travelRequest.count({ where: { status: 'PENDING' } }),
      this.prisma.travelRequest.count({
        where: {
          status: 'APPROVED',
          departureDate: { lte: today },
          returnDate: { gte: today },
        },
      }),
      this.prisma.travelRequest.count({
        where: {
          status: 'APPROVED',
          departureDate: { gt: today, lte: in30 },
        },
      }),
    ]);

    return { success: true, data: { pending, onTripToday: onTrip, upcoming30Days: upcoming } };
  }
}
