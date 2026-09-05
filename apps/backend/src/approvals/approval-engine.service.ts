import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import {
  assertInBranch,
  getEnvelopeBranchIds,
} from '../common/branch/branch-scope.util';
import { assertCanAccessEmployeeRecord } from '../common/services/record-access.util';
import { getBranchContext } from '../common/branch/branch-context';
import {
  APPROVAL_KINDS,
  type ApprovalRequestType,
} from './approval-kind.registry';

export type ApproverType = 'SUPERVISOR' | 'MANAGER' | 'HR_MANAGER' | 'ADMIN';
export type ApprovalMode = 'SEQUENTIAL' | 'PARALLEL';
type Decision = 'APPROVE' | 'REJECT';

// Re-exported so existing importers keep working; the union itself now lives
// with the per-type hooks it belongs to.
export type { ApprovalRequestType };

export interface EngineResult {
  /** Whether a configured workflow trail governs this request. */
  engaged: boolean;
  /** Whether the chain reached a terminal state on this call. */
  finalized: boolean;
  outcome?: 'APPROVED' | 'REJECTED';
  /** The step now awaiting a decision (when not finalized). */
  nextStepOrder?: number;
}

/**
 * Shared, configurable approval-hierarchy engine.
 *
 * Owns the runtime `RequestApproval` trail, per-step approver resolution,
 * eligibility enforcement, next-step notifications and per-step audit. It does
 * NOT run domain side-effects (attendance, balance deduction, pay recompute) —
 * the calling domain service does that when `finalized && outcome==='APPROVED'`.
 *
 * Engagement rule: a request is governed by the engine only when the master
 * switch `supervisor_approval_enabled` is on AND an active `ApprovalWorkflow`
 * exists for its type. Otherwise callers keep their legacy single-approver path,
 * so default behavior is unchanged until an admin configures a workflow.
 *
 * Activation modes (per workflow, chosen by the admin):
 *   SEQUENTIAL — only one step is ACTIVE at a time; step N+1 is activated only
 *                after step N's approver accepts.
 *   PARALLEL   — all steps are activated at once and approve in any order; the
 *                request finalizes when the last outstanding step approves.
 * Both modes finalize as REJECTED on the first rejection.
 */
@Injectable()
export class ApprovalEngineService {
  private readonly logger = new Logger(ApprovalEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  private async isEnabled(): Promise<boolean> {
    const s = await this.prisma.systemSetting.findUnique({
      where: { key: 'supervisor_approval_enabled' },
    });
    return s?.value === 'true';
  }

  async getActiveWorkflow(type: ApprovalRequestType) {
    return this.prisma.approvalWorkflow.findFirst({
      where: { requestType: type as any, isActive: true },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
  }

  /**
   * The employee who raised a given request. Needed wherever a trail row has to
   * be related back to its requester — `RequestApproval` stores only the
   * request id, not the requester.
   */
  private async requesterOf(
    type: ApprovalRequestType,
    requestId: string,
  ): Promise<string | null> {
    const kind = APPROVAL_KINDS[type];
    if (!kind) {
      // A trail row for a type no longer in the registry. Refusing to resolve is
      // safer than guessing: the row simply never becomes actionable.
      this.logger.warn(`No approval kind registered for type "${type}"`);
      return null;
    }
    return kind.requesterOf(this.prisma, requestId);
  }

  /** Requester identity used for approver resolution + self-approval skipping. */
  private async requesterContext(employeeId: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        fullName: true,
        departmentId: true,
        supervisorId: true,
        user: { select: { id: true } },
      },
    });
    return emp;
  }

