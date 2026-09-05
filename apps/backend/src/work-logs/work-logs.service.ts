import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/rbac/project-access.service';
import { PROJECT_PERMISSIONS } from '../projects/rbac/permissions.constants';
import {
  CreateWorkLogDto,
  UpdateWorkLogDto,
  StartTimerDto,
  StopTimerDto,
} from './dto/create-work-log.dto';

@Injectable()
export class WorkLogsService {
  constructor(
    private prisma: PrismaService,
    private projectAccess: ProjectAccessService,
  ) {}

  private workLogInclude = {
    employee: {
      select: { id: true, fullName: true, avatarUrl: true, employeeCode: true },
    },
    task: { select: { id: true, taskCode: true, title: true } },
    status: { select: { id: true, name: true, color: true } },
  };

  // ─── Manual Logging ──────────────────────────────────────────────────────────

  async create(dto: CreateWorkLogDto, user: any) {
    if (!user?.employeeId) throw new BadRequestException('No employee profile');

    const task = await this.prisma.task.findFirst({
      where: { id: dto.taskId, deletedAt: null },
    });
    if (!task) throw new NotFoundException('Task not found');

    const start = new Date(dto.startTime);
    const end = new Date(dto.endTime);
    if (end <= start)
      throw new BadRequestException('End time must be after start time');

    const duration = (end.getTime() - start.getTime()) / (1000 * 60 * 60); // hours

    const workLog = await this.prisma.workLog.create({
      data: {
        taskId: dto.taskId,
        employeeId: user.employeeId,
        startTime: start,
        endTime: end,
        duration,
        notes: dto.notes,
        timerActive: false,
      },
      include: this.workLogInclude,
    });

    await this.syncTaskActualHours(dto.taskId);
    return { success: true, message: 'Work log created', data: workLog };
  }

  async findByTask(taskId: string, user: any) {
    const where: any = { taskId, deletedAt: null };
    if (user?.role === 'EMPLOYEE') where.employeeId = user.employeeId;

    const logs = await this.prisma.workLog.findMany({
      where,
      include: this.workLogInclude,
      orderBy: { startTime: 'desc' },
    });
    return { success: true, data: logs };
  }

  async findMine(user: any) {
    if (!user?.employeeId) return { success: true, data: [] };
    const logs = await this.prisma.workLog.findMany({
      where: { employeeId: user.employeeId, deletedAt: null },
      include: this.workLogInclude,
      orderBy: { startTime: 'desc' },
    });
    return { success: true, data: logs };
  }

