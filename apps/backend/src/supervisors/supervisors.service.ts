import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { withFullName } from '../common/utils/employee-name.util';

/** The person card My Team draws, and the one `supervisorOf` answers with. */
const SUPERVISEE_SELECT = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  workEmail: true,
  position: true,
  status: true,
  department: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;

type SuperviseeRow = Prisma.EmployeeGetPayload<{
  select: typeof SUPERVISEE_SELECT;
}>;

/**
 * The supervisor link — who signs a person's leave and their timesheet.
 *
 * Deliberately separate from `managerId`, which says where somebody sits in the
 * structure. A matrixed engineer reports to a functional head and is supervised
 * by a project lead, and collapsing the two is how a reorganisation silently
 * reroutes every pending approval.
 */
@Injectable()
export class SupervisorsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Emit `fullName` beside the parts — see `employee-name.util.ts`. */
  private card(row: SuperviseeRow) {
    const { workEmail, ...rest } = row;
    return { ...withFullName(rest), email: workEmail };
  }

  private async getEmployeeOrThrow(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        status: true,
        supervisorId: true,
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
  }

  /**
   * Would making `supervisorId` supervise `employeeId` close a loop?
   *
   * Walked rather than expressed as a constraint because the database cannot
   * state it. `seen` guards the walk itself: a cycle written before this check
   * existed would otherwise make the loop non-terminating.
   */
  private async wouldCycle(
    employeeId: string,
    supervisorId: string,
  ): Promise<boolean> {
    let cursor: string | null = supervisorId;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === employeeId) return true;
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const next: { supervisorId: string | null } | null =
        await this.prisma.employee.findUnique({
          where: { id: cursor },
          select: { supervisorId: true },
        });
      cursor = next?.supervisorId ?? null;
    }
    return false;
  }

  async assign(employeeId: string, supervisorId: string, actorUserId?: string) {
    if (employeeId === supervisorId) {
      throw new BadRequestException('An employee cannot supervise themselves');
    }

    const employee = await this.getEmployeeOrThrow(employeeId);
    const supervisor = await this.getEmployeeOrThrow(supervisorId);

    if (supervisor.status !== 'ACTIVE') {
      throw new BadRequestException('A supervisor must be an active employee');
    }
    if (await this.wouldCycle(employeeId, supervisorId)) {
      throw new BadRequestException(
        'That assignment would close a supervisor loop',
      );
    }

    const previousSupervisorId = employee.supervisorId;
    const updated = await this.prisma.employee.update({
      where: { id: employeeId },
      data: { supervisorId },
      select: SUPERVISEE_SELECT,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: actorUserId ?? null,
        action: previousSupervisorId
          ? 'SUPERVISOR_REASSIGNED'
          : 'SUPERVISOR_ASSIGNED',
        entityType: 'Employee',
        entityId: employeeId,
        metadata: { from: previousSupervisorId, to: supervisorId },
      },
    });

    return this.card(updated);
  }

  /**
   * Sequential rather than an `updateMany`: the cycle check reads the chain the
   * previous assignment just changed, so a batch applied in one statement could
   * write a loop that each row passed individually.
   */
  async bulkAssign(
    employeeIds: string[],
    supervisorId: string,
    actorUserId?: string,
  ) {
    const assigned: Array<Awaited<ReturnType<SupervisorsService['assign']>>> =
      [];
    for (const employeeId of employeeIds) {
      assigned.push(await this.assign(employeeId, supervisorId, actorUserId));
    }
    return assigned;
  }

  async unassign(employeeId: string, actorUserId?: string) {
    const employee = await this.getEmployeeOrThrow(employeeId);
    if (!employee.supervisorId) {
      const unchanged = await this.prisma.employee.findUniqueOrThrow({
        where: { id: employeeId },
        select: SUPERVISEE_SELECT,
      });
      return this.card(unchanged);
    }

    const updated = await this.prisma.employee.update({
      where: { id: employeeId },
      data: { supervisorId: null },
      select: SUPERVISEE_SELECT,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: actorUserId ?? null,
        action: 'SUPERVISOR_UNASSIGNED',
        entityType: 'Employee',
        entityId: employeeId,
        metadata: { from: employee.supervisorId },
      },
    });

    return this.card(updated);
  }

  /** Everyone a given supervisor signs for. */
  async reports(supervisorId: string) {
    const rows = await this.prisma.employee.findMany({
      where: { supervisorId },
      select: SUPERVISEE_SELECT,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    return rows.map((row) => this.card(row));
  }

  /** The supervisor of a given employee, or null when they have none. */
  async supervisorOf(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { supervisor: { select: SUPERVISEE_SELECT } },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee.supervisor ? this.card(employee.supervisor) : null;
  }
}
