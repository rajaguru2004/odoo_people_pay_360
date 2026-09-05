import { Injectable } from '@nestjs/common';
import { Prisma, RequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import {
  addDays,
  assertPeriod,
  bucketOf,
  eachDay,
  key,
  parseDateKey,
  rate,
  resolveRange,
  trendKindFor,
  type HubPeriod,
} from '../common/hub/hub-range.util';
import { managerDepartmentIds } from '../common/utils/manager-scope.util';
import type { Principal } from '../auth/auth.service';
import { WorkingDaysService } from './working-days.service';

/**
 * The Leave & Overtime landing hub.
 *
 * Two questions on one page, because they are the same trade: hours the company
 * owes, against hours it has bought.
 *
 * Everything the page draws arrives in ONE request. Fanning out to the list
 * endpoints and counting rows off them would report the length of a PAGE as a
 * count, and the one card whose job is to say how much work is waiting would
 * under-report a queue longer than twenty.
 *
 * Three things this gets right that the endpoints beneath it do not have to:
 *
 *  1. **A request straddling the window is prorated, not double-counted.** A
 *     ten-day leave running 28 Aug → 6 Sep belongs to both months, and charging
 *     August for September's days is a confident wrong answer. The proration
 *     counts WORKING days through the same service that priced the request, so
 *     the two halves add back up to `totalDays`.
 *  2. **CANCELLED is counted.** Four statuses, so the donut's slices sum to the
 *     caption above them.
 *  3. **Overtime is windowed and aggregated in the database**, not month-locked
 *     and reduced in memory off the first page of a list.
 *
 * Every rate goes through `rate()`, which is `null` rather than 0% when there
 * was nothing to divide by. Balance figures are YEAR facts — a week does not
 * have an entitlement — so they are scoped to the year the window ENDS in.
 */

/** How many names an action item carries before it stops being a task. */
const NAME_CAP = 12;

/**
 * A pending request older than this is what the "N older than two days" footnote
 * counts. Two days is the point at which an approval stops being "not yet" and
 * starts being "forgotten".
 */
const STALE_AFTER_DAYS = 2;

/**
 * The welfare signal, not a cap.
 *
 * Nothing here enforces anything: the real ceilings live in the overtime policy
 * and are checked at filing. This only decides whose name is worth surfacing, so
 * a drift between the two changes what is highlighted, never what is allowed.
 */
const HIGH_OVERTIME_HOURS = 30;

export interface LeaveHubStats {
  requests: number;
  approved: number;
  pending: number;
  rejected: number;
  cancelled: number;
  approvalRate: number | null;
  leaveDays: number;
  onLeaveToday: number;
  activeHeadcount: number;
  onLeaveTodayRate: number | null;
  pendingOlderThanTwoDays: number;
  allocated: number;
  carriedOver: number;
  used: number;
  remaining: number;
  utilisation: number | null;
  averageBalance: number | null;
  overtimeHours: number;
  overtimeRequests: number;
  overtimeEmployees: number;
  avgOvertimePerEmployee: number | null;
  topLeaveType: string | null;
}

@Injectable()
export class LeaveHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workingDays: WorkingDaysService,
    private readonly settings: SystemSettingsService,
  ) {}

  async getHubSummary(
    period: HubPeriod = 'month',
    anchorParam: string | undefined,
    user: Principal,
  ) {
    assertPeriod(period);

    const today = parseDateKey(key(new Date()));
    const anchor = anchorParam ? parseDateKey(anchorParam) : today;
    const { start, end, prevAnchor, nextAnchor, label } = resolveRange(
      period,
      anchor,
    );
    const prevRange = resolveRange(period, prevAnchor);

    // The kill switch. Off, and the page drops the overtime panel rather than
    // drawing zeros — "nobody worked late" and "this company does not track
    // overtime" are different claims, and only one of them is true here.
    const overtimeEnabled =
      (await this.settings.get('overtime_enabled')) !== 'false';

    const scope = await managerDepartmentIds(this.prisma, user);

    const [current, previous] = await Promise.all([
      this.aggregate(period, start, end, today, overtimeEnabled, scope, true),
      this.aggregate(
        period,
        prevRange.start,
        prevRange.end,
        today,
        overtimeEnabled,
        scope,
        false,
      ),
    ]);

    return {
      period,
      anchor: key(anchor),
      range: {
        start: key(start),
        end: key(end),
        through: key(end.getTime() > today.getTime() ? today : end),
        label,
        prevAnchor: key(prevAnchor),
        nextAnchor: key(nextAnchor),
        // Leave is filed AHEAD — a request for next month exists today — so one
        // window forward is legitimate. A year beyond that is empty by
        // definition, and paging into emptiness reads as a broken page.
        hasNext: nextAnchor.getTime() <= addDays(today, 366).getTime(),
        isCurrent:
          start.getTime() <= today.getTime() &&
          today.getTime() <= end.getTime(),
      },
      periodStats: current.stats,
      previousStats: previous.stats,
      previousRange: {
        start: key(prevRange.start),
        end: key(prevRange.end),
        label: prevRange.label,
      },
      trendKind: trendKindFor(period),
      trend: current.trend,
      leaveTypes: current.leaveTypes,
      status: current.status,
      balance: current.balance,
      overtime: current.overtime,
      attention: current.attention,
    };
  }

  private employeeWhere(scope: string[] | null): Prisma.EmployeeWhereInput {
    return {
      status: { not: 'TERMINATED' },
      ...(scope === null ? {} : { departmentId: { in: scope } }),
    };
  }

  private async aggregate(
    period: HubPeriod,
    start: Date,
    end: Date,
    today: Date,
    overtimeEnabled: boolean,
    scope: string[] | null,
    wantPanels: boolean,
  ) {
    const employee = this.employeeWhere(scope);
    const year = end.getUTCFullYear();

    const [requests, activeHeadcount, balances, overtimeRows] =
      await Promise.all([
        // Overlap, not containment: a request running 28 Aug → 6 Sep is part of
        // both months, and a window that caught only requests STARTING inside it
        // would lose every leave that spans a boundary.
        this.prisma.leaveRequest.findMany({
          where: { startDate: { lte: end }, endDate: { gte: start }, employee },
          select: {
            id: true,
            employeeId: true,
            leaveType: true,
            startDate: true,
            endDate: true,
            totalDays: true,
            status: true,
            createdAt: true,
            employee: {
              select: {
                firstName: true,
                lastName: true,
                branchId: true,
                department: { select: { id: true, name: true } },
              },
            },
          },
        }),
        this.prisma.employee.count({
          where: { ...employee, status: 'ACTIVE' },
        }),
        this.prisma.leaveTypeBalance.groupBy({
          by: ['leaveTypeKey'],
          where: { year, employee },
          _sum: { allocated: true, used: true, carriedOver: true },
          _count: { employeeId: true },
        }),
        overtimeEnabled
          ? this.prisma.overtimeRequest.findMany({
              where: { date: { gte: start, lte: end }, employee },
              select: {
                employeeId: true,
                date: true,
                hours: true,
                status: true,
                employee: {
                  select: {
                    firstName: true,
                    lastName: true,
                    department: { select: { id: true, name: true } },
                  },
                },
              },
            })
          : Promise.resolve([]),
      ]);

    const counts = { approved: 0, pending: 0, rejected: 0, cancelled: 0 };
    for (const r of requests) {
      if (r.status === RequestStatus.APPROVED) counts.approved += 1;
      else if (r.status === RequestStatus.PENDING) counts.pending += 1;
      else if (r.status === RequestStatus.REJECTED) counts.rejected += 1;
      else counts.cancelled += 1;
    }

    const { totalDays, byType, onLeaveToday } = await this.leaveDays(
      requests,
      start,
      end,
      today,
    );

    let allocated = 0;
    let used = 0;
    let carriedOver = 0;
    const byTypeBalance = balances.map((b) => {
      const a = b._sum.allocated ?? 0;
      const u = b._sum.used ?? 0;
      const c = b._sum.carriedOver ?? 0;
      allocated += a;
      used += u;
      carriedOver += c;
      return {
        // `leaveTypeKey` IS the display label — it is pinned to
        // `LibraryItem.label` and `LeaveRequest.leaveType` matches the same
        // string. A key whose library row was since deactivated still gets a row
        // here under its own name; dropping it would make the totals disagree
        // with the sum of the rows beneath them.
        key: b.leaveTypeKey,
        name: b.leaveTypeKey,
        allocated: a,
        used: u,
        carriedOver: c,
        remaining: a + c - u,
        utilisation: rate(u, a + c),
        employeeCount: b._count.employeeId,
      };
    });
    const remaining = allocated + carriedOver - used;

    const ot = this.overtime(overtimeRows, period, start, end);
    const staleBefore = addDays(today, -STALE_AFTER_DAYS).getTime();

    const stats: LeaveHubStats = {
      requests: requests.length,
      approved: counts.approved,
      pending: counts.pending,
      rejected: counts.rejected,
      cancelled: counts.cancelled,
      approvalRate: rate(counts.approved, requests.length),
      leaveDays: Math.round(totalDays * 10) / 10,
      onLeaveToday: onLeaveToday.size,
      activeHeadcount,
      onLeaveTodayRate: rate(onLeaveToday.size, activeHeadcount),
      pendingOlderThanTwoDays: requests.filter(
        (r) =>
          r.status === RequestStatus.PENDING &&
          r.createdAt.getTime() <= staleBefore,
      ).length,
      allocated,
      carriedOver,
      used,
      remaining,
      utilisation: rate(used, allocated + carriedOver),
      averageBalance:
        activeHeadcount > 0
          ? Math.round((remaining / activeHeadcount) * 10) / 10
          : null,
      overtimeHours: ot.totalHours,
      overtimeRequests: ot.requestCount,
      overtimeEmployees: ot.employeeCount,
      // Divided by the employees WITH overtime, not by headcount — "the average
      // person did 0.4 hours" is not a sentence anybody wanted.
      avgOvertimePerEmployee:
        ot.employeeCount > 0
          ? Math.round((ot.totalHours / ot.employeeCount) * 10) / 10
          : null,
      topLeaveType:
        [...byType.entries()].sort((a, b) => b[1].days - a[1].days)[0]?.[0] ??
        null,
    };

    if (!wantPanels) {
      return {
        stats,
        trend: [],
        leaveTypes: [],
        status: { approved: 0, pending: 0, rejected: 0, cancelled: 0 },
        balance: emptyBalance(),
        overtime: emptyOvertime(overtimeEnabled),
        attention: emptyAttention(),
      };
    }

    // One stacked bar per bucket, all four statuses.
    const buckets = new Map<
      string,
      {
        key: string;
        label: string;
        approved: number;
        pending: number;
        rejected: number;
        cancelled: number;
      }
    >();
    for (const day of eachDay(start, end)) {
      const b = bucketOf(period, day);
      if (!buckets.has(b.key)) {
        buckets.set(b.key, {
          ...b,
          approved: 0,
          pending: 0,
          rejected: 0,
          cancelled: 0,
        });
      }
    }
    for (const r of requests) {
      // A request lands on the bucket it STARTS in, clamped into the window: a
      // bar counts requests, and spreading one request across five bars would
      // make the chart's total disagree with the KPI above it.
      const at = r.startDate < start ? start : r.startDate;
      const entry = buckets.get(bucketOf(period, parseDateKey(key(at))).key);
      if (!entry) continue;
      if (r.status === RequestStatus.APPROVED) entry.approved += 1;
      else if (r.status === RequestStatus.PENDING) entry.pending += 1;
      else if (r.status === RequestStatus.REJECTED) entry.rejected += 1;
      else entry.cancelled += 1;
    }

    const trend = [...buckets.values()].map((b) => ({
      ...b,
      total: b.approved + b.pending + b.rejected + b.cancelled,
    }));

    const leaveTypes = [...byType.entries()]
      .map(([typeKey, v]) => ({
        key: typeKey,
        name: typeKey,
        requests: v.requests,
        days: Math.round(v.days * 10) / 10,
        share: rate(v.days, totalDays),
      }))
      .sort((a, b) => b.days - a.days);

    const pendingRows = requests.filter(
      (r) => r.status === RequestStatus.PENDING,
    );
    const staleRows = pendingRows.filter(
      (r) => r.createdAt.getTime() <= staleBefore,
    );

    return {
      stats,
      trend,
      leaveTypes,
      status: { ...counts },
      balance: {
        allocated,
        carriedOver,
        used,
        remaining,
        utilisation: rate(used, allocated + carriedOver),
        byType: byTypeBalance.sort((a, b) => b.allocated - a.allocated),
      },
      overtime: {
        enabled: overtimeEnabled,
        totalHours: ot.totalHours,
        trend: ot.trend,
        byDepartment: ot.byDepartment,
        topEmployees: ot.topEmployees,
        topDepartment: ot.byDepartment[0] ?? null,
        topEmployee: ot.topEmployees[0] ?? null,
      },
      // A named sample, capped. `count` is the true total; `names` is what turns
      // a number into a task.
      attention: {
        pending: { count: pendingRows.length, names: namesOf(pendingRows) },
        stale: { count: staleRows.length, names: namesOf(staleRows) },
        onLeaveToday: {
          count: onLeaveToday.size,
          names: [...onLeaveToday.values()].slice(0, NAME_CAP),
        },
        highOvertime: {
          count: ot.heavy.length,
          names: ot.heavy.slice(0, NAME_CAP).map((e) => e.name),
        },
      },
    };
  }

  /**
   * Approved leave, prorated to the working days actually inside the window.
   *
   * `totalDays` on a request is the WHOLE request and already excludes the
   * branch's weekly-off days and holidays. So the proration has to ask the same
   * service the same question, or a request straddling a month boundary would be
   * split by a raw day count and its two halves would not add back up.
   *
   * Only APPROVED leave counts as days taken. A pending request is a request,
   * not an absence — it appears in the donut and the trend, not here.
   */
  private async leaveDays(
    requests: LeaveRow[],
    start: Date,
    end: Date,
    today: Date,
  ) {
    const byType = new Map<string, { requests: number; days: number }>();
    const onLeaveToday = new Map<string, string>();
    const todayKey = key(today);
    let totalDays = 0;

    for (const r of requests) {
      const type = byType.get(r.leaveType) ?? { requests: 0, days: 0 };
      type.requests += 1;

      if (r.status !== RequestStatus.APPROVED) {
        byType.set(r.leaveType, type);
        continue;
      }

      const from = r.startDate < start ? start : r.startDate;
      const to = r.endDate > end ? end : r.endDate;
      const working = await this.workingDays.getWorkingDatesBetween(
        from,
        to,
        r.employee?.branchId ?? null,
      );

      // A request wholly inside the window keeps the number the REQUEST carries,
      // rather than a recount that could differ by a day at a branch whose
      // calendar changed since the leave was filed.
      const wholeRequest =
        r.startDate.getTime() >= start.getTime() &&
        r.endDate.getTime() <= end.getTime();
      const days = wholeRequest ? r.totalDays : working.length;

      totalDays += days;
      type.days += days;
      byType.set(r.leaveType, type);

      for (const day of working) {
        if (key(day) === todayKey) {
          onLeaveToday.set(r.employeeId, nameOf(r.employee, r.employeeId));
        }
      }
    }

    return { totalDays, byType, onLeaveToday };
  }

  /**
   * Overtime over the window: the total, its shape, and who is carrying it.
   *
   * APPROVED only for the HOURS — a pending request is a claim, and putting it in
   * the headline would let one mistaken forty-hour submission move the number the
   * whole company is judged on. The request COUNT is every status, because a
   * queue is a queue whatever it is going to become.
   *
   * The top-employee list is a welfare signal rather than a productivity one: the
   * same three names every month is a staffing problem wearing an overtime
   * costume.
   */
  private overtime(
    rows: OvertimeRow[],
    period: HubPeriod,
    start: Date,
    end: Date,
  ) {
    const buckets = new Map<
      string,
      { key: string; label: string; hours: number }
    >();
    for (const day of eachDay(start, end)) {
      const b = bucketOf(period, day);
      if (!buckets.has(b.key)) buckets.set(b.key, { ...b, hours: 0 });
    }

    const byEmployee = new Map<
      string,
      { id: string; name: string; hours: number }
    >();
    const byDepartment = new Map<
      string,
      { id: string; name: string; hours: number }
    >();
    let totalHours = 0;

    for (const r of rows) {
      if (r.status !== RequestStatus.APPROVED) continue;
      const hours = Number(r.hours) || 0;
      totalHours += hours;

      const bucket = buckets.get(
        bucketOf(period, parseDateKey(key(r.date))).key,
      );
      if (bucket) bucket.hours += hours;

      const emp = byEmployee.get(r.employeeId) ?? {
        id: r.employeeId,
        name: nameOf(r.employee, r.employeeId),
        hours: 0,
      };
      emp.hours += hours;
      byEmployee.set(r.employeeId, emp);

      const dept = r.employee?.department;
      if (dept) {
        const d = byDepartment.get(dept.id) ?? {
          id: dept.id,
          name: dept.name,
          hours: 0,
        };
        d.hours += hours;
        byDepartment.set(dept.id, d);
      }
    }

    const round = <T extends { hours: number }>(x: T): T => ({
      ...x,
      hours: Math.round(x.hours * 10) / 10,
    });

    return {
      totalHours: Math.round(totalHours * 10) / 10,
      requestCount: rows.length,
      employeeCount: byEmployee.size,
      trend: [...buckets.values()].map(round),
      byDepartment: [...byDepartment.values()]
        .sort((a, b) => b.hours - a.hours)
        .map(round),
      topEmployees: [...byEmployee.values()]
        .sort((a, b) => b.hours - a.hours)
        .slice(0, 5)
        .map(round),
      heavy: [...byEmployee.values()]
        .filter((e) => e.hours >= HIGH_OVERTIME_HOURS)
        .sort((a, b) => b.hours - a.hours)
        .map(round),
    };
  }
}

