import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TaskDashboardService {
  constructor(private prisma: PrismaService) {}

  async getEmployeeDashboard(user: any) {
    const employeeId = user?.employeeId;
    if (!employeeId) {
      return { success: true, data: this.emptyEmployeeDashboard() };
    }

    const today = new Date();
    const todayStart = new Date(
      Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()),
    );
    const weekStart = this.getStartOfWeek(today);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

    const [
      assignedTasks,
      pendingTasks,
      completedTasks,
      overdueTasks,
      todayLogs,
      weekLogs,
      pendingTimesheets,
      activeTimer,
    ] = await Promise.all([
      this.prisma.task.count({
        where: {
          assignees: { some: { id: employeeId } },
          deletedAt: null,
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        },
      }),
      this.prisma.task.count({
        where: {
          assignees: { some: { id: employeeId } },
          deletedAt: null,
          status: 'TODO',
        },
      }),
      this.prisma.task.count({
        where: {
          assignees: { some: { id: employeeId } },
          deletedAt: null,
          status: 'COMPLETED',
        },
      }),
      this.prisma.task.count({
        where: {
          assignees: { some: { id: employeeId } },
          deletedAt: null,
          dueDate: { lt: todayStart },
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        },
      }),
      this.prisma.workLog.aggregate({
        where: {
          employeeId,
          startTime: { gte: todayStart },
          timerActive: false,
          deletedAt: null,
        },
        _sum: { duration: true },
      }),
      this.prisma.workLog.aggregate({
        where: {
          employeeId,
          startTime: { gte: weekStart, lt: weekEnd },
          timerActive: false,
          deletedAt: null,
        },
        _sum: { duration: true },
      }),
      this.prisma.timesheet.count({
        where: { employeeId, status: 'DRAFT', deletedAt: null },
      }),
      this.prisma.workLog.findFirst({
        where: { employeeId, timerActive: true, deletedAt: null },
        include: {
          task: { select: { id: true, taskCode: true, title: true } },
        },
      }),
    ]);

    const recentTasks = await this.prisma.task.findMany({
      where: { assignees: { some: { id: employeeId } }, deletedAt: null },
      include: { _count: { select: { comments: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    });

    return {
      success: true,
      data: {
        tasks: {
          assigned: assignedTasks,
          pending: pendingTasks,
          completed: completedTasks,
          overdue: overdueTasks,
        },
        hours: {
          today: Number(todayLogs._sum.duration ?? 0).toFixed(2),
          week: Number(weekLogs._sum.duration ?? 0).toFixed(2),
        },
        timesheets: { pendingDraft: pendingTimesheets },
        activeTimer: activeTimer
          ? {
              id: activeTimer.id,
              taskId: activeTimer.taskId,
              task: activeTimer.task,
              startTime: activeTimer.startTime,
              isPaused: !!activeTimer.timerPausedAt,
              pausedAt: activeTimer.timerPausedAt,
            }
          : null,
        recentTasks,
      },
    };
  }

  async getManagerDashboard(user: any) {
    const today = new Date();
    const weekStart = this.getStartOfWeek(today);

    // Finding R59: this narrowed on `managerDeptScope(user)`, which FALLS BACK
    // to the caller's own `departmentId` when they head nothing — so a MANAGER
    // of nobody read every colleague who shares their department, including
    // their activity inside PRIVATE projects they cannot open, with the actor
    // named. Heading nothing is an empty team, not the department you sit in.
    // (`manager-role.util.ts` makes the same point from the other side.)
    let employeeIds: string[];
    if (user?.role === 'MANAGER') {
      const managed: string[] = user?.managedDepartmentIds ?? [];
      if (!managed.length) {
        return { success: true, data: this.emptyManagerDashboard() };
      }
      const employees = await this.prisma.employee.findMany({
        where: { departmentId: { in: managed }, status: 'ACTIVE' },
        select: { id: true },
      });
      employeeIds = employees.map((e) => e.id);
    } else {
      // ADMIN / HR_MANAGER: the whole company, as before.
      const employees = await this.prisma.employee.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true },
      });
      employeeIds = employees.map((e) => e.id);
    }

    const [
      totalTasks,
      taskByStatus,
      pendingTimesheets,
      teamHoursThisWeek,
      overdueTasks,
      recentActivity,
    ] = await Promise.all([
      this.prisma.task.count({
        where: {
          assignees: { some: { id: { in: employeeIds } } },
          deletedAt: null,
        },
      }),
      this.prisma.task.groupBy({
        by: ['status'],
        where: {
          assignees: { some: { id: { in: employeeIds } } },
          deletedAt: null,
        },
        _count: { id: true },
      }),
      this.prisma.timesheet.count({
        where: {
          employeeId: { in: employeeIds },
          status: 'SUBMITTED',
          deletedAt: null,
        },
      }),
      this.prisma.workLog.aggregate({
        where: {
          employeeId: { in: employeeIds },
          startTime: { gte: weekStart },
          timerActive: false,
          deletedAt: null,
        },
        _sum: { duration: true },
      }),
      this.prisma.task.count({
        where: {
          assignees: { some: { id: { in: employeeIds } } },
          deletedAt: null,
          dueDate: { lt: today },
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        },
      }),
      this.prisma.taskActivity.findMany({
        where: { task: { assignees: { some: { id: { in: employeeIds } } } } },
        include: {
          actor: {
            select: {
              employee: { select: { fullName: true, avatarUrl: true } },
            },
          },
          task: { select: { taskCode: true, title: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const statusMap: Record<string, number> = {};
    for (const s of taskByStatus) {
      statusMap[s.status] = s._count.id;
    }

    return {
      success: true,
      data: {
        tasks: {
          total: totalTasks,
          todo: statusMap['TODO'] ?? 0,
          inProgress: statusMap['IN_PROGRESS'] ?? 0,
          inReview: statusMap['IN_REVIEW'] ?? 0,
          completed: statusMap['COMPLETED'] ?? 0,
          blocked: statusMap['BLOCKED'] ?? 0,
          overdue: overdueTasks,
        },
        timesheets: { pendingApproval: pendingTimesheets },
        teamHoursThisWeek: Number(teamHoursThisWeek._sum.duration ?? 0).toFixed(
          2,
        ),
        recentActivity,
      },
    };
  }

  /** A manager who heads nothing has no team — the same shape, all zeroes. */
  private emptyManagerDashboard() {
    return {
      tasks: {
        total: 0,
        todo: 0,
        inProgress: 0,
        inReview: 0,
        completed: 0,
        blocked: 0,
        overdue: 0,
      },
      timesheets: { pendingApproval: 0 },
      teamHoursThisWeek: '0.00',
      recentActivity: [] as unknown[],
    };
  }

  private emptyEmployeeDashboard() {
    return {
      tasks: { assigned: 0, pending: 0, completed: 0, overdue: 0 },
      hours: { today: '0.00', week: '0.00' },
      timesheets: { pendingDraft: 0 },
      activeTimer: null,
      recentTasks: [],
    };
  }

  private getStartOfWeek(date: Date) {
    const d = new Date(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
    );
    const day = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() - day + 1);
    return d;
  }
}
