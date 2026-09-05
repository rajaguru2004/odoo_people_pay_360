import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { getBranchContext } from '../common/branch/branch-context';
import { CreateGrievanceDto } from './dto/create-grievance.dto';
import { UpdateGrievanceDto } from './dto/update-grievance.dto';
import { AddGrievanceNoteDto } from './dto/add-grievance-note.dto';

export const GRIEVANCE_STATUSES = [
  'OPEN',
  'ACKNOWLEDGED',
  'INVESTIGATING',
  'RESOLVED',
  'CLOSED',
  'WITHDRAWN',
] as const;

/**
 * "Still on somebody's desk" — the one definition of an open grievance.
 *
 * There were three. `stats()` counted `OPEN, ACKNOWLEDGED` and dropped
 * `INVESTIGATING`, which is the status a grievance spends the LONGEST in; the
 * Talent hub counted `OPEN, SUBMITTED, IN_PROGRESS, UNDER_REVIEW, ESCALATED`,
 * four of which have never existed in this schema. Both under-counted, in
 * different directions, and neither matched `GRIEVANCE_STATUSES` above.
 *
 * A case is open until it is resolved, closed or withdrawn. Everything else is
 * a stage of being open, not a different thing.
 */
export const OPEN_GRIEVANCE_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'] as const;

/** How long an open grievance may sit before the hubs call it out. */
export const GRIEVANCE_AGING_DAYS = 14;

/** Statuses from which the complainant may still withdraw. */
const WITHDRAWABLE = new Set(['OPEN', 'ACKNOWLEDGED']);

