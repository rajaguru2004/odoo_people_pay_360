import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  getScopedBranchIds,
  rawBranchFilter,
} from '../common/branch/branch-scope.util';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { demoteIfHeadsNothing } from './manager-role.util';

@Injectable()
export class DepartmentsService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    await this.syncManagerRoles();
  }

  async syncManagerRoles() {
    try {
      // Find all active departments with a manager
      const departments = await this.prisma.department.findMany({
        where: {
          isActive: true,
          managerId: { not: null },
        },
        include: {
          manager: {
            include: {
              user: true,
            },
          },
        },
      });

      for (const dept of departments) {
        if (dept.manager?.user && dept.manager.user.role === 'EMPLOYEE') {
          console.log(
            `Syncing role to MANAGER for user ${dept.manager.user.email} (Department Head of ${dept.name})`,
          );
          await this.prisma.user.update({
            where: { id: dept.manager.user.id },
            data: { role: 'MANAGER' },
          });
        }
      }
    } catch (error) {
      console.error(
        'Failed to sync manager roles on module initialization:',
        error,
      );
    }
  }

  async create(dto: CreateDepartmentDto) {
    // Check if code exists
    const existing = await this.prisma.department.findUnique({
      where: { code: dto.code },
    });

    if (existing) {
      throw new ConflictException('Department code already exists');
    }

    // Validate parent department
    if (dto.parentId) {
      const parent = await this.prisma.department.findUnique({
        where: { id: dto.parentId },
      });

      if (!parent) {
        throw new BadRequestException('Parent department not found');
      }

      // Business Rule: Prevent creating too deep hierarchy (max 2 levels)
      if (parent.parentId) {
        throw new BadRequestException(
          'Cannot create department more than 2 levels deep. Teams can only be children of main departments.',
        );
      }
    }

    // Validate manager
    if (dto.managerId) {
      const manager = await this.prisma.employee.findUnique({
        where: { id: dto.managerId },
      });

      if (!manager) {
        throw new BadRequestException('Manager not found');
      }

      // Business Rule: Manager must belong to the same department (or parent if creating child)
      if (dto.parentId) {
        // For child departments (teams), manager should be from parent department
        if (manager.departmentId !== dto.parentId) {
          throw new BadRequestException(
            'Team manager must be an employee of the parent department',
          );
        }
      }

      // A manager may head more than one department, so there is deliberately
      // no "already managing another department" check here.
    }

    const department = await this.prisma.department.create({
      data: dto,
      include: {
        parent: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        manager: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
          },
        },
      },
    });

    return {
      success: true,
      message: 'Department created successfully',
      data: department,
    };
  }

  /**
   * Departments are orthogonal to Branch (an employee has both). When a branch
   * is selected we (a) only surface departments that have at least one employee
   * in that branch and (b) scope every employee count to that branch. Returns
   * empty filters (no narrowing) for unscoped/global callers.
   */
  // Public because the Organization hub needs the SAME narrowing. Department is
  // deliberately absent from BRANCH_SCOPE, so this helper is the one correct way
  // to branch-filter a department query — a second copy in the hub would be a
  // divergent rule that drifts the moment either side is edited.
  departmentBranchFilters() {
    const branchIds = getScopedBranchIds();
    const empWhere = branchIds ? { branchId: { in: branchIds } } : undefined;
    return {
      // raw scalar predicate for merging into an employees `where`
      empWhere,
      // department-list narrowing: has ≥1 in-branch employee, OR is empty
      // (no employees anywhere) so freshly-created departments stay visible
      // under every branch until staff are assigned.
      deptScope: empWhere
        ? {
            OR: [
              { employees: { some: empWhere } },
              { employees: { none: {} } },
            ],
          }
        : {},
      // filtered relation count: only in-branch employees
      empCount: (empWhere ? { where: empWhere } : true) as unknown as true,
    };
  }

  async findAll() {
    const { deptScope, empCount } = this.departmentBranchFilters();
    const departments = await this.prisma.department.findMany({
      where: { isActive: true, ...deptScope },
      include: {
        parent: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        children: {
          select: {
            id: true,
            code: true,
            name: true,
            isActive: true,
            _count: {
              select: {
                employees: empCount,
              },
            },
          },
          where: { isActive: true },
        },
        manager: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
          },
        },
        _count: {
          select: {
            employees: empCount,
            children: true,
          },
        },
      },
      orderBy: { code: 'asc' },
    });

    return {
      success: true,
      data: departments,
    };
  }

  async findOne(id: string) {
    const { empWhere, empCount } = this.departmentBranchFilters();
    const department = await this.prisma.department.findUnique({
      where: { id },
      include: {
        parent: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        children: {
          select: {
            id: true,
            code: true,
            name: true,
            isActive: true,
          },
        },
        manager: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
            email: true,
            phone: true,
          },
        },
        employees: {
          where: { status: 'ACTIVE', ...(empWhere ?? {}) },
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
            email: true,
          },
          take: 10,
        },
        _count: {
          select: {
            employees: empCount,
            children: true,
          },
        },
      },
    });

    if (!department) {
      throw new NotFoundException('Department not found');
    }
    // Gone from every list and from the tree, so a stale link must not keep
    // working — and an edit form must not keep saving into it.
    if (!department.isActive) {
      throw new NotFoundException('Department not found');
    }

    return {
      success: true,
      data: department,
    };
  }

  async update(id: string, dto: UpdateDepartmentDto) {
    const department = await this.prisma.department.findUnique({
      where: { id },
      include: {
        _count: {
          select: { employees: true, children: true },
        },
      },
    });

    if (!department) {
      throw new NotFoundException('Department not found');
    }

    // Check code uniqueness if changing
    if (dto.code && dto.code !== department.code) {
      const existing = await this.prisma.department.findUnique({
        where: { code: dto.code },
      });

      if (existing) {
        throw new ConflictException('Department code already exists');
      }
    }

    // Validate parent department
    if (dto.parentId !== undefined) {
      if (dto.parentId === id) {
        throw new BadRequestException('Department cannot be its own parent');
      }

      if (dto.parentId) {
        const parent = await this.prisma.department.findUnique({
          where: { id: dto.parentId },
        });

        if (!parent) {
          throw new BadRequestException('Parent department not found');
        }

        // Business Rule: Prevent circular references
        await this.checkCircularReference(id, dto.parentId);

        // Business Rule: Prevent too deep hierarchy
        if (parent.parentId) {
          throw new BadRequestException(
            'Cannot create department more than 2 levels deep',
          );
        }

        // Same rule seen from the child side: attaching a department that
        // already has sub-departments would push those sub-departments to a
        // third level.
        if (
          department.parentId !== dto.parentId &&
          department._count.children > 0
        ) {
          throw new BadRequestException(
            'Cannot move a department that has sub-departments under another department. Detach or move its sub-departments first.',
          );
        }

        // Business Rule: Cannot change parent if department has employees
        if (
          department.parentId !== dto.parentId &&
          department._count.employees > 0
        ) {
          throw new BadRequestException(
            'Cannot change parent department when department has employees. Move employees first.',
          );
        }
      }
    }

    // Validate manager
    if (dto.managerId) {
      const manager = await this.prisma.employee.findUnique({
        where: { id: dto.managerId },
      });

      if (!manager) {
        throw new BadRequestException('Manager not found');
      }

      // A manager may head more than one department, so there is deliberately
      // no "already managing another department" check here.
    }

    const updated = await this.prisma.department.update({
      where: { id },
      data: dto,
      include: {
        parent: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        manager: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
          },
        },
      },
    });

    return {
      success: true,
      message: 'Department updated successfully',
      data: updated,
    };
  }

  async delete(id: string) {
    const department = await this.prisma.department.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            employees: true,
            // ACTIVE children only. Counting retired ones too left a parent
            // permanently undeletable, refused because of sub-departments the
            // user could no longer see anywhere.
            children: { where: { isActive: true } },
          },
        },
      },
    });

    if (!department) {
      throw new NotFoundException('Department not found');
    }

    if (department._count.employees > 0) {
      throw new BadRequestException('Cannot delete department with employees');
    }

    if (department._count.children > 0) {
      throw new BadRequestException(
        'Cannot delete department with sub-departments',
      );
    }

    // Soft delete
    await this.prisma.department.update({
      where: { id },
      data: { isActive: false },
    });

    // Removing the department someone headed is one of the two ways a person
    // stops being a manager; the other is a change request replacing them.
    await demoteIfHeadsNothing(this.prisma, department.managerId);

    return {
      success: true,
      message: 'Department deleted successfully',
    };
  }

  async getOrganizationTree() {
    // Keep every node so the hierarchy stays intact, but scope employee counts
    // to the selected branch (a parent may have only child-branch employees).
    const { empCount } = this.departmentBranchFilters();
    const departments = await this.prisma.department.findMany({
      where: { isActive: true },
      include: {
        manager: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
          },
        },
        _count: {
          select: {
            employees: empCount,
            teams: true,
          },
        },
      },
      orderBy: { code: 'asc' },
    });

    // Build tree structure
    const buildTree = (parentId: string | null = null): any[] => {
      return departments
        .filter((dept) => dept.parentId === parentId)
        .map((dept) => ({
          ...dept,
          children: buildTree(dept.id),
        }));
    };

    const tree = buildTree(null);

    return {
      success: true,
      data: tree,
    };
  }

  async assignManager(departmentId: string, managerId: string) {
    const department = await this.prisma.department.findUnique({
      where: { id: departmentId },
    });

    if (!department) {
      throw new NotFoundException('Department not found');
    }

    const manager = await this.prisma.employee.findUnique({
      where: { id: managerId },
      include: {
        user: true,
      },
    });

    if (!manager) {
      throw new NotFoundException('Manager not found');
    }

    // Business Rule: Manager must be active
    if (manager.status !== 'ACTIVE') {
      throw new BadRequestException('Manager must be an active employee');
    }

    // A manager may head more than one department, so there is deliberately
    // no "already managing another department" check here.

    // Business Rule: Ensure manager has appropriate user role
    if (manager.user && manager.user.role === 'EMPLOYEE') {
      // Auto-upgrade to MANAGER role
      await this.prisma.user.update({
        where: { id: manager.user.id },
        data: { role: 'MANAGER' },
      });
    }

    const updated = await this.prisma.department.update({
      where: { id: departmentId },
      data: { managerId },
      include: {
        manager: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
          },
        },
      },
    });

    return {
      success: true,
      message: 'Manager assigned successfully',
      data: updated,
    };
  }

  /**
   * Check for circular reference in department hierarchy
   */
  private async checkCircularReference(
    departmentId: string,
    newParentId: string,
  ): Promise<void> {
    let currentParentId: string | null = newParentId;
    const visited = new Set<string>([departmentId]);

    while (currentParentId) {
      if (visited.has(currentParentId)) {
        throw new BadRequestException(
          'Circular reference detected in department hierarchy',
        );
      }

      visited.add(currentParentId);

      const parent = await this.prisma.department.findUnique({
        where: { id: currentParentId },
        select: { parentId: true },
      });

      if (!parent) break;
      currentParentId = parent.parentId;
    }
  }

  /**
   * Validate department hierarchy integrity
   */
  async validateHierarchyIntegrity(): Promise<{
    success: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];

    // Check for orphaned departments
    const departments = await this.prisma.department.findMany({
      where: { isActive: true },
      include: {
        parent: true,
        _count: {
          select: { employees: true },
        },
      },
    });

    for (const dept of departments) {
      // Check if parent exists but is inactive
      if (dept.parentId && dept.parent && !dept.parent.isActive) {
        issues.push(
          `Department "${dept.name}" has inactive parent "${dept.parent.name}"`,
        );
      }

      // Check for departments with no employees and no children
      const hasChildren = departments.some((d) => d.parentId === dept.id);
      if (dept._count.employees === 0 && !hasChildren && !dept.parentId) {
        issues.push(
          `Department "${dept.name}" has no employees and no sub-departments`,
        );
      }
    }

    return {
      success: issues.length === 0,
      issues,
    };
  }

  async getPerformanceStats() {
    // Use optimized view instead of N+1 queries
    const currentMonthStats: any[] = await this.prisma.$queryRaw`
      WITH dept_stats AS (
        SELECT
          d.id as department_id,
          d.code as department_code,
          d.name as department_name,
          COUNT(DISTINCT e.id) as employee_count,
          COUNT(a.id) as total_attendance,
          COUNT(a.id) FILTER (WHERE a.status = 'PRESENT') as present_count,
          COUNT(a.id) FILTER (WHERE a.is_late = true) as late_count
        FROM departments d
        LEFT JOIN employees e ON d.id = e.department_id AND e.status = 'ACTIVE' ${rawBranchFilter('e')}
        LEFT JOIN attendances a ON e.id = a.employee_id 
          AND DATE_TRUNC('month', a.date) = DATE_TRUNC('month', CURRENT_DATE)
        GROUP BY d.id, d.code, d.name
      )
      SELECT
        department_id as "departmentId",
        department_code as "departmentCode",
        department_name as "departmentName",
        employee_count as "employeeCount",
        CASE WHEN total_attendance > 0 
          THEN ROUND((present_count::numeric / total_attendance::numeric) * 100, 2) 
          ELSE 0 END as "attendanceRate",
        CASE WHEN present_count > 0 
          THEN ROUND(((present_count - late_count)::numeric / present_count::numeric) * 100, 2) 
          ELSE 0 END as "onTimeRate",
        CASE WHEN total_attendance > 0 
          THEN ROUND(
            ((present_count::numeric / total_attendance::numeric) * 0.6 + 
            ((present_count - late_count)::numeric / NULLIF(present_count, 0)::numeric) * 0.4) * 100,
          2) 
          ELSE 0 END as "performanceScore"
      FROM dept_stats
      WHERE employee_count > 0
      ORDER BY "performanceScore" DESC
    `;

    const lastMonthStats: any[] = await this.prisma.$queryRaw`
      WITH last_month_stats AS (
        SELECT
          d.id as department_id,
          COUNT(a.id) as total_attendance,
          COUNT(a.id) FILTER (WHERE a.status = 'PRESENT') as present_count
        FROM departments d
        LEFT JOIN employees e ON d.id = e.department_id AND e.status = 'ACTIVE' ${rawBranchFilter('e')}
        LEFT JOIN attendances a ON e.id = a.employee_id 
          AND DATE_TRUNC('month', a.date) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
        GROUP BY d.id
      )
      SELECT 
        department_id as "departmentId",
        CASE WHEN total_attendance > 0 
          THEN ROUND((present_count::numeric / total_attendance::numeric) * 100, 2) 
          ELSE 0 END as "lastMonthRate"
      FROM last_month_stats
      WHERE total_attendance > 0
    `;

    // Create map for quick lookup
    const lastMonthMap = new Map(
      lastMonthStats.map((s) => [s.departmentId, s.lastMonthRate]),
    );

    // Calculate trends
    const performanceStats = currentMonthStats.map((stat) => {
      const lastMonthRate = lastMonthMap.get(stat.departmentId) || 0;
      const difference = stat.attendanceRate - lastMonthRate;

      let trend: 'up' | 'down' | 'stable';
      if (Math.abs(difference) < 2) {
        trend = 'stable';
      } else if (difference > 0) {
        trend = 'up';
      } else {
        trend = 'down';
      }

      const trendPercentage =
        lastMonthRate > 0
          ? ((stat.attendanceRate - lastMonthRate) / lastMonthRate) * 100
          : 0;

      return {
        ...stat,
        // COUNT(...) comes back as BigInt from the raw query — coerce to Number so
        // the response can be JSON-serialized (BigInt would throw at serialization).
        employeeCount: Number(stat.employeeCount),
        attendanceRate: Number(stat.attendanceRate),
        onTimeRate: Number(stat.onTimeRate),
        performanceScore: Number(stat.performanceScore),
        trend,
        trendPercentage: Math.round(trendPercentage * 10) / 10,
      };
    });

    const now = new Date();
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const endOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    );

    return {
      success: true,
      data: performanceStats,
      meta: {
        period: 'month',
        startDate: startOfMonth,
        endDate: endOfMonth,
        totalDepartments: performanceStats.length,
      },
    };
  }

  async getDepartmentPerformance(id: string) {
    const now = new Date();
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const endOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    );

    // Get current month performance
    const currentPerf: any[] = await this.prisma.$queryRaw`
      WITH dept_stats AS (
        SELECT
          d.id as department_id,
          d.code as department_code,
          d.name as department_name,
          COUNT(DISTINCT e.id) as employee_count,
          COUNT(a.id) as total_attendance,
          COUNT(a.id) FILTER (WHERE a.status = 'PRESENT') as present_count,
          COUNT(a.id) FILTER (WHERE a.is_late = true) as late_count
        FROM departments d
        LEFT JOIN employees e ON d.id = e.department_id AND e.status = 'ACTIVE' ${rawBranchFilter('e')}
        LEFT JOIN attendances a ON e.id = a.employee_id 
          AND DATE_TRUNC('month', a.date) = DATE_TRUNC('month', CURRENT_DATE)
        WHERE d.id = ${id}::uuid
        GROUP BY d.id, d.code, d.name
      )
      SELECT 
        department_id as "departmentId",
        department_code as "departmentCode",
        department_name as "departmentName",
        employee_count as "employeeCount",
        total_attendance as "totalAttendance",
        present_count as "presentCount",
        late_count as "lateCount",
        CASE WHEN total_attendance > 0 
          THEN ROUND((present_count::numeric / total_attendance::numeric) * 100, 2) 
          ELSE 0 END as "attendanceRate",
        CASE WHEN present_count > 0 
          THEN ROUND(((present_count - late_count)::numeric / present_count::numeric) * 100, 2) 
          ELSE 0 END as "onTimeRate",
        CASE WHEN total_attendance > 0 
          THEN ROUND(
            ((present_count::numeric / total_attendance::numeric) * 0.6 + 
            ((present_count - late_count)::numeric / NULLIF(present_count, 0)::numeric) * 0.4) * 100,
          2) 
          ELSE 0 END as "performanceScore"
      FROM dept_stats
    `;

    if (currentPerf.length === 0) {
      throw new NotFoundException('Department performance data not found');
    }

    const perf = currentPerf[0];

    // Convert BigInt to Number for perf data
    const perfData = {
      departmentId: perf.departmentId,
      departmentCode: perf.departmentCode,
      departmentName: perf.departmentName,
      employeeCount: Number(perf.employeeCount),
      totalAttendance: Number(perf.totalAttendance),
      presentCount: Number(perf.presentCount),
      lateCount: Number(perf.lateCount),
      attendanceRate: Number(perf.attendanceRate),
      onTimeRate: Number(perf.onTimeRate),
      performanceScore: Number(perf.performanceScore),
    };

    // Get last month for trend
    const lastMonthPerf: any[] = await this.prisma.$queryRaw`
      WITH last_month_stats AS (
        SELECT
          d.id as department_id,
          COUNT(a.id) as total_attendance,
          COUNT(a.id) FILTER (WHERE a.status = 'PRESENT') as present_count
        FROM departments d
        LEFT JOIN employees e ON d.id = e.department_id AND e.status = 'ACTIVE' ${rawBranchFilter('e')}
        LEFT JOIN attendances a ON e.id = a.employee_id 
          AND DATE_TRUNC('month', a.date) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
        WHERE d.id = ${id}::uuid
        GROUP BY d.id
      )
      SELECT 
        CASE WHEN total_attendance > 0 
          THEN ROUND((present_count::numeric / total_attendance::numeric) * 100, 2) 
          ELSE 0 END as "lastMonthRate"
      FROM last_month_stats
    `;

    const lastMonthRate = Number(lastMonthPerf[0]?.lastMonthRate || 0);
    const difference = perfData.attendanceRate - lastMonthRate;

    let trend: 'up' | 'down' | 'stable';
    if (Math.abs(difference) < 2) {
      trend = 'stable';
    } else if (difference > 0) {
      trend = 'up';
    } else {
      trend = 'down';
    }

    // Get top performers
    const topPerformersRaw: any[] = await this.prisma.$queryRaw`
      SELECT 
        e.id,
        e.employee_code as "employeeCode",
        e.full_name as "fullName",
        e.position,
        COUNT(a.id) FILTER (WHERE a.status = 'PRESENT') as "presentDays",
        COUNT(a.id) as "totalDays",
        COUNT(a.id) FILTER (WHERE a.is_late = true) as "lateDays",
        ROUND(
          (COUNT(a.id) FILTER (WHERE a.status = 'PRESENT')::numeric / 
           NULLIF(COUNT(a.id), 0)::numeric) * 100, 
          1
        ) as "attendanceRate"
      FROM employees e
      LEFT JOIN attendances a ON e.id = a.employee_id 
        AND a.date >= ${startOfMonth}
        AND a.date <= ${endOfMonth}
      WHERE e.department_id = ${id}::uuid
        AND e.status = 'ACTIVE'
        ${rawBranchFilter('e')}
      GROUP BY e.id, e.employee_code, e.full_name, e.position
      HAVING COUNT(a.id) > 0
      ORDER BY "attendanceRate" DESC, "lateDays" ASC
      LIMIT 5
    `;

    // Convert BigInt to Number
    const topPerformers = topPerformersRaw.map((p) => ({
      ...p,
      presentDays: Number(p.presentDays),
      totalDays: Number(p.totalDays),
      lateDays: Number(p.lateDays),
      attendanceRate: Number(p.attendanceRate),
    }));

    // Get 6-month trend
    const sixMonthsAgo = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1),
    );
    const trendDataRaw: any[] = await this.prisma.$queryRaw`
      WITH monthly_stats AS (
        SELECT 
          DATE_TRUNC('month', a.date) as month,
          COUNT(*) FILTER (WHERE a.status = 'PRESENT') as present_count,
          COUNT(*) as total_count
        FROM attendances a
        JOIN employees e ON a.employee_id = e.id
        WHERE e.department_id = ${id}::uuid
          AND a.date >= ${sixMonthsAgo}
          AND a.date <= ${endOfMonth}
          ${rawBranchFilter('e')}
        GROUP BY DATE_TRUNC('month', a.date)
      )
      SELECT 
        TO_CHAR(month, 'Mon') as "monthLabel",
        ROUND((present_count::numeric / total_count::numeric) * 100, 1) as "attendanceRate"
      FROM monthly_stats
      ORDER BY month ASC
    `;

    // Convert BigInt to Number for trend data
    const trendData = trendDataRaw.map((t) => ({
      monthLabel: t.monthLabel,
      attendanceRate: Number(t.attendanceRate),
    }));

    return {
      success: true,
      data: {
        ...perfData,
        trend,
        trendPercentage:
          lastMonthRate > 0
            ? Math.round(
                ((perfData.attendanceRate - lastMonthRate) / lastMonthRate) *
                  100 *
                  10,
              ) / 10
            : 0,
        lastMonthRate,
        topPerformers,
        trendData,
        period: {
          start: startOfMonth,
          end: endOfMonth,
        },
      },
    };
  }

  /**
   * Governance of the structure, rather than the size of it.
   *
   * A department count is inventory — it is the same number every week and
   * nobody acts on it. These are the structural facts somebody has to fix: a
   * department with no head has nobody to escalate to, and the people under it
   * have no approver for anything routed by department.
   *
   * Span of control is the other half: one manager with thirty direct reports
   * is an org-design problem that no headcount total will ever show.
   */
  async structureStats() {
    const [departments, withoutHead, spanRows] = await Promise.all([
      this.prisma.department.count({ where: { isActive: true } }),
      this.prisma.department.findMany({
        where: { isActive: true, managerId: null },
        select: { id: true, name: true, _count: { select: { employees: true } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.employee.groupBy({
        by: ['supervisorId'],
        where: { status: 'ACTIVE', supervisorId: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { supervisorId: 'desc' } },
        take: 8,
      }),
    ]);

    const supervisorIds = spanRows
      .map((r) => r.supervisorId)
      .filter((id): id is string => Boolean(id));
    const supervisors = supervisorIds.length
      ? await this.prisma.employee.findMany({
          where: { id: { in: supervisorIds } },
          select: { id: true, fullName: true, department: { select: { name: true } } },
        })
      : [];
    const byId = new Map(supervisors.map((s) => [s.id, s]));

    return {
      success: true,
      data: {
        departments,
        withoutHead: withoutHead.length,
        // People whose department has no head — they have no escalation path,
        // which is the consequence the count alone does not spell out.
        unmanagedHeadcount: withoutHead.reduce((a, d) => a + d._count.employees, 0),
        headlessDepartments: withoutHead.map((d) => ({
          id: d.id,
          name: d.name,
          employees: d._count.employees,
        })),
        spanOfControl: spanRows.map((r) => ({
          supervisorId: r.supervisorId,
          name: byId.get(r.supervisorId!)?.fullName ?? 'Unknown',
          department: byId.get(r.supervisorId!)?.department?.name ?? null,
          reports: r._count._all,
        })),
      },
    };
  }
}
