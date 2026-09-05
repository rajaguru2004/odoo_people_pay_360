import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ApprovalMode, ApproverType, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../auth/auth.service';
import {
  APPROVAL_KINDS,
  type ApprovalRequestType,
} from './approval-kind.registry';

export type { ApprovalRequestType };

type Decision = 'APPROVE' | 'REJECT';

/** Runtime states a `RequestApproval` row moves through. */
const PENDING = 'PENDING';
const ACTIVE = 'ACTIVE';
const APPROVED = 'APPROVED';
const REJECTED = 'REJECTED';
const SKIPPED = 'SKIPPED';

/** The setting that arms the whole engine. Off, and nothing is governed. */
const MASTER_SWITCH = 'supervisor_approval_enabled';

export interface EngineResult {
  /** Whether a configured workflow trail governs this request. */
  engaged: boolean;
  /** Whether the chain reached a terminal state on this call. */
  finalized: boolean;
  outcome?: 'APPROVED' | 'REJECTED';
  /** The step now awaiting a decision, when the chain has not finished. */
  nextStepOrder?: number;
}

const TRAIL_ORDER = {
  stepOrder: 'asc',
} satisfies Prisma.RequestApprovalOrderByWithRelationInput;

/**
 * The configurable approval hierarchy.
 *
 * Owns the `RequestApproval` trail, per-step approver resolution, eligibility
 * and the per-step audit rows. It deliberately does NOT run domain
 * side-effects — writing leave attendance, deducting a balance, recomputing
 * pay — the calling service does that when `finalized && outcome === 'APPROVED'`.
 * Keeping the two apart is what lets one engine govern leave, overtime and
 * training without knowing what any of them mean.
 *
 * A request is governed only when the master switch is on AND an active
 * `ApprovalWorkflow` exists for its type. Otherwise `engaged: false` comes back
 * and the caller applies its own single-approver rule, so the default behaviour
 * of a fresh install is unchanged until an administrator configures a chain.
 *
 * Two activation modes, chosen per workflow:
 *   SEQUENTIAL — one step is ACTIVE at a time; step N+1 opens only when step N
 *                is approved.
 *   PARALLEL   — every step opens at once and may be approved in any order; the
 *                request finalises when the last outstanding step approves.
 * Both finalise as REJECTED on the first rejection.
 */
