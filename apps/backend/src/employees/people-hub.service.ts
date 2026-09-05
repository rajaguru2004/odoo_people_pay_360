/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmployeesService } from './employees.service';
import { ContractsService } from '../contracts/contracts.service';
import {
  MonthBucket,
  TREND_MONTH_OPTIONS,
  buildMonthBuckets,
  bucketiseByMonth,
  pct,
  walkHeadcountBackwards,
} from '../common/utils/workforce-trend.util';

/**
 * One payload for the People hub.
 *
 * The question this hub owns (Phase C) is **the employee lifecycle** — deadlines
 * and movements. It deliberately carries no headcount-by-department chart (that
 * is Organization's) and no who-is-in-today figure (that is Time & Attendance's).
 *
 * Work permits are deliberately NOT in this payload. `/legal-documents/*`
 * answers 403 for some roles, and the hub is built to quieten two permit cards
 * while the rest of the page keeps working — two Phase C tests pin that. Folding
 * permits in here would let one module's 403 blank the whole dashboard.
 */

export interface PeopleHubSummary {
  months: number;
  headcount: {
    active: number;
    inactive: number;
    byStatus: Array<{ status: string; count: number }>;
  };
  lifecycle: {
    joinersThisMonth: number;
    leaversThisMonth: number;
    netChangeThisMonth: number;
    previousMonth: { joiners: number; leavers: number };
    startingSoon: Array<{
      id: string;
      fullName: string;
      startDate: Date | string;
      department: string | null;
    }>;
    probationEndingSoon: Array<{
      contractId: string;
      employeeId: string | null;
      fullName: string | null;
      endDate: Date | string | null;
    }>;
  };
  contracts: {
    total: number;
    active: number;
    expired: number;
    expiringSoon: number;
    expiring: Array<{
      id: string;
      employeeId: string | null;
      fullName: string | null;
      endDate: Date | string | null;
      daysUntilExpiry: number;
    }>;
  };
  terminations: { awaitingApproval: number; thisMonth: number };
  /** Mutually exclusive buckets that sum to the active headcount. */
  statusSplit: Array<{ key: string; label: string; count: number }>;
  trend: {
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
    /** Leavers over the window against the opening headcount. `null` if none. */
    turnoverRate: number | null;
  };
}

