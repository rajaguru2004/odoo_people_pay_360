import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  getScopedBranchIds,
  rawBranchFilter,
} from '../common/branch/branch-scope.util';
import { managerDeptScope } from '../common/services/manager-scope.util';
import { TimezoneService } from '../common/timezone/timezone.service';

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private tzSvc: TimezoneService,
  ) {}

  /** Company-local calendar day for an instant — so "this month" stats bucket
   *  by the configured timezone, not the server's UTC month boundary. */
  private async companyDayKey(instant: Date): Promise<Date> {
    const companyTZ = await this.tzSvc.getCompanyTZ();
    return this.tzSvc.toDateKey(instant, companyTZ);
  }

  async getOverview(user?: any, dateStr?: string) {
    const isManager = user?.role === 'MANAGER';
    const deptIds: string[] | undefined = isManager
      ? managerDeptScope(user)
      : undefined;
    // Branch-scoped department count: only departments with in-branch staff.
    const branchIds = getScopedBranchIds();
    const now = dateStr ? new Date(dateStr) : new Date();
    const dayKey = await this.companyDayKey(now);
    const currentMonth = dayKey.getUTCMonth() + 1;
    const currentYear = dayKey.getUTCFullYear();
    const startOfMonth = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
    const endOfMonth = new Date(Date.UTC(currentYear, currentMonth, 0));

    // Parallel queries for better performance
    const [
      totalEmployees,
      activeEmployees,
      totalDepartments,
      pendingLeaveRequests,
      pendingOvertimeRequests,
      expiringContracts,
      attendanceThisMonth,
      totalAttendanceRecords,
      lateCount,
      payrollThisMonth,
    ] = await Promise.all([
      // Total employees
      this.prisma.employee.count(),

      // Active employees
      this.prisma.employee.count({ where: { status: 'ACTIVE' } }),

      // Total departments (branch-scoped: only departments with in-branch staff)
      this.prisma.department.count({
        where: branchIds ? { employees: { some: { branchId: { in: branchIds } } } } : {},
      }),

      // Pending leave requests
      this.prisma.leaveRequest.count({
        where: {
          status: 'PENDING',
          ...(deptIds ? { employee: { departmentId: { in: deptIds } } } : {}),
        },
      }),

      // Pending overtime requests
      this.prisma.overtimeRequest.count({
        where: {
          status: 'PENDING',
          ...(deptIds ? { employee: { departmentId: { in: deptIds } } } : {}),
        },
      }),

      // Contracts expiring in 30 days
      this.prisma.contract.count({
        where: {
          status: 'ACTIVE',
          endDate: {
            gte: now,
            lte: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
          },
        },
      }),

      // Attendance this month
      this.prisma.attendance.count({
        where: {
          date: { gte: startOfMonth, lte: endOfMonth },
          status: 'PRESENT',
          ...(deptIds ? { employee: { departmentId: { in: deptIds } } } : {}),
        },
      }),

      // Total attendance records this month
      this.prisma.attendance.count({
        where: {
          date: { gte: startOfMonth, lte: endOfMonth },
          ...(deptIds ? { employee: { departmentId: { in: deptIds } } } : {}),
        },
      }),

      // Late count this month
      this.prisma.attendance.count({
        where: {
          date: { gte: startOfMonth, lte: endOfMonth },
          isLate: true,
          ...(deptIds ? { employee: { departmentId: { in: deptIds } } } : {}),
        },
      }),

      // Payroll this month
      this.prisma.payroll.findFirst({
        where: { month: currentMonth, year: currentYear },
        select: { totalAmount: true, status: true },
      }),
    ]);

    // Fall back to the most recent payroll period when the current calendar
    // month has no batch yet (e.g. payroll is run for the prior month).
    const latestPayroll =
      payrollThisMonth ??
      (await this.prisma.payroll.findFirst({
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        select: { totalAmount: true, status: true },
      }));

    const attendanceRate =
      totalAttendanceRecords > 0
        ? Math.round((attendanceThisMonth / totalAttendanceRecords) * 100)
        : 0;

    const lateRate =
      totalAttendanceRecords > 0
        ? Math.round((lateCount / totalAttendanceRecords) * 100)
        : 0;

    return {
      success: true,
      data: {
        employees: {
          total: totalEmployees,
          active: activeEmployees,
          inactive: totalEmployees - activeEmployees,
        },
        departments: {
          total: totalDepartments,
        },
        attendance: {
          thisMonth: attendanceThisMonth,
          rate: attendanceRate,
          lateCount,
          lateRate,
        },
        leaveRequests: {
          pending: pendingLeaveRequests,
        },
        overtimeRequests: {
          pending: pendingOvertimeRequests,
        },
        contracts: {
          expiringSoon: expiringContracts,
        },
        payroll: {
          thisMonth: latestPayroll
            ? {
                total: Number(latestPayroll.totalAmount),
                status: latestPayroll.status,
              }
            : null,
        },
      },
    };
  }

  async getEmployeeStats(user?: any) {
    const isManager = user?.role === 'MANAGER';
    const deptFilter = isManager ? { departmentId: { in: managerDeptScope(user) } } : {};

    // Single query with groupBy for better performance
    const [byDepartment, byStatus, byGender, departments] = await Promise.all([
      this.prisma.employee.groupBy({
        by: ['departmentId'],
        _count: true,
        where: { status: 'ACTIVE', ...deptFilter },
      }),
      this.prisma.employee.groupBy({
        by: ['status'],
        _count: true,
        where: deptFilter,
      }),
      this.prisma.employee.groupBy({
        by: ['gender'],
        _count: true,
        where: deptFilter,
      }),
      // Fetch all departments once
      this.prisma.department.findMany({
        select: { id: true, name: true, code: true },
      }),
    ]);

    // Create department map for O(1) lookup
    const deptMap = new Map(departments.map((d) => [d.id, d]));

    return {
      success: true,
      data: {
        byDepartment: byDepartment.map((item) => ({
          department: deptMap.get(item.departmentId)?.name || 'Unknown',
          count: item._count,
        })),
        byStatus: byStatus.map((item) => ({
          status: item.status,
          count: item._count,
        })),
        byGender: byGender.map((item) => ({
          gender: item.gender,
          count: item._count,
        })),
      },
    };
  }

  async getAttendanceSummary(user?: any, month?: number, year?: number) {
    const isManager = user?.role === 'MANAGER';
    // An EMPLOYEE gets their own figures. The route admits all four roles and
    // there was no EMPLOYEE arm, so an employee's summary counted every
    // colleague the branch middleware let through — a whole department's
    // lateness presented as if it were their own.
    const deptFilter =
      user?.role === 'EMPLOYEE'
        ? { employeeId: user.employeeId ? user.employeeId : { in: [] } }
        : isManager
          ? { employee: { departmentId: { in: managerDeptScope(user) } } }
          : {};

    const dayKey = await this.companyDayKey(new Date());
    const targetMonth = month || dayKey.getUTCMonth() + 1;
    const targetYear = year || dayKey.getUTCFullYear();
    const startDate = new Date(Date.UTC(targetYear, targetMonth - 1, 1));
    const endDate = new Date(Date.UTC(targetYear, targetMonth, 0));

    const [total, present, late, earlyLeave, avgWorkHours] = await Promise.all([
      this.prisma.attendance.count({
        where: { date: { gte: startDate, lte: endDate }, ...deptFilter },
      }),
      this.prisma.attendance.count({
        where: {
          date: { gte: startDate, lte: endDate },
          status: 'PRESENT',
          ...deptFilter,
        },
      }),
      this.prisma.attendance.count({
        where: {
          date: { gte: startDate, lte: endDate },
          isLate: true,
          ...deptFilter,
        },
      }),
      this.prisma.attendance.count({
        where: {
          date: { gte: startDate, lte: endDate },
          isEarlyLeave: true,
          ...deptFilter,
        },
      }),
      this.prisma.attendance.aggregate({
        where: { date: { gte: startDate, lte: endDate }, ...deptFilter },
        _avg: { workHours: true },
      }),
    ]);

    // Daily attendance trend
    const dailyTrend = await this.prisma.attendance.groupBy({
      by: ['date'],
      where: { date: { gte: startDate, lte: endDate }, ...deptFilter },
      _count: true,
      orderBy: { date: 'asc' },
    });

    const trend = dailyTrend.map((item) => ({
      date: item.date.toISOString().split('T')[0],
      count: item._count,
    }));

    return {
      success: true,
      data: {
        summary: {
          total,
          present,
          late,
          earlyLeave,
          presentRate: total > 0 ? Math.round((present / total) * 100) : 0,
          lateRate: total > 0 ? Math.round((late / total) * 100) : 0,
          avgWorkHours:
            Math.round((Number(avgWorkHours._avg.workHours) || 0) * 100) / 100,
        },
        trend,
      },
      meta: { month: targetMonth, year: targetYear },
    };
  }

  async getPayrollSummary(year?: number) {
    const targetYear = year || new Date().getFullYear();

    const payrolls = await this.prisma.payroll.findMany({
      where: { year: targetYear },
      orderBy: { month: 'asc' },
      select: {
        month: true,
        year: true,
        totalAmount: true,
        status: true,
        _count: { select: { items: true } },
      },
    });

    const summary = payrolls.map((p) => ({
      month: p.month,
      year: p.year,
      totalAmount: Number(p.totalAmount),
      employeeCount: p._count.items,
      status: p.status,
    }));

    const totalPaid = payrolls
      .filter((p) => p.status === 'LOCKED')
      .reduce((sum, p) => sum + Number(p.totalAmount), 0);

    return {
      success: true,
      data: {
        summary,
        totalPaid,
        monthsProcessed: payrolls.length,
      },
      meta: { year: targetYear },
    };
  }

  async getAlerts(user?: any) {
    const isManager = user?.role === 'MANAGER';
    const deptIds: string[] | undefined = isManager
      ? managerDeptScope(user)
      : undefined;

    const now = new Date();
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Use parallel queries with optimized selects
    const [
      expiringContracts,
      pendingLeaveRequests,
      recentLateEmployees,
      pendingOvertimeRequests,
      pendingOvertimeCount,
    ] = await Promise.all([
      // Contracts expiring soon - with employee data in single query
      this.prisma.contract.findMany({
        where: {
          status: 'ACTIVE',
          endDate: { gte: now, lte: in30Days },
          ...(deptIds ? { employee: { departmentId: { in: deptIds } } } : {}),
        },
        select: {
          id: true,
          endDate: true,
          employee: {
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
            },
          },
        },
        orderBy: { endDate: 'asc' },
        take: 10,
      }),

      // Pending leave requests - with employee data in single query
      this.prisma.leaveRequest.findMany({
        where: {
          status: 'PENDING',
          ...(deptIds ? { employee: { departmentId: { in: deptIds } } } : {}),
        },
        select: {
          id: true,
          leaveType: true,
          startDate: true,
          totalDays: true,
          createdAt: true,
          employee: {
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 10,
      }),

      // Employees with late check-ins in last 7 days - with employee data
      this.prisma.attendance.groupBy({
        by: ['employeeId'],
        where: {
          date: { gte: sevenDaysAgo },
          isLate: true,
          ...(deptIds ? { employee: { departmentId: { in: deptIds } } } : {}),
        },
        _count: true,
        orderBy: { _count: { employeeId: 'desc' } },
        take: 10,
      }),

      // Pending overtime requests - with employee data in single query
      this.prisma.overtimeRequest.findMany({
        where: {
          status: 'PENDING',
          ...(deptIds ? { employee: { departmentId: { in: deptIds } } } : {}),
        },
        select: {
          id: true,
          date: true,
          hours: true,
          reason: true,
          createdAt: true,
          employee: {
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 10,
      }),

      // Pending overtime count
      this.prisma.overtimeRequest.count({
        where: {
          status: 'PENDING',
          ...(deptIds ? { employee: { departmentId: { in: deptIds } } } : {}),
        },
      }),
    ]);

    // Fetch employee details for late employees (only if needed)
    const lateEmployeeIds = recentLateEmployees.map((item) => item.employeeId);
    const lateEmployeeDetails =
      lateEmployeeIds.length > 0
        ? await this.prisma.employee.findMany({
            where: { id: { in: lateEmployeeIds } },
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
            },
          })
        : [];

    const empMap = new Map(lateEmployeeDetails.map((e) => [e.id, e]));

    return {
      success: true,
      data: {
        expiringContracts: expiringContracts.map((c) => ({
          contractId: c.id,
          employee: c.employee,
          endDate: c.endDate,
          daysRemaining: c.endDate
            ? Math.ceil(
                (c.endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
              )
            : 0,
        })),
        pendingLeaveRequests: pendingLeaveRequests.map((lr) => ({
          requestId: lr.id,
          employee: lr.employee,
          leaveType: lr.leaveType,
          startDate: lr.startDate,
          totalDays: lr.totalDays,
          createdAt: lr.createdAt,
        })),
        frequentLateEmployees: recentLateEmployees.map((item) => ({
          employee: empMap.get(item.employeeId),
          lateCount: item._count,
        })),
        pendingOvertimeRequests: pendingOvertimeRequests.map((ot) => ({
          requestId: ot.id,
          employee: ot.employee,
          date: ot.date,
          hours: ot.hours ? Number(ot.hours) : 0,
          reason: ot.reason,
          createdAt: ot.createdAt,
        })),
        pendingOvertimeCount,
      },
    };
  }

  async getRecentActivities(user?: any, limit: number = 10) {
    const isManager = user?.role === 'MANAGER';
    const deptFilter = isManager
      ? { employee: { departmentId: { in: managerDeptScope(user) } } }
      : {};

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Fetch recent activities from different sources
    const [recentEmployees, recentLeaveRequests, recentAttendances] =
      await Promise.all([
        // Recent employee updates
        this.prisma.employee.findMany({
          where: {
            updatedAt: { gte: sevenDaysAgo },
            ...(isManager ? { departmentId: { in: managerDeptScope(user) } } : {}),
          },
          select: {
            id: true,
            fullName: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: 'desc' },
          take: limit,
        }),

        // Recent leave requests
        this.prisma.leaveRequest.findMany({
          where: {
            createdAt: { gte: sevenDaysAgo },
            ...deptFilter,
          },
          select: {
            id: true,
            status: true,
            totalDays: true,
            createdAt: true,
            employee: {
              select: { fullName: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),

        // Recent attendance check-ins/outs using actual event timestamps
        this.prisma.attendance.findMany({
          where: {
            OR: [
              { checkIn: { gte: sevenDaysAgo } },
              { checkOut: { gte: sevenDaysAgo } },
            ],
            ...deptFilter,
          },
          select: {
            id: true,
            checkIn: true,
            checkOut: true,
            employee: {
              select: { fullName: true },
            },
          },
          orderBy: { date: 'desc' },
          take: limit,
        }),
      ]);

    // Combine and format activities
    const activities: any[] = [];

    // Employee activities
    recentEmployees.forEach((emp) => {
      const isNew = emp.createdAt.getTime() === emp.updatedAt.getTime();
      activities.push({
        id: `emp-${emp.id}`,
        type: isNew ? 'employee_created' : 'employee_updated',
        description: isNew
          ? `New employee: ${emp.fullName}`
          : `Updated information: ${emp.fullName}`,
        user: 'HR Manager',
        timestamp: emp.updatedAt,
      });
    });

    // Leave request activities
    recentLeaveRequests.forEach((lr) => {
      activities.push({
        id: `leave-${lr.id}`,
        type: `leave_${lr.status.toLowerCase()}`,
        description: `Leave request - ${lr.employee.fullName} (${lr.totalDays} days)`,
        user: lr.employee.fullName,
        timestamp: lr.createdAt,
      });
    });

    // Attendance activities
    recentAttendances.forEach((att) => {
      if (att.checkIn && att.checkIn >= sevenDaysAgo) {
        activities.push({
          id: `att-in-${att.id}`,
          type: 'attendance_checkin',
          description: `${att.employee.fullName} checked in`,
          user: att.employee.fullName,
          timestamp: att.checkIn,
        });
      }
      if (att.checkOut && att.checkOut >= sevenDaysAgo) {
        activities.push({
          id: `att-out-${att.id}`,
          type: 'attendance_checkout',
          description: `${att.employee.fullName} checked out`,
          user: att.employee.fullName,
          timestamp: att.checkOut,
        });
      }
    });

    // Sort by timestamp and limit
    const sortedActivities = activities
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);

    return {
      success: true,
      data: sortedActivities,
    };
  }

  async getTodaySnapshot(user?: any, dateStr?: string) {
    const isManager = user?.role === 'MANAGER';
    const deptIds: string[] | undefined = isManager
      ? managerDeptScope(user)
      : undefined;

    if (deptIds) {
      // Dept-scoped counts for MANAGER (Prisma queries, no raw SQL)
      const now = dateStr ? new Date(dateStr) : new Date();
      const today = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const in7Days = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

      const [workingNow, lateToday, pendingLeaves, pendingOvertime] =
        await Promise.all([
          this.prisma.attendance.count({
            where: {
              date: today,
              checkIn: { not: null },
              checkOut: null,
              status: { not: 'ABSENT' },
              employee: { departmentId: { in: deptIds } },
            },
          }),
          this.prisma.attendance.count({
            where: {
              date: today,
              isLate: true,
              employee: { departmentId: { in: deptIds } },
            },
          }),
          this.prisma.leaveRequest.count({
            where: { status: 'PENDING', employee: { departmentId: { in: deptIds } } },
          }),
          this.prisma.overtimeRequest.count({
            where: { status: 'PENDING', employee: { departmentId: { in: deptIds } } },
          }),
        ]);

      return {
        success: true,
        data: {
          workingNow,
          lateToday,
          pendingApprovals: pendingLeaves + pendingOvertime,
          expiringContracts: 0, // not relevant for dept manager today snapshot
          lastUpdated: new Date().toISOString(),
        },
      };
    }

    // ADMIN/HR_MANAGER: use Prisma counts (NOT raw SQL) so the branch-scoping
    // Prisma middleware applies. A raw $queryRaw bypasses that middleware and
    // returns company-wide counts, ignoring the branch selected in the top bar
    // (X-Branch-Id) — which is why the copilot/dashboard showed all-branch
    // numbers while the attendance page showed only the selected branch. All of
    // these models are branch-scoped (Attendance direct; Leave/Overtime/Contract
    // via employee.branchId), so the counts now honour the active branch scope.
    const now = dateStr ? new Date(dateStr) : new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const in7Days = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [workingNow, lateToday, pendingLeaves, pendingOvertime, expiringContracts] =
      await Promise.all([
        this.prisma.attendance.count({
          where: {
            date: today,
            checkIn: { not: null },
            checkOut: null,
            status: { not: 'ABSENT' },
          },
        }),
        this.prisma.attendance.count({ where: { date: today, isLate: true } }),
        this.prisma.leaveRequest.count({ where: { status: 'PENDING' } }),
        this.prisma.overtimeRequest.count({ where: { status: 'PENDING' } }),
        this.prisma.contract.count({
          where: { status: 'ACTIVE', endDate: { gte: today, lte: in7Days } },
        }),
      ]);

    return {
      success: true,
      data: {
        workingNow,
        lateToday,
        pendingApprovals: pendingLeaves + pendingOvertime,
        expiringContracts,
        lastUpdated: new Date().toISOString(),
      },
    };
  }

  async getTurnoverStats(months: number = 6) {
    // Use optimized view instead of N+1 queries
    const turnoverData: any = await this.prisma.$queryRaw`
      WITH monthly_data AS (
        SELECT
          DATE_TRUNC('month', updated_at) as month,
          EXTRACT(YEAR FROM updated_at) as year,
          EXTRACT(MONTH FROM updated_at) as month_num,
          COUNT(*) FILTER (WHERE status = 'INACTIVE') as terminations,
          (
            SELECT COUNT(*)
            FROM employees e2
            WHERE e2.created_at <= DATE_TRUNC('month', MAX(e.updated_at)) + INTERVAL '1 month' - INTERVAL '1 day'
            ${rawBranchFilter('e2')}
          ) as total_employees_at_month_end
        FROM employees e
        WHERE updated_at >= CURRENT_DATE - INTERVAL '12 months'
        ${rawBranchFilter('e')}
        GROUP BY DATE_TRUNC('month', updated_at), EXTRACT(YEAR FROM updated_at), EXTRACT(MONTH FROM updated_at)
      )
      SELECT
        month,
        year,
        month_num,
        terminations,
        total_employees_at_month_end as total_employees,
        CASE
          WHEN total_employees_at_month_end > 0
          THEN ROUND((terminations::DECIMAL / total_employees_at_month_end) * 100, 1)
          ELSE 0
        END as turnover_rate
      FROM monthly_data
      ORDER BY month DESC
      LIMIT ${months}
    `;

    // Get current and last month data
    const thisMonth = turnoverData[0] || { terminations: 0, turnover_rate: 0 };
    const lastMonth = turnoverData[1] || { terminations: 0, turnover_rate: 0 };

    // Calculate change
    const change =
      lastMonth.terminations > 0
        ? ((Number(thisMonth.terminations) - Number(lastMonth.terminations)) /
            Number(lastMonth.terminations)) *
          100
        : 0;

    // Build trend array (reverse to show oldest to newest)
    const trend = turnoverData
      .reverse()
      .map((row: any) => Number(row.turnover_rate));

    // Get department with highest turnover this month
    const now = new Date();
    const startOfCurrentMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const endOfCurrentMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    );

    const departmentTurnover = await this.prisma.employee.groupBy({
      by: ['departmentId'],
      where: {
        status: 'INACTIVE',
        updatedAt: {
          gte: startOfCurrentMonth,
          lte: endOfCurrentMonth,
        },
      },
      _count: true,
      orderBy: {
        _count: {
          departmentId: 'desc',
        },
      },
      take: 1,
    });

    let topDepartment = 'N/A';
    if (departmentTurnover.length > 0) {
      const dept = await this.prisma.department.findUnique({
        where: { id: departmentTurnover[0].departmentId },
        select: { name: true },
      });
      topDepartment = dept?.name || 'N/A';
    }

    return {
      success: true,
      data: {
        thisMonth: Number(thisMonth.terminations),
        lastMonth: Number(lastMonth.terminations),
        rate: Number(thisMonth.turnover_rate),
        change: Math.round(change * 10) / 10,
        trend,
        topDepartment,
      },
    };
  }
}