@Injectable()
export class GrievancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private readonly include = {
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
    againstEmployee: {
      select: { id: true, employeeCode: true, fullName: true },
    },
    assignedTo: { select: { id: true, email: true } },
  };

  /**
   * Can this user see this grievance?
   *
   * The rule that matters: a grievance about someone must never be visible to
   * that someone. `isDeptInManagerScope` is deliberately NOT used — a manager
   * heading the complainant's department is frequently the person being
   * complained about, so department scoping would grant access to exactly the
   * wrong person.
   */
  private canRead(grievance: any, user: any): boolean {
    if (!user) return false;
    // Never, under any role: the subject of the complaint.
    if (
      grievance.againstEmployeeId &&
      grievance.againstEmployeeId === user.employeeId
    ) {
      return false;
    }
    if (grievance.employeeId === user.employeeId) return true; // complainant
    if (grievance.assignedToId === user.id) return true; // assigned handler
    if (['ADMIN', 'HR_MANAGER'].includes(user.role)) return true;
    return false;
  }

  private async getOrThrow(id: string, user: any) {
    const grievance = await this.prisma.grievance.findUnique({
      where: { id },
      include: this.include,
    });
    if (!grievance) throw new NotFoundException('Grievance not found');
    assertInBranch(grievance.employee.branchId);
    // 404 rather than 403 — for a confidential case, confirming it exists is
    // itself a disclosure.
    if (!this.canRead(grievance, user)) {
      throw new NotFoundException('Grievance not found');
    }
    return grievance;
  }

  async create(employeeId: string, dto: CreateGrievanceDto, user: any) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, fullName: true, branchId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertInBranch(employee.branchId);

    if (dto.againstEmployeeId === employeeId) {
      throw new BadRequestException('A grievance cannot be raised against yourself');
    }

    const grievance = await this.prisma.grievance.create({
      data: {
        employeeId,
        category: dto.category,
        subject: dto.subject,
        description: dto.description,
        isConfidential: dto.isConfidential ?? false,
        againstEmployeeId: dto.againstEmployeeId ?? null,
        status: 'OPEN',
        events: {
          create: {
            type: 'STATUS_CHANGE',
            toStatus: 'OPEN',
            note: 'Grievance raised',
            actorUserId: user?.id ?? null,
          },
        },
      },
      include: this.include,
    });

    await this.audit.log({
      userId: user?.id,
      action: 'GRIEVANCE_RAISED',
      resourceType: 'Grievance',
      resourceId: grievance.id,
      // Never the description — the audit log is widely readable.
      newData: { category: dto.category, isConfidential: grievance.isConfidential },
      branchId: employee.branchId,
    });

    // HR only. Notifying a department manager could notify the subject.
    const hr = await this.prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'HR_MANAGER'] }, isActive: true },
      select: { id: true, employeeId: true },
    });
    await Promise.all(
      hr
        .filter((u) => u.employeeId !== grievance.againstEmployeeId)
        .map((u) =>
          this.notifications
            .create({
              userId: u.id,
              title: 'New grievance raised',
              message: `${grievance.isConfidential ? 'A confidential grievance' : `A grievance (${dto.category})`} was raised and needs an owner.`,
              type: 'WARNING' as any,
              link: '/dashboard/grievances',
            })
            .catch(() => undefined),
        ),
    );

    return { success: true, message: 'Grievance raised.', data: grievance };
  }

  async findAll(params: { status?: string } = {}, user: any) {
    const where: Prisma.GrievanceWhereInput = {};
    if (params.status) where.status = params.status;

    // Both rules below are ORs, so they are collected and ANDed rather than
    // written to `where.OR` twice — a second assignment would silently replace
    // the first and widen the audience.
    const scopes: Prisma.GrievanceWhereInput[] = [];

    if (!['ADMIN', 'HR_MANAGER'].includes(user?.role)) {
      // Everyone else sees only their own cases and anything assigned to them.
      scopes.push({
        OR: [{ employeeId: user?.employeeId ?? '' }, { assignedToId: user?.id ?? '' }],
      });
    }
    // Belt and braces: the subject of a complaint never sees it, even if they
    // are HR or the assigned handler.
    //
    // Spelled out as "names nobody OR names someone else" rather than
    // `NOT: { againstEmployeeId }`, which compiles to
    // `NOT (against_employee_id = $1)` — NULL, not TRUE, on the rows that name
    // nobody, so SQL drops them. Naming a person is the minority case, so that
    // form hid nearly every grievance and HR's list came back empty.
    if (user?.employeeId) {
      scopes.push({
        OR: [
          { againstEmployeeId: null },
          { againstEmployeeId: { not: user.employeeId } },
        ],
      });
    }
    if (scopes.length) where.AND = scopes;

    const data = await this.prisma.grievance.findMany({
      where,
      include: this.include,
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data };
  }

  async findOne(id: string, user: any) {
    const grievance = await this.getOrThrow(id, user);
    const isHandler =
      ['ADMIN', 'HR_MANAGER'].includes(user?.role) || grievance.assignedToId === user?.id;

    const events = await this.prisma.grievanceEvent.findMany({
      where: {
        grievanceId: id,
        // Internal handler notes are never shown to the complainant.
        ...(isHandler ? {} : { isInternal: false }),
      },
      orderBy: { createdAt: 'asc' },
      include: { actor: { select: { id: true, email: true } } },
    });

    return { success: true, data: { ...grievance, events } };
  }

  /** HR updates status, assignment and resolution. */
  async update(id: string, dto: UpdateGrievanceDto, user: any) {
    const grievance = await this.getOrThrow(id, user);
    if (!['ADMIN', 'HR_MANAGER'].includes(user?.role)) {
      throw new ForbiddenException('Only HR can update a grievance');
    }
    if (dto.status && !GRIEVANCE_STATUSES.includes(dto.status as any)) {
      throw new BadRequestException('Invalid status');
    }

    // A handler who is the subject of the complaint would be marking their own
    // homework.
    if (dto.assignedToId) {
      const handler = await this.prisma.user.findUnique({
        where: { id: dto.assignedToId },
        select: { employeeId: true },
      });
      if (
        grievance.againstEmployeeId &&
        handler?.employeeId === grievance.againstEmployeeId
      ) {
        throw new BadRequestException(
          'Cannot assign a grievance to the person it is about',
        );
      }
    }

    const statusChanged = dto.status && dto.status !== grievance.status;
    const updated = await this.prisma.grievance.update({
      where: { id },
      data: {
        ...(dto.status && { status: dto.status }),
        ...(dto.assignedToId !== undefined && { assignedToId: dto.assignedToId }),
        ...(dto.resolution !== undefined && { resolution: dto.resolution }),
        ...(dto.status === 'RESOLVED' && { resolvedAt: new Date() }),
        events: {
          create: {
            type: statusChanged ? 'STATUS_CHANGE' : 'ASSIGNED',
            fromStatus: statusChanged ? grievance.status : null,
            toStatus: dto.status ?? null,
            note: dto.note ?? null,
            actorUserId: user?.id ?? null,
          },
        },
      },
      include: this.include,
    });

    await this.audit.log({
      userId: user?.id,
      action: 'GRIEVANCE_UPDATED',
      resourceType: 'Grievance',
      resourceId: id,
      oldData: { status: grievance.status, assignedToId: grievance.assignedToId },
      newData: { status: dto.status, assignedToId: dto.assignedToId },
      branchId: getBranchContext()?.effectiveBranchId ?? null,
    });

    if (statusChanged && grievance.employee.user?.id) {
      await this.notifications
        .create({
          userId: grievance.employee.user.id,
          title: 'Your grievance was updated',
          message: `Status changed to ${dto.status}.`,
          type: 'INFO' as any,
          link: '/dashboard/my-grievances',
        })
        .catch(() => undefined);
    }

    return { success: true, message: 'Grievance updated.', data: updated };
  }

  /** A handler note. `isInternal` keeps it out of the complainant's view. */
  async addNote(id: string, dto: AddGrievanceNoteDto, user: any) {
    const grievance = await this.getOrThrow(id, user);
    const isHandler =
      ['ADMIN', 'HR_MANAGER'].includes(user?.role) || grievance.assignedToId === user?.id;
    if (dto.isInternal && !isHandler) {
      throw new ForbiddenException('Only a handler can add an internal note');
    }

    const event = await this.prisma.grievanceEvent.create({
      data: {
        grievanceId: id,
        type: 'NOTE',
        note: dto.note,
        isInternal: dto.isInternal ?? false,
        actorUserId: user?.id ?? null,
      },
    });
    return { success: true, data: event };
  }

  /** The complainant withdrawing their own case. */
  async withdraw(id: string, user: any) {
    const grievance = await this.getOrThrow(id, user);
    if (grievance.employeeId !== user?.employeeId) {
      throw new ForbiddenException('Only the complainant can withdraw a grievance');
    }
    if (!WITHDRAWABLE.has(grievance.status)) {
      throw new BadRequestException(
        `Cannot withdraw a grievance that is ${grievance.status.toLowerCase()}`,
      );
    }

    const updated = await this.prisma.grievance.update({
      where: { id },
      data: {
        status: 'WITHDRAWN',
        events: {
          create: {
            type: 'STATUS_CHANGE',
            fromStatus: grievance.status,
            toStatus: 'WITHDRAWN',
            note: 'Withdrawn by the complainant',
            actorUserId: user?.id ?? null,
          },
        },
      },
      include: this.include,
    });

    await this.audit.log({
      userId: user?.id,
      action: 'GRIEVANCE_WITHDRAWN',
      resourceType: 'Grievance',
      resourceId: id,
      branchId: getBranchContext()?.effectiveBranchId ?? null,
    });

    return { success: true, message: 'Grievance withdrawn.', data: updated };
  }

  /**
   * Open cases, and how long the oldest has been waiting.
   *
   * Age is the figure that matters: three grievances open a month is a worse
   * state than ten opened this morning, and a count alone cannot say which one
   * you are looking at.
   */
  async stats() {
    // Was a local `['OPEN','ACKNOWLEDGED']`, which silently excluded every
    // grievance under investigation — see OPEN_GRIEVANCE_STATUSES above.
    const OPEN = OPEN_GRIEVANCE_STATUSES as unknown as string[];
    const fortnightAgo = new Date(Date.now() - GRIEVANCE_AGING_DAYS * 24 * 60 * 60 * 1000);

    const [byStatus, olderThan14Days, oldest] = await Promise.all([
      this.prisma.grievance.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.grievance.count({
        where: { status: { in: OPEN }, createdAt: { lt: fortnightAgo } },
      }),
      this.prisma.grievance.findFirst({
        where: { status: { in: OPEN } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));
    const open = OPEN.reduce((a, s) => a + (counts[s] ?? 0), 0);

    return {
      success: true,
      data: {
        open,
        byStatus: counts,
        olderThan14Days,
        oldestOpenAt: oldest?.createdAt ?? null,
      },
    };
  }
}
