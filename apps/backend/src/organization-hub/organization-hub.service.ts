/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DepartmentsService } from '../departments/departments.service';
import {
  getEnvelopeBranchIds,
  getScopedBranchIds,
} from '../common/branch/branch-scope.util';
import { runWithBranchBypass } from '../common/branch/branch-context';
import {
  MonthBucket,
  TREND_MONTH_OPTIONS,
  buildMonthBuckets,
  bucketiseByMonth,
  growthPercent,
  pct,
  walkHeadcountBackwards,
} from '../common/utils/workforce-trend.util';

/**
 * One payload for the Organization hub.
 *
 * The page used to fan out to six browser requests and count rows off list
 * endpoints, which under-reported every queue longer than a page. One aggregate
 * replaces them, on the model of `AttendanceHubService`.
 *
 * The question this hub owns (Phase C) is **governance of the structure**:
 * where the workforce sits, and what has nobody in charge of it. It carries no
 * attendance figure — that is Time & Attendance's job — and no lifecycle
 * deadline, which is People's.
 */

/** A department or branch as the hub draws it. */
export interface UnitRow {
  id: string;
  name: string;
  employees: number;
  /** Percentage of the active workforce. `null` when there is nobody to divide by. */
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
  /** Governance gaps that are not a count of anything else on the page. */
  unassigned: { noBranch: number };
  growth: {
    months: number;
    buckets: Array<{
      key: string;
      label: string;
      joiners: number;
      leavers: number;
      net: number;
      headcountEnd: number | null;
    }>;
    netChange: number;
    growthPct: number | null;
  };
}

