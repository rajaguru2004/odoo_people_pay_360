import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateTaskCommentDto,
  UpdateTaskCommentDto,
} from './dto/create-task-comment.dto';

@Injectable()
export class TaskCommentsService {
  constructor(private prisma: PrismaService) {}

  private commentInclude = {
    user: {
      select: {
        id: true,
        email: true,
        employee: {
          select: { fullName: true, avatarUrl: true, employeeCode: true },
        },
      },
    },
  };

  async create(dto: CreateTaskCommentDto, user: any) {
    const task = await this.prisma.task.findFirst({
      where: { id: dto.taskId, deletedAt: null },
    });
    if (!task) throw new NotFoundException('Task not found');

    const comment = await this.prisma.taskComment.create({
      data: { taskId: dto.taskId, userId: user.id, comment: dto.comment },
      include: this.commentInclude,
    });

    // Log activity
    await this.prisma.taskActivity.create({
      data: {
        taskId: dto.taskId,
        actorId: user.id,
        activityType: 'COMMENTED',
        description: `${user.employee?.fullName || user.email} commented on the task`,
      },
    });

    return { success: true, message: 'Comment added', data: comment };
  }

  async findByTask(taskId: string) {
    const comments = await this.prisma.taskComment.findMany({
      where: { taskId, deletedAt: null },
      include: this.commentInclude,
      orderBy: { createdAt: 'asc' },
    });
    return { success: true, data: comments };
  }

  async update(id: string, dto: UpdateTaskCommentDto, user: any) {
    const comment = await this.prisma.taskComment.findFirst({
      where: { id, deletedAt: null },
    });
    if (!comment) throw new NotFoundException('Comment not found');

    if (
      comment.userId !== user.id &&
      !['ADMIN', 'HR_MANAGER'].includes(user.role)
    ) {
      throw new ForbiddenException('You can only edit your own comments');
    }

    const updated = await this.prisma.taskComment.update({
      where: { id },
      data: { comment: dto.comment },
      include: this.commentInclude,
    });

    return { success: true, message: 'Comment updated', data: updated };
  }

  async remove(id: string, user: any) {
    const comment = await this.prisma.taskComment.findFirst({
      where: { id, deletedAt: null },
    });
    if (!comment) throw new NotFoundException('Comment not found');

    if (
      comment.userId !== user.id &&
      !['ADMIN', 'HR_MANAGER'].includes(user.role)
    ) {
      throw new ForbiddenException('You can only delete your own comments');
    }

    await this.prisma.taskComment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { success: true, message: 'Comment deleted' };
  }
}
