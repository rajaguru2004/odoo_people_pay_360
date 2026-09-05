import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProjectStatusesService {
  constructor(private prisma: PrismaService) {}

  // List workflow statuses for a project (kanban columns).
  async findByProject(projectId: string) {
    if (!projectId) throw new BadRequestException('projectId is required');
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workflowId: true },
    });
    if (!project?.workflowId)
      return { success: true, data: [] };
    const statuses = await this.prisma.projectTaskStatus.findMany({
      where: { workflowId: project.workflowId, deletedAt: null },
      orderBy: { position: 'asc' },
    });
    return { success: true, data: statuses };
  }

  private async resolveWorkflowId(projectId: string): Promise<string> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workflowId: true },
    });
    if (!project?.workflowId)
      throw new BadRequestException('Project has no workflow');
    return project.workflowId;
  }

  /**
   * Finding R32 — P2002 on `@@unique([workflowId, name])`.
   *
   * The constraint is on the WORKFLOW, not on the project, and workflows are
   * shared: the colliding column may live on a board the caller cannot see, or
   * on a column that has already been soft-deleted (the unique index does not
   * exclude `deleted_at`). A bare "name already exists" would be undiagnosable
   * from the caller's own board, so the message says where else to look.
   */
  private rethrowDuplicateName(e: unknown, name: string): never {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      throw new ConflictException(
        `A column named "${name}" already exists on this project's workflow. ` +
          'Workflows can be shared between projects, so the column may belong ' +
          'to a board you cannot see, or to a column that was deleted — ' +
          'the name stays reserved either way.',
      );
    }
    throw e;
  }

  async create(data: {
    projectId: string;
    name: string;
    color?: string;
    category?: string;
  }) {
    const workflowId = await this.resolveWorkflowId(data.projectId);
    const count = await this.prisma.projectTaskStatus.count({
      where: { workflowId, deletedAt: null },
    });
    try {
      const status = await this.prisma.projectTaskStatus.create({
        data: {
          name: data.name,
          color: data.color || '#64748B',
          category: (data.category ?? 'TODO') as any,
          position: count,
          workflowId,
        },
      });
      return { success: true, message: 'Status created', data: status };
    } catch (e) {
      this.rethrowDuplicateName(e, data.name);
    }
  }

  async update(
    id: string,
    data: { name?: string; color?: string; category?: string; isDefault?: boolean },
  ) {
    const existing = await this.prisma.projectTaskStatus.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Status not found');
    try {
      const status = await this.prisma.$transaction(async (tx) => {
        // Promoting a column demotes the incumbent: `isDefault` is the column a
        // task with no explicit status lands on, so exactly one may hold it.
        // Without a way to promote, the R35 rule below would make the default
        // column permanently undeletable.
        if (data.isDefault === true) {
          await tx.projectTaskStatus.updateMany({
            where: { workflowId: existing.workflowId, id: { not: id } },
            data: { isDefault: false },
          });
        }
        return tx.projectTaskStatus.update({
          where: { id },
          data: {
            ...(data.name !== undefined && { name: data.name }),
            ...(data.color !== undefined && { color: data.color }),
            ...(data.category !== undefined && { category: data.category as any }),
            ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
          },
        });
      });
      return { success: true, message: 'Status updated', data: status };
    } catch (e) {
      this.rethrowDuplicateName(e, data.name ?? existing.name);
    }
  }

  // Reorder columns: array of {id, position}
  async reorder(items: { id: string; position: number }[]) {
    await this.prisma.$transaction(
      items.map((it) =>
        this.prisma.projectTaskStatus.update({
          where: { id: it.id },
          data: { position: it.position },
        }),
      ),
    );
    return { success: true, message: 'Statuses reordered' };
  }

  async remove(id: string) {
    const existing = await this.prisma.projectTaskStatus.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Status not found');

    /**
     * Finding R34 — the guard used to count every task ever filed under the
     * column, soft-deleted ones included. A deleted task appears on no board and
     * in no list, so "move them first" named work that nothing could show and
     * nobody could move: the column was blocked for ever.
     */
    const taskCount = await this.prisma.task.count({
      where: { statusId: id, deletedAt: null },
    });
    if (taskCount > 0)
      throw new BadRequestException(
        'Cannot delete a status that still has tasks. Move them first.',
      );

    /**
     * Finding R35 — a board may not be emptied. `isDefault` was decorative, so
     * the default column was deletable and then so was every other one; a task
     * created afterwards got `statusId: null`, and `getKanban` bucketed it into
     * `columns[0]`, which no longer existed.
     */
    const liveCount = await this.prisma.projectTaskStatus.count({
      where: { workflowId: existing.workflowId, deletedAt: null },
    });
    if (liveCount <= 1)
      throw new BadRequestException(
        'Cannot delete the last remaining column on this board. ' +
          'A project must keep at least one status column.',
      );
    if (existing.isDefault)
      throw new BadRequestException(
        `Cannot delete "${existing.name}" because it is the board's default ` +
          'column — new tasks land on it. Promote another column to default first.',
      );

    await this.prisma.projectTaskStatus.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { success: true, message: 'Status deleted' };
  }
}