@Injectable()
export class ApprovalEngineService {
  private readonly logger = new Logger(ApprovalEngineService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async isEnabled(): Promise<boolean> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: MASTER_SWITCH },
    });
    return setting?.value === 'true';
  }

  async getActiveWorkflow(type: ApprovalRequestType) {
    return this.prisma.approvalWorkflow.findFirst({
      where: { requestType: type, isActive: true },
      include: { steps: { orderBy: TRAIL_ORDER } },
    });
  }

  /** An audit row per step decision, so a chain can be reconstructed later. */
  private async audit(
    userId: string | null | undefined,
    action: string,
    requestId: string,
    metadata: Prisma.InputJsonValue,
  ) {
    await this.prisma.auditLog.create({
      data: {
        userId: userId ?? null,
        action,
        entityType: 'RequestApproval',
        entityId: requestId,
        metadata,
      },
    });
  }

  /**
   * The employee who raised a request. `RequestApproval` stores only the
   * request id, so every path that needs the requester comes through here.
   */
  private async requesterOf(
    type: ApprovalRequestType,
    requestId: string,
  ): Promise<string | null> {
    const kind = APPROVAL_KINDS[type];
    if (!kind) {
      // A trail row for a type the registry no longer knows. Refusing to
      // resolve is safer than guessing: the row simply never becomes
      // actionable, rather than being decided against the wrong record.
      this.logger.warn(`No approval kind registered for type "${type}"`);
      return null;
    }
    return kind.requesterOf(this.prisma, requestId);
  }

  /** Requester identity, used for approver resolution and self-approval skips. */
  private async requesterContext(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        departmentId: true,
        supervisorId: true,
        user: { select: { id: true } },
      },
    });
    if (!employee) return null;
    return {
      ...employee,
      fullName: [employee.firstName, employee.lastName]
        .filter(Boolean)
        .join(' '),
    };
  }

  /**
   * The USER ids eligible to act at a step, given the requester.
   *
   * Role steps (HR_MANAGER, ADMIN) resolve to a live pool; personal steps
   * (SUPERVISOR, MANAGER) resolve to the one person the relationship names.
   */
  private async resolveApprovers(
    approverType: ApproverType,
    requesterEmployeeId: string,
  ): Promise<string[]> {
    if (approverType === ApproverType.SUPERVISOR) {
      const employee = await this.prisma.employee.findUnique({
        where: { id: requesterEmployeeId },
        select: { supervisor: { select: { user: { select: { id: true } } } } },
      });
      const userId = employee?.supervisor?.user?.id;
      return userId ? [userId] : [];
    }
    if (approverType === ApproverType.MANAGER) {
      const employee = await this.prisma.employee.findUnique({
        where: { id: requesterEmployeeId },
        select: {
          department: {
            select: { manager: { select: { user: { select: { id: true } } } } },
          },
        },
      });
      const userId = employee?.department?.manager?.user?.id;
      return userId ? [userId] : [];
    }
    const users = await this.prisma.user.findMany({
      where: { role: approverType, isActive: true },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /**
   * Materialise the trail for a newly raised request and open its first
   * actionable step. `engaged: false` when no workflow governs the request.
   */
  async initiate(
    type: ApprovalRequestType,
    requestId: string,
    requesterEmployeeId: string,
    actorUserId?: string,
  ): Promise<EngineResult> {
    if (!(await this.isEnabled())) return { engaged: false, finalized: false };
    const workflow = await this.getActiveWorkflow(type);
    if (!workflow || workflow.steps.length === 0) {
      return { engaged: false, finalized: false };
    }

    await this.prisma.requestApproval.createMany({
      data: workflow.steps.map((step) => ({
        requestType: type,
        requestId,
        stepOrder: step.stepOrder,
        approverType: step.approverType,
        status: PENDING,
      })),
    });

    const result = await this.activateFrom(
      type,
      requestId,
      requesterEmployeeId,
      1,
      workflow.mode,
    );
    await this.audit(actorUserId, 'APPROVAL_INITIATED', requestId, {
      type,
      workflowId: workflow.id,
      mode: workflow.mode,
      finalized: result.finalized,
    });
    return { engaged: true, ...result };
  }

  /**
   * Open the outstanding steps from `fromOrder` on, skipping any that resolve
   * to nobody or only to the requester.
   *
   * SEQUENTIAL stops at the first actionable step; later steps stay PENDING
   * until that approver accepts. PARALLEL opens every actionable step at once.
   * `finalized: true` comes back when nothing outstanding is left, which is the
   * auto-approve case: a chain whose every step had no eligible approver.
   *
   * Only PENDING rows are considered, so an already-ACTIVE or decided step is
   * never reopened — which matters in PARALLEL, where siblings are already live.
   */
  private async activateFrom(
    type: ApprovalRequestType,
    requestId: string,
    requesterEmployeeId: string,
    fromOrder: number,
    mode: ApprovalMode = ApprovalMode.SEQUENTIAL,
  ): Promise<{
    finalized: boolean;
    outcome?: 'APPROVED';
    nextStepOrder?: number;
  }> {
    const requester = await this.requesterContext(requesterEmployeeId);
    const requesterUserId = requester?.user?.id ?? null;

    const steps = await this.prisma.requestApproval.findMany({
      where: {
        requestType: type,
        requestId,
        stepOrder: { gte: fromOrder },
        status: PENDING,
      },
      orderBy: TRAIL_ORDER,
    });

    let firstActivated: number | undefined;

    for (const step of steps) {
      const approvers = (
        await this.resolveApprovers(step.approverType, requesterEmployeeId)
      ).filter((userId) => userId !== requesterUserId);

      if (approvers.length === 0) {
        await this.prisma.requestApproval.update({
          where: { id: step.id },
          data: {
            status: SKIPPED,
            decidedAt: new Date(),
            comment: 'Auto-skipped: no eligible approver, or self-approval',
          },
        });
        continue;
      }

      // The snapshot. A SUPERVISOR step records WHO owed the decision at the
      // moment it opened, so moving the reporting line afterwards does not
      // silently hand a live request to somebody else — or to nobody. Role
      // steps stay unresolved on purpose: their pool is meant to be whoever
      // holds the role today.
      const resolvedApproverId =
        step.approverType === ApproverType.SUPERVISOR ? approvers[0] : null;

      await this.prisma.requestApproval.update({
        where: { id: step.id },
        data: { status: ACTIVE, resolvedApproverId },
      });

      if (firstActivated === undefined) firstActivated = step.stepOrder;
      if (mode === ApprovalMode.SEQUENTIAL) break;
    }

    if (firstActivated !== undefined) {
      return { finalized: false, nextStepOrder: firstActivated };
    }
    return { finalized: true, outcome: 'APPROVED' };
  }

  /** Whether `user` may act on the given ACTIVE step for this requester. */
  private async isEligible(
    user: Principal | null | undefined,
    step: { approverType: ApproverType; resolvedApproverId: string | null },
    requesterEmployeeId: string,
  ): Promise<boolean> {
    if (!user) return false;
    if (user.role === UserRole.ADMIN) return true;
    if (step.resolvedApproverId) return user.id === step.resolvedApproverId;
    const approvers = await this.resolveApprovers(
      step.approverType,
      requesterEmployeeId,
    );
    return approvers.includes(user.id);
  }

  /**
   * Record an APPROVE/REJECT against the live step.
   *
   * `engaged: false` means no trail governs the request and the caller should
   * fall back to its own rule. Anything else throws rather than quietly doing
   * nothing: an ineligible actor is a 403, a settled chain a 400.
   */
  async decide(
    type: ApprovalRequestType,
    requestId: string,
    requesterEmployeeId: string,
    user: Principal,
    decision: Decision,
    comment?: string,
  ): Promise<EngineResult> {
    const rows = await this.prisma.requestApproval.findMany({
      where: { requestType: type, requestId },
      orderBy: TRAIL_ORDER,
    });
    if (rows.length === 0) return { engaged: false, finalized: false };

    const activeRows = rows.filter((row) => row.status === ACTIVE);
    if (activeRows.length === 0) {
      throw new BadRequestException(
        'No pending approval step for this request',
      );
    }

    // A PARALLEL chain can have several live steps; act on the first one this
    // caller is eligible for. A SEQUENTIAL chain only ever has one.
    let active: (typeof activeRows)[number] | undefined;
    for (const row of activeRows) {
      if (await this.isEligible(user, row, requesterEmployeeId)) {
        active = row;
        break;
      }
    }
    if (!active) {
      throw new ForbiddenException(
        'You are not an eligible approver for the current step',
      );
    }

    if (decision === 'REJECT') {
      await this.prisma.requestApproval.update({
        where: { id: active.id },
        data: {
          status: REJECTED,
          decidedById: user.id,
          decidedAt: new Date(),
          comment: comment || null,
        },
      });
      // One rejection closes the whole chain. Without this a sibling step in a
      // PARALLEL workflow, or a later step reactivated by an edit, could
      // finalise a request that has already been turned down.
      await this.prisma.requestApproval.updateMany({
        where: {
          requestType: type,
          requestId,
          status: { in: [PENDING, ACTIVE] },
        },
        data: {
          status: SKIPPED,
          decidedAt: new Date(),
          comment: `Chain closed: rejected at step ${active.stepOrder}`,
        },
      });
      await this.audit(user.id, 'APPROVAL_STEP_REJECTED', requestId, {
        type,
        stepOrder: active.stepOrder,
        comment: comment ?? null,
      });
      return { engaged: true, finalized: true, outcome: 'REJECTED' };
    }

    await this.prisma.requestApproval.update({
      where: { id: active.id },
      data: {
        status: APPROVED,
        decidedById: user.id,
        decidedAt: new Date(),
        comment: comment || null,
      },
    });
    await this.audit(user.id, 'APPROVAL_STEP_APPROVED', requestId, {
      type,
      stepOrder: active.stepOrder,
      comment: comment ?? null,
    });

    // PARALLEL: siblings may still be live, so the request waits for them.
    const stillLive = activeRows.filter((row) => row.id !== active.id);
    if (stillLive.length > 0) {
      return {
        engaged: true,
        finalized: false,
        nextStepOrder: Math.min(...stillLive.map((row) => row.stepOrder)),
      };
    }

    // SEQUENTIAL: hand over to the next outstanding step. A PARALLEL chain has
    // no PENDING rows left at this point, so the same call finalises it.
    const workflow = await this.getActiveWorkflow(type);
    const result = await this.activateFrom(
      type,
      requestId,
      requesterEmployeeId,
      active.stepOrder + 1,
      workflow?.mode ?? ApprovalMode.SEQUENTIAL,
    );
    return { engaged: true, ...result };
  }

  /**
   * Close a request's live trail — the requester withdrew it. Non-terminal rows
   * become SKIPPED so no approver can finalise something already cancelled.
   */
  async abandon(type: ApprovalRequestType, requestId: string): Promise<void> {
    await this.prisma.requestApproval.updateMany({
      where: {
        requestType: type,
        requestId,
        status: { in: [PENDING, ACTIVE] },
      },
      data: {
        status: SKIPPED,
        decidedAt: new Date(),
        comment: 'Request cancelled',
      },
    });
  }

  /**
   * Whether `user` is part of a request's chain — an approver of any step, or
   * somebody who has already decided one.
   *
   * The by-id doors need this. A supervisor holds role EMPLOYEE, owns none of
   * the requester's records and manages none of their departments, so the
   * ordinary ownership rule refuses them — which would strand every configured
   * chain at step one, with the person being asked to decide unable to open the
   * request at all.
   */
  async isChainParticipant(
    type: ApprovalRequestType,
    requestId: string,
    user: Principal | null | undefined,
  ): Promise<boolean> {
    if (!user) return false;
    const steps = await this.getTrail(type, requestId);
    if (steps.length === 0) return false;
    const requesterEmployeeId = await this.requesterOf(type, requestId);
    if (!requesterEmployeeId) return false;
    for (const row of steps) {
      if (row.decidedById && row.decidedById === user.id) return true;
      if (await this.isEligible(user, row, requesterEmployeeId)) return true;
    }
    return false;
  }

  /** The trail for one request, oldest step first. */
  async getTrail(type: ApprovalRequestType, requestId: string) {
    return this.prisma.requestApproval.findMany({
      where: { requestType: type, requestId },
      orderBy: TRAIL_ORDER,
    });
  }

  /**
   * The trail plus whether `user` may act on it right now.
   *
   * `canAct` runs the same eligibility check `decide()` runs, so a screen that
   * gates its Approve and Reject buttons on it offers the action exactly when
   * the action would succeed. Screens that guess from the caller's role instead
   * strand the MANAGER and SUPERVISOR steps of a configured chain, since
   * neither is the elevated role those screens were written around.
   *
   * `engaged: false` means no chain governs the request and the caller should
   * apply its own single-approver rule.
   */
  async trailFor(
    type: ApprovalRequestType,
    requestId: string,
    user: Principal,
  ): Promise<{
    engaged: boolean;
    steps: Awaited<ReturnType<ApprovalEngineService['getTrail']>>;
    activeStep: number | null;
    canAct: boolean;
  }> {
    const steps = await this.getTrail(type, requestId);
    if (steps.length === 0) {
      return { engaged: false, steps, activeStep: null, canAct: false };
    }

    const activeRows = steps.filter((step) => step.status === ACTIVE);
    const activeStep = activeRows.length
      ? Math.min(...activeRows.map((step) => step.stepOrder))
      : null;

    const requesterEmployeeId = await this.requesterOf(type, requestId);

    // The trail names who decided what, and when. It is not public: without
    // this an authenticated caller could read any request's approval history by
    // walking request ids.
    //
    // Participation counts for as much as ownership. That is the supervisor
    // case — role EMPLOYEE, no relationship to the requester — and refusing it
    // would strand every configured chain at step one, with the person asked to
    // decide unable to see what they are deciding. It also covers an approver
    // who has already acted and still needs to follow what happened next.
    if (requesterEmployeeId) {
      await this.assertMayReadTrail(type, requestId, requesterEmployeeId, user);
    }

    let canAct = false;
    if (requesterEmployeeId) {
      for (const row of activeRows) {
        if (await this.isEligible(user, row, requesterEmployeeId)) {
          canAct = true;
          break;
        }
      }
    }

    return { engaged: true, steps, activeStep, canAct };
  }

  /**
   * Who may read one request's trail: an administrator or HR, the requester,
   * the head of the requester's own department, or anybody in the chain.
   *
   * A department head is narrowed to their own department deliberately. A role
   * step resolves to every active holder of that role, so treating "could hold
   * a step of this type" as a blanket exemption would let any manager read any
   * other department's decisions.
   */
  private async assertMayReadTrail(
    type: ApprovalRequestType,
    requestId: string,
    requesterEmployeeId: string,
    user: Principal,
  ) {
    if (user?.role === UserRole.ADMIN || user?.role === UserRole.HR_MANAGER) {
      return;
    }
    if (user?.employeeId === requesterEmployeeId) return;

    if (user?.role === UserRole.MANAGER) {
      const subject = await this.prisma.employee.findUnique({
        where: { id: requesterEmployeeId },
        select: { departmentId: true },
      });
      if (subject?.departmentId && subject.departmentId === user.departmentId) {
        return;
      }
    }

    if (await this.isChainParticipant(type, requestId, user)) return;

    throw new ForbiddenException(
      'This approval trail belongs to another employee',
    );
  }

  /**
   * Live steps this user may act on — the queue view. `decide()` re-checks
   * eligibility per step, so this may be generous by a row rather than wrong.
   */
  async pendingForUser(user: Principal) {
    const active = await this.prisma.requestApproval.findMany({
      where: { status: ACTIVE },
      orderBy: { createdAt: 'asc' },
    });
    if (user?.role === UserRole.ADMIN) return active;

    const mine = active.filter((row) => {
      if (row.resolvedApproverId) return row.resolvedApproverId === user?.id;
      return (row.approverType as string) === (user?.role as string);
    });

    // A MANAGER step means "the head of the requester's department", not "any
    // user holding the MANAGER role" — matching on role alone would put every
    // other department's requests into this manager's queue.
    const managerRows = mine.filter(
      (row) => row.approverType === ApproverType.MANAGER,
    );
    if (managerRows.length === 0) return mine;

    const managedDepartmentIds = new Set(
      (
        await this.prisma.department.findMany({
          where: { managerId: user?.employeeId ?? '' },
          select: { id: true },
        })
      ).map((department) => department.id),
    );

    const requesterDeptByRequestId = new Map<string, string | null>();
    for (const row of managerRows) {
      const employeeId = await this.requesterOf(row.requestType, row.requestId);
      const employee = employeeId
        ? await this.prisma.employee.findUnique({
            where: { id: employeeId },
            select: { departmentId: true },
          })
        : null;
      requesterDeptByRequestId.set(
        row.requestId,
        employee?.departmentId ?? null,
      );
    }

    return mine.filter((row) => {
      if (row.approverType !== ApproverType.MANAGER) return true;
      const departmentId = requesterDeptByRequestId.get(row.requestId);
      return !!departmentId && managedDepartmentIds.has(departmentId);
    });
  }

  /**
   * Whether this user can ever be asked to approve something under the current
   * configuration — not just whether anything is waiting. It drives navigation
   * visibility, which has to stay stable while the inbox happens to be empty.
   *
   * ADMIN is excluded on purpose: as the override approver they can act on any
   * step from the domain screens, so an inbox listing every request in the
   * system would be noise rather than a queue.
   */
  async canApprove(
    user: Principal,
  ): Promise<{ isApprover: boolean; pending: number }> {
    if (user?.role === UserRole.ADMIN) return { isApprover: false, pending: 0 };

    const pending = (await this.pendingForUser(user)).length;
    if (pending > 0) return { isApprover: true, pending };

    if (!(await this.isEnabled())) return { isApprover: false, pending };

    const workflows = await this.prisma.approvalWorkflow.findMany({
      where: { isActive: true },
      include: { steps: true },
    });
    const stepTypes = new Set(
      workflows.flatMap((workflow) =>
        workflow.steps.map((step) => step.approverType as string),
      ),
    );
    if (stepTypes.size === 0) return { isApprover: false, pending };
    if (stepTypes.has(user?.role)) return { isApprover: true, pending };

    if (stepTypes.has(ApproverType.MANAGER) && user?.employeeId) {
      const heads = await this.prisma.department.count({
        where: { managerId: user.employeeId },
      });
      if (heads > 0) return { isApprover: true, pending };
    }
    if (stepTypes.has(ApproverType.SUPERVISOR) && user?.employeeId) {
      const supervisees = await this.prisma.employee.count({
        where: { supervisorId: user.employeeId },
      });
      if (supervisees > 0) return { isApprover: true, pending };
    }
    return { isApprover: false, pending };
  }

  /**
   * The approval inbox: live steps the user may act on, hydrated with the
   * underlying request and its employee, and only while the request itself is
   * still pending — a cancelled or already finalised one is dropped.
   */
  async inboxForUser(user: Principal) {
    const rows = await this.pendingForUser(user);
    const byType = await this.hydrateByType(rows, false);

    const items = rows
      .map((row) => {
        // Absent means the request is no longer pending, or its kind is gone.
        const request = byType.get(row.requestType)?.get(row.requestId);
        if (!request) return null;
        return {
          requestType: row.requestType,
          requestId: row.requestId,
          stepOrder: row.stepOrder,
          approverType: row.approverType,
          link: APPROVAL_KINDS[row.requestType]?.link ?? null,
          request,
        };
      })
      .filter((item) => item !== null);

    return { success: true as const, data: items };
  }

  /**
   * The requests this user has already decided.
   *
   * The inbox is a QUEUE: a row leaves it the moment it is acted on, which is
   * right for "what still needs me" and wrong for "what did I decide". Keyed on
   * `decidedById` rather than on eligibility, because an approver's record is
   * what THEY did and must survive them later losing the step — a reassignment
   * or a workflow edit — that let them do it.
   */
  async historyForUser(user: Principal, limit = 50) {
    if (!user?.id) return { success: true as const, data: [] };

    const rows = await this.prisma.requestApproval.findMany({
      where: {
        decidedById: user.id,
        status: { in: [APPROVED, REJECTED] },
      },
      orderBy: { decidedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    if (rows.length === 0) return { success: true as const, data: [] };

    const byType = await this.hydrateByType(rows, true);

    const items = rows
      .map((row) => {
        // Absent means the domain row was deleted since. Dropped rather than
        // rendered as a card with nothing on it.
        const request = byType.get(row.requestType)?.get(row.requestId);
        if (!request) return null;
        return {
          requestType: row.requestType,
          requestId: row.requestId,
          stepOrder: row.stepOrder,
          approverType: row.approverType,
          link: APPROVAL_KINDS[row.requestType]?.link ?? null,
          /** What THIS user did, which is not the request's final status. */
          decision: row.status,
          decidedAt: row.decidedAt,
          comment: row.comment,
          request,
        };
      })
      .filter((item) => item !== null);

    return { success: true as const, data: items };
  }

  /**
   * Group trail rows by type and let each registered kind hydrate its own ids.
   * One query per type actually present — a type with nothing waiting is never
   * touched.
   */
  private async hydrateByType(
    rows: { requestType: ApprovalRequestType; requestId: string }[],
    anyStatus: boolean,
  ) {
    const idsByType = new Map<ApprovalRequestType, string[]>();
    for (const row of rows) {
      if (!APPROVAL_KINDS[row.requestType]) {
        this.logger.warn(
          `No approval kind registered for type "${row.requestType}"`,
        );
        continue;
      }
      const bucket = idsByType.get(row.requestType);
      if (bucket) bucket.push(row.requestId);
      else idsByType.set(row.requestType, [row.requestId]);
    }

    const hydrated = await Promise.all(
      [...idsByType.entries()].map(async ([type, ids]) => {
        const requests = await APPROVAL_KINDS[type].hydrate(this.prisma, ids, {
          anyStatus,
        });
        return [
          type,
          new Map(requests.map((r) => [r.id, r] as const)),
        ] as const;
      }),
    );
    return new Map(hydrated);
  }
}
