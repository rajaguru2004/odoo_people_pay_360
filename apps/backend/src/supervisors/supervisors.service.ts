import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertInBranch } from '../common/branch/branch-scope.util';

/**
 * Supervisor assignment — a lightweight, detachable approval-responsibility link
 * on Employee.supervisorId. Independent of department management; never touches
 * the org hierarchy. Assign/reassign/unassign are audited and notify the parties.
 */
@Injectable()
export class SupervisorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async getEmployeeOrThrow(id: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        status: true,
        branchId: true,
        supervisorId: true,
        user: { select: { id: true } },
      },
    });
    if (!emp) throw new NotFoundException('Employee not found');
    return emp;
  }

  /** True if making `supervisorId` supervise `employeeId` would create a cycle. */
  private async wouldCycle(
    employeeId: string,
    supervisorId: string,
  ): Promise<boolean> {
    let cursor: string | null = supervisorId;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === employeeId) return true;
      if (seen.has(cursor)) break; // pre-existing cycle guard
      seen.add(cursor);
      const next = await this.prisma.employee.findUnique({
        where: { id: cursor },
        select: { supervisorId: true },
      });
      cursor = next?.supervisorId ?? null;
    }
    return false;
  }

  async assign(employeeId: string, supervisorId: string, actor: any) {
    if (employeeId === supervisorId) {
      throw new BadRequestException('An employee cannot supervise themselves');
    }
    const employee = await this.getEmployeeOrThrow(employeeId);
    const supervisor = await this.getEmployeeOrThrow(supervisorId);

    // Branch envelope: both parties must be within the actor's scope.
    assertInBranch(employee.branchId);
    assertInBranch(supervisor.branchId);

    if (supervisor.status !== 'ACTIVE') {
      throw new BadRequestException('Supervisor must be an active employee');
    }
    if (await this.wouldCycle(employeeId, supervisorId)) {
      throw new BadRequestException(
        'Assignment would create a supervisor cycle',
      );
    }

    const previousSupervisorId = employee.supervisorId;
    const updated = await this.prisma.employee.update({
      where: { id: employeeId },
      data: { supervisorId },
      select: { id: true, fullName: true, supervisorId: true },
    });
    await this.dropStaleTeamMemberships(employeeId, supervisorId);

    await this.audit.log({
      userId: actor?.id,
      action: previousSupervisorId ? 'SUPERVISOR_REASSIGNED' : 'SUPERVISOR_ASSIGNED',
      resourceType: 'SupervisorAssignment',
      resourceId: employeeId,
      oldData: { supervisorId: previousSupervisorId },
      newData: { supervisorId },
    });

    // Notify the employee and the new supervisor.
    if (employee.user?.id) {
      await this.notifications
        .notifyUser(
          employee.user.id,
          'Supervisor updated',
          `${supervisor.fullName} is now your supervisor for approvals.`,
          'SUPERVISOR_ASSIGNED',
          '/dashboard',
        )
        .catch(() => undefined);
    }
    if (supervisor.user?.id) {
      await this.notifications
        .notifyUser(
          supervisor.user.id,
          'New team member',
          `${employee.fullName} was assigned to you as a supervisee.`,
          'SUPERVISOR_ASSIGNED',
          '/dashboard',
        )
        .catch(() => undefined);
    }

    return { success: true, data: updated };
  }

  async bulkAssign(employeeIds: string[], supervisorId: string, actor: any) {
    const results: any[] = [];
    for (const employeeId of employeeIds) {
      results.push(await this.assign(employeeId, supervisorId, actor));
    }
    return { success: true, count: results.length, data: results };
  }

  async unassign(employeeId: string, actor: any) {
    const employee = await this.getEmployeeOrThrow(employeeId);
    assertInBranch(employee.branchId);
    if (!employee.supervisorId) {
      return { success: true, message: 'Employee had no supervisor', data: employee };
    }
    const updated = await this.prisma.employee.update({
      where: { id: employeeId },
      data: { supervisorId: null },
      select: { id: true, fullName: true, supervisorId: true },
    });
    await this.dropStaleTeamMemberships(employeeId, null);
    await this.audit.log({
      userId: actor?.id,
      action: 'SUPERVISOR_UNASSIGNED',
      resourceType: 'SupervisorAssignment',
      resourceId: employeeId,
      oldData: { supervisorId: employee.supervisorId },
      newData: { supervisorId: null },
    });
    if (employee.user?.id) {
      await this.notifications
        .notifyUser(
          employee.user.id,
          'Supervisor removed',
          'You no longer have an assigned supervisor.',
          'SUPERVISOR_UNASSIGNED',
          '/dashboard',
        )
        .catch(() => undefined);
    }
    return { success: true, data: updated };
  }

  /** Employees supervised by a given supervisor. */
  async reports(supervisorId: string) {
    const data = await this.prisma.employee.findMany({
      where: { supervisorId },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        position: true,
        department: { select: { id: true, name: true } },
      },
      orderBy: { fullName: 'asc' },
    });
    return { success: true, count: data.length, data };
  }

  // ── Supervisor teams ──────────────────────────────────────────────────
  // A "supervisor team" is a named group persisted in the existing Team table
  // (type 'SUPERVISION', teamLead = supervisor). Creating/editing one keeps each
  // member's Employee.supervisorId in sync with the team's supervisor so the
  // approval hierarchy routes correctly. Project teams (other Team.type values)
  // are untouched by these methods.
  private readonly SUPERVISION = 'SUPERVISION';

  private teamInclude() {
    return {
      teamLead: {
        select: { id: true, fullName: true, employeeCode: true, position: true },
      },
      members: {
        where: { isActive: true },
        include: {
          employee: {
            select: {
              id: true,
              fullName: true,
              employeeCode: true,
              position: true,
              supervisorId: true,
              department: { select: { id: true, name: true } },
            },
          },
        },
      },
    };
  }

  /**
   * Membership in a supervision team means exactly one thing: "this employee's
   * approvals route to the team's supervisor". So when the supervisor is changed
   * or cleared directly on the employee, memberships of teams led by anyone else
   * are no longer true and must go — otherwise the Teams page keeps listing a
   * grouping that decides nothing.
   */
  private async dropStaleTeamMemberships(
    employeeId: string,
    newSupervisorId: string | null,
  ) {
    await this.prisma.teamMember.deleteMany({
      where: {
        employeeId,
        team: {
          type: this.SUPERVISION,
          ...(newSupervisorId ? { teamLeadId: { not: newSupervisorId } } : {}),
        },
      },
    });
  }

  /**
   * Drop members whose supervisor no longer matches the team lead and purge the
   * rows behind them, so listings self-heal from assignments made before the
   * two directions were kept in sync (and from any future direct DB edit).
   */
  private async reconcileTeams(teams: any[]) {
    const stale: { teamId: string; employeeId: string }[] = [];
    const reconciled = teams.map((team) => {
      const members = (team.members ?? []).filter((m: any) => {
        const routed = m.employee?.supervisorId === team.teamLeadId;
        if (!routed) stale.push({ teamId: team.id, employeeId: m.employeeId });
        return routed;
      });
      return { ...team, members };
    });

    if (stale.length > 0) {
      await this.prisma.teamMember
        .deleteMany({ where: { OR: stale } })
        .catch(() => undefined); // display already correct; cleanup is best-effort
    }
    return reconciled;
  }

  async listTeams() {
    const data = await this.prisma.team.findMany({
      where: { type: this.SUPERVISION },
      include: this.teamInclude(),
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: await this.reconcileTeams(data) };
  }

  async getTeam(id: string) {
    const team = await this.prisma.team.findFirst({
      where: { id, type: this.SUPERVISION },
      include: this.teamInclude(),
    });
    if (!team) throw new NotFoundException('Team not found');
    const [reconciled] = await this.reconcileTeams([team]);
    return { success: true, data: reconciled };
  }

  async createTeam(
    dto: {
      name: string;
      supervisorId: string;
      memberIds?: string[];
      description?: string;
    },
    actor: any,
  ) {
    const supervisor = await this.prisma.employee.findUnique({
      where: { id: dto.supervisorId },
      select: {
        id: true,
        fullName: true,
        status: true,
        branchId: true,
        departmentId: true,
        user: { select: { id: true } },
      },
    });
    if (!supervisor) throw new NotFoundException('Supervisor not found');
    if (supervisor.status !== 'ACTIVE') {
      throw new BadRequestException('Supervisor must be an active employee');
    }
    assertInBranch(supervisor.branchId);

    // A supervisor never supervises themselves.
    const memberIds = (dto.memberIds ?? []).filter(
      (id) => id !== dto.supervisorId,
    );

    const code = `SUP-${Date.now().toString(36).toUpperCase()}`;
    const team = await this.prisma.team.create({
      data: {
        name: dto.name,
        code,
        description: dto.description ?? null,
        type: this.SUPERVISION,
        departmentId: supervisor.departmentId,
        teamLeadId: dto.supervisorId,
        members: {
          create: memberIds.map((employeeId) => ({
            employeeId,
            role: 'MEMBER',
          })),
        },
      },
      include: this.teamInclude(),
    });

    // Route these members' approvals to the supervisor.
    if (memberIds.length > 0) {
      await this.prisma.employee.updateMany({
        where: { id: { in: memberIds } },
        data: { supervisorId: dto.supervisorId },
      });
    }

    await this.audit.log({
      userId: actor?.id,
      action: 'SUPERVISOR_TEAM_CREATED',
      resourceType: 'Team',
      resourceId: team.id,
      newData: { name: dto.name, supervisorId: dto.supervisorId, memberIds },
    });

    await this.notifyMembers(memberIds, supervisor.fullName);
    if (supervisor.user?.id) {
      await this.notifications
        .notifyUser(
          supervisor.user.id,
          'New team',
          `You now supervise the team "${dto.name}".`,
          'SUPERVISOR_ASSIGNED',
          '/dashboard/my-team',
        )
        .catch(() => undefined);
    }

    return { success: true, data: team };
  }

  async updateTeam(
    id: string,
    dto: {
      name?: string;
      supervisorId?: string;
      memberIds?: string[];
      description?: string;
    },
    actor: any,
  ) {
    const team = await this.prisma.team.findFirst({
      where: { id, type: this.SUPERVISION },
      include: { members: { where: { isActive: true } } },
    });
    if (!team) throw new NotFoundException('Team not found');

    const newSupervisorId = dto.supervisorId ?? team.teamLeadId!;
    if (dto.supervisorId) {
      const sup = await this.prisma.employee.findUnique({
        where: { id: dto.supervisorId },
        select: { id: true, status: true, branchId: true },
      });
      if (!sup) throw new NotFoundException('Supervisor not found');
      if (sup.status !== 'ACTIVE') {
        throw new BadRequestException('Supervisor must be an active employee');
      }
      assertInBranch(sup.branchId);
    }

    const current = team.members.map((m) => m.employeeId);
    const next =
      dto.memberIds !== undefined
        ? dto.memberIds.filter((mid) => mid !== newSupervisorId)
        : current;
    const removed = current.filter((mid) => !next.includes(mid));
    const added = next.filter((mid) => !current.includes(mid));

    await this.prisma.$transaction(async (tx) => {
      await tx.team.update({
        where: { id },
        data: {
          name: dto.name ?? undefined,
          description: dto.description ?? undefined,
          teamLeadId: newSupervisorId,
        },
      });

      if (dto.memberIds !== undefined) {
        // Deactivate removed memberships and detach their supervisor (only if it
        // still points at this team's supervisor).
        if (removed.length > 0) {
          await tx.teamMember.deleteMany({
            where: { teamId: id, employeeId: { in: removed } },
          });
          await tx.employee.updateMany({
            where: { id: { in: removed }, supervisorId: team.teamLeadId },
            data: { supervisorId: null },
          });
        }
        if (added.length > 0) {
          await tx.teamMember.createMany({
            data: added.map((employeeId) => ({
              teamId: id,
              employeeId,
              role: 'MEMBER',
            })),
          });
        }
      }

      // All current members route to the (possibly new) supervisor.
      if (next.length > 0) {
        await tx.employee.updateMany({
          where: { id: { in: next } },
          data: { supervisorId: newSupervisorId },
        });
      }
    });

    await this.audit.log({
      userId: actor?.id,
      action: 'SUPERVISOR_TEAM_UPDATED',
      resourceType: 'Team',
      resourceId: id,
      oldData: { supervisorId: team.teamLeadId, members: current },
      newData: { supervisorId: newSupervisorId, members: next },
    });

    return this.getTeam(id);
  }

  async deleteTeam(id: string, actor: any) {
    const team = await this.prisma.team.findFirst({
      where: { id, type: this.SUPERVISION },
      include: { members: { where: { isActive: true } } },
    });
    if (!team) throw new NotFoundException('Team not found');

    const memberIds = team.members.map((m) => m.employeeId);
    await this.prisma.$transaction(async (tx) => {
      // Detach members whose supervisor is this team's lead, then delete the team
      // (TeamMember rows cascade).
      if (memberIds.length > 0 && team.teamLeadId) {
        await tx.employee.updateMany({
          where: { id: { in: memberIds }, supervisorId: team.teamLeadId },
          data: { supervisorId: null },
        });
      }
      await tx.team.delete({ where: { id } });
    });

    await this.audit.log({
      userId: actor?.id,
      action: 'SUPERVISOR_TEAM_DELETED',
      resourceType: 'Team',
      resourceId: id,
      oldData: { name: team.name, supervisorId: team.teamLeadId, members: memberIds },
    });

    return { success: true, message: 'Team deleted' };
  }

  private async notifyMembers(memberIds: string[], supervisorName: string) {
    if (memberIds.length === 0) return;
    const users = await this.prisma.user.findMany({
      where: { employee: { id: { in: memberIds } }, isActive: true },
      select: { id: true },
    });
    if (users.length === 0) return;
    await this.notifications
      .notifyUsers(
        users.map((u) => u.id),
        'Supervisor updated',
        `${supervisorName} is now your supervisor for approvals.`,
        'SUPERVISOR_ASSIGNED',
        '/dashboard',
      )
      .catch(() => undefined);
  }

  /** The supervisor of a given employee. */
  async supervisorOf(employeeId: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        supervisor: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
            position: true,
          },
        },
      },
    });
    if (!emp) throw new NotFoundException('Employee not found');
    return { success: true, data: emp.supervisor };
  }
}