@Injectable()
export class PeopleHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeesService,
    private readonly contracts: ContractsService,
  ) {}

  /** Refused rather than defaulted — see the note in OrganizationHubService. */
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

  async getSummary(monthsRaw?: string): Promise<PeopleHubSummary> {
    const months = this.parseMonths(monthsRaw);
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const windowStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1),
    );

    const [
      statusRows,
      lifecycleRes,
      contractStatsRes,
      expiringRes,
      openTerminations,
      terminationsThisMonth,
      probationContracts,
      joinDates,
      leaveDates,
      prevJoiners,
      prevLeavers,
    ] = await Promise.all([
      // Employee is 'direct' in BRANCH_SCOPE, so groupBy is narrowed by the
      // Prisma extension. `status` is a free-text column, not an enum, so the
      // rows are reported as they come rather than mapped onto assumed values.
      this.prisma.employee.groupBy({ by: ['status'], _count: { _all: true } }),

      this.employees.lifecycleStats(),
      this.contracts.getStatistics(),
      this.contracts.getExpiringContracts(30),

      // "Notice" is not a stored status — Employee.status is only ACTIVE or
      // INACTIVE. It is an open TerminationRequest: awaiting a decision, or
      // approved with a leaving date still ahead. TerminationRequest is scoped
      // through ['contract','employee'] by the branch map.
      this.prisma.terminationRequest.findMany({
        where: {
          OR: [
            { status: 'PENDING_APPROVAL' },
            { status: 'APPROVED', terminationDate: { gt: now } },
          ],
        },
        select: { status: true, contract: { select: { employeeId: true } } },
      }),
      this.prisma.terminationRequest.count({
        where: { terminationDate: { gte: monthStart } },
      }),

      // "Probation" is likewise derived: an ACTIVE contract of type PROBATION.
      this.prisma.contract.findMany({
        where: { contractType: 'PROBATION', status: 'ACTIVE' },
        select: { employeeId: true },
      }),

      this.prisma.employee.findMany({
        where: { startDate: { gte: windowStart } },
        select: { startDate: true },
      }),
      this.prisma.employee.findMany({
        where: { endDate: { gte: windowStart } },
        select: { endDate: true },
      }),
      this.prisma.employee.count({
        where: { startDate: { gte: prevStart, lt: monthStart } },
      }),
      this.prisma.employee.count({
        where: { endDate: { gte: prevStart, lt: monthStart } },
      }),
    ]);

    const byStatus = statusRows.map((r: any) => ({
      status: r.status as string,
      count: r._count._all as number,
    }));
    const active = byStatus.find((s) => s.status === 'ACTIVE')?.count ?? 0;
    const inactive = byStatus
      .filter((s) => s.status !== 'ACTIVE')
      .reduce((a, s) => a + s.count, 0);

    // ---- status split ------------------------------------------------------
    // Applied in this order so the buckets are mutually exclusive: somebody on
    // probation who has also resigned is counted as leaving, because that is
    // the fact that changes what HR does next. The three then sum, with the
    // inactive bucket, to the whole workforce.
    const noticeIds = new Set(
      openTerminations
        .map((t: any) => t.contract?.employeeId)
        .filter((id: string | undefined): id is string => Boolean(id)),
    );
    const probationIds = new Set(
      probationContracts
        .map((c: any) => c.employeeId as string)
        .filter((id: string) => Boolean(id) && !noticeIds.has(id)),
    );

    const [onNotice, onProbation] = await Promise.all([
      noticeIds.size
        ? this.prisma.employee.count({
            where: { status: 'ACTIVE', id: { in: [...noticeIds] } },
          })
        : Promise.resolve(0),
      probationIds.size
        ? this.prisma.employee.count({
            where: { status: 'ACTIVE', id: { in: [...probationIds] } },
          })
        : Promise.resolve(0),
    ]);

    const statusSplit = [
      // Floored at 0: on a database where a contract outlives the employee
      // record it hangs off, the derived buckets can otherwise exceed the
      // headcount and the donut would draw a negative slice.
      { key: 'active', label: 'Active', count: Math.max(0, active - onNotice - onProbation) },
      { key: 'probation', label: 'Probation', count: onProbation },
      { key: 'notice', label: 'Notice', count: onNotice },
      { key: 'inactive', label: 'Inactive', count: inactive },
    ];

    // ---- trend -------------------------------------------------------------
    const buckets: MonthBucket[] = buildMonthBuckets(months, now);
    bucketiseByMonth(joinDates.map((r) => r.startDate), buckets, 'joiners');
    bucketiseByMonth(leaveDates.map((r) => r.endDate), buckets, 'leavers');
    walkHeadcountBackwards(buckets, active);

    const opening =
      buckets.length && buckets[0].headcountEnd !== null
        ? buckets[0].headcountEnd - buckets[0].net
        : 0;
    const leaversInWindow = buckets.reduce((a, b) => a + b.leavers, 0);

    const lifecycle = (lifecycleRes as any)?.data ?? {};
    const contractStats = (contractStatsRes as any)?.data ?? {};
    const expiringRows = ((expiringRes as any)?.data ?? []) as Array<any>;

    return {
      months,
      headcount: { active, inactive, byStatus },
      lifecycle: {
        joinersThisMonth: lifecycle.joinersThisMonth ?? 0,
        leaversThisMonth: lifecycle.leaversThisMonth ?? 0,
        netChangeThisMonth: lifecycle.netChangeThisMonth ?? 0,
        previousMonth: { joiners: prevJoiners, leavers: prevLeavers },
        startingSoon: lifecycle.startingSoon ?? [],
        probationEndingSoon: lifecycle.probationEndingSoon ?? [],
      },
      contracts: {
        total: contractStats.total ?? 0,
        active: contractStats.active ?? 0,
        expired: contractStats.expired ?? 0,
        expiringSoon: contractStats.expiringSoon ?? 0,
        // Flattened to what the strip prints. `getExpiringContracts` nests the
        // whole contract record beside the countdown; the hub only ever shows a
        // name and a number of days.
        expiring: expiringRows.slice(0, 12).map((row) => ({
          id: row.contract?.id ?? null,
          employeeId: row.contract?.employee?.id ?? null,
          fullName: row.contract?.employee?.fullName ?? null,
          endDate: row.contract?.endDate ?? null,
          daysUntilExpiry: row.daysUntilExpiry ?? 0,
        })),
      },
      terminations: {
        awaitingApproval: openTerminations.filter(
          (t: any) => t.status === 'PENDING_APPROVAL',
        ).length,
        thisMonth: terminationsThisMonth,
      },
      statusSplit,
      trend: {
        months,
        buckets: buckets.map((b) => ({
          key: b.key,
          label: b.label,
          joiners: b.joiners,
          leavers: b.leavers,
          net: b.net,
          headcountEnd: b.headcountEnd,
        })),
        netChange: buckets.reduce((a, b) => a + b.net, 0),
        turnoverRate: pct(leaversInWindow, opening),
      },
    };
  }
}