interface PersonRef {
  firstName: string;
  lastName: string;
  department?: { id: string; name: string } | null;
}

interface LeaveRow {
  id: string;
  employeeId: string;
  leaveType: string;
  startDate: Date;
  endDate: Date;
  totalDays: number;
  status: RequestStatus;
  createdAt: Date;
  employee: (PersonRef & { branchId: string | null }) | null;
}

interface OvertimeRow {
  employeeId: string;
  date: Date;
  hours: Prisma.Decimal;
  status: RequestStatus;
  employee: PersonRef | null;
}

function nameOf(person: PersonRef | null, fallback: string): string {
  if (!person) return fallback;
  return `${person.firstName} ${person.lastName}`.trim() || fallback;
}

/** Distinct names, capped — a count is a decision, a name is a task. */
function namesOf(rows: LeaveRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.size >= NAME_CAP) break;
    seen.add(nameOf(r.employee, r.employeeId));
  }
  return [...seen];
}

const emptyBalance = () => ({
  allocated: 0,
  carriedOver: 0,
  used: 0,
  remaining: 0,
  utilisation: null as number | null,
  byType: [] as Array<Record<string, unknown>>,
});

const emptyOvertime = (enabled: boolean) => ({
  enabled,
  totalHours: 0,
  trend: [] as Array<Record<string, unknown>>,
  byDepartment: [] as Array<Record<string, unknown>>,
  topEmployees: [] as Array<Record<string, unknown>>,
  topDepartment: null as Record<string, unknown> | null,
  topEmployee: null as Record<string, unknown> | null,
});

const emptyAttention = () => ({
  pending: { count: 0, names: [] as string[] },
  stale: { count: 0, names: [] as string[] },
  onLeaveToday: { count: 0, names: [] as string[] },
  highOvertime: { count: 0, names: [] as string[] },
});
