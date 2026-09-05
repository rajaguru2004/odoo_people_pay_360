import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { QueryProjectDto } from './dto/query-project.dto';
import {
  AddProjectMemberDto,
  UpdateProjectMemberDto,
} from './dto/project-member.dto';
import {
  presetRolesCreateData,
  OWNER_ROLE_SLUG,
} from './rbac/permissions.constants';

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
    private notifications: NotificationsService,
  ) {}

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Mint the next `PROJ-####` from a Postgres SEQUENCE.
   *
   * R6 / plan §5.5 F11 — the defect this replaces: the generator used to read
   * the LEXICALLY largest `project_code` in the table and
   * `parseInt(code.replace('PROJ-',''), 10) + 1` it, assuming every row matched
   * `PROJ-<digits>`. Any code whose first letter sorts above 'P' (an imported
   * code, a hand-assigned one, the `WP…` codes the e2e fixtures seed) became
   * that maximum, the parse yielded NaN, and the generator emitted the LITERAL
   * string `PROJ-0NaN`. `project_code` is @unique, so exactly one row could
   * hold it: the first create returned 201 with a nonsense code and every
   * subsequent create in that database answered 500 until the row was deleted.
   *
   * A sequence cannot be poisoned by an unrelated row's format, and — unlike
   * any read-then-write MAX() — is atomic, so two concurrent creates can never
   * be handed the same number. Same mechanism as `LettersService.nextSerial()`
   * (`letter_serial_seq`). Created by migration
   * `20260818120000_add_project_code_sequence` for dev/prod and mirrored into
   * `prisma/e2e-partial-indexes.sql`, which is how the e2e template gets the
   * objects `prisma db push` cannot express.
   */
  private async nextProjectCode(): Promise<string> {
    const rows = await this.prisma.$queryRaw<Array<{ nextval: bigint }>>`
      SELECT nextval('project_code_seq') AS nextval
    `;
    const next = Number(rows[0]?.nextval ?? 0);
    return `PROJ-${String(next).padStart(4, '0')}`;
  }

  /**
   * The column names a P2002 names, as a string — `''` for anything that is not
   * a unique-constraint violation. Postgres reports the DB column, so callers
   * match on `project_code`/`slug`.
   */
  private static conflictTarget(e: unknown): string {
    return e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
      ? String((e.meta as { target?: unknown } | undefined)?.target ?? '')
      : '';
  }

  /**
   * R46 — a well-formed but unknown relation id used to reach Prisma as a
   * P2003 and leave the caller with a bare 500 that named nothing. Check the
   * ids up front and say which one is wrong.
   */
  private async assertRelationsExist(dto: {
    workflowId?: string;
    departmentId?: string;
    teamId?: string;
    ownerId?: string;
  }) {
    const checks: Array<{
      field: string;
      id: string;
      found: Promise<unknown>;
    }> = [];
    if (dto.workflowId)
      checks.push({
        field: 'workflowId',
        id: dto.workflowId,
        found: this.prisma.workflow.findUnique({
          where: { id: dto.workflowId },
          select: { id: true },
        }),
      });
    if (dto.departmentId)
      checks.push({
        field: 'departmentId',
        id: dto.departmentId,
        found: this.prisma.department.findUnique({
          where: { id: dto.departmentId },
          select: { id: true },
        }),
      });
    if (dto.teamId)
      checks.push({
        field: 'teamId',
        id: dto.teamId,
        found: this.prisma.team.findUnique({
          where: { id: dto.teamId },
          select: { id: true },
        }),
      });
    if (dto.ownerId)
      checks.push({
        field: 'ownerId',
        id: dto.ownerId,
        found: this.prisma.employee.findUnique({
          where: { id: dto.ownerId },
          select: { id: true },
        }),
      });

    if (checks.length === 0) return;
    const found = await Promise.all(checks.map((c) => c.found));
    const missing = checks.filter((_, i) => !found[i]);
    if (missing.length > 0) {
      throw new BadRequestException(
        missing.map((m) => `${m.field} "${m.id}" does not exist`),
      );
    }
  }

  /**
   * R47 — `addMember`/`create` used to hand unchecked employee ids straight to
   * a `$transaction` of upserts. One unknown id failed the FK, rolled the whole
   * batch back, and the caller got "Internal server error" with no way to tell
   * which id was at fault or that the good ones had been discarded.
   */
  private async assertEmployeesExist(ids: string[], field: string) {
    if (ids.length === 0) return;
    // `findUnique`, deliberately, NOT `findMany`: the branch middleware scopes
    // findMany/findFirst but not findUnique (BRANCH_READ_ACTIONS), and Project
    // and ProjectMember are absent from `branch-scope.map.ts` — a project is a
    // cross-branch collaboration surface by design (R10). A branch-scoped
    // findMany here would refuse a member the FK itself accepts, turning a
    // validation guard into a tenancy rule nobody asked for.
    const rows = await Promise.all(
      ids.map((id) =>
        this.prisma.employee.findUnique({
          where: { id },
          select: { id: true },
        }),
      ),
    );
    const known = new Set(rows.filter(Boolean).map((r) => r!.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        missing.map((id) => `${field}: no employee exists with id "${id}"`),
      );
    }
  }

  /**
   * R48 — the project date pair had no cross-field check anywhere: not in
   * `CreateProjectDto`, not in `UpdateProjectDto` (`PartialType`, which drops
   * any rule that needs both fields), not in the service. It lives here so a
   * PATCH that sends only ONE half is still checked against the stored other
   * half — the case a DTO-level rule cannot see.
   */
  private assertDateOrder(start: Date | null, end: Date | null) {
    if (start && end && end.getTime() < start.getTime()) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 150);
  }

  private async uniqueSlug(base: string): Promise<string> {
    let slug = base || 'project';
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const existing = await this.prisma.project.findUnique({
        where: { slug },
      });
      if (!existing) return slug;
      slug = `${base}-${n++}`;
    }
  }

  private projectInclude = {
    owner: {
      select: {
        id: true,
        fullName: true,
        employeeCode: true,
        email: true,
        avatarUrl: true,
      },
    },
    // R63 / R64 — `DELETE /departments/:id` and `DELETE /teams/:id` are SOFT
    // deletes (`isActive:false`), so the `SetNull` FKs on Project never fire
    // and the project keeps pointing at a row `GET /departments` and
    // `GET /teams` have already dropped. Projecting `isActive` is what lets a
    // caller tell a retired link from a live one instead of rendering a name
    // that exists nowhere else.
    department: {
      select: { id: true, name: true, code: true, isActive: true },
    },
    team: { select: { id: true, name: true, code: true, isActive: true } },
    workflow: {
      include: { statuses: { orderBy: { position: 'asc' as const } } },
    },
    _count: { select: { tasks: true, members: true, sprints: true } },
  };

  // Visibility gate: ADMIN/HR_MANAGER see all; others see public/internal,
  // owned, member-of, or department-scoped projects.
  private buildWhere(query: QueryProjectDto, user: any) {
    const where: any = { deletedAt: null };

    if (query.status) where.status = query.status;
    if (query.priority) where.priority = query.priority;
    if (query.departmentId) where.departmentId = query.departmentId;
    if (query.isArchived !== undefined)
      where.isArchived = String(query.isArchived) === 'true';
    else where.isArchived = false;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { projectCode: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (!['ADMIN', 'HR_MANAGER'].includes(user?.role)) {
      // Non-admins see only projects they own or are a member of (plus public/internal)
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { visibility: { in: ['INTERNAL', 'PUBLIC'] } },
            { ownerId: user?.employeeId },
            { members: { some: { employeeId: user?.employeeId } } },
          ],
        },
      ];
    }

    return where;
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  async create(dto: CreateProjectDto, user: any) {
    const startDate = dto.startDate ? new Date(dto.startDate) : null;
    const endDate = dto.endDate ? new Date(dto.endDate) : null;
    this.assertDateOrder(startDate, endDate);

    await this.assertRelationsExist(dto);

    const slug = await this.uniqueSlug(dto.slug || this.slugify(dto.name));

    let workflowId = dto.workflowId;
    if (!workflowId) {
      const wf = await this.prisma.workflow.findFirst({
        where: { isDefault: true },
      });
      workflowId = wf?.id;
    }

    const ownerId = dto.ownerId ?? user?.employeeId ?? null;
    const memberIds = new Set(dto.memberIds || []);
    await this.assertEmployeesExist(Array.from(memberIds), 'memberIds');
    if (ownerId) memberIds.add(ownerId);

    const data = {
      name: dto.name,
      slug,
      taskPrefix: dto.taskPrefix,
      description: dto.description,
      color: dto.color || '#00358F',
      avatar: dto.avatar,
      status: (dto.status ?? 'PLANNING') as any,
      priority: (dto.priority ?? 'MEDIUM') as any,
      visibility: (dto.visibility ?? 'PRIVATE') as any,
      startDate,
      endDate,
      workflowId,
      departmentId: dto.departmentId,
      teamId: dto.teamId,
      ownerId,
      createdById: user?.id,
      members: {
        create: Array.from(memberIds).map((employeeId) => ({
          employeeId,
          role: employeeId === ownerId ? ('OWNER' as any) : ('MEMBER' as any),
        })),
      },
      roles: { create: presetRolesCreateData() },
    };

    // The sequence makes a duplicate `project_code` all but impossible; the
    // retry is here for the one case it cannot cover — a row whose code was
    // assigned by hand or imported at a number the sequence has not passed yet.
    // R45: `uniqueSlug()` is still a read-then-write, so two concurrent creates
    // of the same name both see the slug free. The loser used to surface the
    // raw P2002 as a 500; it now gets a 409 the UI can act on.
    let project;
    for (let attempt = 0; ; attempt++) {
      try {
        project = await this.prisma.project.create({
          data: { ...data, projectCode: await this.nextProjectCode() },
          include: { ...this.projectInclude, members: true, roles: true },
        });
        break;
      } catch (e) {
        const target = ProjectsService.conflictTarget(e);
        if (target.includes('slug')) {
          throw new ConflictException(
            `A project with the slug "${slug}" already exists`,
          );
        }
        if (
          attempt < 4 &&
          (target.includes('project_code') || target.includes('projectCode'))
        ) {
          continue;
        }
        throw e;
      }
    }

    // Map each seeded member onto its project role (owner → owner role,
    // everyone else → the default role).
    const ownerRole = project.roles.find((r) => r.slug === OWNER_ROLE_SLUG);
    const defaultRole =
      project.roles.find((r) => r.isDefault) ??
      project.roles.find((r) => r.slug === 'member');
    await this.prisma.$transaction(
      project.members.map((m) =>
        this.prisma.projectMember.update({
          where: { id: m.id },
          data: {
            roleId: m.employeeId === ownerId ? ownerRole?.id : defaultRole?.id,
          },
        }),
      ),
    );

    return {
      success: true,
      message: 'Project created successfully',
      data: project,
    };
  }

  async findAll(query: QueryProjectDto, user: any) {
    const page = Number(query.page) || 1;
    const limit = Math.min(Number(query.limit) || 20, 200);
    const skip = (page - 1) * limit;
    const where = this.buildWhere(query, user);
    const sortBy = query.sortBy ?? 'createdAt';
    const sortOrder = query.sortOrder ?? 'desc';

    const [projects, total] = await Promise.all([
      this.prisma.project.findMany({
        where,
        skip,
        take: limit,
        include: this.projectInclude,
        orderBy: { [sortBy]: sortOrder },
      }),
      this.prisma.project.count({ where }),
    ]);

    return {
      success: true,
      data: projects,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getStats(user: any) {
    const where = this.buildWhere({} as QueryProjectDto, user);
    const [total, active, completed, onHold] = await Promise.all([
      this.prisma.project.count({ where }),
      this.prisma.project.count({ where: { ...where, status: 'ACTIVE' } }),
      this.prisma.project.count({ where: { ...where, status: 'COMPLETED' } }),
      this.prisma.project.count({ where: { ...where, status: 'ON_HOLD' } }),
    ]);
    return {
      success: true,
      data: { total, active, completed, onHold },
    };
  }

  async findOne(id: string, user: any) {
    const project = await this.prisma.project.findFirst({
      where: { id, deletedAt: null },
      include: {
        ...this.projectInclude,
        members: {
          include: {
            employee: {
              select: {
                id: true,
                fullName: true,
                employeeCode: true,
                email: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    return { success: true, data: project };
  }

  async findBySlug(slug: string, user: any) {
    const project = await this.prisma.project.findFirst({
      where: { slug, deletedAt: null },
      include: {
        ...this.projectInclude,
        members: {
          include: {
            employee: {
              select: {
                id: true,
                fullName: true,
                employeeCode: true,
                email: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    return { success: true, data: project };
  }

  async update(id: string, dto: UpdateProjectDto, user: any) {
    const existing = await this.prisma.project.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Project not found');

    const data: any = {};
    const fields = [
      'name',
      'taskPrefix',
      'description',
      'color',
      'avatar',
      'status',
      'priority',
      'visibility',
      'workflowId',
      'departmentId',
      'teamId',
      'ownerId',
    ];
    for (const f of fields) {
      if ((dto as any)[f] !== undefined) data[f] = (dto as any)[f];
    }
    if (dto.startDate !== undefined)
      data.startDate = dto.startDate ? new Date(dto.startDate) : null;
    if (dto.endDate !== undefined)
      data.endDate = dto.endDate ? new Date(dto.endDate) : null;

    // R48 — compare the EFFECTIVE pair, so a PATCH that sends only one half is
    // still checked against the half already stored.
    this.assertDateOrder(
      data.startDate !== undefined ? data.startDate : existing.startDate,
      data.endDate !== undefined ? data.endDate : existing.endDate,
    );

    // R46 — the same unchecked foreign keys as on create.
    await this.assertRelationsExist(dto);

    if (dto.slug !== undefined && dto.slug !== existing.slug)
      data.slug = await this.uniqueSlug(dto.slug);

    let project;
    try {
      project = await this.prisma.project.update({
        where: { id },
        data,
        include: this.projectInclude,
      });
    } catch (e) {
      // R45, same read-then-write on the rename path.
      if (ProjectsService.conflictTarget(e).includes('slug')) {
        throw new ConflictException(
          `A project with the slug "${data.slug}" already exists`,
        );
      }
      throw e;
    }
    return {
      success: true,
      message: 'Project updated successfully',
      data: project,
    };
  }

  async remove(id: string, user: any) {
    const existing = await this.prisma.project.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Project not found');
    await this.prisma.project.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { success: true, message: 'Project deleted successfully' };
  }

  async setArchived(id: string, archived: boolean) {
    const existing = await this.prisma.project.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Project not found');
    const project = await this.prisma.project.update({
      where: { id },
      data: { isArchived: archived },
      include: this.projectInclude,
    });
    return {
      success: true,
      message: archived ? 'Project archived' : 'Project unarchived',
      data: project,
    };
  }

  // ─── Analytics ───────────────────────────────────────────────────────────────

  async getCharts(slug: string) {
    const project = await this.prisma.project.findFirst({
      where: { slug, deletedAt: null },
      select: { id: true, workflowId: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    const taskWhere = { projectId: project.id, deletedAt: null };

    const [statuses, tasks, byPriority, byType, sprints] = await Promise.all([
      this.prisma.projectTaskStatus.findMany({
        where: { workflowId: project.workflowId ?? undefined, deletedAt: null },
        orderBy: { position: 'asc' },
      }),
      this.prisma.task.findMany({
        where: taskWhere,
        select: {
          statusId: true,
          storyPoints: true,
          sprintId: true,
          workflowStatus: { select: { category: true } },
        },
      }),
      this.prisma.task.groupBy({
        by: ['priority'],
        where: taskWhere,
        _count: { _all: true },
      }),
      this.prisma.task.groupBy({
        by: ['type'],
        where: taskWhere,
        _count: { _all: true },
      }),
      this.prisma.sprint.findMany({
        where: { projectId: project.id, isArchived: false },
        select: { id: true, name: true, status: true },
      }),
    ]);

    const statusDistribution = statuses.map((s) => ({
      name: s.name,
      color: s.color,
      value: tasks.filter((t) => t.statusId === s.id).length,
    }));

    const total = tasks.length;
    const done = tasks.filter(
      (t) => t.workflowStatus?.category === 'DONE',
    ).length;
    const inProgress = tasks.filter(
      (t) => t.workflowStatus?.category === 'IN_PROGRESS',
    ).length;

    // Sprint velocity: completed story points per sprint
    const velocity = sprints.map((sp) => ({
      name: sp.name,
      points: tasks
        .filter(
          (t) => t.sprintId === sp.id && t.workflowStatus?.category === 'DONE',
        )
        .reduce((sum, t) => sum + (t.storyPoints ?? 0), 0),
    }));

    return {
      success: true,
      data: {
        kpi: {
          total,
          done,
          inProgress,
          todo: total - done - inProgress,
          completionRate: total ? Math.round((done / total) * 100) : 0,
        },
        statusDistribution,
        byPriority: byPriority.map((p) => ({
          name: p.priority,
          value: p._count._all,
        })),
        byType: byType.map((t) => ({ name: t.type, value: t._count._all })),
        velocity,
      },
    };
  }

  // ─── Members ─────────────────────────────────────────────────────────────────

  private memberRoleSelect = {
    id: true,
    name: true,
    slug: true,
    color: true,
    permissions: true,
    isSystem: true,
    isDefault: true,
  };

  async getMembers(projectId: string) {
    const members = await this.prisma.projectMember.findMany({
      where: { projectId },
      include: {
        employee: {
          select: {
            id: true,
            fullName: true,
            employeeCode: true,
            email: true,
            avatarUrl: true,
            position: true,
          },
        },
        projectRole: { select: this.memberRoleSelect },
      },
      orderBy: { joinedAt: 'asc' },
    });
    return { success: true, data: members };
  }

  /**
   * Resolve the ProjectRole to assign a member: prefer roleId, then a
   * slug/name match, otherwise the project's default role. Returns the role
   * plus the legacy enum value to keep the `role` column in sync.
   */
  private async resolveMemberRole(
    projectId: string,
    dto: { roleId?: string; role?: string },
  ) {
    const roles = await this.prisma.projectRole.findMany({
      where: { projectId },
    });
    let role = dto.roleId ? roles.find((r) => r.id === dto.roleId) : undefined;
    if (dto.roleId && !role)
      throw new BadRequestException('Role does not belong to this project');

    // R50 — a legacy role NAME that matched nothing used to fall silently
    // through to the project default: `{role:'SUPREME_LEADER'}` answered 201
    // and the caller was told nothing. An unrecognised NON-EMPTY name is now
    // refused. Absent, empty and blank still mean "use the default" — and the
    // match is still case-insensitive on the slug, which is what keeps
    // `NewProjectModal`'s literal 'MEMBER' working.
    const wanted = dto.role?.trim().toLowerCase();
    if (!role && wanted) {
      role =
        roles.find((r) => r.slug.toLowerCase() === wanted) ??
        roles.find((r) => r.name.toLowerCase() === wanted);
      if (!role)
        throw new BadRequestException(
          `Unknown project role "${dto.role}" — pass a roleId, or one of: ${roles
            .map((r) => r.slug)
            .join(', ')}`,
        );
    }

    if (!role)
      role =
        roles.find((r) => r.isDefault) ??
        roles.find((r) => r.slug === 'member');
    if (!role) throw new BadRequestException('Project has no roles configured');

    const legacy = ['OWNER', 'MANAGER', 'MEMBER', 'VIEWER'].includes(
      role.slug.toUpperCase(),
    )
      ? (role.slug.toUpperCase() as any)
      : ('MEMBER' as any);
    return { roleId: role.id, legacy };
  }

  async addMember(projectId: string, dto: AddProjectMemberDto) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
    });
    if (!project) throw new NotFoundException('Project not found');

    const ids = new Set(dto.employeeIds || []);
    if (dto.employeeId) ids.add(dto.employeeId);
    if (ids.size === 0)
      throw new BadRequestException('employeeId or employeeIds required');

    // R47 — validated BEFORE the upsert transaction: one unknown id used to
    // fail the FK, roll the whole batch back and report "Internal server
    // error", so a bulk add silently discarded the good ids too.
    await this.assertEmployeesExist(
      Array.from(ids),
      dto.employeeIds?.length ? 'employeeIds' : 'employeeId',
    );

    const { roleId, legacy } = await this.resolveMemberRole(projectId, dto);

    // Detect which IDs are genuinely new before upserting
    const existing = await this.prisma.projectMember.findMany({
      where: { projectId, employeeId: { in: Array.from(ids) } },
      select: { employeeId: true },
    });
    const existingIds = new Set(existing.map((m) => m.employeeId));
    const newIds = Array.from(ids).filter((id) => !existingIds.has(id));

    const created = await this.prisma.$transaction(
      Array.from(ids).map((employeeId) =>
        this.prisma.projectMember.upsert({
          where: { projectId_employeeId: { projectId, employeeId } },
          update: { roleId, role: legacy },
          create: { projectId, employeeId, roleId, role: legacy },
        }),
      ),
    );

    // Fire-and-forget: resolve role display name, then notify new members
    if (newIds.length > 0) {
      this.prisma.projectRole
        .findUnique({ where: { id: roleId }, select: { name: true } })
        .then((r) => {
          const roleName = r?.name ?? (legacy as string);
          this.notifyProjectMembersAdded(newIds, project, roleName).catch(
            () => {},
          );
        })
        .catch(() => {});
    }

    return { success: true, message: 'Member(s) added', data: created };
  }

  private async notifyProjectMembersAdded(
    newIds: string[],
    project: { name: string; projectCode: string; slug: string },
    roleName: string,
  ) {
    const frontendUrl =
      process.env.FRONTEND_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      'http://localhost:3000';
    const projectUrl = `${frontendUrl}/dashboard/projects/${project.slug}`;

    for (const employeeId of newIds) {
      try {
        const emp = await this.prisma.employee.findUnique({
          where: { id: employeeId },
          select: { email: true, fullName: true },
        });
        if (!emp) continue;

        await this.mailService.sendProjectMemberAdded(emp.email, {
          recipientName: emp.fullName,
          projectName: project.name,
          projectCode: project.projectCode,
          roleName,
          projectUrl,
        });

        const user = await this.prisma.user.findFirst({
          where: { employeeId },
          select: { id: true },
        });
        if (user) {
          await this.notifications.notifyUser(
            user.id,
            'Added to Project',
            `You have been added to project ${project.name} (${project.projectCode}) as ${roleName}.`,
            // Discriminating type, not 'INFO': it is what selects the WhatsApp
            // template, and 'INFO' resolves to none.
            'PROJECT_MEMBER_ADDED',
            `/dashboard/projects/${project.slug}`,
            {
              waData: {
                projectName: `${project.name} (${project.projectCode})`,
                role: roleName,
              },
            },
          );
        }
      } catch {
        // ignore per-employee errors, continue loop
      }
    }
  }

  async updateMember(
    projectId: string,
    memberId: string,
    dto: UpdateProjectMemberDto,
  ) {
    const member = await this.prisma.projectMember.findFirst({
      where: { id: memberId, projectId },
    });
    if (!member) throw new NotFoundException('Member not found');
    const { roleId, legacy } = await this.resolveMemberRole(projectId, dto);
    const updated = await this.prisma.projectMember.update({
      where: { id: memberId },
      data: { roleId, role: legacy },
      include: { projectRole: { select: this.memberRoleSelect } },
    });
    return { success: true, message: 'Member role updated', data: updated };
  }

  async removeMember(projectId: string, memberId: string) {
    const member = await this.prisma.projectMember.findFirst({
      where: { id: memberId, projectId },
    });
    if (!member) throw new NotFoundException('Member not found');
    await this.prisma.projectMember.delete({ where: { id: memberId } });
    return { success: true, message: 'Member removed' };
  }

  /**
   * Every live project that currently has NO owner, newest change first.
   *
   * R12, third branch of the handover rule. When a hard delete finds no heir at
   * all — no other member carrying the `owner` slug, and a creator who has left
   * too — the project is allowed to keep a null `ownerId` rather than blocking
   * the delete of a person the business has already decided to erase. That
   * decision is only defensible if the result is FINDABLE, and until now it was
   * not: nothing in the API answered "which projects have nobody in charge?",
   * so an ownerless project was indistinguishable from a healthy one except by
   * reading the column directly.
   *
   * Three things now make the same state discoverable, deliberately at three
   * different distances:
   *   1. this route, for an admin looking on purpose;
   *   2. a `PROJECT_OWNER_ORPHANED` AuditLog row on the project, which puts it
   *      in the project's own activity feed beside every other project change;
   *   3. a `logger.warn` at the moment it happens, for whoever watches logs.
   *
   * ADMIN/HR_MANAGER only — it is a whole-estate query, deliberately not
   * membership-scoped, because the people who can fix an ownerless project are
   * exactly the people who are not on it.
   */
  async findOwnerless() {
    const projects = await this.prisma.project.findMany({
      where: { ownerId: null, deletedAt: null },
      select: {
        id: true,
        projectCode: true,
        name: true,
        slug: true,
        status: true,
        visibility: true,
        isArchived: true,
        departmentId: true,
        createdById: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { members: true, tasks: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      success: true,
      data: projects,
      meta: { total: projects.length },
    };
  }

  async getActivity(
    projectId: string,
    query: { page?: number; limit?: number },
  ) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const tasks = await this.prisma.task.findMany({
      where: { projectId },
      select: { id: true },
    });
    const taskIds = tasks.map((t) => t.id);

    const where: any = {
      OR: [
        { resourceType: 'Project', resourceId: projectId },
        ...(taskIds.length > 0
          ? [{ resourceType: 'Task', resourceId: { in: taskIds } }]
          : []),
      ],
    };

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              employee: { select: { fullName: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      success: true,
      data: logs,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// R12 + R13 — owner handover on a HARD employee delete
// ─────────────────────────────────────────────────────────────────────────────

/** What one project's ownership handover did. Returned so the caller can log. */
export interface ProjectOwnerHandover {
  projectId: string;
  projectCode: string;
  projectName: string;
  previousOwnerId: string;
  newOwnerId: string | null;
  /** Which rule in the ladder produced `newOwnerId`. */
  via: 'owner-role-member' | 'creator' | 'none';
}

const handoverLogger = new Logger('ProjectOwnerHandover');

/**
 * A member counts as holding owner rights when their PROJECT ROLE says so.
 *
 * `ProjectMember` carries two role columns: the modern `roleId` → `ProjectRole`
 * (whose `slug` is what `ProjectAccessService.getAccess()` reads) and the legacy
 * `role` enum. The slug is authoritative; the enum is only consulted for a row
 * that has no `roleId` at all, which is what a project created before the RBAC
 * presets — or by a caller that wrote the enum directly — looks like.
 */
function holdsOwnerRole(member: {
  role: string;
  roleId: string | null;
  projectRole: { slug: string } | null;
}): boolean {
  if (member.projectRole) return member.projectRole.slug === OWNER_ROLE_SLUG;
  if (member.roleId) return false;
  return member.role === 'OWNER';
}

/**
 * Hand every project this employee OWNS to somebody else, and leave a record of
 * the memberships the delete is about to erase — both inside the caller's
 * transaction, so no observer ever sees an ownerless intermediate state.
 *
 * ── The defect (findings R12 + R13) ────────────────────────────────────────
 * `Project.ownerId` is `onDelete: SetNull` and `ProjectMember.employeeId` is
 * `onDelete: Cascade`. A HARD delete of an employee therefore nulled the
 * project's owner AND erased that person's membership row in the same instant,
 * severing BOTH routes `ProjectAccessService.getAccess()` has to owner rights:
 * `project.ownerId === employeeId`, and a membership row whose role slug is
 * `owner`. Nobody inherited. The surviving members got 403 on `PATCH` and only
 * a global ADMIN/HR_MANAGER could act on the project again — and the membership
 * row went with no tombstone of any kind, so nothing recorded that the person
 * had ever been on the project.
 *
 * Note the contrast this preserves, because it is what made the finding subtle:
 * the product's ordinary offboarding is a SOFT delete that writes
 * `Employee.status = 'INACTIVE'` (R72). It fires neither FK, so ownership
 * survives an ordinary departure untouched. This runs on the HARD delete only,
 * which `EmployeesService.hardDelete` already gates on the employee being
 * INACTIVE/TERMINATED first.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * For each owned project, in order:
 *   1. the longest-serving OTHER member holding the `owner` role slug;
 *   2. failing that, the project's `createdById` — a USER id, so it is resolved
 *      through `User.employeeId` — if that employee still exists and is ACTIVE;
 *   3. failing that, `ownerId` stays null, but loudly: a warn log, a
 *      `PROJECT_OWNER_ORPHANED` audit row on the project, and the row shows up
 *      in `GET /projects/ownerless`.
 *
 * Within rule 1, an ACTIVE member outranks a longer-serving inactive one. That
 * is a deliberate refinement of "longest-serving": a soft-deleted employee's
 * login is deactivated, so handing them the project would satisfy the letter of
 * the rule and leave the project just as unmanageable as before. If every
 * owner-slug member is inactive the longest-serving one still wins — a
 * reachable-by-reactivation owner beats none.
 *
 * The heir ends up holding owner rights by BOTH of `getAccess()`'s routes:
 * `Project.ownerId` is repointed AND their membership row is upserted onto the
 * project's `owner` role. One route silently failing can no longer strand a
 * project.
 */
export async function reassignProjectOwnershipOnEmployeeDelete(
  tx: Prisma.TransactionClient,
  employeeId: string,
  actorUserId?: string | null,
): Promise<ProjectOwnerHandover[]> {
  return runWithBranchBypass(async () => {
    const leaving = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, fullName: true, employeeCode: true },
    });

    // ── R13: tombstone every membership the cascade is about to erase ────────
    //
    // The membership rows themselves cannot survive without a schema change
    // (`ProjectMember.employeeId` is NOT NULL and `Cascade`), and a migration is
    // not what this fix is. What CAN survive, at no schema cost, is the fact:
    // an AuditLog row per project naming who was removed, from which role, and
    // when they had joined. `ProjectsService.getActivity` reads AuditLog for
    // `resourceType: 'Project'`, so the departure appears in the project's own
    // activity feed — the same place every other project change appears —
    // instead of the roster silently shrinking by one overnight.
    const memberships = await tx.projectMember.findMany({
      where: { employeeId },
      select: {
        id: true,
        projectId: true,
        role: true,
        roleId: true,
        joinedAt: true,
        projectRole: { select: { slug: true, name: true } },
      },
    });

    for (const m of memberships) {
      await tx.auditLog.create({
        data: {
          userId: actorUserId ?? null,
          action: 'PROJECT_MEMBER_REMOVED',
          resourceType: 'Project',
          resourceId: m.projectId,
          oldData: {
            memberId: m.id,
            employeeId,
            employeeName: leaving?.fullName ?? null,
            employeeCode: leaving?.employeeCode ?? null,
            role: m.role,
            roleSlug: m.projectRole?.slug ?? null,
            roleName: m.projectRole?.name ?? null,
            joinedAt: m.joinedAt.toISOString(),
          },
          newData: { reason: 'EMPLOYEE_HARD_DELETED' },
        },
      });
    }

    // ── R12: hand over every owned project ───────────────────────────────────
    //
    // No `deletedAt: null` filter, on purpose. The FK fires on every row that
    // points at this employee, archived and soft-deleted included, so the
    // invariant "no project row is ever left ownerless by a delete" has to be
    // enforced on every row too — otherwise a project restored later comes back
    // with nobody in charge and no record of why.
    const owned = await tx.project.findMany({
      where: { ownerId: employeeId },
      select: { id: true, name: true, projectCode: true, createdById: true },
      orderBy: { createdAt: 'asc' },
    });

    const handovers: ProjectOwnerHandover[] = [];

    for (const project of owned) {
      const heir = await pickHeir(tx, project, employeeId);

      if (heir) {
        await tx.project.update({
          where: { id: project.id },
          data: { ownerId: heir.employeeId },
        });

        // Route two to owner rights: the membership row must CARRY the owner
        // slug, not merely be pointed at by `ownerId`.
        const ownerRole = await tx.projectRole.findFirst({
          where: { projectId: project.id, slug: OWNER_ROLE_SLUG },
          select: { id: true },
        });
        await tx.projectMember.upsert({
          where: {
            projectId_employeeId: {
              projectId: project.id,
              employeeId: heir.employeeId,
            },
          },
          update: {
            role: 'OWNER' as any,
            ...(ownerRole ? { roleId: ownerRole.id } : {}),
          },
          create: {
            projectId: project.id,
            employeeId: heir.employeeId,
            role: 'OWNER' as any,
            roleId: ownerRole?.id ?? null,
          },
        });
      } else {
        handoverLogger.warn(
          `Project ${project.projectCode} (${project.id}) is now OWNERLESS: ` +
            `owner ${leaving?.employeeCode ?? employeeId} was hard-deleted and ` +
            `no other member holds the owner role, nor is the creator still ` +
            `active. Find it with GET /projects/ownerless.`,
        );
      }

      const heirEmployee = heir
        ? await tx.employee.findUnique({
            where: { id: heir.employeeId },
            select: { fullName: true, employeeCode: true },
          })
        : null;

      // The handover is a project change, and the project's activity feed is
      // where project changes are read. A silent ownership transfer would be
      // the one change to the record that is invisible exactly where every
      // other one is visible.
      await tx.auditLog.create({
        data: {
          userId: actorUserId ?? null,
          action: heir ? 'PROJECT_OWNER_REASSIGNED' : 'PROJECT_OWNER_ORPHANED',
          resourceType: 'Project',
          resourceId: project.id,
          oldData: {
            ownerId: employeeId,
            ownerName: leaving?.fullName ?? null,
            ownerCode: leaving?.employeeCode ?? null,
          },
          newData: {
            ownerId: heir?.employeeId ?? null,
            ownerName: heirEmployee?.fullName ?? null,
            ownerCode: heirEmployee?.employeeCode ?? null,
            via: heir?.via ?? 'none',
            reason: 'EMPLOYEE_HARD_DELETED',
          },
        },
      });

      handovers.push({
        projectId: project.id,
        projectCode: project.projectCode,
        projectName: project.name,
        previousOwnerId: employeeId,
        newOwnerId: heir?.employeeId ?? null,
        via: heir?.via ?? 'none',
      });
    }

    return handovers;
  });
}

/** Rules 1 and 2 of the ladder. `null` means rule 3 — accept a null owner. */
async function pickHeir(
  tx: Prisma.TransactionClient,
  project: { id: string; createdById: string | null },
  leavingEmployeeId: string,
): Promise<{ employeeId: string; via: 'owner-role-member' | 'creator' } | null> {
  // Rule 1 — longest-serving other member carrying the `owner` slug.
  const others = await tx.projectMember.findMany({
    where: { projectId: project.id, employeeId: { not: leavingEmployeeId } },
    select: {
      employeeId: true,
      role: true,
      roleId: true,
      projectRole: { select: { slug: true } },
      employee: { select: { status: true } },
    },
    // Longest-serving first. `joinedAt` defaults to now(), so ties are only
    // possible for rows written in the same statement; `id` breaks them
    // deterministically so two runs of the same delete pick the same heir.
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
  });

  const ownerSlugHolders = others.filter(holdsOwnerRole);
  const heir =
    ownerSlugHolders.find((m) => m.employee?.status === 'ACTIVE') ??
    ownerSlugHolders[0];
  if (heir) return { employeeId: heir.employeeId, via: 'owner-role-member' };

  // Rule 2 — the project's creator, if they are still here and still active.
  //
  // `Project.createdById` holds a USER id (`ProjectsService.create` writes
  // `user?.id`), not an employee id, and it has no FK — so it can point at a
  // user row that no longer exists. Resolve it defensively through
  // `User.employeeId`, which the hard delete nulls on its way out, so a creator
  // who was themselves hard-deleted resolves to nothing rather than to a
  // dangling id.
  if (project.createdById) {
    const creator = await tx.user.findUnique({
      where: { id: project.createdById },
      select: { employee: { select: { id: true, status: true } } },
    });
    const emp = creator?.employee;
    if (emp && emp.id !== leavingEmployeeId && emp.status === 'ACTIVE') {
      return { employeeId: emp.id, via: 'creator' };
    }
  }

  // Rule 3 — accept the null owner rather than block the delete, and make it
  // findable. See `ProjectsService.findOwnerless`.
  return null;
}
