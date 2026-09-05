import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import { withFullName } from '../common/utils/employee-name.util';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { CreateSessionDto } from './dto/create-session.dto';
import { NominateDto } from './dto/nominate.dto';
import { DecideNominationDto } from './dto/decide-nomination.dto';
import { RecordAttendanceDto } from './dto/record-attendance.dto';
import type { Principal } from '../auth/auth.service';

/** Seats a session has actually committed. */
const COMMITTED_STATUSES = ['APPROVED', 'ATTENDED'];

/** Roles that may settle a nomination when no approval chain governs it. */
const DEFAULT_APPROVER_ROLES: string[] = [UserRole.ADMIN, UserRole.HR_MANAGER];

const NOMINATION_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
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
      branch: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.TrainingNominationInclude;

type NominationRow = Prisma.TrainingNominationGetPayload<{
  include: typeof NOMINATION_INCLUDE;
}>;

@Injectable()
export class TrainingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: ApprovalEngineService,
  ) {}

  private serialize(row: NominationRow) {
    return { ...row, employee: withFullName(row.employee) };
  }

  // ── Course catalogue ───────────────────────────────────────────────────────

  async createCourse(dto: CreateCourseDto) {
    try {
      return await this.prisma.course.create({ data: { ...dto } });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(`Course code "${dto.code}" already exists`);
      }
      throw error;
    }
  }

  async listCourses(activeOnly = false) {
    return this.prisma.course.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: { title: 'asc' },
    });
  }

  async updateCourse(id: string, dto: UpdateCourseDto) {
    const existing = await this.prisma.course.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Course not found');
    return this.prisma.course.update({ where: { id }, data: dto });
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  async createSession(dto: CreateSessionDto) {
    const course = await this.prisma.course.findUnique({
      where: { id: dto.courseId },
      select: { id: true, defaultCost: true },
    });
    if (!course) throw new NotFoundException('Course not found');

    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);
    if (endDate < startDate) {
      throw new BadRequestException(
        'A session cannot end before it starts',
      );
    }

    return this.prisma.trainingSession.create({
      data: {
        courseId: dto.courseId,
        branchId: dto.branchId ?? null,
        startDate,
        endDate,
        location: dto.location ?? null,
        trainer: dto.trainer ?? null,
        seats: dto.seats ?? null,
        // Falls back to the course default so a session always has a cost for
        // its nominations to snapshot.
        costPerSeat: dto.costPerSeat ?? course.defaultCost ?? null,
      },
      include: { course: true },
    });
  }

  async listSessions(params: { status?: string; from?: string; to?: string }) {
    const where: Prisma.TrainingSessionWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.from || params.to) {
      where.startDate = {
        ...(params.from ? { gte: new Date(params.from) } : {}),
        ...(params.to ? { lte: new Date(params.to) } : {}),
      };
    }

    return this.prisma.trainingSession.findMany({
      where,
      include: {
        course: true,
        branch: { select: { id: true, name: true } },
        _count: {
          select: { nominations: { where: { status: { in: COMMITTED_STATUSES } } } },
        },
      },
      orderBy: { startDate: 'desc' },
    });
  }

  // ── Nominations ────────────────────────────────────────────────────────────

  async nominate(dto: NominateDto, user: Principal) {
    const [session, employee] = await Promise.all([
      this.prisma.trainingSession.findUnique({
        where: { id: dto.sessionId },
        include: { course: { select: { title: true } } },
      }),
      this.prisma.employee.findUnique({
        where: { id: dto.employeeId },
        select: { id: true, status: true },
      }),
    ]);
    if (!session) throw new NotFoundException('Training session not found');
    if (!employee) throw new NotFoundException('Employee not found');

    if (['CANCELLED', 'COMPLETED'].includes(session.status)) {
      throw new BadRequestException(
        `Cannot nominate to a ${session.status.toLowerCase()} session`,
      );
    }
    if (employee.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Cannot nominate an employee whose status is ${employee.status}`,
      );
    }

    // The duplicate check runs BEFORE the seat cap. On a full session the
    // unique constraint would otherwise be reported as "session full", which
    // sends the nominator hunting for a seat this person already holds.
    const existing = await this.prisma.trainingNomination.findUnique({
      where: {
        sessionId_employeeId: {
          sessionId: dto.sessionId,
          employeeId: dto.employeeId,
        },
      },
      select: { status: true },
    });
    if (existing) {
      throw new ConflictException(
        `This employee is already nominated for this session (${existing.status.toLowerCase()})`,
      );
    }

    if (session.seats !== null) {
      const taken = await this.prisma.trainingNomination.count({
        where: { sessionId: dto.sessionId, status: { in: COMMITTED_STATUSES } },
      });
      if (taken >= session.seats) {
        throw new BadRequestException(
          `This session is full (${session.seats} seat(s))`,
        );
      }
    }

    const nomination = await this.prisma.trainingNomination.create({
      data: {
        sessionId: dto.sessionId,
        employeeId: dto.employeeId,
        nominatedById: user.id,
        justification: dto.justification ?? null,
        // Snapshotted: an approved cost must not move when somebody edits the
        // session afterwards.
        cost: session.costPerSeat,
        status: 'PENDING',
      },
      include: NOMINATION_INCLUDE,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: user.id,
        action: 'TRAINING_NOMINATED',
        entityType: 'TrainingNomination',
        entityId: nomination.id,
        metadata: {
          employeeId: dto.employeeId,
          course: session.course.title,
        },
      },
    });

    // With no configured chain the nomination is settled by the nominator's own
    // authority, exactly as a fresh install behaves.
    const init = await this.engine.initiate(
      'TRAINING',
      nomination.id,
      dto.employeeId,
      user.id,
    );
    if (!init.engaged || init.finalized) {
      return this.applyApproved(nomination.id, user.id);
    }

    return this.serialize(nomination);
  }

  async decide(
    id: string,
    user: Principal,
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

    // `engaged: false` means no chain governs this one, so the module falls
    // back to its own single-approver rule rather than letting anybody settle it.
    if (!result.engaged && !DEFAULT_APPROVER_ROLES.includes(user.role)) {
      throw new ForbiddenException(
        'Your role is not permitted to decide training nominations',
      );
    }

    if (!result.engaged || result.finalized) {
      return decision === 'APPROVE'
        ? this.applyApproved(id, user.id, dto.remarks)
        : this.applyRejected(id, user.id, dto.remarks);
    }

    // The chain has more steps to run; the nomination stays PENDING.
    return this.serialize(await this.getNominationOrThrow(id));
  }

  private async getNominationOrThrow(id: string) {
    const nomination = await this.prisma.trainingNomination.findUnique({
      where: { id },
      include: NOMINATION_INCLUDE,
    });
    if (!nomination) throw new NotFoundException('Nomination not found');
    return nomination;
  }

  private async applyApproved(id: string, approverUserId: string, remarks?: string) {
    const nomination = await this.getNominationOrThrow(id);
    const updated = await this.prisma.trainingNomination.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approverId: approverUserId,
        approvedAt: new Date(),
      },
      include: NOMINATION_INCLUDE,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: approverUserId,
        action: 'TRAINING_APPROVED',
        entityType: 'TrainingNomination',
        entityId: id,
        metadata: { course: nomination.session.course.title, remarks: remarks ?? null },
      },
    });

    return this.serialize(updated);
  }

  private async applyRejected(id: string, approverUserId: string, reason?: string) {
    const updated = await this.prisma.trainingNomination.update({
      where: { id },
      data: {
        status: 'REJECTED',
        approverId: approverUserId,
        approvedAt: new Date(),
        rejectedReason: reason ?? null,
      },
      include: NOMINATION_INCLUDE,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: approverUserId,
        action: 'TRAINING_REJECTED',
        entityType: 'TrainingNomination',
        entityId: id,
        metadata: { reason: reason ?? null },
      },
    });

    return this.serialize(updated);
  }

  async cancelNomination(id: string, user: Principal) {
    const nomination = await this.getNominationOrThrow(id);
    const isOwner = nomination.employeeId === user?.employeeId;
    if (!isOwner && !DEFAULT_APPROVER_ROLES.includes(user?.role)) {
      throw new ForbiddenException('Not permitted to cancel this nomination');
    }
    if (!['PENDING', 'APPROVED'].includes(nomination.status)) {
      throw new BadRequestException(
        `Cannot cancel a ${nomination.status.toLowerCase()} nomination`,
      );
    }

    // Close the live trail first, so no approver can finalise something that
    // has already been withdrawn.
    await this.engine.abandon('TRAINING', id);

    const updated = await this.prisma.trainingNomination.update({
      where: { id },
      data: { status: 'CANCELLED' },
      include: NOMINATION_INCLUDE,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: user?.id ?? null,
        action: 'TRAINING_CANCELLED',
        entityType: 'TrainingNomination',
        entityId: id,
      },
    });

    return this.serialize(updated);
  }

  /**
   * Record attendance, the score and the certificate.
   *
   * The certificate's expiry is derived from the course's validity window and
   * the attendance date, which is what puts it in front of the employee in the
   * vault before it lapses — no separate expiry job.
   */
  async recordAttendance(id: string, dto: RecordAttendanceDto, userId: string) {
    const nomination = await this.getNominationOrThrow(id);
    if (!['APPROVED', 'ATTENDED', 'NO_SHOW'].includes(nomination.status)) {
      throw new BadRequestException(
        'Only an approved nomination can have attendance recorded against it',
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
      include: NOMINATION_INCLUDE,
    });

    await this.prisma.auditLog.create({
      data: {
        userId,
        action: dto.attended ? 'TRAINING_ATTENDED' : 'TRAINING_NO_SHOW',
        entityType: 'TrainingNomination',
        entityId: id,
        metadata: {
          score: dto.score ?? null,
          passed: dto.passed ?? null,
          certificateExpiry: certificateExpiry?.toISOString() ?? null,
        },
      },
    });

    return this.serialize(updated);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async listNominations(
    params: { sessionId?: string; status?: string },
    user: Principal,
  ) {
    const where: Prisma.TrainingNominationWhereInput = {};
    if (params.sessionId) where.sessionId = params.sessionId;
    if (params.status) where.status = params.status;

    if (user?.role === UserRole.MANAGER) {
      const scope = await this.managedDepartmentIds(user);
      if (scope.length === 0) return [];
      where.employee = { departmentId: { in: scope } };
    }

    const rows = await this.prisma.trainingNomination.findMany({
      where,
      include: NOMINATION_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.serialize(row));
  }

  async findByEmployee(employeeId: string) {
    const rows = await this.prisma.trainingNomination.findMany({
      where: { employeeId },
      include: NOMINATION_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.serialize(row));
  }

  /** The training calendar in four numbers. */
  async stats() {
    const now = new Date();
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [activeCourses, sessionsByStatus, upcoming, nominations] =
      await Promise.all([
        this.prisma.course.count({ where: { isActive: true } }),
        this.prisma.trainingSession.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        this.prisma.trainingSession.count({
          where: { status: 'SCHEDULED', startDate: { gte: now, lte: in30Days } },
        }),
        this.prisma.trainingNomination.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
      ]);

    return {
      activeCourses,
      upcomingSessions30Days: upcoming,
      sessionsByStatus: Object.fromEntries(
        sessionsByStatus.map((row) => [row.status, row._count._all]),
      ),
      nominationsByStatus: Object.fromEntries(
        nominations.map((row) => [row.status, row._count._all]),
      ),
    };
  }

  /** The departments a manager speaks for: the ones they head, plus their own. */
  private async managedDepartmentIds(user: Principal): Promise<string[]> {
    const ids = new Set<string>();
    if (user.departmentId) ids.add(user.departmentId);
    if (user.employeeId) {
      const headed = await this.prisma.department.findMany({
        where: { managerId: user.employeeId },
        select: { id: true },
      });
      headed.forEach((department) => ids.add(department.id));
    }
    return [...ids];
  }
}
