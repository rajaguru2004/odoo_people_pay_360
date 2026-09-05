import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { withFullName } from '../common/utils/employee-name.util';
import {
  canReadGrievance,
  canReadInternalNotes,
  GRIEVANCE_AGING_DAYS,
  GRIEVANCE_STATUSES,
  isGrievanceHandler,
  OPEN_GRIEVANCE_STATUSES,
  WITHDRAWABLE_STATUSES,
  type GrievanceReader,
} from './grievance-visibility.util';
import { CreateGrievanceDto } from './dto/create-grievance.dto';
import { UpdateGrievanceDto } from './dto/update-grievance.dto';
import { AddGrievanceNoteDto } from './dto/add-grievance-note.dto';

const GRIEVANCE_INCLUDE = {
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
  againstEmployee: {
    select: { id: true, employeeCode: true, firstName: true, lastName: true },
  },
  assignedTo: { select: { id: true, email: true } },
} satisfies Prisma.GrievanceInclude;

type GrievanceRow = Prisma.GrievanceGetPayload<{
  include: typeof GRIEVANCE_INCLUDE;
}>;

/**
 * Employee concerns, and the trail of what was done about them.
 *
 * Deliberately not on an approval chain: a grievance is a case with a handler
 * and a history, not a request queued for a decision.
 */