  /**
   * Resolve the set of USER ids eligible to act at a step, given the requester.
   * Role steps (HR_MANAGER/ADMIN) resolve live; personal steps (SUPERVISOR/
   * MANAGER) resolve to the specific assignee(s).
   */
  private async resolveApprovers(
    approverType: ApproverType,
    requesterEmployeeId: string,
  ): Promise<string[]> {
    if (approverType === 'SUPERVISOR') {
      const emp = await this.prisma.employee.findUnique({
        where: { id: requesterEmployeeId },
        select: { supervisor: { select: { user: { select: { id: true } } } } },
      });
      const uid = emp?.supervisor?.user?.id;
      return uid ? [uid] : [];
    }
    if (approverType === 'MANAGER') {
      const emp = await this.prisma.employee.findUnique({
        where: { id: requesterEmployeeId },
        select: {
          department: {
            select: { manager: { select: { user: { select: { id: true } } } } },
          },
        },
      });
      const uid = emp?.department?.manager?.user?.id;
      return uid ? [uid] : [];
    }
    // Role-based pools (active users). Branch-narrowing is intentionally omitted:
    // HR/Admin are typically global-branch principals; per-step decide() still
    // enforces exact eligibility.
    const users = await this.prisma.user.findMany({
      where: { role: approverType, isActive: true },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /**
   * Materialize the trail for a newly-created request and activate the first
   * actionable step. Returns engaged=false when no workflow governs the request.
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
      data: workflow.steps.map((s) => ({
        requestType: type as any,
        requestId,
        stepOrder: s.stepOrder,
        approverType: s.approverType,
        status: 'PENDING',
      })),
    });

    const mode = ((workflow as any).mode ?? 'SEQUENTIAL') as ApprovalMode;
    const res = await this.activateFrom(
      type,
      requestId,
      requesterEmployeeId,
      1,
      mode,
    );
    await this.audit.log({
      userId: actorUserId,
      action: 'APPROVAL_INITIATED',
      resourceType: 'RequestApproval',
      resourceId: requestId,
      newData: { type, workflowId: workflow.id, mode, finalized: res.finalized },
      branchId: getBranchContext()?.effectiveBranchId ?? null,
    });
    return { engaged: true, ...res };
  }

  /**
   * Activate outstanding (PENDING) steps from `fromOrder` onward, skipping steps
   * that resolve to nobody or only to the requester (self-approval).
   *
   * SEQUENTIAL stops at the first actionable step — later steps stay PENDING
   * until that approver accepts. PARALLEL activates every actionable step.
   * Returns finalized=true when nothing outstanding remains (auto-approve).
   *
   * Only PENDING rows are considered, so already-ACTIVE or decided steps are
   * never re-activated (matters in PARALLEL, where siblings are already live).
   */
  private async activateFrom(
    type: ApprovalRequestType,
    requestId: string,
    requesterEmployeeId: string,
    fromOrder: number,
    mode: ApprovalMode = 'SEQUENTIAL',
  ): Promise<{ finalized: boolean; outcome?: 'APPROVED'; nextStepOrder?: number }> {
    const requester = await this.requesterContext(requesterEmployeeId);
    const requesterUserId = requester?.user?.id ?? null;

    const steps = await this.prisma.requestApproval.findMany({
      where: {
        requestType: type as any,
        requestId,
        stepOrder: { gte: fromOrder },
        status: 'PENDING',
      },
      orderBy: { stepOrder: 'asc' },
    });

    let firstActivated: number | undefined;

    for (const step of steps) {
      const approvers = (
        await this.resolveApprovers(step.approverType as ApproverType, requesterEmployeeId)
      ).filter((uid) => uid !== requesterUserId); // drop self-approval

      if (approvers.length === 0) {
        await this.prisma.requestApproval.update({
          where: { id: step.id },
          data: {
            status: 'SKIPPED',
            decidedAt: new Date(),
            comment: 'Auto-skipped: no eligible approver / self-approval',
          },
        });
        continue;
      }

      const resolvedApproverId =
        step.approverType === 'SUPERVISOR' ? approvers[0] : null;
      await this.prisma.requestApproval.update({
        where: { id: step.id },
        data: { status: 'ACTIVE', resolvedApproverId },
      });

      await this.notifications
        .notifyUsers(
          approvers,
          'Approval requested',
          `A ${type.toLowerCase()} request from ${requester?.fullName ?? 'an employee'} awaits your approval (step ${step.stepOrder}).`,
          'APPROVAL_REQUESTED',
          APPROVAL_KINDS[type].link,
          // WhatsApp comes free here: APPROVAL_REQUESTED is a discriminating
          // type, so the template registry selects on it without an explicit
          // key. waData only enriches the body. One block covers LEAVE,
          // OVERTIME, BANK_CHANGE, TRAVEL, TRAINING and ADVANCE_LOAN.
          {
            waData: {
              requestType: type,
              requesterName: requester?.fullName ?? 'An employee',
              stepOrder: step.stepOrder,
            },
            waDedupeKey: `approval:${type}:${requestId}:step${step.stepOrder}:requested`,
            // What the approver is being asked to decide. Carries no authority:
            // each channel mints its own single-use, identity-bound capability
            // from it, so this row is never itself a way to approve anything.
            decision: { requestType: type, requestId },
          },
        )
        .catch((e) => this.logger.error(`notify approvers failed: ${e.message}`));

      if (firstActivated === undefined) firstActivated = step.stepOrder;
      if (mode === 'SEQUENTIAL') break;
    }

    if (firstActivated !== undefined) {
      return { finalized: false, nextStepOrder: firstActivated };
    }
    return { finalized: true, outcome: 'APPROVED' };
  }

  /** Whether `user` may act on the given ACTIVE step for this requester. */
  private async isEligible(
    user: any,
    step: { approverType: string; resolvedApproverId: string | null },
    requesterEmployeeId: string,
  ): Promise<boolean> {
    if (user?.role === 'ADMIN') return true; // super-approver override
    if (step.resolvedApproverId) return user?.id === step.resolvedApproverId;
    const approvers = await this.resolveApprovers(
      step.approverType as ApproverType,
      requesterEmployeeId,
    );
    return approvers.includes(user?.id);
  }

  /**
   * Record an APPROVE/REJECT decision against the active step. Throws
   * Forbidden/BadRequest on invalid actors or state. Returns engaged=false when
   * no trail governs the request (caller uses its legacy single-approver path).
   */
  async decide(
    type: ApprovalRequestType,
    requestId: string,
    requesterEmployeeId: string,
    user: any,
    decision: Decision,
    comment?: string,
  ): Promise<EngineResult> {
    const rows = await this.prisma.requestApproval.findMany({
      where: { requestType: type as any, requestId },
      orderBy: { stepOrder: 'asc' },
    });
    if (rows.length === 0) return { engaged: false, finalized: false };

    const activeRows = rows.filter((r) => r.status === 'ACTIVE');
    if (activeRows.length === 0) {
      throw new BadRequestException('No pending approval step for this request');
    }

    // PARALLEL chains can have several live steps — act on the first one this
    // user is eligible for. SEQUENTIAL chains only ever have one.
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

    const branchId = getBranchContext()?.effectiveBranchId ?? null;

    if (decision === 'REJECT') {
      await this.prisma.requestApproval.update({
        where: { id: active.id },
        data: {
          status: 'REJECTED',
          decidedById: user.id,
          decidedAt: new Date(),
          comment: comment || null,
        },
      });
      // One rejection kills the whole chain — no sibling/later step may later
      // finalize a request that was already turned down.
      await this.prisma.requestApproval.updateMany({
        where: {
          requestType: type as any,
          requestId,
          status: { in: ['PENDING', 'ACTIVE'] },
        },
        data: {
          status: 'SKIPPED',
          decidedAt: new Date(),
          comment: `Chain closed: rejected at step ${active.stepOrder}`,
        },
      });
      await this.audit.log({
        userId: user.id,
        action: 'APPROVAL_STEP_REJECTED',
        resourceType: 'RequestApproval',
        resourceId: requestId,
        newData: { type, stepOrder: active.stepOrder, comment },
        branchId,
      });
      await this.notifyRequester(type, requesterEmployeeId, decision, active.stepOrder);
      return { engaged: true, finalized: true, outcome: 'REJECTED' };
    }

    await this.prisma.requestApproval.update({
      where: { id: active.id },
      data: {
        status: 'APPROVED',
        decidedById: user.id,
        decidedAt: new Date(),
        comment: comment || null,
      },
    });
    await this.audit.log({
      userId: user.id,
      action: 'APPROVAL_STEP_APPROVED',
      resourceType: 'RequestApproval',
      resourceId: requestId,
      newData: { type, stepOrder: active.stepOrder, comment },
      branchId,
    });
    await this.notifyRequester(type, requesterEmployeeId, decision, active.stepOrder);

    // PARALLEL: other steps may still be live — the request waits for them.
    const stillLive = activeRows.filter((r) => r.id !== active!.id);
    if (stillLive.length > 0) {
      return {
        engaged: true,
        finalized: false,
        nextStepOrder: Math.min(...stillLive.map((r) => r.stepOrder)),
      };
    }

    // SEQUENTIAL: hand off to the next outstanding step (a PARALLEL chain has no
    // PENDING rows left here, so this correctly finalizes).
    const mode = ((await this.getActiveWorkflow(type)) as any)?.mode ?? 'SEQUENTIAL';
    const res = await this.activateFrom(
      type,
      requestId,
      requesterEmployeeId,
      active.stepOrder + 1,
      mode as ApprovalMode,
    );
    return { engaged: true, ...res };
  }

  private async notifyRequester(
    type: ApprovalRequestType,
    requesterEmployeeId: string,
    decision: Decision,
    stepOrder: number,
  ) {
    const requester = await this.requesterContext(requesterEmployeeId);
    const uid = requester?.user?.id;
    if (!uid) return;
    const approved = decision === 'APPROVE';
    await this.notifications
      .notifyUser(
        uid,
        approved ? 'Approval progressed' : 'Request rejected',
        approved
          ? `Your ${type.toLowerCase()} request was approved at step ${stepOrder}.`
          : `Your ${type.toLowerCase()} request was rejected at step ${stepOrder}.`,
        approved ? 'APPROVAL_STEP_APPROVED' : 'APPROVAL_REJECTED',
        APPROVAL_KINDS[type].link,
        {
          waData: { requestType: type, stepOrder },
          waDedupeKey: `approval:${type}:${requesterEmployeeId}:step${stepOrder}:${decision}`,
        },
      )
      .catch((e) => this.logger.error(`notify requester failed: ${e.message}`));
  }

  /**
   * Terminate a request's live trail (e.g. the requester cancels). Non-terminal
   * rows become SKIPPED so no approver can later finalize a withdrawn request.
   */
  async abandon(type: ApprovalRequestType, requestId: string) {
    await this.prisma.requestApproval.updateMany({
      where: {
        requestType: type as any,
        requestId,
        status: { in: ['PENDING', 'ACTIVE'] },
      },
      data: { status: 'SKIPPED', decidedAt: new Date(), comment: 'Request cancelled' },
    });
  }

  /**
   * Whether `user` is part of this request's approval chain — an approver of
   * any step, or someone who has already decided one.
   *
   * The by-id doors need this. A SUPERVISOR holds role EMPLOYEE, owns none of
   * the requester's records and manages none of their departments, so the
   * ordinary ownership rule refuses them — which would strand every configured
   * chain at step one: the person being asked to decide could not open the
   * request.
   */
  async isChainParticipant(
    type: ApprovalRequestType,
    requestId: string,
    user: any,
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

  /** Hydrated trail for a request (UI + tooling). */
  async getTrail(type: ApprovalRequestType, requestId: string) {
    return this.prisma.requestApproval.findMany({
      where: { requestType: type as any, requestId },
      orderBy: { stepOrder: 'asc' },
    });
  }

  /**
   * The trail for one request PLUS whether `user` may act on it right now.
   *
   * `canAct` is decided with the very same `isEligible` check `decide()` runs,
   * so a screen that gates its Approve/Reject buttons on it offers the action
   * exactly when the action would succeed. Without this, screens fall back to
   * guessing from the caller's role — which silently strands the MANAGER and
   * SUPERVISOR steps of a configured chain, since neither role is the classic
   * "approver role" those screens were written for.
   *
   * `engaged: false` means no chain governs this request; callers should then
   * apply their legacy single-approver rule.
   */
  async trailFor(
    type: ApprovalRequestType,
    requestId: string,
    user: any,
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

    const activeRows = steps.filter((s) => s.status === 'ACTIVE');
    const activeStep = activeRows.length
      ? Math.min(...activeRows.map((s) => s.stepOrder))
      : null;

    const requesterEmployeeId = await this.requesterOf(type, requestId);

    // The trail names who decided what, and when. It is not public: without
    // this guard any authenticated user could read any request's approval
    // history — across branches — by walking request ids.
    if (requesterEmployeeId && user) {
      const subject = await this.prisma.employee.findUnique({
        where: { id: requesterEmployeeId },
        select: { id: true, departmentId: true, branchId: true },
      });
      if (subject) {
        // The branch envelope is a hard boundary and is checked FIRST, for
        // everyone. A role-based step (HR_MANAGER, ADMIN) resolves to every
        // active user of that role — deliberately, since those are usually
        // global principals — so treating "is a step approver" as a blanket
        // exemption would let a branch-scoped HR read a chain for an employee
        // whose own record answers 404.
        assertInBranch(subject.branchId);

        // Inside the envelope, a PARTICIPANT in the chain may read it even when
        // they own none of the record. That is the SUPERVISOR case — role
        // EMPLOYEE, no relationship to the requester — and refusing it would
        // strand every configured chain.
        //
        // Participation spans every step, not just the live one, and includes
        // steps already decided: an approver who has acted must still be able
        // to follow what happened to the request afterwards.
        let isParticipant = false;
        for (const row of steps) {
          if (row.decidedById && row.decidedById === user?.id) {
            isParticipant = true;
            break;
          }
          if (await this.isEligible(user, row, requesterEmployeeId)) {
            isParticipant = true;
            break;
          }
        }
        if (!isParticipant) {
          assertCanAccessEmployeeRecord(user, subject);
        }
      }
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
   * Active steps the given user may act on. Precise per-step eligibility is
   * re-checked in decide(); this is the queue view. SUPERVISOR steps match by
   * snapshot; role steps match by role; ADMIN sees all.
   */
  async pendingForUser(user: any) {
    const active = await this.prisma.requestApproval.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    if (user?.role === 'ADMIN') return active;

    const mine = active.filter((r) => {
      if (r.resolvedApproverId) return r.resolvedApproverId === user?.id;
      return r.approverType === user?.role;
    });

    // A MANAGER step means "the head of the requester's department", not "any
    // user with the MANAGER role" — matching on role alone would put every
    // other department's requests in this manager's queue.
    const managerRows = mine.filter((r) => r.approverType === 'MANAGER');
    // The branch narrowing has to happen on THIS path too — a queue made only
    // of role steps (HR_MANAGER, ADMIN) is exactly the case that leaked.
    if (managerRows.length === 0) return this.narrowToBranch(mine);

    const managedDepartmentIds = new Set(
      (
        await this.prisma.department.findMany({
          where: { managerId: user?.employeeId ?? '' },
          select: { id: true },
        })
      ).map((d) => d.id),
    );

    const requesterDeptByRequestId = new Map<string, string | null>();
    for (const row of managerRows) {
      const employeeId = await this.requesterOf(
        row.requestType as ApprovalRequestType,
        row.requestId,
      );
      const emp = employeeId
        ? await this.prisma.employee.findUnique({
            where: { id: employeeId },
            select: { departmentId: true },
          })
        : null;
      requesterDeptByRequestId.set(row.requestId, emp?.departmentId ?? null);
    }

    const scoped = mine.filter((r) => {
      if (r.approverType !== 'MANAGER') return true;
      const deptId = requesterDeptByRequestId.get(r.requestId);
      return !!deptId && managedDepartmentIds.has(deptId);
    });

    return this.narrowToBranch(scoped);
  }

  /**
   * Drop rows whose requester sits outside the caller's branch envelope.
   *
   * Role steps are resolved by ROLE alone, deliberately — HR and Admin are
   * usually global principals. But a branch-scoped HR_MANAGER is not, and
   * without this the queue listed steps for employees whose records they cannot
   * open, while `/inbox` filtered exactly those rows out at hydration. The two
   * doors disagreed about the same row.
   */
  private async narrowToBranch<T extends { requestType: string; requestId: string }>(
    rows: T[],
  ): Promise<T[]> {
    const envelope = getEnvelopeBranchIds();
    if (envelope === null || rows.length === 0) return rows;
    const allowed = new Set(envelope);

    const keep: T[] = [];
    for (const row of rows) {
      const employeeId = await this.requesterOf(
        row.requestType as ApprovalRequestType,
        row.requestId,
      );
      if (!employeeId) continue;
      const emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { branchId: true },
      });
      // A company-wide (null-branch) employee is not "another branch's" data,
      // but a scoped caller stays fail-closed — the same rule assertInBranch
      // applies.
      if (emp?.branchId && allowed.has(emp.branchId)) keep.push(row);
    }
    return keep;
  }

  /**
   * Whether this user can ever be asked to approve something under the current
   * configuration — not just right now. Drives navigation visibility, which must
   * stay stable when the inbox happens to be empty.
   *
   * True when an active chain contains a step this user can fill (HR by role,
   * MANAGER by heading a department, SUPERVISOR by having supervisees), or when
   * they already have live steps waiting.
   *
   * ADMIN is excluded on purpose: as the super-approver they can act on any step
   * from the domain screens (Leaves/Overtime), so an inbox listing every request
   * in the system is noise rather than a queue.
   */
  async canApprove(user: any): Promise<{ isApprover: boolean; pending: number }> {
    if (user?.role === 'ADMIN') return { isApprover: false, pending: 0 };

    const pending = (await this.pendingForUser(user)).length;
    if (pending > 0) return { isApprover: true, pending };

    if (!(await this.isEnabled())) return { isApprover: false, pending };

    const workflows = await this.prisma.approvalWorkflow.findMany({
      where: { isActive: true },
      include: { steps: true },
    });
    const stepTypes = new Set(
      workflows.flatMap((w) => w.steps.map((s) => s.approverType as string)),
    );
    if (stepTypes.size === 0) return { isApprover: false, pending };

    if (stepTypes.has(user?.role)) return { isApprover: true, pending };

    if (stepTypes.has('MANAGER') && user?.employeeId) {
      const heads = await this.prisma.department.count({
        where: { managerId: user.employeeId },
      });
      if (heads > 0) return { isApprover: true, pending };
    }
    if (stepTypes.has('SUPERVISOR') && user?.employeeId) {
      const supervisees = await this.prisma.employee.count({
        where: { supervisorId: user.employeeId },
      });
      if (supervisees > 0) return { isApprover: true, pending };
    }
    return { isApprover: false, pending };
  }

  /**
   * The user's approval inbox — active steps they may act on, hydrated with the
   * underlying leave/overtime request + employee, and only for requests still
   * PENDING (cancelled/finalized are excluded). Drives the supervisor's
   * "Approvals" screen.
   */
  async inboxForUser(user: any) {
    const rows = await this.pendingForUser(user);

    // Group the trail rows by type, then let each registered kind hydrate its
    // own ids. One query per type present in the queue — types with no waiting
    // rows are never touched.
    const idsByType = new Map<ApprovalRequestType, string[]>();
    for (const row of rows) {
      const type = row.requestType as ApprovalRequestType;
      if (!APPROVAL_KINDS[type]) {
        this.logger.warn(`No approval kind registered for type "${type}"`);
        continue;
      }
      const bucket = idsByType.get(type);
      if (bucket) bucket.push(row.requestId);
      else idsByType.set(type, [row.requestId]);
    }

    const hydrated = await Promise.all(
      [...idsByType.entries()].map(async ([type, ids]) => {
        const requests = await APPROVAL_KINDS[type].hydrate(this.prisma, ids);
        return [type, new Map(requests.map((r) => [r.id, r] as const))] as const;
      }),
    );
    const byType = new Map(hydrated);

    const items = rows
      .map((r) => {
        const type = r.requestType as ApprovalRequestType;
        // Absent => the request is no longer pending (or its kind is gone).
        const req = byType.get(type)?.get(r.requestId);
        if (!req) return null;
        return {
          requestType: r.requestType,
          requestId: r.requestId,
          stepOrder: r.stepOrder,
          approverType: r.approverType,
          request: req,
        };
      })
      .filter(Boolean);

    return { success: true, data: items };
  }

  /**
   * The requests this user has already decided.
   *
   * The inbox is a QUEUE: a row leaves it the moment it is acted on, which is
   * correct for "what still needs me" and wrong for "what did I decide". An
   * approver who has just approved something had no way to see it again — the
   * card simply vanished, and with it any record of the correction they made
   * on the way through.
   *
   * Keyed on `decidedById`, not on eligibility: a supervisor's record is what
   * THEY did, and it must survive them later losing the step (a reassignment,
   * a workflow edit) that let them do it.
   */
  async historyForUser(user: any, limit = 50) {
    if (!user?.id) return { success: true, data: [] };

    const rows = await this.prisma.requestApproval.findMany({
      where: {
        decidedById: user.id,
        status: { in: ['APPROVED', 'REJECTED'] },
      },
      orderBy: { decidedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    if (rows.length === 0) return { success: true, data: [] };

    const idsByType = new Map<ApprovalRequestType, string[]>();
    for (const row of rows) {
      const type = row.requestType as ApprovalRequestType;
      if (!APPROVAL_KINDS[type]) {
        this.logger.warn(`No approval kind registered for type "${type}"`);
        continue;
      }
      const bucket = idsByType.get(type);
      if (bucket) bucket.push(row.requestId);
      else idsByType.set(type, [row.requestId]);
    }

    const hydrated = await Promise.all(
      [...idsByType.entries()].map(async ([type, ids]) => {
        // anyStatus: these rows are decided by definition. Hydrating them
        // pending-only is how a history renders permanently empty.
        const requests = await APPROVAL_KINDS[type].hydrate(this.prisma, ids, {
          anyStatus: true,
        });
        return [type, new Map(requests.map((r) => [r.id, r] as const))] as const;
      }),
    );
    const byType = new Map(hydrated);

    const items = rows
      .map((r) => {
        const type = r.requestType as ApprovalRequestType;
        // Absent => the domain row was deleted since. Dropped rather than
        // rendered as a card with nothing on it.
        const req = byType.get(type)?.get(r.requestId);
        if (!req) return null;
        return {
          requestType: r.requestType,
          requestId: r.requestId,
          stepOrder: r.stepOrder,
          approverType: r.approverType,
          /** What THIS user did, which is not the request's final status. */
          decision: r.status,
          decidedAt: r.decidedAt,
          comment: r.comment,
          request: req,
        };
      })
      .filter(Boolean);

    // Branch envelope, same rule the queue applies.
    return { success: true, data: await this.narrowToBranch(items as any[]) };
  }
}
