import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma, SprintStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The sprint lifecycle, as a real state machine (finding R30).
 *
 *     PLANNING ──start──▶ ACTIVE ──complete──▶ COMPLETED (terminal)
 *        │                  │
 *        └───── cancel ─────┴──────────────▶ CANCELLED (terminal)
 *
 * `CANCELLED` used to be reachable only through the generic `PATCH` — no verb,
 * no message and no side effects, so cancelling was indistinguishable from
 * renaming (finding R37) — and the R30 fix, which took `status` off
 * `UpdateSprintDto`, made it unreachable altogether. It is a real operation
 * now: `PATCH /sprints/:id/cancel`, from PLANNING or ACTIVE, terminal exactly
 * like COMPLETED, and it returns the sprint's open work to the backlog for the
 * same reason completing does (finding R39) — a sprint abandoned mid-flight
 * strands work exactly as a completed one does.
 */
const ALLOWED_TRANSITIONS: Record<string, SprintStatus[]> = {
  PLANNING: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/**
 * The sprint statuses whose date range RESERVES those days in the project.
 *
 * Decision R38/overlap: two sprints in one project may not cover the same
 * days. CANCELLED is deliberately absent — a cancelled sprint never ran, so its
 * range is an abandoned plan and must not stop anyone re-planning the same
 * window. COMPLETED is deliberately PRESENT: a completed sprint is the
 * project's record of what actually shipped over those days, and velocity,
 * burndown and capacity all read back by date. Letting a new sprint cover a
 * closed one's days would leave two sprints claiming the same delivered period,
 * which is exactly the ambiguity the rule exists to remove.
 */
const RANGE_RESERVING_STATUSES: SprintStatus[] = [
  'PLANNING',
  'ACTIVE',
  'COMPLETED',
];

@Injectable()
export class SprintsService {
  constructor(private prisma: PrismaService) {}

  private slugify(name: string): string {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 150);
  }

  /**
   * Refuse an illegal move, naming BOTH the status the sprint is in and the one
   * the caller asked for — a bare "not allowed" is not actionable from a board.
   */
  private assertTransition(from: SprintStatus, to: SprintStatus) {
    if (from === to) {
      throw new BadRequestException(
        `Sprint is already ${from}; it cannot be moved to ${to} again.`,
      );
    }
    if (!(ALLOWED_TRANSITIONS[from] ?? []).includes(to)) {
      throw new BadRequestException(
        `Cannot move a sprint from ${from} to ${to}. ` +
          'A sprint moves PLANNING -> ACTIVE -> COMPLETED, may be CANCELLED ' +
          'from PLANNING or ACTIVE, and COMPLETED and CANCELLED are both final.',
      );
    }
  }

  /**
   * Finding R38, the inverted-range half — nothing anywhere compared the two
   * dates, so `endDate` before `startDate` stored a sprint of negative length
   * and every duration, burndown and capacity figure downstream inherited it.
   * Equal dates are a one-day sprint and stay legal; only the inversion is
   * refused. (The OVERLAP half of R38 is enforced separately, by
   * `assertNoOverlap` below.)
   */
  private assertDateOrder(startDate: Date | null, endDate: Date | null) {
    if (!startDate || !endDate) return;
    if (endDate.getTime() < startDate.getTime()) {
      throw new BadRequestException(
        'endDate must be on or after startDate. ' +
          `Received startDate ${startDate.toISOString()} and endDate ${endDate.toISOString()}.`,
      );
    }
  }

  /**
   * Finding R38, the empty-name half. The DTO refuses `''` and `'   '`, but a
   * name made only of punctuation ("---", "!!!") still slugifies to the empty
   * string, and an empty slug is what collided on `@@unique([projectId, slug])`
   * for the second such sprint. The invariant belongs where the slug is made.
   */
  private slugOrRefuse(name: string): string {
    const slug = this.slugify(name);
    if (!slug) {
      throw new BadRequestException(
        `"${name}" cannot be used as a sprint name: it contains no letters or ` +
          'digits, so the sprint would have an empty identifier.',
      );
    }
    return slug;
  }

  /** `YYYY-MM-DD` — `startDate`/`endDate` are `@db.Date`, so the time half is noise. */
  private day(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /**
   * Finding R38, the OVERLAP half — decided, and enforced here.
   *
   * Two sprints in one project could cover the same days, which sat oddly
   * beside the one-ACTIVE-sprint-at-a-time invariant (R31): overlapping sprints
   * could be PLANNED but not both RUN, so the planner only discovered the
   * contradiction at the moment they pressed Start. The rule is now stated at
   * the point the range is set instead.
   *
   * BOTH ends are inclusive: a sprint ending on the 14th and one starting on
   * the 14th overlap on that day. A sprint with no dates — or with only one end
   * — cannot overlap anything, in either direction: an open-ended range names no
   * span of days, so there is nothing to compare, and refusing on a half-set
   * range would block the perfectly ordinary act of typing one date first.
   *
   * Which sprints reserve their days is `RANGE_RESERVING_STATUSES`, above.
   */
  private async assertNoOverlap(
    projectId: string,
    startDate: Date | null,
    endDate: Date | null,
    excludeSprintId?: string,
  ) {
    if (!startDate || !endDate) return;

    // Inclusive on both ends: [aStart, aEnd] and [bStart, bEnd] intersect
    // exactly when aStart <= bEnd AND aEnd >= bStart.
    const clash = await this.prisma.sprint.findFirst({
      where: {
        projectId,
        status: { in: RANGE_RESERVING_STATUSES },
        startDate: { not: null, lte: endDate },
        endDate: { not: null, gte: startDate },
        ...(excludeSprintId && { id: { not: excludeSprintId } }),
      },
      select: { name: true, startDate: true, endDate: true, status: true },
      orderBy: { startDate: 'asc' },
    });
    if (!clash) return;

    throw new BadRequestException(
      `Sprint dates ${this.day(startDate)} to ${this.day(endDate)} overlap ` +
        `"${clash.name}" (${clash.status}, ${this.day(clash.startDate!)} to ` +
        `${this.day(clash.endDate!)}). Two sprints in one project may not ` +
        'cover the same days; both ends of a range count as covered.',
    );
  }

  /**
   * Decisions R39 (complete) and R37 (cancel): a sprint that closes hands its
   * OPEN work back to the backlog, in the SAME transaction that closes it.
   *
   * "Open" means the task is not sitting in a **DONE-category workflow status**.
   * `StatusCategory` is the product's own definition of finished — it is what
   * `TasksService.moveStatus()` reads to stamp `completedDate` and to fire the
   * completion notification — so a column categorised DONE is what the board
   * means by delivered, and nothing else in the codebase reads the category for
   * anything else. Two consequences worth stating:
   *
   *   - a task with NO workflow status at all counts as OPEN. It sits on no
   *     column, so it is not evidence that anything was delivered.
   *   - the free-standing `Task.status` enum is deliberately NOT consulted. It
   *     is a separate axis that a board move does not write, so keying on it
   *     would make the sweep disagree with the board the user is looking at.
   *
   * Tasks already in a DONE column stay attached, so the closed sprint's record
   * of what it delivered stays honest. Soft-deleted tasks are left alone: they
   * are on no backlog either way, and moving them would inflate the count the
   * caller is shown.
   */
  private async returnOpenTasksToBacklog(
    tx: Prisma.TransactionClient,
    sprintId: string,
  ): Promise<number> {
    // Resolved to ids first rather than filtered inside `updateMany`: a
    // relation predicate (`workflowStatus.category`) is not something a bulk
    // write can carry, and the id list is what makes the reported count exact.
    const open = await tx.task.findMany({
      where: {
        sprintId,
        deletedAt: null,
        OR: [
          { statusId: null },
          { workflowStatus: { category: { not: 'DONE' } } },
        ],
      },
      select: { id: true },
    });
    if (!open.length) return 0;

    const moved = await tx.task.updateMany({
      where: { id: { in: open.map((t) => t.id) } },
      data: { sprintId: null },
    });
    return moved.count;
  }

  /** P2002 on `@@unique([projectId, slug])` — a retyped sprint name, not a crash. */
  private rethrowDuplicateName(e: unknown, name: string): never {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      throw new ConflictException(
        `A sprint named "${name}" already exists in this project.`,
      );
    }
    throw e;
  }

  async findByProject(projectId: string, status?: string) {
    if (!projectId) throw new BadRequestException('projectId is required');
    const where: any = { projectId, isArchived: false };
    if (status) where.status = status;
    const sprints = await this.prisma.sprint.findMany({
      where,
      include: { _count: { select: { tasks: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: sprints };
  }

  async findOne(id: string) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id },
      include: { _count: { select: { tasks: true } } },
    });
    if (!sprint) throw new NotFoundException('Sprint not found');
    return { success: true, data: sprint };
  }

  async create(data: {
    projectId: string;
    name: string;
    goal?: string;
    startDate?: string;
    endDate?: string;
  }) {
    const project = await this.prisma.project.findUnique({ where: { id: data.projectId } });
    if (!project) throw new NotFoundException('Project not found');

    const slug = this.slugOrRefuse(data.name);
    const startDate = data.startDate ? new Date(data.startDate) : null;
    const endDate = data.endDate ? new Date(data.endDate) : null;
    this.assertDateOrder(startDate, endDate);
    await this.assertNoOverlap(data.projectId, startDate, endDate);

    try {
      const sprint = await this.prisma.sprint.create({
        data: {
          projectId: data.projectId,
          name: data.name,
          slug,
          goal: data.goal,
          startDate,
          endDate,
        },
      });
      return { success: true, message: 'Sprint created', data: sprint };
    } catch (e) {
      this.rethrowDuplicateName(e, data.name);
    }
  }

  /**
   * Editorial fields only. `status` is deliberately NOT accepted here (R30):
   * the lifecycle verbs own every transition, so there is exactly one door into
   * each status and it is guarded.
   */
  async update(
    id: string,
    data: { name?: string; goal?: string; startDate?: string; endDate?: string },
  ) {
    const existing = await this.prisma.sprint.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Sprint not found');

    const slug = data.name !== undefined ? this.slugOrRefuse(data.name) : undefined;

    // A PATCH may move either end, so the pair is checked as it will END UP,
    // not as it arrived: patching only `endDate` is still capable of inverting
    // the range against the `startDate` already on the row.
    const nextStart =
      data.startDate !== undefined
        ? data.startDate
          ? new Date(data.startDate)
          : null
        : existing.startDate;
    const nextEnd =
      data.endDate !== undefined
        ? data.endDate
          ? new Date(data.endDate)
          : null
        : existing.endDate;
    this.assertDateOrder(nextStart, nextEnd);

    // Same "as it will END UP" reading for the overlap rule, and the sprint
    // being patched is excluded so it cannot collide with itself.
    //
    // Only asked when the patch actually MOVES a date, though. The lifecycle
    // verbs stamp dates of their own — `start()` writes today's date onto an
    // undated sprint and `complete()` closes it the same day — so a project can
    // legitimately hold sprints whose ranges already overlap, none of which any
    // caller chose. Re-asking the question on an editorial patch would refuse a
    // rename or a goal edit for a collision the request neither created nor can
    // fix, which is the shape of refusal R73 exists to complain about.
    if (data.startDate !== undefined || data.endDate !== undefined) {
      await this.assertNoOverlap(existing.projectId, nextStart, nextEnd, id);
    }

    try {
      const sprint = await this.prisma.sprint.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name, slug: slug as string }),
          ...(data.goal !== undefined && { goal: data.goal }),
          ...(data.startDate !== undefined && { startDate: data.startDate ? new Date(data.startDate) : null }),
          ...(data.endDate !== undefined && { endDate: data.endDate ? new Date(data.endDate) : null }),
        },
      });
      return { success: true, message: 'Sprint updated', data: sprint };
    } catch (e) {
      this.rethrowDuplicateName(e, data.name ?? existing.name);
    }
  }

  async start(id: string) {
    const existing = await this.prisma.sprint.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Sprint not found');
    this.assertTransition(existing.status, 'ACTIVE');

    /**
     * One ACTIVE sprint per project (finding R31). The invariant is enforced by
     * REFUSING this start, not by force-completing a row the caller never
     * mentioned — the previous implementation closed the live sprint with an
     * `updateMany` that wrote only `status`, leaving it COMPLETED with a NULL
     * `endDate` and no audit of any kind.
     */
    const live = await this.prisma.sprint.findFirst({
      where: { projectId: existing.projectId, status: 'ACTIVE', id: { not: id } },
      select: { id: true, name: true },
    });
    if (live) {
      throw new ConflictException(
        `Project already has an active sprint ("${live.name}"). ` +
          'Complete it before starting another.',
      );
    }

    const sprint = await this.prisma.sprint.update({
      where: { id },
      data: { status: 'ACTIVE', startDate: existing.startDate ?? new Date() },
    });
    return { success: true, message: 'Sprint started', data: sprint };
  }

  /**
   * Finding R39, decided: completing a sprint returns its open work to the
   * backlog. The unfinished tasks used to stay attached to a COMPLETED sprint —
   * not carried over, not returned, and invisible to any `sprintId IS NULL`
   * backlog view, so the closed sprint's scope kept growing after it closed.
   *
   * The sweep and the status write are ONE transaction: a sprint that is
   * COMPLETED while its tasks are still attached, or tasks detached from a
   * sprint that is still ACTIVE, are both states no screen can explain.
   */
  async complete(id: string) {
    const existing = await this.prisma.sprint.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Sprint not found');
    this.assertTransition(existing.status, 'COMPLETED');

    const { sprint, returned } = await this.prisma.$transaction(async (tx) => {
      const returned = await this.returnOpenTasksToBacklog(tx, id);
      const sprint = await tx.sprint.update({
        where: { id },
        data: { status: 'COMPLETED', endDate: existing.endDate ?? new Date() },
      });
      return { sprint, returned };
    });

    return {
      success: true,
      message: this.closedMessage('Sprint completed', returned),
      data: sprint,
      // Reported so the caller can tell the user what moved: rows the request
      // never named have changed, and a silent bulk write is how a board
      // surprises the person who pressed the button.
      tasksReturnedToBacklog: returned,
    };
  }

  /**
   * Finding R37, decided: cancelling is a real operation.
   *
   * PLANNING or ACTIVE -> CANCELLED, and CANCELLED is terminal exactly as
   * COMPLETED is — it cannot be started, completed or cancelled again.
   * `assertTransition` owns all of that; this method only has to name the
   * target. Open work goes back to the backlog on the same rule as `complete`,
   * because an abandoned sprint strands work exactly as a closed one does.
   *
   * The dates are deliberately left as they were: a cancelled sprint never ran,
   * so stamping an `endDate` would record a close that did not happen. Its
   * range also stops reserving those days — see `RANGE_RESERVING_STATUSES`.
   */
  async cancel(id: string) {
    const existing = await this.prisma.sprint.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Sprint not found');
    this.assertTransition(existing.status, 'CANCELLED');

    const { sprint, returned } = await this.prisma.$transaction(async (tx) => {
      const returned = await this.returnOpenTasksToBacklog(tx, id);
      const sprint = await tx.sprint.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });
      return { sprint, returned };
    });

    return {
      success: true,
      message: this.closedMessage('Sprint cancelled', returned),
      data: sprint,
      tasksReturnedToBacklog: returned,
    };
  }

  private closedMessage(verb: string, returned: number): string {
    if (returned === 0) return verb;
    return `${verb} — ${returned} open ${
      returned === 1 ? 'task' : 'tasks'
    } returned to the backlog`;
  }

  async remove(id: string) {
    const existing = await this.prisma.sprint.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Sprint not found');
    // Detach tasks then delete
    await this.prisma.task.updateMany({ where: { sprintId: id }, data: { sprintId: null } });
    await this.prisma.sprint.delete({ where: { id } });
    return { success: true, message: 'Sprint deleted' };
  }
}
