/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HolidaysService } from '../holidays/holidays.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { managerDeptScope } from '../common/services/manager-scope.util';
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

/**
 * The Leave & Overtime module hub.
 *
 * Two questions, and the page answers both at once: how much leave is being
 * used and waiting, and how much overtime is being worked. They belong on one
 * page because they are the same trade — hours the company owes against hours
 * it has bought.
 *
 * ## Three things this gets right that the endpoints it replaces did not
 *
 * 1. **A request that straddles the window is prorated, not double-counted.**
 *    `GET /leave-balances/company-overview` is year-scoped, so the question
 *    never arose. Here a 10-day leave running 28 Aug → 6 Sep belongs to both
 *    August and September, and charging August for September's days is exactly
 *    the sort of confident wrong answer this codebase files as a defect. The
 *    proration counts WORKING days via `HolidaysService`, the same way
 *    `leave-requests.service.ts:198-203` computes `totalDays` in the first
 *    place — a raw day count would disagree with the number on the request.
 *
 * 2. **CANCELLED is counted.** `getCompanyLeaveOverview`
 *    (`leave-balances.service.ts:1290+`) counts PENDING, APPROVED, REJECTED and
 *    a total, so a cancelled request silently vanishes from the status donut
 *    and the four slices do not sum to the caption above them.
 *
 * 3. **Overtime is windowed, not month-locked.** `getMonthlyReport`
 *    (`overtime.service.ts:1321-1385`) takes a month, and computes its totals
 *    by re-running `findAll` with `limit = total` and reducing in memory. This
 *    aggregates in the database over whatever window the selector names.
 *
 * Every rate goes through `rate()`, which is `null` rather than 0% when there
 * was nothing to divide by. Balance figures are year facts — a week does not
 * have an entitlement — so they are scoped to the year the window ENDS in.
 */

export interface HubUser {
  role?: string;
  departmentId?: string;
  managedDepartmentIds?: string[];
}

/** How many names an action item carries before it stops being a task. */
const NAME_CAP = 12;

/**
 * A pending request older than this is what the "N older than 2 days" footnote
 * counts. Two days is the point at which an approval stops being "not yet" and
 * starts being "forgotten" — the same judgement the attendance hub applies to
 * its correction queue at three.
 */
const STALE_AFTER_DAYS = 2;

/**
 * Mirrors `OvertimeService.MAX_MONTHLY_OVERTIME` (`overtime.service.ts:31`),
 * which is `private readonly` and so cannot be imported. Kept as a threshold
 * for the welfare signal only — nothing here enforces a cap, so a drift between
 * the two changes which names are highlighted, never whether a request is
 * allowed.
 */
const HIGH_OVERTIME_HOURS = 30;

const APPROVED = 'APPROVED';
const PENDING = 'PENDING';
const REJECTED = 'REJECTED';
const CANCELLED = 'CANCELLED';

