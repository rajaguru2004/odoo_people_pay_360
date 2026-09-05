import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface PeriodArgs {
  employeeId: string;
  from: Date;
  to: Date;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Per-employee performance aggregates over an arbitrary date range. These are
 * the data sources behind the `*_employee_summary` MCP tools and the AI
 * appraisal agent. Read-only; branch scoping applies through the Prisma
 * middleware exactly as for the rest of the app.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async attendanceSummary({ employeeId, from, to }: PeriodArgs) {
    const rows = await this.prisma.attendance.findMany({
      where: { employeeId, date: { gte: from, lte: to } },
      select: {
        status: true,
        isLate: true,
        isEarlyLeave: true,
        workHours: true,
        checkIn: true,
        checkOut: true,
      },
    });
    const present = rows.filter((r) => r.status !== 'ABSENT');
    const absent = rows.filter((r) => r.status === 'ABSENT');
    const late = rows.filter((r) => r.isLate);
    const earlyLeave = rows.filter((r) => r.isEarlyLeave);
    const totalHours = rows.reduce((s, r) => s + num(r.workHours), 0);
    const recorded = rows.length;
    return {
      recordedDays: recorded,
      presentDays: present.length,
      absentDays: absent.length,
      lateDays: late.length,
      earlyLeaveDays: earlyLeave.length,
      totalWorkHours: round2(totalHours),
      avgWorkHoursPerDay: present.length ? round2(totalHours / present.length) : 0,
      attendanceRate: recorded ? round2((present.length / recorded) * 100) : null,
      punctualityRate: present.length
        ? round2(((present.length - late.length) / present.length) * 100)
        : null,
    };
  }

  async leaveSummary({ employeeId, from, to }: PeriodArgs) {
    const requests = await this.prisma.leaveRequest.findMany({
      where: { employeeId, startDate: { lte: to }, endDate: { gte: from } },
      select: { leaveType: true, totalDays: true, status: true },
    });
    const approved = requests.filter((r) => r.status === 'APPROVED');
    const byType: Record<string, number> = {};
    for (const r of approved) byType[r.leaveType] = (byType[r.leaveType] ?? 0) + r.totalDays;
    const years = new Set<number>([from.getUTCFullYear(), to.getUTCFullYear()]);
    const balances = await this.prisma.leaveTypeBalance.findMany({
      where: { employeeId, year: { in: [...years] } },
      select: { year: true, leaveTypeKey: true, allocated: true, used: true, carriedOver: true },
    });
    return {
      totalRequests: requests.length,
      approvedRequests: approved.length,
      rejectedRequests: requests.filter((r) => r.status === 'REJECTED').length,
      pendingRequests: requests.filter((r) => r.status === 'PENDING').length,
      approvedDays: approved.reduce((s, r) => s + r.totalDays, 0),
      approvedDaysByType: byType,
      balances,
    };
  }

  async overtimeSummary({ employeeId, from, to }: PeriodArgs) {
    const rows = await this.prisma.overtimeRequest.findMany({
      where: { employeeId, date: { gte: from, lte: to } },
      select: {
        status: true,
        hours: true,
        regularHours: true,
        lateHours: true,
        doubleHours: true,
        foodAllowance: true,
      },
    });
    const approved = rows.filter((r) => r.status === 'APPROVED');
    return {
      totalRequests: rows.length,
      approvedRequests: approved.length,
      rejectedRequests: rows.filter((r) => r.status === 'REJECTED').length,
      approvedHours: round2(approved.reduce((s, r) => s + num(r.hours), 0)),
      regularHours: round2(approved.reduce((s, r) => s + num(r.regularHours), 0)),
      lateHours: round2(approved.reduce((s, r) => s + num(r.lateHours), 0)),
      doubleHours: round2(approved.reduce((s, r) => s + num(r.doubleHours), 0)),
      foodAllowanceTotal: round2(approved.reduce((s, r) => s + num(r.foodAllowance), 0)),
    };
  }

  async taskStats({ employeeId, from, to }: PeriodArgs) {
    const tasks = await this.prisma.task.findMany({
      where: {
        assignees: { some: { id: employeeId } },
        deletedAt: null,
        isArchived: false,
        OR: [
          { completedDate: { gte: from, lte: to } },
          { createdAt: { gte: from, lte: to } },
          { dueDate: { gte: from, lte: to } },
        ],
      },
      select: {
        status: true,
        dueDate: true,
        completedDate: true,
        estimatedHours: true,
        actualHours: true,
        storyPoints: true,
        priority: true,
      },
    });
    const completed = tasks.filter((t) => t.status === 'COMPLETED');
    const withDue = completed.filter((t) => t.dueDate && t.completedDate);
    const onTime = withDue.filter((t) => t.completedDate! <= t.dueDate!);
    const now = new Date();
    const overdueOpen = tasks.filter(
      (t) =>
        t.dueDate &&
        t.dueDate < now &&
        t.status !== 'COMPLETED' &&
        t.status !== 'CANCELLED',
    );
    return {
      totalTasks: tasks.length,
      completedTasks: completed.length,
      completionRate: tasks.length ? round2((completed.length / tasks.length) * 100) : null,
      completedWithDueDate: withDue.length,
      completedOnTime: onTime.length,
      onTimeRate: withDue.length ? round2((onTime.length / withDue.length) * 100) : null,
      overdueOpenTasks: overdueOpen.length,
      inProgressTasks: tasks.filter((t) => t.status === 'IN_PROGRESS').length,
      blockedTasks: tasks.filter((t) => t.status === 'BLOCKED').length,
      storyPointsCompleted: completed.reduce((s, t) => s + (t.storyPoints ?? 0), 0),
      estimatedHours: round2(tasks.reduce((s, t) => s + num(t.estimatedHours), 0)),
      actualHours: round2(tasks.reduce((s, t) => s + num(t.actualHours), 0)),
      highPriorityCompleted: completed.filter(
        (t) => t.priority === 'HIGH' || t.priority === 'CRITICAL',
      ).length,
    };
  }

  async projectContribution({ employeeId, from, to }: PeriodArgs) {
    const memberships = await this.prisma.projectMember.findMany({
      where: { employeeId, project: { deletedAt: null } },
      select: {
        role: true,
        joinedAt: true,
        project: {
          select: { name: true, status: true, priority: true, startDate: true, endDate: true },
        },
      },
    });
    const owned = await this.prisma.project.count({
      where: { ownerId: employeeId, deletedAt: null },
    });
    const activeInPeriod = memberships.filter(
      (m) =>
        m.joinedAt <= to &&
        (m.project.status === 'ACTIVE' || m.project.status === 'COMPLETED' || !m.project.endDate || m.project.endDate >= from),
    );
    return {
      totalProjects: memberships.length,
      activeInPeriod: activeInPeriod.length,
      ownedProjects: owned,
      leadRoles: memberships.filter((m) => m.role === 'OWNER' || m.role === 'MANAGER').length,
      projects: memberships.map((m) => ({
        name: m.project.name,
        status: m.project.status,
        priority: m.project.priority,
        role: m.role,
      })),
    };
  }

  async worklogSummary({ employeeId, from, to }: PeriodArgs) {
    const rows = await this.prisma.workLog.findMany({
      where: { employeeId, deletedAt: null, startTime: { gte: from, lte: to } },
      select: { duration: true, startTime: true },
    });
    const totalHours = rows.reduce((s, r) => s + num(r.duration), 0);
    const days = new Set(rows.map((r) => r.startTime.toISOString().slice(0, 10)));
    return {
      entries: rows.length,
      totalHoursLogged: round2(totalHours),
      distinctDaysWithLogs: days.size,
      avgHoursPerActiveDay: days.size ? round2(totalHours / days.size) : 0,
    };
  }

  async timesheetSummary({ employeeId, from, to }: PeriodArgs) {
    const rows = await this.prisma.timesheet.findMany({
      where: { employeeId, deletedAt: null, workDate: { gte: from, lte: to } },
      select: { status: true, hoursWorked: true, workDate: true },
    });
    const submittedOrBeyond = rows.filter((r) => r.status !== 'DRAFT');
    const approved = rows.filter((r) => r.status === 'APPROVED');
    return {
      totalEntries: rows.length,
      submittedEntries: submittedOrBeyond.length,
      approvedEntries: approved.length,
      rejectedEntries: rows.filter((r) => r.status === 'REJECTED').length,
      totalHours: round2(rows.reduce((s, r) => s + num(r.hoursWorked), 0)),
      approvalRate: submittedOrBeyond.length
        ? round2((approved.length / submittedOrBeyond.length) * 100)
        : null,
      distinctDaysCovered: new Set(rows.map((r) => r.workDate.toISOString().slice(0, 10))).size,
    };
  }

  async conductRecords({ employeeId, from, to }: PeriodArgs) {
    const [rewards, disciplines] = await Promise.all([
      this.prisma.reward.findMany({
        where: { employeeId, rewardDate: { gte: from, lte: to } },
        select: { reason: true, amount: true, rewardType: true, rewardDate: true },
      }),
      this.prisma.discipline.findMany({
        where: { employeeId, disciplineDate: { gte: from, lte: to } },
        select: { reason: true, amount: true, disciplineType: true, disciplineDate: true },
      }),
    ]);
    return {
      rewardCount: rewards.length,
      rewardAmount: round2(rewards.reduce((s, r) => s + num(r.amount), 0)),
      rewards: rewards.slice(0, 20),
      disciplineCount: disciplines.length,
      disciplineAmount: round2(disciplines.reduce((s, r) => s + num(r.amount), 0)),
      disciplines: disciplines.slice(0, 20),
    };
  }

  async teamMembership(employeeId: string) {
    const rows = await this.prisma.teamMember.findMany({
      where: { employeeId, isActive: true },
      select: {
        role: true,
        allocationPercentage: true,
        team: { select: { name: true, type: true } },
      },
    });
    return {
      teams: rows.map((r) => ({
        team: r.team.name,
        teamType: r.team.type,
        role: r.role,
        allocationPercentage: r.allocationPercentage,
      })),
      leadRoles: rows.filter((r) => r.role === 'LEAD').length,
    };
  }
}