@Injectable()
export class GrievancesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Emit `fullName` on both people the case names. */
  private serialize(row: GrievanceRow) {
    return {
      ...row,
      employee: withFullName(row.employee),
      againstEmployee: withFullName(row.againstEmployee),
    };
  }

  /**
   * 404 rather than 403 when the reader may not see it: for a confidential
   * case, confirming that it exists is itself the disclosure.
   */
  private async getOrThrow(id: string, user: GrievanceReader) {
    const grievance = await this.prisma.grievance.findUnique({
      where: { id },
      include: GRIEVANCE_INCLUDE,
    });
    if (!grievance || !canReadGrievance(grievance, user)) {
      throw new NotFoundException('Grievance not found');
    }
    return grievance;
  }

  async create(
    employeeId: string | null | undefined,
    dto: CreateGrievanceDto,
    user: GrievanceReader,
  ) {
    if (!employeeId) {
      throw new BadRequestException(
        'Only a user attached to an employee record can raise a grievance',
      );
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, branchId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    if (dto.againstEmployeeId === employeeId) {
      throw new BadRequestException(
        'A grievance cannot be raised against yourself',
      );
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
      include: GRIEVANCE_INCLUDE,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: user?.id ?? null,
        action: 'GRIEVANCE_RAISED',
        entityType: 'Grievance',
        entityId: grievance.id,
        // Never the description. The audit log is widely readable and the
        // account of what happened is the confidential part.
        metadata: {
          category: dto.category,
          isConfidential: grievance.isConfidential,
        },
      },
    });

    return this.serialize(grievance);
  }

  async findAll(params: { status?: string }, user: GrievanceReader) {
    const where: Prisma.GrievanceWhereInput = {};
    if (params.status) where.status = params.status;

    // Both rules below are ORs, so they are collected and ANDed rather than
    // written to `where.OR` twice — a second assignment would replace the first
    // and widen the audience.
    const scopes: Prisma.GrievanceWhereInput[] = [];

    if (!isGrievanceHandler(user)) {
      scopes.push({
        OR: [
          { employeeId: user?.employeeId ?? '' },
          { assignedToId: user?.id ?? '' },
        ],
      });
    }

    // The subject of a complaint never sees it, whatever their role.
    //
    // Spelled out as "names nobody OR names somebody else" rather than
    // `NOT: { againstEmployeeId }`, which compiles to
    // `NOT (against_employee_id = $1)` — NULL, not TRUE, on the rows that name
    // nobody, so the database drops them. Naming a person is the minority
    // case, so that form would hide nearly every grievance from the desk.
    if (user?.employeeId) {
      scopes.push({
        OR: [
          { againstEmployeeId: null },
          { againstEmployeeId: { not: user.employeeId } },
        ],
      });
    }
    if (scopes.length) where.AND = scopes;

    const rows = await this.prisma.grievance.findMany({
      where,
      include: GRIEVANCE_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.serialize(row));
  }

  async findOne(id: string, user: GrievanceReader) {
    const grievance = await this.getOrThrow(id, user);
    const seesInternal = canReadInternalNotes(grievance, user);

    const events = await this.prisma.grievanceEvent.findMany({
      where: {
        grievanceId: id,
        ...(seesInternal ? {} : { isInternal: false }),
      },
      orderBy: { createdAt: 'asc' },
      include: { actor: { select: { id: true, email: true } } },
    });

    return { ...this.serialize(grievance), events };
  }

  /** The desk moving a case along: status, handler, resolution. */
  async update(id: string, dto: UpdateGrievanceDto, user: GrievanceReader) {
    const grievance = await this.getOrThrow(id, user);
    if (!isGrievanceHandler(user)) {
      throw new ForbiddenException('Only HR can update a grievance');
    }
    if (dto.status && !GRIEVANCE_STATUSES.includes(dto.status as never)) {
      throw new BadRequestException('Unknown grievance status');
    }

    // A handler who is the subject of the complaint would be marking their own
    // homework — and would then be able to read it, which the visibility rule
    // exists to prevent.
    if (dto.assignedToId && grievance.againstEmployeeId) {
      const handler = await this.prisma.user.findUnique({
        where: { id: dto.assignedToId },
        select: { employeeId: true },
      });
      if (handler?.employeeId === grievance.againstEmployeeId) {
        throw new BadRequestException(
          'A grievance cannot be assigned to the person it is about',
        );
      }
    }

    const statusChanged = Boolean(dto.status && dto.status !== grievance.status);
    const updated = await this.prisma.grievance.update({
      where: { id },
      data: {
        ...(dto.status && { status: dto.status }),
        ...(dto.assignedToId !== undefined && {
          assignedToId: dto.assignedToId,
        }),
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
      include: GRIEVANCE_INCLUDE,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: user?.id ?? null,
        action: 'GRIEVANCE_UPDATED',
        entityType: 'Grievance',
        entityId: id,
        metadata: {
          from: { status: grievance.status, assignedToId: grievance.assignedToId },
          to: { status: dto.status ?? null, assignedToId: dto.assignedToId ?? null },
        },
      },
    });

    return this.serialize(updated);
  }

  /** A note on the trail. `isInternal` keeps it away from the complainant. */
  async addNote(id: string, dto: AddGrievanceNoteDto, user: GrievanceReader) {
    const grievance = await this.getOrThrow(id, user);
    if (dto.isInternal && !canReadInternalNotes(grievance, user)) {
      throw new ForbiddenException('Only a handler can add an internal note');
    }

    return this.prisma.grievanceEvent.create({
      data: {
        grievanceId: id,
        type: 'NOTE',
        note: dto.note,
        isInternal: dto.isInternal ?? false,
        actorUserId: user?.id ?? null,
      },
    });
  }

  /** The complainant closing their own case. */
  async withdraw(id: string, user: GrievanceReader) {
    const grievance = await this.getOrThrow(id, user);
    if (grievance.employeeId !== user?.employeeId) {
      throw new ForbiddenException(
        'Only the complainant can withdraw a grievance',
      );
    }
    if (!WITHDRAWABLE_STATUSES.has(grievance.status)) {
      throw new BadRequestException(
        `A grievance that is ${grievance.status.toLowerCase()} can no longer be withdrawn`,
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
      include: GRIEVANCE_INCLUDE,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: user?.id ?? null,
        action: 'GRIEVANCE_WITHDRAWN',
        entityType: 'Grievance',
        entityId: id,
      },
    });

    return this.serialize(updated);
  }

  /**
   * Open cases, and how long the oldest has waited.
   *
   * Age is the figure that matters: three cases open a month is a worse state
   * than ten opened this morning, and a count alone cannot tell them apart.
   */
  async stats() {
    const open = OPEN_GRIEVANCE_STATUSES as unknown as string[];
    const cutoff = new Date(
      Date.now() - GRIEVANCE_AGING_DAYS * 24 * 60 * 60 * 1000,
    );

    const [byStatus, aging, oldest] = await Promise.all([
      this.prisma.grievance.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.grievance.count({
        where: { status: { in: open }, createdAt: { lt: cutoff } },
      }),
      this.prisma.grievance.findFirst({
        where: { status: { in: open } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const counts = Object.fromEntries(
      byStatus.map((row) => [row.status, row._count._all]),
    );

    return {
      open: open.reduce((total, status) => total + (counts[status] ?? 0), 0),
      byStatus: counts,
      olderThan14Days: aging,
      oldestOpenAt: oldest?.createdAt ?? null,
    };
  }
}
