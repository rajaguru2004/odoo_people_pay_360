import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { managerDeptScope } from '../common/services/manager-scope.util';
import { NotificationsService } from '../notifications/notifications.service';
import { WorkLogsService } from '../work-logs/work-logs.service';
import { MailService } from '../mail/mail.service';
import { ProjectAccessService } from '../projects/rbac/project-access.service';
import {
  PROJECT_PERMISSIONS,
  ProjectPermission,
} from '../projects/rbac/permissions.constants';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import {
  QueryTaskDto,
  AssignTaskDto,
  ChangeStatusDto,
  BulkAssignDto,
} from './dto/query-task.dto';

/**
 * Longest root→leaf chain the hierarchy accepts (finding R62). Five levels is
 * generous next to Jira, which allows exactly one below a standard issue; the
 * point of the number is that there IS one — the tree was unbounded, and
 * `findOne` only ever expands a single level of `childTasks`, so everything
 * below that was already invisible from the parent.
 */
const MAX_TASK_DEPTH = 5;

/**
 * Hard stop for any walk over `parentTaskId` / `childTasks`, independent of the
 * cap above. Rows created before the cap existed can already be deeper, and a
 * parent chain that loops (nothing in the schema forbids it) must not spin.
 */
const MAX_HIERARCHY_WALK = 50;

/** Bounds on the dependency-graph walk (finding R56). */
const MAX_DEPENDENCY_DEPTH = 50;
const MAX_DEPENDENCY_NODES = 1000;