  async update(id: string, dto: UpdateWorkLogDto, user: any) {
    const log = await this.prisma.workLog.findFirst({
      where: { id, deletedAt: null },
    });
    if (!log) throw new NotFoundException('Work log not found');
    if (
      log.employeeId !== user?.employeeId &&
      !['ADMIN', 'HR_MANAGER'].includes(user?.role)
    ) {
      throw new ForbiddenException('Access denied');
    }
    if (log.timerActive)
      throw new BadRequestException('Stop the timer before editing');

    const start = dto.startTime ? new Date(dto.startTime) : log.startTime;
    const end = dto.endTime ? new Date(dto.endTime) : log.endTime;
    const duration = end
      ? (end.getTime() - start.getTime()) / (1000 * 60 * 60)
      : null;

    const updated = await this.prisma.workLog.update({
      where: { id },
      data: {
        ...(dto.startTime && { startTime: start }),
        ...(dto.endTime && { endTime: end }),
        ...(duration !== null && { duration }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
      },
      include: this.workLogInclude,
    });

    await this.syncTaskActualHours(log.taskId);
    return { success: true, message: 'Work log updated', data: updated };
  }

  async remove(id: string, user: any) {
    const log = await this.prisma.workLog.findFirst({
      where: { id, deletedAt: null },
    });
    if (!log) throw new NotFoundException('Work log not found');
    if (
      log.employeeId !== user?.employeeId &&
      !['ADMIN', 'HR_MANAGER'].includes(user?.role)
    ) {
      throw new ForbiddenException('Access denied');
    }

    await this.prisma.workLog.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await this.syncTaskActualHours(log.taskId);
    return { success: true, message: 'Work log deleted' };
  }

  // ─── Timer Tracking ──────────────────────────────────────────────────────────

  async startTimer(dto: StartTimerDto, user: any) {
    if (!user?.employeeId) throw new BadRequestException('No employee profile');

    // Check no active timer exists for this employee
    const existing = await this.prisma.workLog.findFirst({
      where: {
        employeeId: user.employeeId,
        timerActive: true,
        deletedAt: null,
      },
    });
    if (existing) {
      throw new BadRequestException(
        'You already have an active timer. Stop it first.',
      );
    }

    const task = await this.prisma.task.findFirst({
      where: { id: dto.taskId, deletedAt: null },
      include: {
        workflowStatus: { select: { id: true, name: true } },
        assignees: { select: { id: true } },
      },
    });
    if (!task) throw new NotFoundException('Task not found');

    // Only assignees (or admins / project owner / managers) may time a task.
    await this.assertCanTime(task, user);

    const workLog = await this.prisma.workLog.create({
      data: {
        taskId: dto.taskId,
        employeeId: user.employeeId,
        startTime: new Date(),
        notes: dto.notes,
        timerActive: true,
        timerPausedSecs: 0,
        // Tag the log to the stage it is being logged against.
        statusId: task.statusId ?? null,
        statusName: task.workflowStatus?.name ?? task.status ?? null,
      },
      include: this.workLogInclude,
    });

    return { success: true, message: 'Timer started', data: workLog };
  }

  /**
   * A task may be timed by its assignees, by global ADMIN/HR_MANAGER, or by a
   * project owner/manager (anyone holding TASK_ASSIGN in the project).
   */
  private async assertCanTime(task: any, user: any) {
    if (['ADMIN', 'HR_MANAGER'].includes(user?.role)) return;

    const isAssignee = (task.assignees || []).some(
      (a: any) => a.id === user?.employeeId,
    );
    if (isAssignee) return;

    if (task.projectId) {
      const access = await this.projectAccess.getAccess(task.projectId, user);
      if (
        access.isGlobalAdmin ||
        access.isOwner ||
        access.permissions.includes(PROJECT_PERMISSIONS.TASK_ASSIGN)
      ) {
        return;
      }
    }

    throw new ForbiddenException(
      'Only the people assigned to this task can track time on it.',
    );
  }

  async pauseTimer(user: any) {
    const log = await this.getActiveTimer(user.employeeId);
    if (log.timerPausedAt)
      throw new BadRequestException('Timer is already paused');

    const updated = await this.prisma.workLog.update({
      where: { id: log.id },
      data: { timerPausedAt: new Date() },
      include: this.workLogInclude,
    });

    return { success: true, message: 'Timer paused', data: updated };
  }

  async resumeTimer(user: any) {
    const log = await this.getActiveTimer(user.employeeId);
    if (!log.timerPausedAt)
      throw new BadRequestException('Timer is not paused');

    const pausedSecs = Math.floor(
      (new Date().getTime() - log.timerPausedAt.getTime()) / 1000,
    );

    const updated = await this.prisma.workLog.update({
      where: { id: log.id },
      data: {
        timerPausedAt: null,
        timerPausedSecs: log.timerPausedSecs + pausedSecs,
      },
      include: this.workLogInclude,
    });

    return { success: true, message: 'Timer resumed', data: updated };
  }

  async stopTimer(dto: StopTimerDto, user: any) {
    const log = await this.getActiveTimer(user.employeeId);
    const updated = await this.finalizeTimer(log, dto.notes);
    return { success: true, message: 'Timer stopped', data: updated };
  }

  /**
   * Stop every running timer on a task (used when the task changes status — the
   * stage is complete, so its time is committed). Each finalized log keeps the
   * statusId/statusName it was started with = the stage just completed.
   */
  async stopActiveTimersForTask(taskId: string): Promise<number> {
    const active = await this.prisma.workLog.findMany({
      where: { taskId, timerActive: true, deletedAt: null },
    });
    for (const log of active) {
      await this.finalizeTimer(log);
    }
    return active.length;
  }

  /** Finalize a running/paused timer: compute net duration and close it out. */
  private async finalizeTimer(log: any, notes?: string) {
    const now = new Date();
    // If currently paused, accumulate last pause segment
    let totalPausedSecs = log.timerPausedSecs;
    if (log.timerPausedAt) {
      totalPausedSecs += Math.floor(
        (now.getTime() - new Date(log.timerPausedAt).getTime()) / 1000,
      );
    }

    const rawDurationMs = now.getTime() - new Date(log.startTime).getTime();
    const netDurationMs = rawDurationMs - totalPausedSecs * 1000;
    const duration = Math.max(0, netDurationMs) / (1000 * 60 * 60); // hours

    const updated = await this.prisma.workLog.update({
      where: { id: log.id },
      data: {
        endTime: now,
        duration,
        timerActive: false,
        timerPausedAt: null,
        timerPausedSecs: totalPausedSecs,
        ...(notes !== undefined && { notes }),
      },
      include: this.workLogInclude,
    });

    await this.syncTaskActualHours(log.taskId);
    return updated;
  }

  async getActiveTimerStatus(user: any) {
    if (!user?.employeeId) return { success: true, data: null };
    const log = await this.prisma.workLog.findFirst({
      where: {
        employeeId: user.employeeId,
        timerActive: true,
        deletedAt: null,
      },
      include: this.workLogInclude,
    });
    return { success: true, data: log };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async getActiveTimer(employeeId: string) {
    const log = await this.prisma.workLog.findFirst({
      where: { employeeId, timerActive: true, deletedAt: null },
    });
    if (!log) throw new NotFoundException('No active timer found');
    return log;
  }

  private async syncTaskActualHours(taskId: string) {
    const result = await this.prisma.workLog.aggregate({
      where: {
        taskId,
        timerActive: false,
        deletedAt: null,
        duration: { not: null },
      },
      _sum: { duration: true },
    });

    await this.prisma.task.update({
      where: { id: taskId },
      data: { actualHours: result._sum.duration ?? 0 },
    });
  }
}