@Injectable()
export class OrganizationHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly departments: DepartmentsService,
  ) {}

  /**
   * A window outside the offered list is refused rather than defaulted.
   *
   * Phase E's lesson from `anchor=2026-13-45`: a silent fallback answers for a
   * period nobody asked about, and the reader cannot see that it happened.
   */
  private parseMonths(raw?: string): number {
    if (raw === undefined || raw === null || raw === '') return 6;
    const n = Number(raw);
    if (!Number.isInteger(n) || !TREND_MONTH_OPTIONS.includes(n as 6 | 12)) {
      throw new BadRequestException(
        `months must be one of ${TREND_MONTH_OPTIONS.join(', ')}, received "${raw}"`,
      );
    }
    return n;
  }

  async getSummary(monthsRaw?: string): Promise<OrganizationHubSummary> {
    const months = this.parseMonths(monthsRaw);
    const now = new Date();

    // Departments are orthogonal to Branch and absent from BRANCH_SCOPE, so the
    // narrowing has to be explicit. Reused from DepartmentsService rather than
    // rewritten — a second copy would drift from `GET /departments` and the two
    // screens would disagree about how many departments exist.
    const { empWhere, deptScope, empCount } = this.departments.departmentBranchFilters();
    // Two different questions, two different helpers.
    //
    // `getScopedBranchIds()` is the SELECTED branch — the same narrowing the
    // Prisma extension applies to every employee count on this page. The branch
    // panel has to use it, or the bars would show all nine branches while the
    // headcount they are shares OF had already narrowed to one, and the shares
    // would not add up to 100%.
    //
    // `getEnvelopeBranchIds()` is everything the caller MAY see, which is the
    // reach `DepartmentChangeRequestsService.findAll` gives a change request.
    // The queue card matches the list screen it links to.
    const scoped = getScopedBranchIds();
    const envelope = getEnvelopeBranchIds();

    // ────────────────────────────────────────────────────────────────────────
    // Phase 1: everything that MUST stay inside the caller's branch scope.
    //
    // Nothing that calls `runWithBranchBypass` may share a `Promise.all` with
    // these. The bypass is a COUNTER on a shared AsyncLocalStorage store
    // (`branch-context.ts:78`), not an isolated scope: it stays raised for the
    // whole time its callback is awaited, so any sibling query that reaches
    // Prisma in that window is silently unscoped too.
    //
    // That is not hypothetical. It shipped: with Head Office selected the hub
    // reported "Total employees 49" — the org-wide figure — beside a branch
    // panel correctly showing 11. Two numbers on one screen, one of them
    // leaking headcount from branches the reader is not entitled to see.
    const [
      activeHeadcount,
      inactiveHeadcount,
      departmentRows,
      branchRows,
      structure,
      supervisorRows,
      joinDates,
      leaveDates,
    ] = await Promise.all([
      // Employee is 'direct' in BRANCH_SCOPE, so count/groupBy/findMany are
      // narrowed by the Prisma extension. Filtering by branch again here would
      // be a second implementation of the same rule.
      this.prisma.employee.count({ where: { status: 'ACTIVE' } }),
      this.prisma.employee.count({ where: { status: { not: 'ACTIVE' } } }),

      this.prisma.department.findMany({
        where: { isActive: true, ...deptScope },
        select: {
          id: true,
          name: true,
          managerId: true,
          _count: {
            select: {
              // Filtered relation count: in-branch AND active. A nested count is
              // invisible to the branch extension, which is why `empWhere` is
              // spliced in by hand here and nowhere else.
              employees: (empWhere
                ? { where: { ...empWhere, status: 'ACTIVE' } }
                : { where: { status: 'ACTIVE' } }) as unknown as true,
            },
          },
        },
        orderBy: { name: 'asc' },
      }),

      this.prisma.branch.findMany({
        // A branch's identity IS the branch, so it is filtered on `id` rather
        // than on a `branchId` column the row does not have.
        where: { isActive: true, ...(scoped === null ? {} : { id: { in: scoped } }) },
        select: {
          id: true,
          name: true,
          managerId: true,
          _count: {
            select: {
              employees: { where: { status: 'ACTIVE' } } as unknown as true,
            },
          },
        },
        orderBy: { name: 'asc' },
      }),

      this.departments.structureStats(),

      this.prisma.employee.groupBy({
        by: ['supervisorId'],
        where: { status: 'ACTIVE', supervisorId: { not: null } },
        _count: { _all: true },
      }),

      // Two single-column reads, bucketed in JS. `months × 2` count queries
      // would be twenty-four round trips for the same answer.
      this.prisma.employee.findMany({
        where: { startDate: { gte: windowStart(months, now) } },
        select: { startDate: true },
      }),
      this.prisma.employee.findMany({
        where: { endDate: { gte: windowStart(months, now) } },
        select: { endDate: true },
      }),
    ]);

    // ────────────────────────────────────────────────────────────────────────
    // Phase 2: the two reads that deliberately look outside the branch scope.
    // Sequential, and only after every scoped query above has resolved.

    // Same reach rule as `DepartmentChangeRequestsService.findAll`: a change
    // request carries no branch of its own, so it inherits the reach of the
    // department it is about. The nested employee filter IS the check, so it
    // has to run with scoping bypassed — read through the middleware it could
    // only ever see the caller's own branches and would answer "no staff" for
    // every department elsewhere.
    const changeRequestRows = await this.changeRequestCounts(envelope);

    // Counted org-wide on purpose. An employee with no branch belongs to no
    // branch in particular — the same rule the change-request service applies
    // to a department with nobody in it — and this is a governance gap that
    // disappears entirely if every branch view reports 0.
    const noBranch = await runWithBranchBypass(() =>
      this.prisma.employee.count({ where: { status: 'ACTIVE', branchId: null } }),
    );

    const structureData = (structure as any)?.data ?? {};

    // ---- departments -------------------------------------------------------
    const deptRows: UnitRow[] = departmentRows
      .map((d) => ({
        id: d.id,
        name: d.name,
        employees: d._count.employees,
        share: pct(d._count.employees, activeHeadcount),
      }))
      .sort((a, b) => b.employees - a.employees);

    // Computed here rather than taken from `structureStats`, which does not
    // apply the branch narrowing (recorded as a pre-existing inconsistency in
    // the tracker). Deriving it locally is what keeps every figure on this page
    // agreeing with every other one.
    const headless = departmentRows
      .filter((d) => !d.managerId)
      .map((d) => ({ id: d.id, name: d.name, employees: d._count.employees }));

    // ---- branches ----------------------------------------------------------
    const branchUnitRows: UnitRow[] = branchRows
      .map((b) => ({
        id: b.id,
        name: b.name,
        employees: b._count.employees,
        share: pct(b._count.employees, activeHeadcount),
      }))
      .sort((a, b) => b.employees - a.employees);

    // ---- managers ----------------------------------------------------------
    // One person can head a department, manage a branch and carry direct
    // reports. Counting the roles would treat them as three managers, so the
    // total is the size of the union and the three parts are reported beside it.
    const deptHeadIds = new Set(
      departmentRows.map((d) => d.managerId).filter((id): id is string => Boolean(id)),
    );
    const branchManagerIds = new Set(
      branchRows.map((b) => b.managerId).filter((id): id is string => Boolean(id)),
    );
    const supervisorIds = new Set(
      supervisorRows.map((r) => r.supervisorId).filter((id): id is string => Boolean(id)),
    );
    const allManagerIds = new Set([...deptHeadIds, ...branchManagerIds, ...supervisorIds]);

    const widestSpan = (structureData.spanOfControl ?? [])[0] ?? null;

    // ---- growth ------------------------------------------------------------
    const buckets: MonthBucket[] = buildMonthBuckets(months, now);
    bucketiseByMonth(joinDates.map((r) => r.startDate), buckets, 'joiners');
    bucketiseByMonth(leaveDates.map((r) => r.endDate), buckets, 'leavers');
    walkHeadcountBackwards(buckets, activeHeadcount);

    return {
      months,
      headcount: {
        active: activeHeadcount,
        inactive: inactiveHeadcount,
        total: activeHeadcount + inactiveHeadcount,
      },
      branches: {
        total: branchRows.length,
        withoutManager: branchRows.filter((b) => !b.managerId).length,
        rows: branchUnitRows,
      },
      departments: {
        total: departmentRows.length,
        withoutHead: headless.length,
        // The consequence, not the count: these people have no approver for
        // anything routed by department.
        unmanagedHeadcount: headless.reduce((a, d) => a + d.employees, 0),
        rows: deptRows,
        headless,
      },
      managers: {
        total: allManagerIds.size,
        deptHeads: deptHeadIds.size,
        branchManagers: branchManagerIds.size,
        supervisors: supervisorIds.size,
        widestSpan: widestSpan
          ? {
              supervisorId: widestSpan.supervisorId ?? null,
              name: widestSpan.name,
              department: widestSpan.department ?? null,
              reports: widestSpan.reports,
            }
          : null,
      },
      changeRequests: changeRequestRows,
      unassigned: { noBranch },
      growth: {
        months,
        buckets: buckets.map((b) => ({
          key: b.key,
          label: b.label,
          joiners: b.joiners,
          leavers: b.leavers,
          net: b.net,
          headcountEnd: b.headcountEnd,
        })),
        netChange: buckets.reduce((sum, b) => sum + b.net, 0),
        growthPct: growthPercent(buckets),
      },
    };
  }

  /**
   * Change requests counted by status in the database.
   *
   * The hub used to read the length of `GET /departments/change-requests`, which
   * returns no pagination meta — so any queue longer than one page was silently
   * under-reported on the one card whose whole job is to say how much work is
   * waiting.
   */
  private async changeRequestCounts(envelope: string[] | null) {
    const where: any = {};
    if (envelope !== null) {
      where.department = {
        OR: [
          { employees: { some: { branchId: { in: envelope } } } },
          { employees: { none: {} } },
        ],
      };
    }

    const rows = await runWithBranchBypass(() =>
      this.prisma.departmentChangeRequest.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
    );

    const byStatus = new Map(rows.map((r: any) => [r.status, r._count._all as number]));
    const pending = byStatus.get('PENDING') ?? 0;
    const approved = byStatus.get('APPROVED') ?? 0;
    const rejected = byStatus.get('REJECTED') ?? 0;
    const cancelled = byStatus.get('CANCELLED') ?? 0;

    return {
      pending,
      approved,
      rejected,
      cancelled,
      // Summed from the rows rather than the four named statuses, so a status
      // added later still lands in the total instead of vanishing from it.
      total: rows.reduce((sum: number, r: any) => sum + (r._count._all as number), 0),
    };
  }
}

/** First instant of the earliest month in the trend window. */
function windowStart(months: number, now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
}