export interface LeaveHubPeriodStats {
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
  pendingOlderThan2Days: number;
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
    private readonly holidays: HolidaysService,
    private readonly settings: SystemSettingsService,
  ) {}

  /** ACTIVE, non-admin, and inside the caller's department scope if a manager. */
  private employeeWhere(user?: HubUser): Prisma.EmployeeWhereInput {
    const where: any = { status: 'ACTIVE', NOT: { user: { role: 'ADMIN' } } };
    if (user?.role === 'MANAGER' && user?.departmentId) {
      where.departmentId = { in: managerDeptScope(user as any) };
    }
    return where;
  }

  async getHubSummary(
    period: HubPeriod = 'month',
    anchorParam?: string,
    user?: HubUser,
  ) {
    assertPeriod(period);

    const today = parseDateKey(key(new Date()));
    const anchor = anchorParam ? parseDateKey(anchorParam) : today;
    const { start, end, prevAnchor, nextAnchor, label } = resolveRange(period, anchor);
    const prevRange = resolveRange(period, prevAnchor);

    // The kill switch. Off → the page drops the overtime KPI and the overtime
    // panel rather than drawing zeros, which would read as "nobody worked late"
    // instead of "this company does not track overtime".
    const overtimeEnabled =
      (await this.settings.getSetting('overtime_enabled', 'true')) === 'true';

    const [current, previous] = await Promise.all([
      this.aggregate(period, start, end, today, overtimeEnabled, user),
      this.aggregate(period, prevRange.start, prevRange.end, today, overtimeEnabled, user, false),
    ]);

    return {
      success: true,
      data: {
        period,
        anchor: key(anchor),
        range: {
          start: key(start),
          end: key(end),
          through: key(end.getTime() > today.getTime() ? today : end),
          label,
          prevAnchor: key(prevAnchor),
          nextAnchor: key(nextAnchor),
          // Leave is filed ahead — a request for next month exists today — so
          // one window forward is legitimate. Beyond that is empty by
          // definition and paging into it reads as a broken page.
          hasNext: nextAnchor.getTime() <= addDays(today, 366).getTime(),
          isCurrent:
            start.getTime() <= today.getTime() && today.getTime() <= end.getTime(),
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
      },
    };
  }

  private async aggregate(
    period: HubPeriod,
    start: Date,
    end: Date,
    today: Date,
    overtimeEnabled: boolean,
    user?: HubUser,
    wantPanels = true,
  ) {
    const employee = this.employeeWhere(user);
    const year = end.getUTCFullYear();

    const [requests, activeHeadcount, balances, overtimeRows] =
      await Promise.all([
        // Overlap, not containment: a request running 28 Aug → 6 Sep is part of
        // both months, and a window that only caught requests starting inside
        // it would lose every leave that spans a boundary.
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
            approvedAt: true,
            employee: {
              select: {
                fullName: true,
                branchId: true,
                department: { select: { id: true, name: true } },
              },
            },
          },
        }),
        this.prisma.employee.count({ where: employee }),
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
                    fullName: true,
                    department: { select: { id: true, name: true } },
                  },
                },
              },
            })
          : Promise.resolve([]),
      ]);

    // ── status counts, all four of them ─────────────────────────────────────
    const counts = { approved: 0, pending: 0, rejected: 0, cancelled: 0 };
    for (const r of requests) {
      if (r.status === APPROVED) counts.approved += 1;
      else if (r.status === PENDING) counts.pending += 1;
      else if (r.status === REJECTED) counts.rejected += 1;
      else if (r.status === CANCELLED) counts.cancelled += 1;
    }

    // ── leave days, prorated to the part of the request inside the window ───
    const { totalDays, byType, onLeaveToday } = await this.leaveDays(
      requests,
      start,
      end,
      today,
    );

    // ── balances: a YEAR fact, scoped to the year the window ends in ────────
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
        key: b.leaveTypeKey,
        // `leaveTypeKey` IS the display label — `schema.prisma:4454` pins it to
        // `LibraryItem.label`, and `LeaveRequest.leaveType` matches the same
        // string. A key whose library row was since deleted still gets a row
        // here under its own name; dropping it would make the totals disagree
        // with the sum of the rows beneath them.
        name: b.leaveTypeKey,
        allocated: a,
        used: u,
        carriedOver: c,
        // There is no `remaining` column; this is the formula
        // `leave-balances.service.ts:325-333` already uses.
        remaining: a + c - u,
        utilisation: rate(u, a + c),
        employeeCount: b._count.employeeId,
      };
    });
    const remaining = allocated + carriedOver - used;

    // ── overtime ────────────────────────────────────────────────────────────
    const ot = this.overtime(overtimeRows as OvertimeRow[], period, start, end);

    const stats: LeaveHubPeriodStats = {
      requests: requests.length,
      approved: counts.approved,
      pending: counts.pending,
      rejected: counts.rejected,
      cancelled: counts.cancelled,
      approvalRate: rate(counts.approved, requests.length),
      leaveDays: totalDays,
      onLeaveToday: onLeaveToday.size,
      activeHeadcount,
      onLeaveTodayRate: rate(onLeaveToday.size, activeHeadcount),
      pendingOlderThan2Days: requests.filter(
        (r) =>
          r.status === PENDING &&
          r.createdAt.getTime() <= addDays(today, -STALE_AFTER_DAYS).getTime(),
      ).length,
      allocated,
      carriedOver,
      used,
      remaining,
      utilisation: rate(used, allocated + carriedOver),
      averageBalance:
        activeHeadcount > 0 ? Math.round((remaining / activeHeadcount) * 10) / 10 : null,
      overtimeHours: ot.totalHours,
      overtimeRequests: ot.requestCount,
      overtimeEmployees: ot.employeeCount,
      // Divided by employees WITH overtime, not by headcount — "the average
      // person did 0.4 hours" is not the sentence anybody wanted.
      avgOvertimePerEmployee:
        ot.employeeCount > 0
          ? Math.round((ot.totalHours / ot.employeeCount) * 10) / 10
          : null,
      topLeaveType:
        [...byType.entries()].sort((a, b) => b[1].days - a[1].days)[0]?.[0] ?? null,
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

    // ── main chart: one stacked bar per bucket, all four statuses ───────────
    const buckets = new Map<
      string,
      { key: string; label: string; approved: number; pending: number; rejected: number; cancelled: number }
    >();
    for (const day of eachDay(start, end)) {
      const b = bucketOf(period, day);
      if (!buckets.has(b.key)) {
        buckets.set(b.key, { ...b, approved: 0, pending: 0, rejected: 0, cancelled: 0 });
      }
    }
    for (const r of requests) {
      // A request lands on the bucket it STARTS in, clamped into the window: a
      // bar counts requests, and spreading one request across five bars would
      // make the chart's total disagree with the KPI above it.
      const at = r.startDate < start ? start : r.startDate;
      const b = bucketOf(period, parseDateKey(key(at)));
      const entry = buckets.get(b.key);
      if (!entry) continue;
      if (r.status === APPROVED) entry.approved += 1;
      else if (r.status === PENDING) entry.pending += 1;
      else if (r.status === REJECTED) entry.rejected += 1;
      else if (r.status === CANCELLED) entry.cancelled += 1;
    }
    const trend = [...buckets.values()].map((b) => ({
      ...b,
      total: b.approved + b.pending + b.rejected + b.cancelled,
    }));

    // ── right-side: what kinds of leave people are consuming ───────────────
    const leaveTypes = [...byType.entries()]
      .map(([typeKey, v]) => ({
        key: typeKey,
        name: typeKey,
        requests: v.requests,
        days: Math.round(v.days * 10) / 10,
        share: rate(v.days, totalDays),
      }))
      .sort((a, b) => b.days - a.days);

    // ── the action queue ────────────────────────────────────────────────────
    const pendingRows = requests.filter((r) => r.status === PENDING);
    const staleRows = pendingRows.filter(
      (r) => r.createdAt.getTime() <= addDays(today, -STALE_AFTER_DAYS).getTime(),
    );
    const attention = {
      pending: {
        count: pendingRows.length,
        names: namesOf(pendingRows),
      },
      stale: {
        count: staleRows.length,
        names: namesOf(staleRows),
      },
      onLeaveToday: {
        count: onLeaveToday.size,
        names: [...onLeaveToday.values()].slice(0, NAME_CAP),
      },
      highOvertime: {
        count: ot.heavy.length,
        names: ot.heavy.slice(0, NAME_CAP).map((e) => e.name),
      },
    };

    return {
      stats,
      trend,
      leaveTypes,
      status: {
        approved: counts.approved,
        pending: counts.pending,
        rejected: counts.rejected,
        cancelled: counts.cancelled,
      },
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
      attention,
    };
  }

  /**
   * Approved leave, prorated to the working days actually inside the window.
   *
   * `totalDays` on the request is the WHOLE request and already excludes the
   * employee's branch weekly-offs and holidays (`leave-requests.service.ts:198`
   * via `getWorkDaysBetween`). So the proration has to ask the same service the
   * same question, or a request straddling a month boundary would be split by a
   * raw day count and the two halves would not add back up to `totalDays`.
   *
   * Only APPROVED leave counts as days taken. A pending request is a request,
   * not an absence — it appears in the status donut and the trend, not here.
   */
  private async leaveDays(
    requests: LeaveRow[],
    start: Date,
    end: Date,
    today: Date,
  ) {
    const byDay = new Map<string, number>();
    const byType = new Map<string, { requests: number; days: number }>();
    const onLeaveToday = new Map<string, string>();
    let totalDays = 0;

    for (const r of requests) {
      const type = byType.get(r.leaveType) ?? { requests: 0, days: 0 };
      type.requests += 1;

      if (r.status !== APPROVED) {
        byType.set(r.leaveType, type);
        continue;
      }

      const from = r.startDate < start ? start : r.startDate;
      const to = r.endDate > end ? end : r.endDate;
      const working = await this.holidays.getWorkingDatesBetween(
        from,
        to,
        r.employee?.branchId ?? undefined,
      );
      // A whole request inside the window keeps the number the request itself
      // carries, rather than a recount that could differ by a day at a branch
      // whose calendar changed since the leave was filed.
      const wholeRequest =
        r.startDate.getTime() >= start.getTime() && r.endDate.getTime() <= end.getTime();
      const days = wholeRequest ? r.totalDays : working.length;

      totalDays += days;
      type.days += days;
      byType.set(r.leaveType, type);

      for (const day of working) {
        const k = key(day);
        byDay.set(k, (byDay.get(k) ?? 0) + 1);
        if (k === key(today)) {
          onLeaveToday.set(r.employeeId, r.employee?.fullName ?? r.employeeId);
        }
      }
    }

    return { totalDays, byDay, byType, onLeaveToday };
  }

  /**
   * Overtime over the window: the total, its shape, and who is carrying it.
   *
   * APPROVED only for the hours — pending overtime is a claim, and putting it
   * in the headline would let a mistaken 40-hour submission move the number the
   * whole company is judged on. The request COUNT is every status, because the
   * queue is a queue whatever it is going to become.
   *
   * The top-employee list is a welfare signal rather than a productivity one:
   * the same three names every month is a staffing problem wearing an overtime
   * costume.
   */
  private overtime(rows: OvertimeRow[], period: HubPeriod, start: Date, end: Date) {
    const buckets = new Map<string, { key: string; label: string; hours: number }>();
    for (const day of eachDay(start, end)) {
      const b = bucketOf(period, day);
      if (!buckets.has(b.key)) buckets.set(b.key, { ...b, hours: 0 });
    }

    const byEmployee = new Map<string, { id: string; name: string; hours: number }>();
    const byDepartment = new Map<string, { id: string; name: string; hours: number }>();
    let totalHours = 0;

    for (const r of rows) {
      if (r.status !== APPROVED) continue;
      const hours = Number(r.hours) || 0;
      totalHours += hours;

      const b = bucketOf(period, parseDateKey(key(r.date)));
      const bucket = buckets.get(b.key);
      if (bucket) bucket.hours += hours;

      const emp = byEmployee.get(r.employeeId) ?? {
        id: r.employeeId,
        name: r.employee?.fullName ?? r.employeeId,
        hours: 0,
      };
      emp.hours += hours;
      byEmployee.set(r.employeeId, emp);

      const dept = r.employee?.department;
      if (dept) {
        const d = byDepartment.get(dept.id) ?? { id: dept.id, name: dept.name, hours: 0 };
        d.hours += hours;
        byDepartment.set(dept.id, d);
      }
    }

    const round = <T extends { hours: number }>(x: T): T => ({
      ...x,
      hours: Math.round(x.hours * 10) / 10,
    });
    const topEmployees = [...byEmployee.values()]
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 5)
      .map(round);

    return {
      totalHours: Math.round(totalHours * 10) / 10,
      requestCount: rows.length,
      employeeCount: byEmployee.size,
      trend: [...buckets.values()].map(round),
      byDepartment: [...byDepartment.values()].sort((a, b) => b.hours - a.hours).map(round),
      topEmployees,
      heavy: [...byEmployee.values()]
        .filter((e) => e.hours >= HIGH_OVERTIME_HOURS)
        .sort((a, b) => b.hours - a.hours)
        .map(round),
    };
  }
}

