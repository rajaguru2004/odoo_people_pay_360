import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { ListTeamsDto } from './dto/list-teams.dto';
import { AddTeamMemberDto } from './dto/add-team-member.dto';
import { UpdateTeamMemberDto } from './dto/update-team-member.dto';

const TEAM_INCLUDE = {
  department: { select: { id: true, code: true, name: true } },
  teamLead: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      position: true,
      avatarUrl: true,
    },
  },
  // Only live memberships. A team that has closed off six people over a year
  // is not a team of six, and the roster card prints this number directly.
  _count: { select: { members: { where: { isActive: true } } } },
} satisfies Prisma.TeamInclude;

const TEAM_MEMBER_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      position: true,
      avatarUrl: true,
      status: true,
    },
  },
} satisfies Prisma.TeamMemberInclude;

/** Midnight UTC of the given instant — date-only columns are stored there. */
function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

@Injectable()
export class TeamsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(query: ListTeamsDto) {
    return this.prisma.team.findMany({
      where: {
        ...(query.departmentId ? { departmentId: query.departmentId } : {}),
        ...(query.includeInactive ? {} : { isActive: true }),
      },
      include: TEAM_INCLUDE,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: {
        ...TEAM_INCLUDE,
        members: {
          include: TEAM_MEMBER_INCLUDE,
          // Live members first, then leads before the rest: the roster is read
          // top-down and a closed membership is history, not staffing.
          orderBy: [
            { isActive: 'desc' },
            { role: 'asc' },
            { employee: { employeeCode: 'asc' } },
          ],
        },
      },
    });
    if (!team) throw new NotFoundException('Team not found');
    return team;
  }

  async create(dto: CreateTeamDto) {
    const clash = await this.prisma.team.findUnique({
      where: { code: dto.code },
    });
    if (clash)
      throw new ConflictException(`Team code ${dto.code} is already in use`);

    await this.assertDepartmentExists(dto.departmentId);
    if (dto.teamLeadId) await this.assertEmployeeExists(dto.teamLeadId);

    return this.prisma.team.create({
      data: dto,
      include: TEAM_INCLUDE,
    });
  }

  async update(id: string, dto: UpdateTeamDto) {
    const current = await this.findOne(id);

    if (dto.code && dto.code !== current.code) {
      const clash = await this.prisma.team.findUnique({
        where: { code: dto.code },
      });
      if (clash)
        throw new ConflictException(`Team code ${dto.code} is already in use`);
    }

    if (dto.departmentId) await this.assertDepartmentExists(dto.departmentId);
    if (dto.teamLeadId) await this.assertEmployeeExists(dto.teamLeadId);

    return this.prisma.team.update({
      where: { id },
      // `teamLeadId: null` must survive as an explicit null so a team can be
      // left without a lead rather than keeping the previous one.
      data: dto,
      include: TEAM_INCLUDE,
    });
  }

  /**
   * Refuses while anyone is still on the roster.
   *
   * `onDelete: Cascade` on TeamMember would take the memberships with it, and
   * the allocation those people were carrying would disappear from the staffing
   * picture without anybody being told where they went.
   */
  async remove(id: string) {
    const team = await this.findOne(id);
    const active = team._count.members;
    if (active > 0) {
      throw new BadRequestException(
        `${active} member(s) are still on this team. Remove them first.`,
      );
    }
    await this.prisma.team.delete({ where: { id } });
    return { deleted: true };
  }

  async addMember(teamId: string, dto: AddTeamMemberDto) {
    await this.assertTeamExists(teamId);
    await this.assertEmployeeExists(dto.employeeId);

    const startDate = dto.startDate ? new Date(dto.startDate) : new Date();

    // `@@unique([teamId, employeeId])` means a person rejoining is the SAME row
    // reopened, never a second one. A duplicate would double-count them in
    // every roster figure — the member count, the allocation total, the
    // department's team headcount — while looking like an ordinary insert.
    return this.prisma.teamMember.upsert({
      where: { teamId_employeeId: { teamId, employeeId: dto.employeeId } },
      create: {
        teamId,
        employeeId: dto.employeeId,
        role: dto.role,
        allocation: dto.allocation,
        startDate,
      },
      update: {
        ...(dto.role ? { role: dto.role } : {}),
        ...(dto.allocation !== undefined ? { allocation: dto.allocation } : {}),
        startDate,
        endDate: null,
        isActive: true,
      },
      include: TEAM_MEMBER_INCLUDE,
    });
  }

  async updateMember(
    teamId: string,
    memberId: string,
    dto: UpdateTeamMemberDto,
  ) {
    await this.findMemberOrThrow(teamId, memberId);

    return this.prisma.teamMember.update({
      where: { id: memberId },
      data: {
        ...(dto.role ? { role: dto.role } : {}),
        ...(dto.allocation !== undefined ? { allocation: dto.allocation } : {}),
        ...(dto.endDate ? { endDate: new Date(dto.endDate) } : {}),
      },
      include: TEAM_MEMBER_INCLUDE,
    });
  }

  /**
   * Soft when the membership has actually run, hard when it never did.
   *
   * A row created today and removed today produced no roster history worth
   * keeping, and leaving it behind as a closed membership makes the team look
   * like it churned. Once the start date is in the past somebody appeared on
   * that roster on a day that has already been reported on, so the row stays
   * and is closed off instead.
   */
  async removeMember(teamId: string, memberId: string) {
    const member = await this.findMemberOrThrow(teamId, memberId);
    const today = startOfUtcDay(new Date());
    const hasHistory = startOfUtcDay(member.startDate) < today;

    if (!hasHistory) {
      await this.prisma.teamMember.delete({ where: { id: memberId } });
      return { removed: true, retained: false };
    }

    await this.prisma.teamMember.update({
      where: { id: memberId },
      data: { isActive: false, endDate: new Date() },
    });
    return { removed: true, retained: true };
  }

  private async findMemberOrThrow(teamId: string, memberId: string) {
    const member = await this.prisma.teamMember.findUnique({
      where: { id: memberId },
    });
    // Checking the parent as well as the id stops a member id from one team
    // being edited through another team's URL.
    if (!member || member.teamId !== teamId)
      throw new NotFoundException('Team member not found');
    return member;
  }

  private async assertTeamExists(id: string) {
    const found = await this.prisma.team.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Team not found');
  }

  private async assertDepartmentExists(id: string) {
    const found = await this.prisma.department.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Department not found');
  }

  private async assertEmployeeExists(id: string) {
    const found = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Employee not found');
  }
}
