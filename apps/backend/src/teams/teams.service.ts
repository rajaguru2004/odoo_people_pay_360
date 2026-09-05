import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertInBranch,
  getEnvelopeBranchIds,
} from '../common/branch/branch-scope.util';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { AddTeamMemberDto } from './dto/add-team-member.dto';

/**
 * Supervisor teams share this table: they are `Team` rows with
 * `type: 'SUPERVISION'`, written and owned by `supervisors.service.ts`.
 *
 * `findAll` always excluded them. Every by-id method did not, so the org Teams
 * API could read, rename, delete and re-staff a row that exists to express an
 * approval chain — and `removeMember` here does not clear
 * `Employee.supervisorId`, so membership and routing came apart silently.
 * Every door onto this table now applies the same filter.
 */
const ORG_TEAM_ONLY = { type: { not: 'SUPERVISION' } } as const;

@Injectable()
export class TeamsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Teams were outside the branch engine entirely: `Team` and `TeamMember` are
   * not in `branch-scope.map.ts`, so the Prisma middleware never touched them
   * and a caller scoped to one branch listed and mutated teams in every other.
   *
   * They cannot be added to that map, because a team has no `branchId` of its
   * own and neither does a `Department` — a department's branch is expressed by
   * WHERE ITS PEOPLE ARE. So this reuses the rule the Organization module
   * already settled on for exactly the same problem: a department is in scope
   * if it has staff in the caller's envelope, or if it has no staff at all
   * (a new department belongs to whoever can see it).
   *
   * The two counts must run OUTSIDE branch scoping. Read through the
   * middleware, the second one can only ever see the caller's own branches, so
   * a department staffed entirely elsewhere reads as "nobody in it" and sails
   * through — which is the bug, not the fix.
   */
  private async departmentInBranchScope(departmentId: string): Promise<boolean> {
    const envelope = getEnvelopeBranchIds();
    if (envelope === null) return true;

    const { inScope, anyStaff } = await runWithBranchBypass(async () => ({
      inScope: await this.prisma.employee.count({
        where: { departmentId, branchId: { in: envelope } },
      }),
      anyStaff: await this.prisma.employee.count({ where: { departmentId } }),
    }));

    return inScope > 0 || anyStaff === 0;
  }

  /**
   * 404 for a branch the caller cannot reach — never 403, or the response
   * confirms the team exists. 403 for a department they can see but do not
   * head, which is the Organization module's convention for the same pair.
   */
  private async assertTeamInScope(
    team: { id: string; departmentId: string },
    user?: { role?: string; managedDepartmentIds?: string[]; departmentId?: string },
  ): Promise<void> {
    // Manager scope first. A MANAGER and the department they do not head are
    // inside the same company and the same branch envelope, so the honest
    // answer is 403 — "you may not", not "it does not exist". The 404 below is
    // reserved for the branch boundary, where confirming existence is itself
    // the leak.
    if (
      user?.role === 'MANAGER' &&
      !isDeptInManagerScope(user, team.departmentId)
    ) {
      throw new ForbiddenException(
        'You do not have permission to manage teams outside your department.',
      );
    }
    if (!(await this.departmentInBranchScope(team.departmentId))) {
      throw new NotFoundException('Team not found');
    }
  }

  async create(dto: CreateTeamDto, user?: any) {
    // Check if code exists
    const existing = await this.prisma.team.findUnique({
      where: { code: dto.code },
    });

    if (existing) {
      throw new ConflictException('Team code already exists');
    }

    // Validate department
    const department = await this.prisma.department.findUnique({
      where: { id: dto.departmentId },
    });

    if (!department) {
      throw new BadRequestException('Department not found');
    }

    if (!department.isActive) {
      throw new BadRequestException(
        'Cannot create team for inactive department',
      );
    }

    // A team is created INTO a department, so the same rule that governs
    // reading one governs where a new one may be put.
    await this.assertTeamInScope({ id: '', departmentId: dto.departmentId }, user);

    // Validate team lead
    if (dto.teamLeadId) {
      const teamLead = await this.prisma.employee.findUnique({
        where: { id: dto.teamLeadId },
      });

      if (!teamLead) {
        throw new BadRequestException('Team lead not found');
      }

      if (teamLead.departmentId !== dto.departmentId) {
        throw new BadRequestException(
          'Team lead must belong to the same department',
        );
      }

      if (teamLead.status !== 'ACTIVE') {
        throw new BadRequestException('Team lead must be an active employee');
      }
    }

    const team = await this.prisma.team.create({
      data: dto,
      include: {
        department: {
          select: { id: true, code: true, name: true },
        },
        teamLead: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
          },
        },
        _count: {
          select: { members: true },
        },
      },
    });

    return {
      success: true,
      message: 'Team created successfully',
      data: team,
    };
  }

  async findAll(user?: any, departmentId?: string) {
    // Exclude supervisor teams (managed under /supervisors/teams) so they don't
    // leak into the project-teams list.
    const where: any = { isActive: true, type: { not: 'SUPERVISION' } };

    if (departmentId) {
      where.departmentId = departmentId;
    }

    // Branch: a team belongs to whatever branch its department's people are in,
    // so the visible set is "departments with staff in my envelope, plus
    // departments with no staff at all". Computed outside branch scoping for
    // the reason given on `departmentInBranchScope`.
    const envelope = getEnvelopeBranchIds();
    if (envelope !== null) {
      const visibleDepartmentIds = await runWithBranchBypass(async () => {
        const [inScope, staffed] = await Promise.all([
          this.prisma.employee.findMany({
            where: { branchId: { in: envelope } },
            select: { departmentId: true },
            distinct: ['departmentId'],
          }),
          this.prisma.employee.findMany({
            select: { departmentId: true },
            distinct: ['departmentId'],
          }),
        ]);
        const inScopeIds = new Set(inScope.map((e) => e.departmentId));
        const staffedIds = new Set(staffed.map((e) => e.departmentId));
        const allDepartments = await this.prisma.department.findMany({
          select: { id: true },
        });
        return allDepartments
          .map((d) => d.id)
          .filter((id) => inScopeIds.has(id) || !staffedIds.has(id));
      });
      where.departmentId = departmentId
        ? { in: visibleDepartmentIds.filter((id) => id === departmentId) }
        : { in: visibleDepartmentIds };
    }

    // A MANAGER sees the teams of the departments they head, and no others.
    if (user?.role === 'MANAGER') {
      const managed: string[] =
        user.managedDepartmentIds?.length
          ? user.managedDepartmentIds
          : [user.departmentId].filter(Boolean);
      const current = where.departmentId?.in as string[] | undefined;
      where.departmentId = {
        in: current ? current.filter((id) => managed.includes(id)) : managed,
      };
    }

    const teams = await this.prisma.team.findMany({
      where,
      include: {
        department: {
          select: { id: true, code: true, name: true },
        },
        teamLead: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
          },
        },
        _count: {
          select: { members: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    return {
      success: true,
      data: teams,
    };
  }

  async findOne(id: string, user?: any) {
    const team = await this.prisma.team.findFirst({
      where: { id, ...ORG_TEAM_ONLY },
      include: {
        department: {
          select: { id: true, code: true, name: true },
        },
        teamLead: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
            email: true,
          },
        },
        members: {
          where: { isActive: true },
          include: {
            employee: {
              select: {
                id: true,
                employeeCode: true,
                fullName: true,
                position: true,
                email: true,
                avatarUrl: true,
              },
            },
          },
          orderBy: { role: 'asc' },
        },
        _count: {
          select: { members: true },
        },
      },
    });

    if (!team) {
      throw new NotFoundException('Team not found');
    }

    await this.assertTeamInScope(team, user);

    return {
      success: true,
      data: team,
    };
  }

  async update(id: string, dto: UpdateTeamDto, user?: any) {
    const team = await this.prisma.team.findFirst({
      where: { id, ...ORG_TEAM_ONLY },
    });

    if (!team) {
      throw new NotFoundException('Team not found');
    }

    await this.assertTeamInScope(team, user);

    // Check code uniqueness if changing
    if (dto.code && dto.code !== team.code) {
      const existing = await this.prisma.team.findUnique({
        where: { code: dto.code },
      });

      if (existing) {
        throw new ConflictException('Team code already exists');
      }
    }

    // Validate department if changing
    if (dto.departmentId && dto.departmentId !== team.departmentId) {
      const department = await this.prisma.department.findUnique({
        where: { id: dto.departmentId },
      });

      if (!department || !department.isActive) {
        throw new BadRequestException('Invalid department');
      }
    }

    // Validate team lead if changing
    if (dto.teamLeadId) {
      const teamLead = await this.prisma.employee.findUnique({
        where: { id: dto.teamLeadId },
      });

      if (!teamLead) {
        throw new BadRequestException('Team lead not found');
      }

      const targetDeptId = dto.departmentId || team.departmentId;
      if (teamLead.departmentId !== targetDeptId) {
        throw new BadRequestException(
          'Team lead must belong to the team department',
        );
      }
    }

    const updated = await this.prisma.team.update({
      where: { id },
      data: dto,
      include: {
        department: {
          select: { id: true, code: true, name: true },
        },
        teamLead: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
          },
        },
      },
    });

    return {
      success: true,
      message: 'Team updated successfully',
      data: updated,
    };
  }

  async delete(id: string, user?: any) {
    const team = await this.prisma.team.findFirst({
      where: { id, ...ORG_TEAM_ONLY },
      include: {
        // Only ACTIVE members block deletion — removed members are soft-deleted
        // (isActive=false) and must not keep the team undeletable forever.
        _count: {
          select: { members: { where: { isActive: true } } },
        },
      },
    });

    if (!team) {
      throw new NotFoundException('Team not found');
    }

    await this.assertTeamInScope(team, user);

    if (team._count.members > 0) {
      throw new BadRequestException(
        'Cannot delete team with members. Remove all members first.',
      );
    }

    // Soft delete
    await this.prisma.team.update({
      where: { id },
      data: { isActive: false },
    });

    return {
      success: true,
      message: 'Team deleted successfully',
    };
  }

  // Team Member Management
  async addMember(teamId: string, dto: AddTeamMemberDto, user?: any) {
    const team = await this.prisma.team.findFirst({
      where: { id: teamId, ...ORG_TEAM_ONLY },
    });

    if (!team || !team.isActive) {
      throw new NotFoundException('Team not found or inactive');
    }

    await this.assertTeamInScope(team, user);

    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // `addMember` takes a bare employeeId, so without this a caller scoped to
    // one branch could pull someone from another into a team by guessing an id.
    // 404, not 403: the branch boundary must not confirm that the id exists.
    assertInBranch(employee.branchId);

    if (employee.status !== 'ACTIVE') {
      throw new BadRequestException('Employee must be active');
    }

    if (employee.departmentId !== team.departmentId) {
      throw new BadRequestException(
        'Employee must belong to the same department as the team',
      );
    }

    // Check if already a member
    const existing = await this.prisma.teamMember.findFirst({
      where: {
        teamId,
        employeeId: dto.employeeId,
        isActive: true,
      },
    });

    if (existing) {
      throw new ConflictException('Employee is already a member of this team');
    }

    const member = await this.prisma.teamMember.create({
      data: {
        teamId,
        employeeId: dto.employeeId,
        role: dto.role || 'MEMBER',
        allocationPercentage: dto.allocationPercentage || 100,
        startDate: dto.startDate ? new Date(dto.startDate) : new Date(),
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        isActive: true,
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
            email: true,
          },
        },
      },
    });

    return {
      success: true,
      message: 'Team member added successfully',
      data: member,
    };
  }

  async removeMember(teamId: string, memberId: string, user?: any) {
    const member = await this.prisma.teamMember.findFirst({
      where: { id: memberId, team: ORG_TEAM_ONLY },
    });

    if (!member || member.teamId !== teamId) {
      throw new NotFoundException('Team member not found');
    }

    const owningTeam = await this.prisma.team.findUnique({
      where: { id: member.teamId },
      select: { id: true, departmentId: true },
    });
    if (owningTeam) await this.assertTeamInScope(owningTeam, user);

    // Soft delete
    await this.prisma.teamMember.update({
      where: { id: memberId },
      data: {
        isActive: false,
        endDate: new Date(),
      },
    });

    return {
      success: true,
      message: 'Team member removed successfully',
    };
  }

  async getEmployeeTeams(employeeId: string) {
    const memberships = await this.prisma.teamMember.findMany({
      where: {
        employeeId,
        isActive: true,
      },
      include: {
        team: {
          include: {
            department: {
              select: { id: true, code: true, name: true },
            },
            teamLead: {
              select: { id: true, fullName: true },
            },
          },
        },
      },
    });

    return {
      success: true,
      data: memberships.map((m) => ({
        ...m.team,
        membership: {
          role: m.role,
          allocationPercentage: m.allocationPercentage,
          startDate: m.startDate,
          endDate: m.endDate,
        },
      })),
    };
  }
}