interface LeaveRow {
  id: string;
  employeeId: string;
  leaveType: string;
  startDate: Date;
  endDate: Date;
  totalDays: number;
  status: string;
  createdAt: Date;
  approvedAt: Date | null;
  employee: {
    fullName: string;
    branchId: string | null;
    department: { id: string; name: string } | null;
  } | null;
}

interface OvertimeRow {
  employeeId: string;
  date: Date;
  hours: unknown;
  status: string;
  employee: {
    fullName: string;
    department: { id: string; name: string } | null;
  } | null;
}

/** Distinct names, capped — a count is a decision, a name is a task. */
function namesOf(rows: LeaveRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.size >= NAME_CAP) break;
    seen.add(r.employee?.fullName ?? r.employeeId);
  }
  return [...seen];
}

const emptyBalance = () => ({
  allocated: 0,
  carriedOver: 0,
  used: 0,
  remaining: 0,
  utilisation: null as number | null,
  byType: [] as any[],
});

const emptyOvertime = (enabled: boolean) => ({
  enabled,
  totalHours: 0,
  trend: [] as any[],
  byDepartment: [] as any[],
  topEmployees: [] as any[],
  topDepartment: null as any,
  topEmployee: null as any,
});

const emptyAttention = () => ({
  pending: { count: 0, names: [] as string[] },
  stale: { count: 0, names: [] as string[] },
  onLeaveToday: { count: 0, names: [] as string[] },
  highOvertime: { count: 0, names: [] as string[] },
});
