import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import {
  CreateChangeRequestDto,
  ChangeRequestType,
} from './dto/create-change-request.dto';
import {
  ReviewChangeRequestDto,
  ReviewAction,
} from './dto/review-change-request.dto';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { DepartmentsService } from './departments.service';
import { demoteIfHeadsNothing } from './manager-role.util';
import { getEnvelopeBranchIds } from '../common/branch/branch-scope.util';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/dto/create-notification.dto';

@Injectable()
export class DepartmentChangeRequestsService {
  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
    private settingsService: SystemSettingsService,
    private departmentsService: DepartmentsService,
    private notifications: NotificationsService,
  ) {}

  /**
   * A change request carries no branch of its own, so its reach is the reach of
   * the department it is about: the branches that department's staff sit in. A
   * department with nobody in it belongs to no branch in particular and stays
   * visible to everyone, which is what keeps a freshly created one usable.
   *
   * Global callers are unaffected. Without this, a branch-scoped HR manager
   * could review a change of head for a department staffed entirely in a branch
   * they have no access to.
   */
  private async assertDepartmentInBranchScope(departmentId: string) {
    const envelope = getEnvelopeBranchIds();
    if (envelope === null) return;

    // Deliberately outside branch scoping. These two counts are the check
    // ITSELF: read through the scoping middleware, the second one can only ever
    // see the caller's own branches, so a department staffed entirely elsewhere
    // reads as "nobody in it" and sails through.
    const { inScope, anyStaff } = await runWithBranchBypass(async () => ({
      inScope: await this.prisma.employee.count({
        where: { departmentId, branchId: { in: envelope } },
      }),
      anyStaff: await this.prisma.employee.count({ where: { departmentId } }),
    }));

    if (inScope > 0) return;
    if (anyStaff === 0) return;

    throw new ForbiddenException(
      'This department belongs to a branch you do not have access to.',
    );
  }

  async create(
    departmentId: string,
    userId: string,
    dto: CreateChangeRequestDto,
  ) {
    // Validate department exists
    const department = await this.prisma.department.findUnique({
      where: { id: departmentId },
      include: {
        manager: true,
        parent: true,
        _count: { select: { employees: true } },
      },
    });

    if (!department) {
      throw new NotFoundException('Department not found');
    }

    // Lookup user to check role
    const requester = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    const bypassTenure =
      requester?.role === 'ADMIN' || requester?.role === 'HR_MANAGER';

    let effectiveDate = new Date();
    if (dto.effectiveDate) {
      const parsedDate = new Date(dto.effectiveDate);
      if (!isNaN(parsedDate.getTime())) {
        effectiveDate = parsedDate;
      }
    }

    // RESTRUCTURE has no field on the DTO that could describe a restructure,
    // and nothing in applyApprovedChange that could carry one out — so a
    // request of this type reached APPROVED and changed nothing, leaving the
    // reader believing a restructure had happened. Refused at the door until it
    // means something.
    if (dto.requestType === ChangeRequestType.RESTRUCTURE) {
      throw new BadRequestException(
        'RESTRUCTURE requests are not supported yet. Raise a manager or parent change instead.',
      );
    }

    // Validate based on request type
    if (dto.requestType === ChangeRequestType.CHANGE_MANAGER) {
      // Check manager eligibility if a new manager is specified
      if (dto.newManagerId) {
        const eligibility = await this.checkManagerEligibility(
          dto.newManagerId,
          departmentId,
          bypassTenure,
        );
        if (!eligibility.eligible) {
          throw new BadRequestException(
            `Manager not eligible: ${eligibility.reasons.join(', ')}`,
          );
        }
      }
    }

    if (dto.requestType === ChangeRequestType.CHANGE_PARENT) {
      if (!dto.newParentId) {
        throw new BadRequestException(
          'New parent ID is required for CHANGE_PARENT request',
        );
      }

      // Validate parent
      const newParent = await this.prisma.department.findUnique({
        where: { id: dto.newParentId },
      });

      if (!newParent) {
        throw new BadRequestException('New parent department not found');
      }

      if (newParent.parentId) {
        throw new BadRequestException(
          'Cannot set parent to a child department (max 2 levels)',
        );
      }
    }

    // Prepare newData based on request type
    let newData: any = undefined;
    if (dto.requestType === ChangeRequestType.CHANGE_MANAGER) {
      newData = { managerId: dto.newManagerId };
    } else if (dto.requestType === ChangeRequestType.CHANGE_PARENT) {
      newData = { parentId: dto.newParentId };
    }

    // "One open request per department" used to be a read followed by a write,
    // which two concurrent raises pass together — and two reviewers then approve
    // conflicting heads for the same department. Taking a row lock on the
    // department first makes the pair serialize: the second transaction reads
    // the first one's request and refuses.
    const changeRequest = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM departments WHERE id = ${departmentId}::uuid FOR UPDATE`;

      const pendingRequest = await tx.departmentChangeRequest.findFirst({
        where: { departmentId, status: 'PENDING' },
      });
      if (pendingRequest) {
        throw new BadRequestException(
          'There is already a pending change request for this department',
        );
      }

      return tx.departmentChangeRequest.create({
        data: {
          departmentId,
          requestType: dto.requestType,
          requestedBy: userId,
          oldManagerId: department.managerId,
          oldParentId: department.parentId,
          oldData: {
            code: department.code,
            name: department.name,
            description: department.description,
          },
          newManagerId: dto.newManagerId,
          newParentId: dto.newParentId,
          newData,
          reason: dto.reason,
          effectiveDate,
        },
        include: {
          department: true,
          requester: {
            include: { employee: true },
          },
          oldManager: true,
          newManager: true,
        },
      });
    });

    // Send notification to HR/Admin
    await this.notifyApprovers(changeRequest);

    return {
      success: true,
      message: 'Change request created successfully',
      data: changeRequest,
    };
  }

  async findAll(filters?: { status?: string; departmentId?: string }) {
    const where: any = {};

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.departmentId) {
      where.departmentId = filters.departmentId;
    }

    // Same reach as the detail and the review: a scoped caller sees requests for
    // departments staffed in their branches, plus departments with nobody in
    // them (which belong to no branch in particular). Written as an explicit
    // predicate and run with scoping bypassed, because the nested employee
    // filter is the check ITSELF — read through the middleware it could only
    // ever see the caller's own branches and would answer "no staff" for every
    // department elsewhere.
    const envelope = getEnvelopeBranchIds();
    if (envelope !== null) {
      where.department = {
        OR: [
          { employees: { some: { branchId: { in: envelope } } } },
          { employees: { none: {} } },
        ],
      };
    }

    const requests = await runWithBranchBypass(() =>
      this.prisma.departmentChangeRequest.findMany({
        where,
        include: {
          department: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
          requester: {
            select: {
              id: true,
              email: true,
              employee: {
                select: {
                  id: true,
                  fullName: true,
                  employeeCode: true,
                },
              },
            },
          },
          reviewer: {
            select: {
              id: true,
              email: true,
              employee: {
                select: {
                  id: true,
                  fullName: true,
                  employeeCode: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );

    return {
      success: true,
      data: requests,
    };
  }

  async findOne(id: string, actor?: any) {
    const request = await this.prisma.departmentChangeRequest.findUnique({
      where: { id },
      include: {
        department: {
          include: {
            _count: { select: { employees: true } },
          },
        },
        requester: {
          include: { employee: true },
        },
        reviewer: {
          include: { employee: true },
        },
        oldManager: true,
        newManager: true,
        oldParent: true,
        newParent: true,
      },
    });

    if (!request) {
      throw new NotFoundException('Change request not found');
    }

    // A MANAGER may read a request about a department they head, and no other —
    // the same rule GET /departments/:id applies right beside this one. Without
    // it, any manager could read any department's headcount and pending-approval
    // figures through the impact panel.
    if (
      actor?.role === 'MANAGER' &&
      !isDeptInManagerScope(actor, request.departmentId)
    ) {
      throw new ForbiddenException(
        'You do not have permission to view other departments.',
      );
    }
    await this.assertDepartmentInBranchScope(request.departmentId);

    // Get impact analysis
    const impact = await this.analyzeImpact(request.departmentId, request);

    return {
      success: true,
      data: {
        ...request,
        impact,
      },
    };
  }

  async review(id: string, actor: any, dto: ReviewChangeRequestDto) {
    const userId: string = actor?.id;
    const request = await this.prisma.departmentChangeRequest.findUnique({
      where: { id },
      include: {
        department: true,
        requester: { include: { employee: true } },
        oldManager: true,
        newManager: { include: { user: true } },
      },
    });

    if (!request) {
      throw new NotFoundException('Change request not found');
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException('Change request has already been reviewed');
    }

    // Whoever asked for the change does not get to grant it. Leave, overtime
    // and reimbursement have always refused self-approval; this flow decides who
    // holds managerial authority, so it is the last one that should not.
    if (request.requestedBy === userId) {
      throw new ForbiddenException(
        'You cannot review a change request you raised yourself.',
      );
    }

    await this.assertDepartmentInBranchScope(request.departmentId);

    const newStatus =
      dto.action === ReviewAction.APPROVE ? 'APPROVED' : 'REJECTED';

    // Apply BEFORE recording the decision. The rules can still refuse at this
    // point — a request raised when it was legal may have been overtaken by
    // other changes to the tree — and a request that could not be applied must
    // not be left sitting in APPROVED as though it had been.
    if (dto.action === ReviewAction.APPROVE) {
      await this.applyApprovedChange(request, userId);
    }

    const updated = await this.prisma.departmentChangeRequest.update({
      where: { id },
      data: {
        status: newStatus,
        reviewedBy: userId,
        reviewedAt: new Date(),
        reviewNote: dto.reviewNote,
      },
      include: {
        department: true,
        requester: { include: { employee: true } },
        reviewer: { include: { employee: true } },
        oldManager: true,
        newManager: { include: { user: true } },
      },
    });

    // Send notifications
    await this.notifyReviewDecision(updated);

    return {
      success: true,
      message: `Change request ${newStatus.toLowerCase()} successfully`,
      data: updated,
    };
  }

  /**
   * Withdraws a request that has not been decided yet.
   *
   * `CANCELLED` has existed in the schema and in both status badges since the
   * feature shipped, and nothing could reach it: the only caller was a frontend
   * method PATCHing a route no controller declared. A raiser who changes their
   * mind had to ask someone else to reject their own request — or leave it open,
   * blocking every later request for that department.
   */
  async cancel(id: string, actor: any) {
    const request = await this.prisma.departmentChangeRequest.findUnique({
      where: { id },
    });

    if (!request) {
      throw new NotFoundException('Change request not found');
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException(
        'Only a pending change request can be cancelled',
      );
    }

    const isReviewer = actor?.role === 'ADMIN' || actor?.role === 'HR_MANAGER';
    if (!isReviewer && request.requestedBy !== actor?.id) {
      throw new ForbiddenException(
        'You can only cancel a change request you raised yourself.',
      );
    }

    if (
      actor?.role === 'MANAGER' &&
      !isDeptInManagerScope(actor, request.departmentId)
    ) {
      throw new ForbiddenException(
        'You do not have permission to view other departments.',
      );
    }
    await this.assertDepartmentInBranchScope(request.departmentId);

    const updated = await this.prisma.departmentChangeRequest.update({
      where: { id },
      data: { status: 'CANCELLED', reviewedAt: new Date() },
      include: { department: true },
    });

    return {
      success: true,
      message: 'Change request cancelled successfully',
      data: updated,
    };
  }

  private async applyApprovedChange(request: any, userId: string) {
    if (request.requestType === ChangeRequestType.CHANGE_MANAGER) {
      if (request.newManagerId) {
        // Create manager transition
        const transitionDaysStr = await this.settingsService.getSetting(
          'dept_manager_transition_days',
          '14',
        );
        const parsedDays = parseInt(transitionDaysStr, 10);
        const transitionDays = isNaN(parsedDays) ? 14 : Math.max(0, parsedDays);

        const targetEndDate = new Date(request.effectiveDate);
        targetEndDate.setDate(targetEndDate.getDate() + transitionDays);

        await this.prisma.managerTransition.create({
          data: {
            departmentId: request.departmentId,
            changeRequestId: request.id,
            oldManagerId: request.oldManagerId,
            newManagerId: request.newManagerId,
            status: 'INITIATED',
            targetEndDate,
            handoverTasks: this.getDefaultHandoverTasks(),
          },
        });
      }

      // Update department manager immediately
      await this.prisma.department.update({
        where: { id: request.departmentId },
        data: { managerId: request.newManagerId || null },
      });

      // Log history
      await this.logHistory({
        departmentId: request.departmentId,
        changeType: 'MANAGER_CHANGED',
        changedBy: userId,
        oldValue: { managerId: request.oldManagerId },
        newValue: { managerId: request.newManagerId },
        changeReason: request.reason,
      });

      // Update user role if needed
      if (
        request.newManager?.user &&
        request.newManager.user.role === 'EMPLOYEE'
      ) {
        await this.prisma.user.update({
          where: { id: request.newManager.user.id },
          data: { role: 'MANAGER' },
        });
      }

      // Demote the outgoing head if this was the last department they ran. Same
      // rule as an ordinary department delete, so it lives in one place.
      await demoteIfHeadsNothing(this.prisma, request.oldManagerId);
    }

    if (request.requestType === ChangeRequestType.CHANGE_PARENT) {
      // Through DepartmentsService, not a bare write: every hierarchy rule —
      // the two-level cap from both sides, the has-employees and has-children
      // guards, the cycle check — has to hold at the moment the change is
      // APPLIED, not only when it was proposed. A request raised while legal and
      // approved a week later used to build a tree the API refuses to create
      // directly.
      await this.departmentsService.update(request.departmentId, {
        parentId: request.newParentId,
      });

      await this.logHistory({
        departmentId: request.departmentId,
        changeType: 'PARENT_CHANGED',
        changedBy: userId,
        oldValue: { parentId: request.oldParentId },
        newValue: { parentId: request.newParentId },
        changeReason: request.reason,
      });
    }
  }

  private async checkManagerEligibility(
    employeeId: string,
    _departmentId: string,
    bypassTenure = false,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      include: {
        user: true,
      },
    });

    if (!employee) {
      return { eligible: false, reasons: ['Employee not found'] };
    }

    const reasons: string[] = [];

    // Check 1: Must be ACTIVE
    if (employee.status !== 'ACTIVE') {
      reasons.push('Employee must be ACTIVE');
    }

    // A manager may head more than one department, so managing another active
    // department is no longer a disqualifier.

    // Check 2: Minimum tenure (configured from settings, default: 6 months)
    if (!bypassTenure) {
      const minTenureStr = await this.settingsService.getSetting(
        'dept_manager_min_tenure_months',
        '6',
      );
      const parsedTenure = parseInt(minTenureStr, 10);
      const minTenure = isNaN(parsedTenure) ? 6 : Math.max(0, parsedTenure);

      const tenureMonths = Math.floor(
        (Date.now() - employee.startDate.getTime()) /
          (1000 * 60 * 60 * 24 * 30),
      );
      if (tenureMonths < minTenure) {
        reasons.push(
          `Minimum tenure is ${minTenure} months (current: ${tenureMonths} months)`,
        );
      }
    }

    return {
      eligible: reasons.length === 0,
      reasons,
    };
  }

  private async analyzeImpact(departmentId: string, request: any) {
    const department = await this.prisma.department.findUnique({
      where: { id: departmentId },
      include: {
        _count: {
          select: {
            employees: true,
            children: true,
          },
        },
      },
    });

    // Count pending approvals
    const [pendingLeaves, pendingOvertime] = await Promise.all([
      this.prisma.leaveRequest.count({
        where: {
          employee: { departmentId },
          status: 'PENDING',
        },
      }),
      this.prisma.overtimeRequest.count({
        where: {
          employee: { departmentId },
          status: 'PENDING',
        },
      }),
    ]);

    const transitionDaysStr = await this.settingsService.getSetting(
      'dept_manager_transition_days',
      '14',
    );
    const parsedDays = parseInt(transitionDaysStr, 10);
    const transitionDays = isNaN(parsedDays) ? 14 : Math.max(0, parsedDays);

    return {
      affectedEmployees: department?._count.employees || 0,
      affectedTeams: department?._count.children || 0,
      pendingApprovals: {
        leaves: pendingLeaves,
        overtime: pendingOvertime,
      },
      estimatedTransitionDays: transitionDays,
    };
  }

  private getDefaultHandoverTasks() {
    return [
      { id: 1, title: 'Handover management documents', completed: false },
      { id: 2, title: 'Introduce team members', completed: false },
      { id: 3, title: 'Handover ongoing projects', completed: false },
      { id: 4, title: 'Update system access permissions', completed: false },
      { id: 5, title: 'Handover meeting with HR', completed: false },
    ];
  }

  private async logHistory(data: {
    departmentId: string;
    changeType: string;
    changedBy: string;
    oldValue: any;
    newValue: any;
    changeReason: string;
  }) {
    await this.prisma.departmentHistory.create({
      data,
    });
  }

  /** Human label for a request type, for a notification body. */
  private describeRequestType(requestType: string): string {
    switch (requestType) {
      case ChangeRequestType.CHANGE_MANAGER:
        return 'a change of head';
      case ChangeRequestType.CHANGE_PARENT:
        return 'a change of reporting line';
      default:
        return 'a change';
    }
  }

  /** Best available name for whoever raised the request. */
  private requesterName(request: any): string {
    return (
      request?.requester?.employee?.fullName ??
      request?.requester?.email ??
      'Someone'
    );
  }

  /**
   * Tell the people who can decide this request that it is waiting.
   *
   * R18: both notifiers were `console.log` stubs, so a request that
   * reorganises the company hierarchy sat in a queue nobody was told about and
   * its raiser never learned the outcome — while every other request-shaped
   * flow in the app (letters, leave, loans, travel) writes a real Notification
   * row. Same shape as `LettersService.notifyHr`: one row per recipient, each
   * failure swallowed, because the request has already committed and a
   * notification outage must not turn a successful raise into a 500.
   *
   * TODO: email delivery is still owed. `MailService` is injected for it and
   * nothing calls it yet; the in-app half below is implemented.
   */
  private async notifyApprovers(request: any) {
    // Whoever raised it may not review it (`review()` refuses self-approval),
    // so telling them it is waiting for them would be noise.
    const approvers = await this.prisma.user.findMany({
      where: {
        role: { in: ['HR_MANAGER', 'ADMIN'] },
        isActive: true,
        id: { not: request.requestedBy },
      },
      select: { id: true },
    });

    const title = 'Department change request awaiting review';
    const message =
      `${this.requesterName(request)} requested ` +
      `${this.describeRequestType(request.requestType)} for ` +
      `${request.department?.name ?? 'a department'}.`;

    await Promise.all(
      approvers.map((approver) =>
        this.notifications
          .create({
            userId: approver.id,
            title,
            message,
            type: NotificationType.INFO,
            link: '/dashboard/departments/change-requests',
          })
          .catch(() => undefined),
      ),
    );
  }

  /**
   * Tell the raiser what was decided. Linked to the request itself rather than
   * the queue, because the reviewer's note is on the detail screen.
   *
   * TODO: the old and new managers are still told nothing. They are affected
   * rather than waiting on anything, so this is a product call about how loud
   * a reorganisation should be, not a missing half of the flow above.
   */
  private async notifyReviewDecision(request: any) {
    const approved = request.status === 'APPROVED';
    const outcome = approved ? 'approved' : 'rejected';

    if (!request.requestedBy) return;

    const note = (request.reviewNote ?? '').trim();
    await this.notifications
      .create({
        userId: request.requestedBy,
        title: `Department change request ${outcome}`,
        message:
          `Your request for ${this.describeRequestType(request.requestType)} ` +
          `for ${request.department?.name ?? 'a department'} was ${outcome}` +
          (note ? `: ${note}` : '.'),
        type: approved ? NotificationType.SUCCESS : NotificationType.WARNING,
        link: `/dashboard/departments/change-requests/${request.id}`,
      })
      .catch(() => undefined);
  }
}
