import { Injectable } from '@nestjs/common';
import { EmployeeStatus, RequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildWorkforceTrend,
  trendWindowEnd,
  trendWindowStart,
  type WorkforceTrend,
} from '../common/utils/workforce-trend.util';

/** A branch or department sized against the active workforce. */
export interface UnitRow {
  id: string;
  name: string;
  employees: number;
  share: number | null;
}

export interface OrganizationHubSummary {
  months: number;
  headcount: { active: number; inactive: number; total: number };
  branches: { total: number; withoutManager: number; rows: UnitRow[] };
  departments: {
    total: number;
    withoutHead: number;
    unmanagedHeadcount: number;
    rows: UnitRow[];
    headless: Array<{ id: string; name: string; employees: number }>;
  };
  managers: {
    total: number;
    deptHeads: number;
    branchManagers: number;
    supervisors: number;
    widestSpan: {
      supervisorId: string | null;
      name: string;
      department: string | null;
      reports: number;
    } | null;
  };
  changeRequests: {
    pending: number;
    approved: number;
    rejected: number;
    cancelled: number;
    total: number;
  };
  unassigned: { noBranch: number; noDepartment: number };
  growth: WorkforceTrend;
}

/**
 * A slice of the active workforce, to one decimal place.
 *
 * `null` when there is nobody to divide by. A 0 would read as "this unit holds
 * none of the workforce", which is a claim about a denominator that does not
 * exist.
 */
function shareOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

@Injectable()
export class OrganizationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Everything the Organisation hub renders, in one round of parallel reads.
   *
   * The page is a set of cards that must agree with each other — a headcount
   * total that disagrees with the sum of the branch rows is worse than either
   * number alone — so they are all derived from the same set of results rather
   * than fetched card by card.
   */
  async hubSummary(months: number): Promise<OrganizationHubSummary> {
    const now = new Date();
    const windowStart = trendWindowStart(months, now);
    const windowEnd = trendWindowEnd(now);
    const active = { status: EmployeeStatus.ACTIVE } as const;

    const [
      statusGroups,
      branches,
      departments,
      supervisorGroups,
      changeRequestGroups,
      noBranch,
      noDepartment,
      hires,
      exits,
    ] = await Promise.all([
      this.prisma.employee.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.branch.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          managerId: true,
          _count: { select: { employees: { where: active } } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.department.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          managerId: true,
          _count: { select: { employees: { where: active } } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.employee.groupBy({
        by: ['supervisorId'],
        where: { ...active, supervisorId: { not: null } },
        _count: { _all: true },
      }),
      // Counted in the database, not by measuring a list. The queue endpoint is
      // paginated, so a backlog longer than one page would be under-reported on
      // the one card whose whole job is to say how much work is waiting.
      this.prisma.departmentChangeRequest.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.employee.count({ where: { ...active, branchId: null } }),
      this.prisma.employee.count({ where: { ...active, departmentId: null } }),
      // Two flat reads of one column each. A count per month would be
      // `months × 2` round trips for exactly the same answer.
      this.prisma.employee.findMany({
        where: { hireDate: { gte: windowStart, lt: windowEnd } },
        select: { hireDate: true },
      }),
      this.prisma.employee.findMany({
        where: { exitDate: { gte: windowStart, lt: windowEnd } },
        select: { exitDate: true },
      }),
    ]);

    // ACTIVE is the workforce; everything else — on leave, suspended, exited —
    // is a record that exists but is not at a desk this morning.
    const total = statusGroups.reduce((sum, g) => sum + g._count._all, 0);
    const activeCount =
      statusGroups.find((g) => g.status === EmployeeStatus.ACTIVE)?._count
        ._all ?? 0;

    const branchRows = this.toRows(branches, activeCount);
    const departmentRows = this.toRows(departments, activeCount);

    const headless = departments
      .filter((d) => !d.managerId)
      .map((d) => ({ id: d.id, name: d.name, employees: d._count.employees }))
      .sort(
        (a, b) => b.employees - a.employees || a.name.localeCompare(b.name),
      );

    // One person can head a department, run a branch and supervise a team. The
    // three role counts would sum to three managers where the organisation has
    // one, so the headline number is the size of the union.
    const deptHeadIds = idSet(departments.map((d) => d.managerId));
    const branchManagerIds = idSet(branches.map((b) => b.managerId));
    const supervisorIds = idSet(supervisorGroups.map((g) => g.supervisorId));
    const everyManager = new Set([
      ...deptHeadIds,
      ...branchManagerIds,
      ...supervisorIds,
    ]);

    const byStatus = (status: RequestStatus) =>
      changeRequestGroups.find((g) => g.status === status)?._count._all ?? 0;

    return {
      months,
      headcount: {
        active: activeCount,
        inactive: total - activeCount,
        total,
      },
      branches: {
        total: branches.length,
        withoutManager: branches.filter((b) => !b.managerId).length,
        rows: branchRows,
      },
      departments: {
        total: departments.length,
        withoutHead: headless.length,
        unmanagedHeadcount: headless.reduce((sum, d) => sum + d.employees, 0),
        rows: departmentRows,
        headless,
      },
      managers: {
        total: everyManager.size,
        deptHeads: deptHeadIds.size,
        branchManagers: branchManagerIds.size,
        supervisors: supervisorIds.size,
        widestSpan: await this.widestSpan(supervisorGroups),
      },
      changeRequests: {
        pending: byStatus(RequestStatus.PENDING),
        approved: byStatus(RequestStatus.APPROVED),
        rejected: byStatus(RequestStatus.REJECTED),
        cancelled: byStatus(RequestStatus.CANCELLED),
        total: changeRequestGroups.reduce((sum, g) => sum + g._count._all, 0),
      },
      unassigned: { noBranch, noDepartment },
      growth: buildWorkforceTrend({
        months,
        hireDates: definedDates(hires.map((e) => e.hireDate)),
        exitDates: definedDates(exits.map((e) => e.exitDate)),
        currentHeadcount: activeCount,
        now,
      }),
    };
  }

  private toRows(
    units: Array<{ id: string; name: string; _count: { employees: number } }>,
    activeCount: number,
  ): UnitRow[] {
    return units
      .map((u) => ({
        id: u.id,
        name: u.name,
        employees: u._count.employees,
        share: shareOf(u._count.employees, activeCount),
      }))
      .sort(
        (a, b) => b.employees - a.employees || a.name.localeCompare(b.name),
      );
  }

  /**
   * The single largest span of control, resolved to a name.
   *
   * Only the winner is looked up. Fetching every supervisor's name to display
   * one of them would grow with the organisation for no gain on screen.
   */
  private async widestSpan(
    groups: Array<{ supervisorId: string | null; _count: { _all: number } }>,
  ) {
    const widest = groups.reduce<(typeof groups)[number] | null>(
      (best, g) =>
        best === null || g._count._all > best._count._all ? g : best,
      null,
    );
    if (!widest?.supervisorId) return null;

    const person = await this.prisma.employee.findUnique({
      where: { id: widest.supervisorId },
      select: {
        firstName: true,
        lastName: true,
        department: { select: { name: true } },
      },
    });

    return {
      supervisorId: widest.supervisorId,
      name: person
        ? [person.firstName, person.lastName].filter(Boolean).join(' ')
        : 'Unknown',
      department: person?.department?.name ?? null,
      reports: widest._count._all,
    };
  }
}

function idSet(ids: Array<string | null>): Set<string> {
  return new Set(ids.filter((id): id is string => id !== null));
}

function definedDates(dates: Array<Date | null>): Date[] {
  return dates.filter((d): d is Date => d !== null);
}