/** Bound on the subtask cascade (finding R57). */
const MAX_CASCADE_NODES = 1000;

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private workLogs: WorkLogsService,
    private mailService: MailService,
    private access: ProjectAccessService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async generateTaskCode(): Promise<string> {
    // Numeric MAX of the TASK-#### sequence. A lexical `orderBy` breaks once codes
    // pass TASK-9999 ("TASK-9999" sorts above "TASK-10000"), which yields a max+1
    // that already exists and collides forever.
    const rows = await this.prisma.$queryRawUnsafe<{ max: number | null }[]>(
      `SELECT MAX(CAST(substring(task_code from 6) AS INTEGER)) AS max
         FROM tasks
        WHERE task_code ~ '^TASK-[0-9]+$'`,
    );
    const nextNum = Number(rows?.[0]?.max ?? 0) + 1;
    return `TASK-${String(nextNum).padStart(4, '0')}`;
  }

  private taskInclude = {
    assignees: {
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        avatarUrl: true,
      },
    },
    reporter: {
      select: { id: true, employeeCode: true, fullName: true, email: true },
    },
    workflowStatus: {
      select: { id: true, name: true, color: true, category: true, position: true },
    },
    project: { select: { id: true, name: true, slug: true, color: true, projectCode: true } },
    labels: { include: { label: true } },
    _count: {
      select: { comments: true, attachments: true, workLogs: true, childTasks: true },
    },
  };

  private async logActivity(
    taskId: string,
    actorId: string | undefined,
    activityType: string,
    description: string,
    oldValue?: any,
    newValue?: any,
  ) {
    await this.prisma.taskActivity.create({
      data: {
        taskId,
        actorId,
        activityType: activityType as any,
        description,
        oldValue,
        newValue,
      },
    });
  }

  /**
   * The project-scoped permissions the caller holds on a task's project.
   *
   * Empty for a task with no project — there is nothing project-scoped to hold.
   * This replaces the old `slug !== 'member'` heuristic, which asked the wrong
   * question three ways: it never ran unless the caller's GLOBAL role was
   * EMPLOYEE (so a project OWNER whose global role was MANAGER was refused on
   * their own project — finding R42), it counted `viewer` — a role with zero
   * permissions — as privileged, and it could not see a custom role at all.
   */
  private async projectPermissions(
    task: { projectId?: string | null } | null,
    user: any,
  ): Promise<string[]> {
    if (!task?.projectId) return [];
    const access = await this.access.getAccess(task.projectId, user);
    return access.permissions;
  }

  /**
   * Every foreign key the create payload carries, checked before the write.
   *
   * Without this each one is a raw Prisma failure the caller sees as
   * "Internal server error" with nothing naming the field that was wrong
   * (finding R61). The assignee case answers 404 "Employee not found" — the
   * same answer `assign()` already gives for the same mistake, which is what
   * made the two doors disagree.
   */
  private async assertReferencesExist(dto: {
    sprintId?: string;
    statusId?: string;
    parentTaskId?: string;
    labelIds?: string[];
    assigneeIds?: string[];
  }) {
    if (dto.sprintId) {
      const sprint = await this.prisma.sprint.findUnique({
        where: { id: dto.sprintId },
        select: { id: true },
      });
      if (!sprint)
        throw new BadRequestException(`sprintId "${dto.sprintId}" does not exist`);
    }

    if (dto.statusId) {
      // Finding R7, the write-target half — the lookup had no `deletedAt`
      // filter, so a soft-deleted column stayed a valid write target: a task
      // filed into a deleted column is live, listed by `GET /tasks`, and on NO
      // kanban column at all, because the board only renders live columns.
      // Work silently off the board is worse than a refusal.
      const status = await this.prisma.projectTaskStatus.findFirst({
        where: { id: dto.statusId, deletedAt: null },
        select: { id: true },
      });
      if (!status)
        throw new BadRequestException(`statusId "${dto.statusId}" does not exist`);
    }

    if (dto.parentTaskId) {
      const parent = await this.prisma.task.findFirst({
        where: { id: dto.parentTaskId, deletedAt: null },
        select: { id: true },
      });
      if (!parent)
        throw new BadRequestException(
          `parentTaskId "${dto.parentTaskId}" does not exist`,
        );
    }

    if (dto.labelIds?.length) {
      const found = await this.prisma.label.findMany({
        where: { id: { in: dto.labelIds } },
        select: { id: true },
      });
      const missing = dto.labelIds.filter(
        (id) => !found.some((l) => l.id === id),
      );
      if (missing.length)
        throw new BadRequestException(
          `labelIds contains ids that do not exist: ${missing.join(', ')}`,
        );
    }

    if (dto.assigneeIds?.length) {
      const found = await this.prisma.employee.findMany({
        where: { id: { in: dto.assigneeIds } },
        select: { id: true },
      });
      if (found.length !== dto.assigneeIds.length)
        throw new NotFoundException('Employee not found');
    }
  }

  /** Returns the project-role slug for an employee, or null if not a member. */
  private async resolveProjectRoleSlug(
    projectId: string,
    employeeId: string,
  ): Promise<string | null> {
    const member = await this.prisma.projectMember.findFirst({
      where: { projectId, employeeId },
      include: { projectRole: { select: { slug: true } } },
    });
    return member?.projectRole?.slug ?? null;
  }

  /**
   * A workflow status has to belong to the task's OWN project (finding R58).
   *
   * `ProjectTaskStatus` hangs off a WORKFLOW, and nothing checked that the
   * workflow was the one the task's project uses. A status id borrowed from
   * another project was accepted, and the task then appeared on NO kanban
   * board at all: its own board has no column with that id, and it is not
   * status-less either, so it missed the "unassigned" bucket `getKanban`
   * builds for legacy rows. It showed on the flat list and nowhere else.
   *
   * A SHARED workflow is still fine — two projects on one workflow have the
   * same `workflowId`, which is exactly what this compares.
   */
  private async assertStatusBelongsToProject(
    projectId: string | null | undefined,
    statusId: string,
  ) {
    const status = await this.prisma.projectTaskStatus.findUnique({
      where: { id: statusId },
      select: { workflowId: true },
    });
    if (!status)
      throw new BadRequestException(`statusId "${statusId}" does not exist`);

    if (!projectId)
      throw new BadRequestException(
        `statusId "${statusId}" cannot be set on a task that belongs to no project — a workflow status only exists on a project board`,
      );

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workflowId: true },
    });
    if (!project?.workflowId || project.workflowId !== status.workflowId)
      throw new BadRequestException(
        `statusId "${statusId}" belongs to another project's workflow`,
      );
  }

  /**
   * `StatusTransition` is enforced WHEN ROWS EXIST, and only then (finding R36).
   *
   * The table carries a real `@@unique([workflowId, fromStatusId, toStatusId])`
   * and three cascading FKs, and until now no controller read it and no service
   * consulted it — the only writer in the repository is `sample-data.extras.ts`.
   * So a workflow could declare `from -> to` and the API would still accept the
   * reverse: the table described a rule the product did not enforce.
   *
   * The rule is deliberately CONDITIONAL, so this is backwards compatible and
   * no existing board changes behaviour:
   *
   *   - a workflow with NO transition rows is unrestricted, exactly as before.
   *     Every board in the product today is in that state.
   *   - a workflow with ANY transition rows is a declared graph, and a task may
   *     move only along an edge that is in it.
   *
   * There is no edge to check when there is no `from` — a task being CREATED
   * into a column is not a move, and neither is re-setting a task to the column
   * it already occupies. Both pass through untouched.
   *
   * Defining the rules is out of scope by decision: there is no CRUD surface
   * for `StatusTransition`, and this is enforcement only.
   */
  private async assertTransitionDeclared(
    fromStatusId: string | null | undefined,
    toStatusId: string,
  ) {
    if (!fromStatusId || fromStatusId === toStatusId) return;

    const [from, to] = await Promise.all([
      this.prisma.projectTaskStatus.findUnique({
        where: { id: fromStatusId },
        select: { id: true, name: true, workflowId: true },
      }),
      this.prisma.projectTaskStatus.findUnique({
        where: { id: toStatusId },
        select: { id: true, name: true, workflowId: true },
      }),
    ]);
    // A missing or cross-workflow column is somebody else's refusal
    // (`assertStatusBelongsToProject`, R58) and answering it here would give
    // the caller the wrong reason.
    if (!from || !to || from.workflowId !== to.workflowId) return;

    const declared = await this.prisma.statusTransition.count({
      where: { workflowId: to.workflowId },
    });
    if (declared === 0) return;

    const edge = await this.prisma.statusTransition.findUnique({
      where: {
        workflowId_fromStatusId_toStatusId: {
          workflowId: to.workflowId,
          fromStatusId: from.id,
          toStatusId: to.id,
        },
      },
      select: { id: true },
    });
    if (edge) return;

    // Name BOTH columns: "this move is not allowed" on its own tells a board
    // nothing, and the two columns are the only thing the user can act on.
    throw new BadRequestException(
      `This board's workflow declares which moves are allowed, and ` +
        `"${from.name}" -> "${to.name}" is not one of them.`,
    );
  }

  /** Ancestor ids of a task, nearest first. Bounded, and loop-safe. */
  private async ancestorIds(taskId: string): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>([taskId]);
    let cursor: string | null = taskId;
    for (let i = 0; i < MAX_HIERARCHY_WALK && cursor; i++) {
      const row: { parentTaskId: string | null } | null =
        await this.prisma.task.findUnique({
          where: { id: cursor },
          select: { parentTaskId: true },
        });
      const next = row?.parentTaskId ?? null;
      if (!next || seen.has(next)) break;
      out.push(next);
      seen.add(next);
      cursor = next;
    }
    return out;
  }

  /**
   * Type and parentage have to agree, and the tree has to end (finding R62).
   *
   * `createSubtask` set `type: dto.type ?? 'SUBTASK'`, so `type: 'EPIC'` gave a
   * row that was simultaneously an epic and somebody's child, while
   * `POST /tasks {type:'SUBTASK'}` gave a subtask of nothing. Both make the
   * `types=` filters and every "epics" view disagree with the tree they are
   * drawn from. TASK / BUG / STORY are deliberately left free to sit at either
   * level — a story under an epic is the ordinary case.
   */
  private async assertHierarchy(
    taskId: string | null,
    type: string | undefined,
    parentTaskId: string | null | undefined,
  ) {
    const effectiveType = type ?? 'TASK';

    if (effectiveType === 'SUBTASK' && !parentTaskId)
      throw new BadRequestException(
        'type "SUBTASK" requires a parentTaskId — a subtask of nothing is not a subtask',
      );
    if (effectiveType === 'EPIC' && parentTaskId)
      throw new BadRequestException(
        'type "EPIC" cannot have a parentTaskId — an epic is a top-level item',
      );

    if (!parentTaskId) return;
    if (taskId && taskId === parentTaskId)
      throw new BadRequestException('A task cannot be its own parent');

    const ancestors = await this.ancestorIds(parentTaskId);
    if (taskId && ancestors.includes(taskId))
      throw new BadRequestException('A task cannot be its own ancestor');

    // `ancestors.length` is the parent's depth; the new child sits two levels
    // below the parent's own root, so that is what the cap is measured against.
    if (ancestors.length + 2 > MAX_TASK_DEPTH)
      throw new BadRequestException(
        `Task hierarchy is limited to ${MAX_TASK_DEPTH} levels`,
      );
  }

  /**
   * Every live descendant of a task, breadth-first and bounded (finding R57).
   */
  private async descendantIds(rootId: string): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>([rootId]);
    let frontier = [rootId];
    for (let level = 0; frontier.length && level < MAX_HIERARCHY_WALK; level++) {
      const children = await this.prisma.task.findMany({
        where: { parentTaskId: { in: frontier }, deletedAt: null },
        select: { id: true },
      });
      const next: string[] = [];
      for (const child of children) {
        if (seen.has(child.id) || out.length >= MAX_CASCADE_NODES) continue;
        seen.add(child.id);
        out.push(child.id);
        next.push(child.id);
      }
      frontier = next;
    }
    return out;
  }

  /**
   * Refuse an edge that closes a ring anywhere in the graph (finding R56).
   *
   * The old check was a single `findUnique` for the exact reverse edge, so
   * A→B→C→A built cleanly and every node in the ring was permanently blocked
   * by another node in it — no scheduler, Gantt render or "what can I start"
   * query over that graph terminates with an answer.
   *
   * Breadth-first from the proposed BLOCKER, following what it depends on. The
   * `seen` set alone guarantees termination (each node is expanded once); the
   * depth and node caps are a latency budget on top of that, and hitting one
   * REFUSES the edge rather than admitting it unverified — admitting an
   * unverified edge is the defect being fixed.
   */
  private async assertNoDependencyCycle(
    dependentTaskId: string,
    blockingTaskId: string,
  ) {
    let frontier = [blockingTaskId];
    const seen = new Set<string>(frontier);

    for (let depth = 0; frontier.length; depth++) {
      if (depth >= MAX_DEPENDENCY_DEPTH || seen.size > MAX_DEPENDENCY_NODES)
        throw new BadRequestException(
          'Dependency graph is too large to check for cycles; this link was not added',
        );

      const edges = await this.prisma.taskDependency.findMany({
        where: { dependentTaskId: { in: frontier } },
        select: { blockingTaskId: true },
      });

      const next: string[] = [];
      for (const edge of edges) {
        if (edge.blockingTaskId === dependentTaskId)
          throw new BadRequestException('Circular dependency detected');
        if (seen.has(edge.blockingTaskId)) continue;
        seen.add(edge.blockingTaskId);
        next.push(edge.blockingTaskId);
      }
      frontier = next;
    }
  }

  private buildWhere(query: QueryTaskDto, user: any, skipProjectRoleFilter = false) {
    const where: any = { deletedAt: null };

    // Exclude subtasks from all list/kanban views — they only appear under their parent
    if (query.projectId) {
      where.parentTaskId = null;
    }

    if (query.status) where.status = query.status;
    if (query.priority) where.priority = query.priority;
    if (query.assigneeId) {
      where.assignees = { some: { id: query.assigneeId } };
    }
    if (query.reporterId) where.reporterId = query.reporterId;

    // Project management filters
    if (query.projectId) where.projectId = query.projectId;
    if (query.sprintId) where.sprintId = query.sprintId;
    if (query.statusId) where.statusId = query.statusId;
    if (query.statuses) {
      const ids = query.statuses.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length) where.statusId = { in: ids };
    }
    if (query.types) {
      const types = query.types.split(',').map((s) => s.trim()).filter(Boolean);
      if (types.length) where.type = { in: types };
    }
    if (query.labels) {
      const labelIds = query.labels.split(',').map((s) => s.trim()).filter(Boolean);
      if (labelIds.length) where.labels = { some: { labelId: { in: labelIds } } };
    }
    if (query.isArchived !== undefined)
      where.isArchived = String(query.isArchived) === 'true';
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { taskCode: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.dueDateFrom || query.dueDateTo) {
      where.dueDate = {};
      if (query.dueDateFrom) where.dueDate.gte = new Date(query.dueDateFrom);
      if (query.dueDateTo) where.dueDate.lte = new Date(query.dueDateTo);
    }
    if (query.startDateFrom || query.startDateTo) {
      where.startDate = {};
      if (query.startDateFrom)
        where.startDate.gte = new Date(query.startDateFrom);
      if (query.startDateTo) where.startDate.lte = new Date(query.startDateTo);
    }

    // Private task visibility gate:
    // Non-admin/HR users can only see private tasks if they are assigned to it or reported it.
    if (!['ADMIN', 'HR_MANAGER'].includes(user?.role)) {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { isPrivate: false },
            {
              isPrivate: true,
              OR: [
                { assignees: { some: { id: user?.employeeId } } },
                { reporterId: user?.employeeId },
              ],
            },
          ],
        },
      ];
    }

    const isGlobalAdmin = ['ADMIN', 'HR_MANAGER'].includes(user?.role);
    const employeeId = user?.employeeId;

    if (query.projectId) {
      // Project-scoped view: use project role visibility (skipProjectRoleFilter = true means OWNER/MANAGER/VIEWER).
      // MEMBER (or non-member) sees only own tasks.
      if (!isGlobalAdmin && employeeId && !skipProjectRoleFilter) {
        where.AND = [
          ...(where.AND || []),
          {
            OR: [
              { assignees: { some: { id: employeeId } } },
              { reporterId: employeeId },
            ],
          },
        ];
      }
    } else {
      // Global task list (no project filter): use global role behaviour.
      if (!isGlobalAdmin && employeeId) {
        if (user?.role === 'MANAGER' && user?.departmentId) {
          // Global MANAGER: dept-scoped
          where.AND = [
            ...(where.AND || []),
            { assignees: { some: { departmentId: { in: managerDeptScope(user) } } } },
          ];
        } else {
          // EMPLOYEE and others: own tasks only
          where.AND = [
            ...(where.AND || []),
            {
              OR: [
                { assignees: { some: { id: employeeId } } },
                { reporterId: employeeId },
              ],
            },
          ];
        }
      }
    }

    return where;
  }

  // ─── CRUD ───────────────────────────────────────────────────────────────────

  async create(dto: CreateTaskDto, user: any) {
    const assigneeIds = [...(dto.assigneeIds || [])];
    if (dto.assigneeId && !assigneeIds.includes(dto.assigneeId)) {
      assigneeIds.push(dto.assigneeId);
    }
    // `TaskLabel` is `@@id([taskId, labelId])`, so the same id twice in one
    // payload is a composite-PK violation the caller saw as a 500 (R61). A
    // repeated selection means one label, not an error.
    const labelIds = dto.labelIds ? [...new Set(dto.labelIds)] : undefined;

    await this.assertReferencesExist({ ...dto, assigneeIds, labelIds });

    // Finding R58: a status from another project's workflow was accepted and
    // the card then rendered on no board at all.
    //
    // The R36 transition rule is deliberately NOT asked here: a `StatusTransition`
    // is a from -> to edge and a task being created has no `from`. Enforcing it
    // on create would mean inventing an entry edge the table cannot express, and
    // would make every declared workflow refuse the first card anyone filed.
    if (dto.statusId)
      await this.assertStatusBelongsToProject(dto.projectId, dto.statusId);

    // Finding R62: type and parentage had to agree with nothing, and the tree
    // had no bottom.
    await this.assertHierarchy(null, dto.type, dto.parentTaskId);

    let taskCode = await this.generateTaskCode();

    // Project task: resolve a default workflow status if none provided
    let statusId = dto.statusId;
    if (dto.projectId && !statusId) {
      const project = await this.prisma.project.findUnique({
        where: { id: dto.projectId },
        select: { workflowId: true },
      });
      if (project?.workflowId) {
        const defaultStatus = await this.prisma.projectTaskStatus.findFirst({
          where: { workflowId: project.workflowId, deletedAt: null },
          orderBy: { position: 'asc' },
        });
        statusId = defaultStatus?.id;
      }
    }

    const buildData = () => ({
      taskCode,
      title: dto.title,
      description: dto.description,
      priority: (dto.priority ?? 'MEDIUM') as any,
      status: (dto.status ?? 'TODO') as any,
      type: (dto.type ?? 'TASK') as any,
      isPrivate: dto.isPrivate ?? false, // private task flag
      assignees: {
        connect: assigneeIds.map((id) => ({ id })),
      },
      reporterId: dto.reporterId ?? user?.employeeId,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      startDate: dto.startDate ? new Date(dto.startDate) : null,
      estimatedHours: dto.estimatedHours,
      tags: dto.tags ?? [],
      // Project management
      projectId: dto.projectId ?? null,
      statusId: statusId ?? null,
      sprintId: dto.sprintId ?? null,
      parentTaskId: dto.parentTaskId ?? null,
      storyPoints: dto.storyPoints ?? null,
      // Geo location
      locationName: dto.locationName ?? null,
      latitude: dto.latitude ?? null,
      longitude: dto.longitude ?? null,
      ...(labelIds?.length && {
        labels: { create: labelIds.map((labelId) => ({ labelId })) },
      }),
    });

    // taskCode generation is non-atomic (max + 1), so concurrent creates can
    // collide on the unique code. Regenerate and retry on that specific clash.
    let task: any;
    for (let attempt = 0; ; attempt++) {
      try {
        task = await this.prisma.task.create({
          data: buildData(),
          include: this.taskInclude,
        });
        break;
      } catch (e: any) {
        if (
          attempt < 4 &&
          e?.code === 'P2002' &&
          String(e?.meta?.target ?? '').includes('task_code')
        ) {
          taskCode = await this.generateTaskCode();
          continue;
        }
        throw e;
      }
    }

    await this.logActivity(
      task.id,
      user?.id,
      'CREATED',
      `Task "${task.title}" created`,
    );

    // Notify assignees — fire-and-forget so HTTP response is not blocked
    for (const assigneeId of assigneeIds) {
      this.notifyAssignment(task.id, assigneeId, task.title, task.taskCode).catch(
        () => {},
      );
    }

    return { success: true, message: 'Task created successfully', data: task };
  }

  async findAll(query: QueryTaskDto, user: any) {
    const page = Number(query.page) || 1;
    const limit = Math.min(Number(query.limit) || 20, 200);
    const skip = (page - 1) * limit;

    // Project view: any non-admin with OWNER/MANAGER/VIEWER role sees all; MEMBER sees own only
    let skipProjectRoleFilter = false;
    if (!['ADMIN', 'HR_MANAGER'].includes(user?.role) && user?.employeeId && query.projectId) {
      const slug = await this.resolveProjectRoleSlug(query.projectId, user.employeeId);
      skipProjectRoleFilter = !!slug && slug !== 'member';
    }

    const where = this.buildWhere(query, user, skipProjectRoleFilter);
    const sortBy = query.sortBy ?? 'createdAt';
    const sortOrder = query.sortOrder ?? 'desc';

    const [tasks, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        skip,
        take: limit,
        include: this.taskInclude,
        orderBy: { [sortBy]: sortOrder },
      }),
      this.prisma.task.count({ where }),
    ]);

    return {
      success: true,
      data: tasks,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findMyTasks(user: any, query: QueryTaskDto) {
    const employeeId = user?.employeeId;
    if (!employeeId) {
      return { success: true, data: [], meta: { total: 0 } };
    }
    const where: any = {
      assignees: { some: { id: employeeId } },
      deletedAt: null,
    };
    if (query.status) where.status = query.status;
    if (query.priority) where.priority = query.priority;

    const tasks = await this.prisma.task.findMany({
      where,
      include: this.taskInclude,
      orderBy: { updatedAt: 'desc' },
    });

    return { success: true, data: tasks, meta: { total: tasks.length } };
  }

  async findOne(id: string, user: any) {
    const task = await this.prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: {
        ...this.taskInclude,
        comments: {
          where: { deletedAt: null },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                employee: { select: { fullName: true, avatarUrl: true } },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        attachments: {
          where: { deletedAt: null },
          include: {
            uploader: {
              select: {
                id: true,
                email: true,
                employee: { select: { fullName: true } },
              },
            },
          },
          orderBy: { uploadedAt: 'desc' },
        },
        activities: {
          include: {
            actor: {
              select: {
                id: true,
                email: true,
                employee: { select: { fullName: true, avatarUrl: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        workLogs: {
          where: { deletedAt: null },
          include: {
            employee: { select: { id: true, fullName: true, avatarUrl: true } },
          },
          orderBy: { startTime: 'desc' },
        },
        childTasks: {
          where: { deletedAt: null },
          include: {
            assignees: { select: { id: true, fullName: true, avatarUrl: true } },
            workflowStatus: { select: { id: true, name: true, color: true, category: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        parentTask: { select: { id: true, taskCode: true, title: true } },
        sprint: { select: { id: true, name: true, status: true } },
        dependsOn: {
          include: { blockingTask: { select: { id: true, taskCode: true, title: true, status: true } } },
        },
        blocks: {
          include: { dependentTask: { select: { id: true, taskCode: true, title: true, status: true } } },
        },
      },
    });

    if (!task) throw new NotFoundException('Task not found');
    await this.assertAccess(task, user);

    const serializedTask = {
      ...task,
      attachments: task.attachments?.map((a: any) => ({
        ...a,
        fileSize:
          a.fileSize !== null && a.fileSize !== undefined
            ? Number(a.fileSize)
            : null,
      })),
    };

    return { success: true, data: serializedTask };
  }

  async update(id: string, dto: UpdateTaskDto, user: any) {
    const existing = await this.prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: { assignees: { select: { id: true } } },
    });
    if (!existing) throw new NotFoundException('Task not found');

    const perms = await this.projectPermissions(existing, user);
    this.assertUpdateAccess(
      existing,
      user,
      perms,
      PROJECT_PERMISSIONS.TASK_EDIT,
    );

    const labelIds = dto.labelIds ? [...new Set(dto.labelIds)] : undefined;
    await this.assertReferencesExist({
      ...dto,
      labelIds,
      assigneeIds: [
        ...(dto.assigneeIds ?? []),
        ...(dto.assigneeId ? [dto.assigneeId] : []),
      ],
    });

    // The same two rules the create door applies (R58, R62), asked against
    // what the row will BE once this patch lands rather than what it carried.
    const effectiveProjectId =
      dto.projectId !== undefined ? dto.projectId : existing.projectId;
    if (dto.statusId) {
      await this.assertStatusBelongsToProject(effectiveProjectId, dto.statusId);
      // Finding R36 — a PATCH that moves `statusId` is the same move the board
      // makes, through a quieter door, so it answers to the same declared graph.
      await this.assertTransitionDeclared(existing.statusId, dto.statusId);
    }

    if (dto.type !== undefined || dto.parentTaskId !== undefined) {
      await this.assertHierarchy(
        id,
        dto.type !== undefined ? dto.type : (existing.type as string),
        dto.parentTaskId !== undefined
          ? dto.parentTaskId
          : existing.parentTaskId,
      );
    }

    // Leaving the current stage completes it — commit any running timers first
    // so their time is recorded against the stage just finished.
    const statusChanged =
      (dto.statusId !== undefined && dto.statusId !== existing.statusId) ||
      (dto.status !== undefined && dto.status !== existing.status);
    if (statusChanged) {
      await this.workLogs.stopActiveTimersForTask(id);
    }

    const oldStatus = existing.status;
    let assigneeConnectDisconnect: any = {};
    let assigneeIds: string[] | undefined = undefined;
    if (dto.assigneeIds !== undefined || dto.assigneeId !== undefined) {
      assigneeIds = dto.assigneeIds || [];
      if (dto.assigneeId && !assigneeIds.includes(dto.assigneeId)) {
        assigneeIds.push(dto.assigneeId);
      }
      assigneeConnectDisconnect = {
        assignees: {
          set: assigneeIds.map((aid) => ({ id: aid })),
        },
      };
    }

    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.priority !== undefined && { priority: dto.priority as any }),
        ...(dto.status !== undefined && { status: dto.status as any }),
        ...(dto.isPrivate !== undefined && { isPrivate: dto.isPrivate }),
        ...assigneeConnectDisconnect,
        ...(dto.reporterId !== undefined && { reporterId: dto.reporterId }),
        ...(dto.dueDate !== undefined && {
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        }),
        ...(dto.startDate !== undefined && {
          startDate: dto.startDate ? new Date(dto.startDate) : null,
        }),
        ...(dto.completedDate !== undefined && {
          completedDate: dto.completedDate ? new Date(dto.completedDate) : null,
        }),
        ...(dto.estimatedHours !== undefined && {
          estimatedHours: dto.estimatedHours,
        }),
        ...(dto.tags !== undefined && { tags: dto.tags }),
        ...(dto.status === 'COMPLETED' && { completedDate: new Date() }),
        // Project management
        ...(dto.projectId !== undefined && { projectId: dto.projectId }),
        ...(dto.statusId !== undefined && { statusId: dto.statusId }),
        ...(dto.sprintId !== undefined && { sprintId: dto.sprintId }),
        ...(dto.parentTaskId !== undefined && { parentTaskId: dto.parentTaskId }),
        ...(dto.type !== undefined && { type: dto.type as any }),
        ...(dto.storyPoints !== undefined && { storyPoints: dto.storyPoints }),
        // Geo location
        ...(dto.locationName !== undefined && { locationName: dto.locationName }),
        ...(dto.latitude !== undefined && { latitude: dto.latitude }),
        ...(dto.longitude !== undefined && { longitude: dto.longitude }),
        ...(labelIds !== undefined && {
          labels: {
            deleteMany: {},
            create: labelIds.map((labelId) => ({ labelId })),
          },
        }),
      },
      include: this.taskInclude,
    });

    await this.logActivity(
      id,
      user?.id,
      dto.status !== undefined && dto.status !== existing.status
        ? 'STATUS_CHANGED'
        : 'EDITED',
      dto.status !== undefined && dto.status !== existing.status
        ? `Status changed from ${existing.status} to ${dto.status}`
        : `Task updated`,
      dto.status !== undefined ? { status: oldStatus } : undefined,
      dto.status !== undefined ? { status: dto.status } : undefined,
    );

    return { success: true, message: 'Task updated', data: updated };
  }

  async remove(id: string, user: any) {
    const task = await this.prisma.task.findFirst({
      where: { id, deletedAt: null },
    });
    if (!task) throw new NotFoundException('Task not found');

    // No global-role re-check here (finding R41). `@RequireProjectPermission(
    // TASK_DELETE, { from: 'task' })` on the controller has already decided;
    // re-asking for ADMIN/HR_MANAGER/MANAGER made the manager PRESET — a
    // project role held by an EMPLOYEE — unable to use the very permission it
    // ships with, so two of the twelve catalogued permissions were 403 always.

    // Finding R57. `remove()` soft-deleted ONLY the row it was given, and
    // `buildWhere` forces `parentTaskId: null` on every project list and board
    // — so a child kept pointing at a parent that 404s and became a live,
    // assignable, status-changeable task on NO screen anywhere, reachable only
    // by its own uuid.
    //
    // CASCADE, not re-parent-to-null. Deleting a parent is a statement about
    // the work it breaks down, and re-parenting would promote breakdown items
    // onto the board as top-level cards nobody put there. Either way the rule
    // that matters holds: nothing is left live and unreachable.
    const descendants = await this.descendantIds(id);
    const deletedAt = new Date();
    await this.prisma.task.updateMany({
      where: { id: { in: [id, ...descendants] } },
      data: { deletedAt },
    });

    if (descendants.length) {
      await this.logActivity(
        id,
        user?.id,
        'EDITED',
        `Task deleted with ${descendants.length} subtask(s)`,
      );
    }

    return {
      success: true,
      message: descendants.length
        ? `Task deleted, along with ${descendants.length} subtask(s)`
        : 'Task deleted',
      deletedSubtaskCount: descendants.length,
    };
  }

  async archive(id: string, user: any) {
    const task = await this.prisma.task.findFirst({
      where: { id, deletedAt: null },
    });
    if (!task) throw new NotFoundException('Task not found');

    // Same route, same permission, same reason as `remove()` above (R41):
    // `@RequireProjectPermission(TASK_DELETE)` gates this door already.

    await this.prisma.task.update({
      where: { id },
      data: { isArchived: true },
    });
    await this.logActivity(id, user?.id, 'EDITED', 'Task archived');
    return { success: true, message: 'Task archived' };
  }

  async assign(id: string, dto: AssignTaskDto, user: any) {
    const task = await this.prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: { assignees: { select: { id: true, fullName: true } } },
    });
    if (!task) throw new NotFoundException('Task not found');

    // No global-role re-check (finding R41) — `@RequireProjectPermission(
    // TASK_ASSIGN, { from: 'task' })` on the controller is the authority.

    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.assigneeId },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const isAssigned = task.assignees.some((a) => a.id === dto.assigneeId);
    if (!isAssigned) {
      const updated = await this.prisma.task.update({
        where: { id },
        data: {
          assignees: {
            connect: { id: dto.assigneeId },
          },
        },
        include: this.taskInclude,
      });

      await this.logActivity(
        id,
        user?.id,
        'ASSIGNED',
        `Task assigned to ${employee.fullName}`,
        undefined,
        { assigneeId: dto.assigneeId },
      );
      this.notifyAssignment(id, dto.assigneeId, task.title, task.taskCode).catch(
        () => {},
      );

      return { success: true, message: `Task assigned`, data: updated };
    }

    return {
      success: true,
      message: `Task already assigned to ${employee.fullName}`,
      data: task,
    };
  }

  /**
   * `POST /tasks/:id/status` moves the free-standing `Task.status` ENUM
   * (TODO / IN_PROGRESS / IN_REVIEW / COMPLETED / CANCELLED / BLOCKED), not the
   * workflow column. `ChangeStatusDto` carries no `statusId` and this method
   * never writes one, so the R36 transition rule has nothing to check here: a
   * `StatusTransition` row is an edge between two `ProjectTaskStatus` rows, and
   * this door touches neither end of one. The board move is
   * `moveStatus()`; the quiet one is `update()` with a `statusId`. Both are
   * governed, and this one is a different axis rather than an unguarded hole.
   */
  async changeStatus(id: string, dto: ChangeStatusDto, user: any) {
    const task = await this.prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: { assignees: { select: { id: true } } },
    });
    if (!task) throw new NotFoundException('Task not found');
    // TASK_STATUS_UPDATE is a BOARD-wide capability in the catalogue ("Update
    // task status"), not a personal one. Narrowing the `member` preset to its
    // own cards meant a member could not move a colleague's card on the board
    // they share (finding R43); the permission now governs, as it reads.
    const perms = await this.projectPermissions(task, user);
    this.assertUpdateAccess(
      task,
      user,
      perms,
      PROJECT_PERMISSIONS.TASK_STATUS_UPDATE,
    );

    // Leaving the current stage completes it — commit any running timers first
    // so their time is recorded against the stage just finished.
    if (dto.status !== task.status) {
      await this.workLogs.stopActiveTimersForTask(id);
    }

    const updates: any = { status: dto.status };
    if (dto.status === 'COMPLETED') updates.completedDate = new Date();

    const updated = await this.prisma.task.update({
      where: { id },
      data: updates,
      include: this.taskInclude,
    });

    await this.logActivity(
      id,
      user?.id,
      'STATUS_CHANGED',
      `Status changed from ${task.status} to ${dto.status}`,
      { status: task.status },
      { status: dto.status },
    );

    if (dto.status === 'COMPLETED') {
      this.sendCompletionNotification(updated, user).catch(() => {});
    }

    return { success: true, message: 'Status updated', data: updated };
  }

  /**
   * Bulk assign — gated exactly like the single-task door it mirrors.
   *
   * Finding R8: this used to ask only "are you a MANAGER somewhere", so a
   * MANAGER who was a member of nothing bulk-assigned tasks inside a PRIVATE
   * project and then read them back through `/tasks/my-tasks`, while
   * `POST /tasks/:id/assign` refused the same caller. A door that does strictly
   * more, to many tasks at once, must not be weaker than the one it mirrors.
   *
   * The payload may span several projects, so every project it touches is
   * checked — one refusal refuses the batch, before anything is written.
   */
  async bulkAssign(dto: BulkAssignDto, user: any) {
    const taskIds = [...new Set(dto.taskIds)];
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: taskIds }, deletedAt: null },
      select: { id: true, projectId: true },
    });
    const missing = taskIds.filter((id) => !tasks.some((t) => t.id === id));
    if (missing.length)
      throw new NotFoundException(`Task not found: ${missing.join(', ')}`);

    for (const projectId of new Set(tasks.map((t) => t.projectId))) {
      if (
        !projectId ||
        !(await this.access.has(
          projectId,
          user,
          PROJECT_PERMISSIONS.TASK_ASSIGN,
        ))
      ) {
        throw new ForbiddenException(
          'You do not have permission to assign tasks in this project',
        );
      }
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.assigneeId },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    await Promise.all(
      taskIds.map((taskId) =>
        this.prisma.task.update({
          where: { id: taskId },
          data: {
            assignees: {
              connect: { id: dto.assigneeId },
            },
          },
        }),
      ),
    );

    // Log activities
    await this.prisma.taskActivity.createMany({
      data: taskIds.map((taskId) => ({
        taskId,
        actorId: user?.id,
        activityType: 'ASSIGNED' as any,
        description: `Bulk assigned to ${employee.fullName}`,
      })),
    });

    // Fire-and-forget per-task notifications — does not block the HTTP response
    void (async () => {
      for (const taskId of taskIds) {
        const t = await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { title: true, taskCode: true },
        });
        if (t) {
          this.notifyAssignment(taskId, dto.assigneeId, t.title, t.taskCode).catch(
            () => {},
          );
        }
      }
    })();
    return {
      success: true,
      message: `${taskIds.length} tasks assigned to ${employee.fullName}`,
    };
  }

  // ─── Access guards ───────────────────────────────────────────────────────────

  private async assertAccess(task: any, user: any) {
    if (['ADMIN', 'HR_MANAGER'].includes(user?.role)) return;

    if (task.isPrivate) {
      if (task.assignees?.some((a: any) => a.id === user?.employeeId)) return;
      if (task.reporterId === user?.employeeId) return;
      throw new ForbiddenException('Access denied');
    }

    // Any project member (any role) can read non-private tasks
    if (task.projectId && user?.employeeId) {
      const slug = await this.resolveProjectRoleSlug(task.projectId, user.employeeId);
      if (slug !== null) return;
    }

    if (task.assignees?.some((a: any) => a.id === user?.employeeId)) return;
    if (task.reporterId === user?.employeeId) return;
    throw new ForbiddenException('Access denied');
  }

  /**
   * The write rule, once the project guard has already had its say.
   *
   * `perms` is the caller's project-scoped permission set on THIS task's
   * project (empty for a task with no project); `required` is the permission
   * the operation is catalogued under. A private task is a narrower thing than
   * a project permission — it is invisible to members who are not on it, so
   * TASK_EDIT rather than the operation's own permission is what stands in for
   * "manages this project's work".
   */
  private assertUpdateAccess(
    task: any,
    user: any,
    perms: string[] = [],
    required: ProjectPermission = PROJECT_PERMISSIONS.TASK_EDIT,
  ) {
    const isGlobalAdmin = ['ADMIN', 'HR_MANAGER'].includes(user?.role);
    const isAssignee = !!task.assignees?.some(
      (a: any) => a.id === user?.employeeId,
    );
    const isReporter = task.reporterId === user?.employeeId;

    if (task.isPrivate) {
      if (isGlobalAdmin) return;
      if (perms.includes(PROJECT_PERMISSIONS.TASK_EDIT)) return;
      if (isAssignee) return;
      if (isReporter) return;
      throw new ForbiddenException('Access denied');
    }

    if (isGlobalAdmin) return;
    if (perms.includes(required)) return;
    // Tasks outside any project (no permission set to consult): the reporter or
    // an assigned EMPLOYEE may still act on their own work.
    if (user?.role === 'EMPLOYEE' && isAssignee) return;
    if (isReporter) return;
    throw new ForbiddenException('Access denied');
  }

  // ─── Notifications ───────────────────────────────────────────────────────────

  private async notifyAssignment(
    taskId: string,
    assigneeEmployeeId: string,
    taskTitle: string,
    taskCode: string,
  ) {
    try {
      const [assigneeUser, emp, taskCtx] = await Promise.all([
        this.prisma.user.findFirst({
          where: { employeeId: assigneeEmployeeId },
          select: { id: true },
        }),
        this.prisma.employee.findUnique({
          where: { id: assigneeEmployeeId },
          select: { email: true, fullName: true },
        }),
        this.prisma.task.findUnique({
          where: { id: taskId },
          select: {
            priority: true,
            dueDate: true,
            reporter: { select: { fullName: true } },
            project: { select: { name: true } },
          },
        }),
      ]);

      if (assigneeUser) {
        await this.notifications.notifyUser(
          assigneeUser.id,
          'Task Assigned',
          `You have been assigned to task: ${taskCode ? `[${taskCode}]` : ''} ${taskTitle}`,
          // Discriminating type, not 'INFO': it is what selects the WhatsApp
          // template, and 'INFO' resolves to none.
          'TASK_ASSIGNED',
          `/dashboard/tasks/${taskId}`,
          {
            waData: {
              taskTitle: taskCode ? `[${taskCode}] ${taskTitle}` : taskTitle,
              projectName: taskCtx?.project?.name,
              dueDate: taskCtx?.dueDate ?? undefined,
              priority: (taskCtx?.priority as string) ?? undefined,
            },
          },
        );
      }

      if (emp?.email) {
        const frontendUrl =
          process.env.FRONTEND_URL ||
          process.env.NEXT_PUBLIC_APP_URL ||
          'http://localhost:3000';
        await this.mailService.sendTaskAssigned(emp.email, {
          recipientName: emp.fullName,
          taskTitle,
          taskCode,
          projectName: taskCtx?.project?.name,
          priority: (taskCtx?.priority as string) ?? 'MEDIUM',
          dueDate: taskCtx?.dueDate
            ? taskCtx.dueDate.toLocaleDateString('en-US')
            : undefined,
          reporterName: taskCtx?.reporter?.fullName,
          taskUrl: `${frontendUrl}/dashboard/tasks/${taskId}`,
        });
      }
    } catch {
      // Ignore notification errors
    }
  }

  private async sendCompletionNotification(task: any, user: any) {
    try {
      const frontendUrl =
        process.env.FRONTEND_URL ||
        process.env.NEXT_PUBLIC_APP_URL ||
        'http://localhost:3000';
      const taskUrl = `${frontendUrl}/dashboard/tasks/${task.id}`;
      const completedDate = new Date().toLocaleDateString('en-US');

      let completedByName = 'A team member';
      if (user?.employeeId) {
        const emp = await this.prisma.employee.findUnique({
          where: { id: user.employeeId },
          select: { fullName: true },
        });
        if (emp) completedByName = emp.fullName;
      }

      // Primary recipient: project owner
      let recipientEmail: string | undefined;
      let recipientName: string | undefined;
      if (task.projectId) {
        const project = await this.prisma.project.findUnique({
          where: { id: task.projectId },
          select: {
            name: true,
            owner: { select: { email: true, fullName: true } },
          },
        });
        recipientEmail = project?.owner?.email;
        recipientName = project?.owner?.fullName;
      }

      // Fallback: reporter (already in taskInclude)
      if (!recipientEmail && task.reporter?.email) {
        recipientEmail = task.reporter.email;
        recipientName = task.reporter.fullName;
      }

      if (!recipientEmail) return;

      await this.mailService.sendTaskCompleted(recipientEmail, {
        recipientName: recipientName ?? 'Project Manager',
        taskTitle: task.title,
        taskCode: task.taskCode,
        projectName: task.project?.name,
        completedByName,
        completedDate,
        taskUrl,
      });
    } catch {
      // ignore
    }
  }

  // ─── Dashboard stats ─────────────────────────────────────────────────────────

  async getTaskStats(user: any) {
    const baseWhere: any = { deletedAt: null };
    if (user?.role === 'EMPLOYEE' && user?.employeeId) {
      baseWhere.assignees = { some: { id: user.employeeId } };
    } else if (user?.role === 'MANAGER' && user?.departmentId) {
      baseWhere.assignees = { some: { departmentId: { in: managerDeptScope(user) } } };
    }

    const [total, todo, inProgress, inReview, completed, overdue] =
      await Promise.all([
        this.prisma.task.count({ where: baseWhere }),
        this.prisma.task.count({ where: { ...baseWhere, status: 'TODO' } }),
        this.prisma.task.count({
          where: { ...baseWhere, status: 'IN_PROGRESS' },
        }),
        this.prisma.task.count({
          where: { ...baseWhere, status: 'IN_REVIEW' },
        }),
        this.prisma.task.count({
          where: { ...baseWhere, status: 'COMPLETED' },
        }),
        this.prisma.task.count({
          where: {
            ...baseWhere,
            dueDate: { lt: new Date() },
            status: { notIn: ['COMPLETED', 'CANCELLED'] },
          },
        }),
      ]);

    return {
      success: true,
      data: { total, todo, inProgress, inReview, completed, overdue },
    };
  }

  // ─── Project Kanban ───────────────────────────────────────────────────────────

  // Returns the project's workflow columns each with their tasks (board payload).
  async getKanban(projectId: string, user: any, query: QueryTaskDto) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { workflowId: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    const statuses = await this.prisma.projectTaskStatus.findMany({
      where: { workflowId: project.workflowId ?? undefined, deletedAt: null },
      orderBy: { position: 'asc' },
    });

    // Project view: any non-admin with OWNER/MANAGER/VIEWER role sees all; MEMBER sees own only
    let skipProjectRoleFilter = false;
    if (!['ADMIN', 'HR_MANAGER'].includes(user?.role) && user?.employeeId && projectId) {
      const slug = await this.resolveProjectRoleSlug(projectId, user.employeeId);
      skipProjectRoleFilter = !!slug && slug !== 'member';
    }

    const where = this.buildWhere({ ...query, projectId } as QueryTaskDto, user, skipProjectRoleFilter);
    const tasks = await this.prisma.task.findMany({
      where,
      include: this.taskInclude,
      orderBy: { updatedAt: 'desc' },
    });

    const columns = statuses.map((s) => ({
      ...s,
      tasks: tasks.filter((t: any) => t.statusId === s.id),
    }));
    // Tasks with no workflow status (e.g. legacy) bucket into first column
    const unassigned = tasks.filter((t: any) => !t.statusId);
    if (unassigned.length && columns.length) {
      columns[0].tasks.push(...unassigned);
    }

    return { success: true, data: { columns } };
  }

  // Move a task to a different workflow column (kanban drag-drop).
  async moveStatus(id: string, statusId: string, user: any) {
    const task = await this.prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: { workflowStatus: true, assignees: { select: { id: true } } },
    });
    if (!task) throw new NotFoundException('Task not found');
    const perms = await this.projectPermissions(task, user);
    this.assertUpdateAccess(
      task,
      user,
      perms,
      PROJECT_PERMISSIONS.TASK_STATUS_UPDATE,
    );

    // Finding R7, the write-target half — a soft-deleted column is not a place
    // a task may be moved to; it renders on no board.
    const newStatus = await this.prisma.projectTaskStatus.findFirst({
      where: { id: statusId, deletedAt: null },
    });
    if (!newStatus) throw new BadRequestException('Invalid status');

    // Finding R58 through the drag-and-drop door: the board a card is dragged
    // onto has to be the board it belongs to.
    await this.assertStatusBelongsToProject(task.projectId, statusId);

    // Finding R36 — the drag-and-drop door is the one a declared workflow graph
    // exists to govern. Unrestricted when the workflow declares nothing.
    await this.assertTransitionDeclared(task.statusId, statusId);

    // Leaving the current stage completes it — commit any running timers first
    // so their time is recorded against the stage just finished.
    if (statusId !== task.statusId) {
      await this.workLogs.stopActiveTimersForTask(id);
    }

    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        statusId,
        ...(newStatus.category === 'DONE' && { completedDate: new Date() }),
      },
      include: this.taskInclude,
    });

    await this.logActivity(
      id,
      user?.id,
      'STATUS_CHANGED',
      `Status changed to ${newStatus.name}`,
      { statusId: task.statusId },
      { statusId },
    );

    if (newStatus.category === 'DONE') {
      this.sendCompletionNotification(updated, user).catch(() => {});
    }

    return { success: true, message: 'Task moved', data: updated };
  }

  // ─── Subtasks ─────────────────────────────────────────────────────────────────

  async getSubtasks(parentTaskId: string) {
    const subtasks = await this.prisma.task.findMany({
      where: { parentTaskId, deletedAt: null },
      include: this.taskInclude,
      orderBy: { createdAt: 'asc' },
    });
    return { success: true, data: subtasks };
  }

  async createSubtask(parentTaskId: string, dto: CreateTaskDto, user: any) {
    const parent = await this.prisma.task.findFirst({
      where: { id: parentTaskId, deletedAt: null },
      select: { id: true, projectId: true, statusId: true },
    });
    if (!parent) throw new NotFoundException('Parent task not found');
    // `type: dto.type ?? 'SUBTASK'` survives as a DEFAULT; what changed is that
    // `create()` now refuses the combinations that never made sense (R62) — an
    // EPIC under a parent — and enforces the depth cap.
    return this.create(
      {
        ...dto,
        parentTaskId,
        projectId: dto.projectId ?? parent.projectId ?? undefined,
        statusId: dto.statusId ?? parent.statusId ?? undefined,
        type: dto.type ?? 'SUBTASK',
      },
      user,
    );
  }

  // ─── Dependencies ─────────────────────────────────────────────────────────────

  async getDependencies(taskId: string) {
    const [dependsOn, blocks] = await Promise.all([
      this.prisma.taskDependency.findMany({
        where: { dependentTaskId: taskId },
        include: { blockingTask: { select: { id: true, taskCode: true, title: true, status: true } } },
      }),
      this.prisma.taskDependency.findMany({
        where: { blockingTaskId: taskId },
        include: { dependentTask: { select: { id: true, taskCode: true, title: true, status: true } } },
      }),
    ]);
    return { success: true, data: { dependsOn, blocks } };
  }

  async addDependency(
    dependentTaskId: string,
    blockingTaskId: string,
    type = 'BLOCKS',
  ) {
    if (dependentTaskId === blockingTaskId)
      throw new BadRequestException('A task cannot depend on itself');

    // Finding R56: this was a single `findUnique` for the exact reverse edge,
    // so only DIRECT cycles were refused. The walk subsumes it — a direct
    // reverse edge is found at the first level — and answers with the same
    // message, so the direct case reads identically to the caller.
    await this.assertNoDependencyCycle(dependentTaskId, blockingTaskId);

    try {
      const dep = await this.prisma.taskDependency.create({
        data: { dependentTaskId, blockingTaskId, type: type as any },
      });
      return { success: true, message: 'Dependency added', data: dep };
    } catch (e: any) {
      // `@@unique([dependentTaskId, blockingTaskId])` does its job; the caller
      // just used to see the raw failure as a 500 (finding R61).
      if (e?.code === 'P2002') {
        throw new ConflictException(
          'These two tasks are already linked by a dependency',
        );
      }
      if (e?.code === 'P2003' || e?.code === 'P2025') {
        throw new BadRequestException(
          `blockingTaskId "${blockingTaskId}" does not exist`,
        );
      }
      throw e;
    }
  }

  async removeDependency(id: string) {
    const existing = await this.prisma.taskDependency.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Dependency not found');
    await this.prisma.taskDependency.delete({ where: { id } });
    return { success: true, message: 'Dependency removed' };
  }
}
