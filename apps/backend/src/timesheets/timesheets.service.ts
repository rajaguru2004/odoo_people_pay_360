import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  managerDeptScope,
  isDeptInManagerScope,
} from '../common/services/manager-scope.util';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CreateTimesheetDto,
  UpdateTimesheetDto,
  ApproveRejectTimesheetDto,
} from './dto/create-timesheet.dto';
import { QueryTimesheetDto } from './dto/query-timesheet.dto';

@Injectable()
export class TimesheetsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  private timesheetInclude = {
    employee: {
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        avatarUrl: true,
        department: { select: { name: true } },
      },
    },
    task: { select: { id: true, taskCode: true, title: true } },
    approver: {
      select: {
        id: true,
        email: true,
        employee: { select: { fullName: true } },
      },
    },
  };

  private buildWhere(query: QueryTimesheetDto, user: any) {
    const where: any = { deletedAt: null };
    if (query.status) where.status = query.status;
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.taskId) where.taskId = query.taskId;
    if (query.startDate || query.endDate) {
      where.workDate = {};
      if (query.startDate) where.workDate.gte = new Date(query.startDate);
      if (query.endDate) where.workDate.lte = new Date(query.endDate);
    }
    // MANAGER: scope to own dept
    if (user?.role === 'MANAGER' && user?.departmentId) {
      where.employee = { departmentId: { in: managerDeptScope(user) } };
    }
    return where;
  }

  async create(dto: CreateTimesheetDto, user: any) {
    if (!user?.employeeId)
      throw new BadRequestException('No employee profile linked');

    const task = await this.prisma.task.findFirst({
      where: { id: dto.taskId, deletedAt: null },
    });
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const timesheet = await this.prisma.timesheet.create({
      data: {
        employeeId: user.employeeId,
        taskId: dto.taskId,
        workDate: new Date(dto.workDate),
        hoursWorked: dto.hoursWorked,
        description: dto.description,
        status: 'DRAFT',
      },
      include: this.timesheetInclude,
    });

    return { success: true, message: 'Timesheet created', data: timesheet };
  }

  async findAll(query: QueryTimesheetDto, user: any) {
    const page = Number(query.page) || 1;
    const limit = Math.min(Number(query.limit) || 20, 200);
    const skip = (page - 1) * limit;
    const where = this.buildWhere(query, user);

    const [timesheets, total] = await Promise.all([
      this.prisma.timesheet.findMany({
        where,
        skip,
        take: limit,
        include: this.timesheetInclude,
        orderBy: { workDate: 'desc' },
      }),
      this.prisma.timesheet.count({ where }),
    ]);

    return {
      success: true,
      data: timesheets,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findMine(user: any, query: QueryTimesheetDto) {
    if (!user?.employeeId)
      return { success: true, data: [], meta: { total: 0 } };
    const where: any = { employeeId: user.employeeId, deletedAt: null };
    if (query.status) where.status = query.status;
    if (query.startDate || query.endDate) {
      where.workDate = {};
      if (query.startDate) where.workDate.gte = new Date(query.startDate);
      if (query.endDate) where.workDate.lte = new Date(query.endDate);
    }

    const timesheets = await this.prisma.timesheet.findMany({
      where,
      include: this.timesheetInclude,
      orderBy: { workDate: 'desc' },
    });

    return {
      success: true,
      data: timesheets,
      meta: { total: timesheets.length },
    };
  }

  async findPending(user: any) {
    const where: any = { status: 'SUBMITTED', deletedAt: null };
    if (user?.role === 'MANAGER' && user?.departmentId) {
      where.employee = { departmentId: { in: managerDeptScope(user) } };
    }

    const timesheets = await this.prisma.timesheet.findMany({
      where,
      include: this.timesheetInclude,
      orderBy: { submittedAt: 'asc' },
    });

    return {
      success: true,
      data: timesheets,
      meta: { total: timesheets.length },
    };
  }

  async findOne(id: string, user: any) {
    const ts = await this.prisma.timesheet.findFirst({
      where: { id, deletedAt: null },
      include: this.timesheetInclude,
    });
    if (!ts) throw new NotFoundException('Timesheet not found');
    this.assertReadAccess(ts, user);
    return { success: true, data: ts };
  }

  async update(id: string, dto: UpdateTimesheetDto, user: any) {
    const ts = await this.prisma.timesheet.findFirst({
      where: { id, deletedAt: null },
    });
    if (!ts) throw new NotFoundException('Timesheet not found');
    if (ts.employeeId !== user?.employeeId)
      throw new ForbiddenException('Access denied');
    if (ts.status !== 'DRAFT')
      throw new BadRequestException('Only draft timesheets can be updated');

    if (dto.taskId) {
      const task = await this.prisma.task.findFirst({
        where: { id: dto.taskId, deletedAt: null },
      });
      if (!task) {
        throw new NotFoundException('Task not found');
      }
    }

    const updated = await this.prisma.timesheet.update({
      where: { id },
      data: {
        ...(dto.taskId !== undefined && { taskId: dto.taskId }),
        ...(dto.workDate !== undefined && { workDate: new Date(dto.workDate) }),
        ...(dto.hoursWorked !== undefined && { hoursWorked: dto.hoursWorked }),
        ...(dto.description !== undefined && { description: dto.description }),
      },
      include: this.timesheetInclude,
    });

    return { success: true, message: 'Timesheet updated', data: updated };
  }

  async remove(id: string, user: any) {
    const ts = await this.prisma.timesheet.findFirst({
      where: { id, deletedAt: null },
    });
    if (!ts) throw new NotFoundException('Timesheet not found');
    if (ts.employeeId !== user?.employeeId)
      throw new ForbiddenException('Access denied');
    if (ts.status !== 'DRAFT')
      throw new BadRequestException('Only draft timesheets can be deleted');

    await this.prisma.timesheet.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { success: true, message: 'Timesheet deleted' };
  }

  async submit(id: string, user: any) {
    const ts = await this.prisma.timesheet.findFirst({
      where: { id, deletedAt: null },
      include: { employee: { select: { departmentId: true } } },
    });
    if (!ts) throw new NotFoundException('Timesheet not found');
    if (ts.employeeId !== user?.employeeId)
      throw new ForbiddenException('Access denied');
    if (ts.status !== 'DRAFT')
      throw new BadRequestException('Only draft timesheets can be submitted');

    const updated = await this.prisma.timesheet.update({
      where: { id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
      include: this.timesheetInclude,
    });

    // Notify managers/HR
    await this.notifyManagers(
      ts.employee?.departmentId,
      'Timesheet Submitted',
      `Employee submitted a timesheet for ${ts.workDate.toLocaleDateString()}`,
      id,
    );

    return {
      success: true,
      message: 'Timesheet submitted for approval',
      data: updated,
    };
  }

  async approve(id: string, dto: ApproveRejectTimesheetDto, user: any) {
    if (!['ADMIN', 'HR_MANAGER', 'MANAGER'].includes(user?.role))
      throw new ForbiddenException('Insufficient permissions');

    const ts = await this.prisma.timesheet.findFirst({
      where: { id, deletedAt: null },
    });
    if (!ts) throw new NotFoundException('Timesheet not found');
    if (ts.status !== 'SUBMITTED')
      throw new BadRequestException(
        'Only submitted timesheets can be approved',
      );

    if (user?.role === 'MANAGER' && user?.departmentId) {
      const emp = await this.prisma.employee.findUnique({
        where: { id: ts.employeeId },
        select: { departmentId: true },
      });
      if (!isDeptInManagerScope(user, emp?.departmentId))
        throw new ForbiddenException(
          'You can only approve timesheets for your department',
        );
    }

    const updated = await this.prisma.timesheet.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: user.id },
      include: this.timesheetInclude,
    });

    // Notify employee
    await this.notifyEmployee(
      ts.employeeId,
      'Timesheet Approved',
      `Your timesheet for ${ts.workDate.toLocaleDateString()} has been approved`,
      id,
    );

    return { success: true, message: 'Timesheet approved', data: updated };
  }

  async reject(id: string, dto: ApproveRejectTimesheetDto, user: any) {
    if (!['ADMIN', 'HR_MANAGER', 'MANAGER'].includes(user?.role))
      throw new ForbiddenException('Insufficient permissions');

    const ts = await this.prisma.timesheet.findFirst({
      where: { id, deletedAt: null },
    });
    if (!ts) throw new NotFoundException('Timesheet not found');
    if (ts.status !== 'SUBMITTED')
      throw new BadRequestException(
        'Only submitted timesheets can be rejected',
      );

    const updated = await this.prisma.timesheet.update({
      where: { id },
      data: {
        status: 'REJECTED',
        approvedAt: new Date(),
        approvedBy: user.id,
        rejectionReason: dto.rejectionReason || dto.comment,
      },
      include: this.timesheetInclude,
    });

    await this.notifyEmployee(
      ts.employeeId,
      'Timesheet Rejected',
      `Your timesheet for ${ts.workDate.toLocaleDateString()} was rejected`,
      id,
    );

    return { success: true, message: 'Timesheet rejected', data: updated };
  }

  // ─── Summary endpoints ───────────────────────────────────────────────────────

  async getDailySummary(user: any, date?: string) {
    const targetDate = date ? new Date(date) : new Date();
    const dayStart = new Date(
      Date.UTC(
        targetDate.getFullYear(),
        targetDate.getMonth(),
        targetDate.getDate(),
      ),
    );
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const timesheets = await this.prisma.timesheet.findMany({
      where: {
        employeeId: user?.employeeId,
        workDate: { gte: dayStart, lt: dayEnd },
        deletedAt: null,
      },
      include: this.timesheetInclude,
    });

    const totalHours = timesheets.reduce(
      (sum, ts) => sum + Number(ts.hoursWorked),
      0,
    );
    return { success: true, data: { date: dayStart, totalHours, timesheets } };
  }

  async getWeeklySummary(user: any, weekStart?: string) {
    const start = weekStart
      ? new Date(weekStart)
      : this.getStartOfWeek(new Date());
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);

    const timesheets = await this.prisma.timesheet.findMany({
      where: {
        employeeId: user?.employeeId,
        workDate: { gte: start, lt: end },
        deletedAt: null,
      },
      include: this.timesheetInclude,
      orderBy: { workDate: 'asc' },
    });

    const totalHours = timesheets.reduce(
      (sum, ts) => sum + Number(ts.hoursWorked),
      0,
    );
    const byDay = this.groupByDate(timesheets);
    return {
      success: true,
      data: { weekStart: start, weekEnd: end, totalHours, byDay, timesheets },
    };
  }

  async getMonthlySummary(user: any, year?: number, month?: number) {
    const now = new Date();
    const y = year || now.getFullYear();
    const m = month !== undefined ? month - 1 : now.getMonth();
    const monthStart = new Date(Date.UTC(y, m, 1));
    const monthEnd = new Date(Date.UTC(y, m + 1, 1));

    const timesheets = await this.prisma.timesheet.findMany({
      where: {
        employeeId: user?.employeeId,
        workDate: { gte: monthStart, lt: monthEnd },
        deletedAt: null,
      },
      include: this.timesheetInclude,
      orderBy: { workDate: 'asc' },
    });

    const totalHours = timesheets.reduce(
      (sum, ts) => sum + Number(ts.hoursWorked),
      0,
    );
    const byDay = this.groupByDate(timesheets);
    return {
      success: true,
      data: { year: y, month: m + 1, totalHours, byDay, timesheets },
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private assertReadAccess(ts: any, user: any) {
    if (['ADMIN', 'HR_MANAGER'].includes(user?.role)) return;
    if (user?.role === 'MANAGER') return;
    if (ts.employeeId === user?.employeeId) return;
    throw new ForbiddenException('Access denied');
  }

  private getStartOfWeek(date: Date) {
    const d = new Date(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
    );
    const day = d.getUTCDay(); // 0=Sun
    d.setUTCDate(d.getUTCDate() - day + 1); // Monday
    return d;
  }

  private groupByDate(timesheets: any[]) {
    const map: Record<string, any> = {};
    for (const ts of timesheets) {
      const key = ts.workDate.toISOString().split('T')[0];
      if (!map[key]) map[key] = { date: key, totalHours: 0, items: [] };
      map[key].totalHours += Number(ts.hoursWorked);
      map[key].items.push(ts);
    }
    return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
  }

  private async notifyEmployee(
    employeeId: string,
    title: string,
    message: string,
    tsId: string,
  ) {
    try {
      const u = await this.prisma.user.findFirst({
        where: { employeeId },
        select: { id: true },
      });
      if (u)
        await this.notifications.notifyUser(
          u.id,
          title,
          message,
          'INFO',
          `/dashboard/timesheets/${tsId}`,
        );
    } catch {}
  }

  private async notifyManagers(
    departmentId: string | undefined,
    title: string,
    message: string,
    tsId: string,
  ) {
    try {
      const managers = await this.prisma.user.findMany({
        where: {
          role: { in: ['ADMIN', 'HR_MANAGER', 'MANAGER'] },
          isActive: true,
        },
        select: { id: true },
      });
      for (const m of managers) {
        await this.notifications.notifyUser(
          m.id,
          title,
          message,
          'INFO',
          `/dashboard/timesheets/${tsId}`,
        );
      }
    } catch {}
  }
}
