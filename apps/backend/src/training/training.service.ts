import {
  BadRequestException,
  ConflictException,
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
import { BudgetCommitmentService } from '../budgets/budget-commitment.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { getBranchContext } from '../common/branch/branch-context';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { CreateCourseDto } from './dto/create-course.dto';
import { CreateSessionDto } from './dto/create-session.dto';
import { NominateDto } from './dto/nominate.dto';
import { DecideNominationDto } from './dto/decide-nomination.dto';
import { RecordAttendanceDto } from './dto/record-attendance.dto';

const TRAINING_EXPENSE_TYPE = 'Training';
const TRAINING_BUDGET_CATEGORY = 'Training';

@Injectable()
export class TrainingService {
  private readonly logger = new Logger(TrainingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SystemSettingsService,
    private readonly engine: ApprovalEngineService,
    private readonly reimbursements: ReimbursementsService,
    private readonly budget: BudgetCommitmentService,
  ) {}

  private readonly nominationInclude = {
    employee: {
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        departmentId: true,
        branchId: true,
        department: { select: { id: true, name: true } },
        user: { select: { id: true } },
      },
    },
    session: {
      include: {
        course: {
          select: {
            id: true,
            code: true,
            title: true,
            category: true,
            certValidMonths: true,
          },
        },
      },
    },
  };

  // ── Course catalogue ──────────────────────────────────────────────────────

  async createCourse(dto: CreateCourseDto, userId: string) {
    try {
      const course = await this.prisma.course.create({ data: { ...dto } });
      await this.audit.log({
        userId,
        action: 'COURSE_CREATED',
        resourceType: 'Course',
        resourceId: course.id,
        newData: { code: course.code, title: course.title },
      });
      return { success: true, data: course };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Course code "${dto.code}" already exists`);
      }
      throw e;
    }
  }

  async listCourses(activeOnly = false) {
    const data = await this.prisma.course.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: { title: 'asc' },
    });
    return { success: true, data };
  }

  async updateCourse(id: string, dto: Partial<CreateCourseDto>, userId: string) {
    const existing = await this.prisma.course.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Course not found');
    const course = await this.prisma.course.update({ where: { id }, data: dto });
    await this.audit.log({
      userId,
      action: 'COURSE_UPDATED',
      resourceType: 'Course',
      resourceId: id,
      newData: dto as any,
    });
    return { success: true, data: course };
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async createSession(dto: CreateSessionDto, userId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: dto.courseId },
      select: { id: true, defaultCost: true },
    });
    if (!course) throw new NotFoundException('Course not found');

    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);
    if (endDate < startDate) {
      throw new BadRequestException('Session end date cannot be before its start');
    }

    const session = await this.prisma.trainingSession.create({
      data: {
        courseId: dto.courseId,
        branchId: dto.branchId ?? null,
        startDate,
        endDate,
        location: dto.location ?? null,
        trainer: dto.trainer ?? null,
        seats: dto.seats ?? null,
        // Fall back to the course's default so a session always has a cost to
        // snapshot onto its nominations.
        costPerSeat: dto.costPerSeat ?? course.defaultCost ?? null,
      },
      include: { course: true },
    });

    await this.audit.log({
      userId,
      action: 'TRAINING_SESSION_CREATED',
      resourceType: 'TrainingSession',
      resourceId: session.id,
      newData: { courseId: dto.courseId, startDate: dto.startDate },
      branchId: dto.branchId ?? null,
    });
    return { success: true, data: session };
  }

  async listSessions(params: { status?: string; from?: string; to?: string } = {}) {
    const where: Prisma.TrainingSessionWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.from || params.to) {
      where.startDate = {
        ...(params.from ? { gte: new Date(params.from) } : {}),
        ...(params.to ? { lte: new Date(params.to) } : {}),
      };
    }
    const data = await this.prisma.trainingSession.findMany({
      where,
      include: {
        course: true,
        branch: { select: { id: true, name: true } },
        _count: {
          select: { nominations: { where: { status: { in: ['APPROVED', 'ATTENDED'] } } } },
        },
      },
      orderBy: { startDate: 'desc' },
    });
    return { success: true, data };
  }

  // ── Nominations ───────────────────────────────────────────────────────────

  async nominate(dto: NominateDto, user: any) {
    const [session, employee] = await Promise.all([
      this.prisma.trainingSession.findUnique({
        where: { id: dto.sessionId },
        include: { course: true },
      }),
      this.prisma.employee.findUnique({
        where: { id: dto.employeeId },
        select: {
          id: true,
          fullName: true,
          branchId: true,
          status: true,
          departmentId: true,
          user: { select: { id: true } },
        },
      }),
    ]);
    if (!session) throw new NotFoundException('Training session not found');
    if (!employee) throw new NotFoundException('Employee not found');
    assertInBranch(employee.branchId);

    if (['CANCELLED', 'COMPLETED'].includes(session.status)) {
      throw new BadRequestException(
        `Cannot nominate to a ${session.status.toLowerCase()} session`,
      );
    }
    if (employee.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Cannot nominate an employee with status ${employee.status}`,
      );
    }

    // Duplicate check BEFORE the seat cap: on a full session the unique
    // constraint would otherwise be reported as "session full", which sends the
    // nominator looking for a seat that this employee already holds.
    const existing = await this.prisma.trainingNomination.findUnique({
      where: {
        sessionId_employeeId: {
          sessionId: dto.sessionId,
          employeeId: dto.employeeId,
        },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      throw new ConflictException(
        `This employee is already nominated for this session (${existing.status.toLowerCase()})`,
      );
    }

    // Seat capacity, counted against seats actually committed.
    if (session.seats !== null) {
      const taken = await this.prisma.trainingNomination.count({
        where: { sessionId: dto.sessionId, status: { in: ['APPROVED', 'ATTENDED'] } },
      });
      if (taken >= session.seats) {
        throw new BadRequestException(
          `This session is full (${session.seats} seat(s))`,
        );
      }
    }

    let nomination;
    try {
      nomination = await this.prisma.trainingNomination.create({
        data: {
          sessionId: dto.sessionId,
          employeeId: dto.employeeId,
          nominatedById: user.id,
          source: dto.source ?? 'MANUAL',
          appraisalResultId: dto.appraisalResultId ?? null,
          justification: dto.justification ?? null,
          // Snapshot, for the same reason travel snapshots its per-diem.
          cost: session.costPerSeat,
          status: 'PENDING',
        },
        include: this.nominationInclude,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'This employee is already nominated for this session',
        );
      }
      throw e;
    }

    await this.audit.log({
      userId: user.id,
      action: 'TRAINING_NOMINATED',
      resourceType: 'TrainingNomination',
      resourceId: nomination.id,
      newData: {
        employeeId: dto.employeeId,
        course: session.course.title,
        source: dto.source ?? 'MANUAL',
      },
      branchId: employee.branchId,
    });

    const init = await this.engine.initiate(
      'TRAINING',
      nomination.id,
      dto.employeeId,
      user.id,
    );
    if (!init.engaged || init.finalized) {
      return this.applyApproved(nomination.id, user.id);
    }

    return {
      success: true,
      message: 'Nomination submitted for approval.',
      data: nomination,
    };
  }

  async decide(
    id: string,
    user: any,
    decision: 'APPROVE' | 'REJECT',
    dto: DecideNominationDto = {},
  ) {
    const nomination = await this.getNominationOrThrow(id);
    if (nomination.status !== 'PENDING') {
      throw new BadRequestException(
        `Cannot decide a ${nomination.status.toLowerCase()} nomination`,
      );
    }

    const result = await this.engine.decide(
      'TRAINING',
      id,
      nomination.employeeId,
      user,
      decision,
      dto.remarks,
    );

    if (!result.engaged) {
      await this.assertLegacyApprover(user, nomination.employee.departmentId);
    }

    if (decision === 'REJECT' && (!result.engaged || result.finalized)) {
      return this.applyRejected(id, user.id, dto.remarks);
    }
    if (decision === 'APPROVE' && (!result.engaged || result.finalized)) {
      return this.applyApproved(id, user.id, dto.remarks);
    }

    return {
      success: true,
      message: 'Decision recorded. Awaiting the next approval step.',
      data: { id, status: 'PENDING' },
    };
  }

  private async assertLegacyApprover(user: any, departmentId: string | null) {
    const raw = await this.settings.getSetting(
      'training_approver_roles',
      'HR_MANAGER,ADMIN',
    );
    const roles = raw.split(',').map((r) => r.trim()).filter(Boolean);
    if (!roles.includes(user?.role)) {
      throw new ForbiddenException(
        'Your role is not configured to approve training nominations',
      );
    }
    if (user.role === 'MANAGER' && !isDeptInManagerScope(user, departmentId ?? '')) {
      throw new ForbiddenException(
        'You can only review nominations from your own department',
      );
    }
  }

  private async getNominationOrThrow(id: string) {
    const nomination = await this.prisma.trainingNomination.findUnique({
      where: { id },
      include: this.nominationInclude,
    });
    if (!nomination) throw new NotFoundException('Nomination not found');
    assertInBranch(nomination.employee.branchId);
    return nomination;
  }

  /**
   * Approved nomination side-effects.
   *
   * Who pays decides whether a claim is spawned. `training_paid_by = COMPANY`
   * (the default) means the company settles with the provider directly and
   * there is nothing to reimburse — the cost is still recorded on the
   * nomination so budgeting can see it. `EMPLOYEE` means the employee paid and
   * gets it back through the ordinary reimbursement path.
   */
  private async applyApproved(id: string, approverUserId: string, remarks?: string) {
    const nomination = await this.getNominationOrThrow(id);

    const updated = await this.prisma.trainingNomination.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approverId: approverUserId,
        approvedAt: new Date(),
      },
      include: this.nominationInclude,
    });

    const paidBy = await this.settings.getSetting('training_paid_by', 'COMPANY');
    if (paidBy === 'EMPLOYEE' && nomination.cost && Number(nomination.cost) > 0) {
      try {
        await this.reimbursements.createFromSource({
          employeeId: nomination.employeeId,
          type: TRAINING_EXPENSE_TYPE,
          amount: nomination.cost,
          expenseDate: nomination.session.startDate,
          description: `Training — ${nomination.session.course.title}`,
          sourceType: 'TRAINING',
          sourceId: nomination.id,
          budgetCategory: TRAINING_BUDGET_CATEGORY,
          status: 'APPROVED',
          approverId: approverUserId,
        });
      } catch (e: any) {
        this.logger.error(
          `Training claim for nomination ${id} failed: ${e?.message ?? e}`,
        );
      }
    }

    // Commit regardless of who pays: a company-settled course still consumes
    // the training budget, it just never becomes a reimbursement.
    if (nomination.cost && Number(nomination.cost) > 0) {
      await this.budget.commit({
        sourceType: 'TRAINING',
        sourceId: nomination.id,
        amount: nomination.cost,
        departmentId: nomination.employee.departmentId,
        category: TRAINING_BUDGET_CATEGORY,
        branchId: nomination.employee.branchId,
        onDate: nomination.session.startDate,
      });
    }

    await this.audit.log({
      userId: approverUserId,
      action: 'TRAINING_APPROVED',
      resourceType: 'TrainingNomination',
      resourceId: id,
      newData: { course: nomination.session.course.title, remarks, paidBy },
      branchId: getBranchContext()?.effectiveBranchId ?? null,
    });

    if (nomination.employee.user?.id) {
      await this.notifications
        .create({
          userId: nomination.employee.user.id,
          title: 'Training nomination approved',
          message: `You are confirmed for ${nomination.session.course.title}, starting ${nomination.session.startDate.toDateString()}.`,
          type: 'SUCCESS' as any,
          link: '/dashboard/my-training',
          waTemplate: 'training_nomination',
          waData: {
            courseName: nomination.session.course.title,
            sessionDate: nomination.session.startDate.toISOString(),
            status: 'APPROVED',
          },
          waDedupeKey: `training:${id}:approved`,
        })
        .catch(() => undefined);
    }

    return { success: true, message: 'Nomination approved.', data: updated };
  }

  private async applyRejected(id: string, approverUserId: string, reason?: string) {
    const nomination = await this.getNominationOrThrow(id);
    const updated = await this.prisma.trainingNomination.update({
      where: { id },
      data: {
        status: 'REJECTED',
        approverId: approverUserId,
        approvedAt: new Date(),
        rejectedReason: reason ?? null,
      },
      include: this.nominationInclude,
    });

    await this.budget.release('TRAINING', id, reason ?? 'Nomination rejected');

    await this.audit.log({
      userId: approverUserId,
      action: 'TRAINING_REJECTED',
      resourceType: 'TrainingNomination',
      resourceId: id,
      newData: { reason },
      branchId: getBranchContext()?.effectiveBranchId ?? null,
    });

    if (nomination.employee.user?.id) {
      await this.notifications
        .create({
          userId: nomination.employee.user.id,
          title: 'Training nomination rejected',
          message: `Your nomination for ${nomination.session.course.title} was rejected.${reason ? ` Reason: ${reason}` : ''}`,
          type: 'ERROR' as any,
          link: '/dashboard/my-training',
          waTemplate: 'training_nomination',
          waData: { courseName: nomination.session.course.title, status: 'REJECTED' },
          waDedupeKey: `training:${id}:rejected`,
        })
        .catch(() => undefined);
    }

    return { success: true, message: 'Nomination rejected.', data: updated };
  }

  async cancelNomination(id: string, user: any) {
    const nomination = await this.getNominationOrThrow(id);
    const isOwner = nomination.employee.user?.id === user?.id;
    if (!isOwner && !['ADMIN', 'HR_MANAGER'].includes(user?.role)) {
      throw new ForbiddenException('Not permitted to cancel this nomination');
    }
    if (!['PENDING', 'APPROVED'].includes(nomination.status)) {
      throw new BadRequestException(
        `Cannot cancel a ${nomination.status.toLowerCase()} nomination`,
      );
    }

    await this.engine.abandon('TRAINING', id);
    const cancelledClaims = await this.reimbursements.cancelBySource('TRAINING', id);

    const updated = await this.prisma.trainingNomination.update({
      where: { id },
      data: { status: 'CANCELLED' },
      include: this.nominationInclude,
    });

    await this.budget.release('TRAINING', id, 'Nomination cancelled');

    await this.audit.log({
      userId: user?.id,
      action: 'TRAINING_CANCELLED',
      resourceType: 'TrainingNomination',
      resourceId: id,
      newData: { cancelledClaims },
      branchId: getBranchContext()?.effectiveBranchId ?? null,
    });

    return { success: true, message: 'Nomination cancelled.', data: updated };
  }

  /**
   * Record attendance, score and the certificate.
   *
   * Certificate expiry is derived from the course's validity window and the
   * attendance date, which is what registers this nomination with the reminder
   * engine — no separate expiry cron.
   */
  async recordAttendance(id: string, dto: RecordAttendanceDto, userId: string) {
    const nomination = await this.getNominationOrThrow(id);
    if (!['APPROVED', 'ATTENDED', 'NO_SHOW'].includes(nomination.status)) {
      throw new BadRequestException(
        'Only an approved nomination can have attendance recorded',
      );
    }

    const attendedAt = dto.attendedAt
      ? new Date(dto.attendedAt)
      : nomination.session.endDate;

    let certificateExpiry: Date | null = null;
    const validMonths = nomination.session.course.certValidMonths;
    if (dto.attended && validMonths && validMonths > 0) {
      certificateExpiry = new Date(attendedAt);
      certificateExpiry.setMonth(certificateExpiry.getMonth() + validMonths);
    }

    const updated = await this.prisma.trainingNomination.update({
      where: { id },
      data: {
        status: dto.attended ? 'ATTENDED' : 'NO_SHOW',
        attendedAt: dto.attended ? attendedAt : null,
        score: dto.score ?? null,
        passed: dto.passed ?? null,
        certificateUrl: dto.certificateUrl ?? null,
        certificateExpiry,
      },
      include: this.nominationInclude,
    });

    await this.audit.log({
      userId,
      action: dto.attended ? 'TRAINING_ATTENDED' : 'TRAINING_NO_SHOW',
      resourceType: 'TrainingNomination',
      resourceId: id,
      newData: { score: dto.score, passed: dto.passed, certificateExpiry },
      branchId: getBranchContext()?.effectiveBranchId ?? null,
    });

    return { success: true, message: 'Attendance recorded.', data: updated };
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async listNominations(params: { sessionId?: string; status?: string }, user: any) {
    const where: Prisma.TrainingNominationWhereInput = {};
    if (params.sessionId) where.sessionId = params.sessionId;
    if (params.status) where.status = params.status;
    if (user?.role === 'MANAGER') {
      const deptIds = (user.managedDepartmentIds ?? []).filter(Boolean);
      if (deptIds.length === 0) return { success: true, data: [] };
      where.employee = { departmentId: { in: deptIds } };
    }
    const data = await this.prisma.trainingNomination.findMany({
      where,
      include: this.nominationInclude,
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data };
  }

  async findByEmployee(employeeId: string) {
    const data = await this.prisma.trainingNomination.findMany({
      where: { employeeId },
      include: this.nominationInclude,
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data };
  }

  /** The training calendar in four numbers. */
  async stats() {
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [activeCourses, sessionsByStatus, upcomingSessions, nominations] = await Promise.all([
      this.prisma.course.count({ where: { isActive: true } }),
      this.prisma.trainingSession.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.trainingSession.count({
        where: { status: 'SCHEDULED', startDate: { gte: now, lte: in30 } },
      }),
      this.prisma.trainingNomination.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    return {
      success: true,
      data: {
        activeCourses,
        upcomingSessions30Days: upcomingSessions,
        sessionsByStatus: Object.fromEntries(sessionsByStatus.map((r) => [r.status, r._count._all])),
        nominationsByStatus: Object.fromEntries(nominations.map((r) => [r.status, r._count._all])),
      },
    };
  }
}
