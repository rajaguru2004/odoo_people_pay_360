/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import { HolidaysService } from '../holidays/holidays.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { AttendancesService, UserPayload } from './attendances.service';
import { managerDeptScope } from '../common/services/manager-scope.util';
import { rawBranchFilter } from '../common/branch/branch-scope.util';
import {
  addDays,
  assertPeriod,
  key,
  MONTHS,
  parseDateKey,
  rate,
  resolveRange,
  startOfWeek,
  type HubPeriod,
} from '../common/hub/hub-range.util';

// Re-exported because `attendances.controller.ts` and every existing importer
// reach for `HubPeriod` here. The definition now lives with the shared range
// helpers, which the Schedules and Leave hubs read too.
export type { HubPeriod };

/** Attendance rows only ever carry these three statuses today. */
const PRESENT = 'PRESENT';
const ABSENT = 'ABSENT';
const LEAVE = 'LEAVE';

/**
 * The denominator, reconciled against what actually happened.
 *
 * The calendar is the primary source: it knows the branch working week, its
 * holidays and who is on approved leave. But it is a plan, and people work
 * outside it — a shift covered on a public holiday, a Saturday call-out, an
 * employee whose branch record says one thing and whose punches say another.
 * Taken alone the calendar produced **106% attendance** on this database,
 * because Founders Day is a holiday and six people clocked in anyway.
 *
 * So: whoever the calendar expected, OR whoever actually turned up, whichever
 * is larger. This can only ever RAISE the denominator, so it never hides an
 * absence — it only stops a rate claiming more than everybody.
 */
function reconcileExpected(
  calendarExpected: number,
  present: number,
  onLeave: number,
  recordedAbsent: number,
): number {
  return Math.max(calendarExpected, present + onLeave + recordedAbsent);
}

/** One day of the workforce, as the hub reads it. */
export interface DaySnapshot {
  date: string;
  /** Employees the calendar says should have worked (branch week + holidays). */
  expected: number;
  present: number;
  onTime: number;
  late: number;
  absent: number;
  onLeave: number;
  /** Clocked in and never clocked out — unclosed shifts skew pay. */
  notCheckedOut: number;
  /** Expected, not on leave, and no punch yet. */
  notCheckedIn: number;
  avgWorkHours: number | null;
  presentRate: number | null;
  lateRate: number | null;
  absentRate: number | null;
  onTimeRate: number | null;
  /**
   * True once the configured attendance day-end has passed. Before it, a
   * missing punch is somebody still on their way, not an absence.
   */
  settled: boolean;
}

/** One bar of the main trend chart: a day (week/month) or a month (year). */
export interface TrendBucket {
  key: string;
  label: string;
  expected: number;
  present: number;
  onTime: number;
  late: number;
  absent: number;
  onLeave: number;
  attendanceRate: number | null;
}

/**
 * Everything the Time & Attendance module hub puts on screen, in one request.
 *
 * The hub asks two different questions at once and they need different shapes:
 * "what is happening right now" (today, and today only — a KPI that silently
 * became a month average when somebody clicked *Month* would be a lie the
 * reader cannot see) and "what does the selected period look like" (the trend
 * bars, the department ranking, the period rates). So `today` is computed from
 * today whatever the period, and only `periodStats`/`trend`/`departments`
 * follow the Week/Month/Year selector.
 *
 * `expected` is the number every rate on this page divides by. It is NOT the
 * headcount: an employee whose branch is closed that day, or who is on approved
 * leave, was never going to punch, and counting them as absent would invent
 * absences every weekend. It comes from `HolidaysService.getWorkingDatesBetween`
 * per BRANCH, because branches run different working weeks (Sun–Thu in Muscat,
 * Mon–Fri in Bengaluru).
 */
@Injectable()
export class AttendanceHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tzSvc: TimezoneService,
    private readonly holidaysService: HolidaysService,
    private readonly settingsService: SystemSettingsService,
    private readonly attendancesService: AttendancesService,
  ) {}

  /** ACTIVE, non-admin, and inside the caller's department scope if a manager. */
  private employeeWhere(user?: UserPayload): Prisma.EmployeeWhereInput {
    const where: any = { status: 'ACTIVE', NOT: { user: { role: 'ADMIN' } } };
    if (user?.role === 'MANAGER' && user?.departmentId) {
      where.departmentId = { in: managerDeptScope(user) };
    }
    return where;
  }

  /** The same scope, expressed as a filter on `attendance.employee`. */
  private attendanceWhere(from: Date, to: Date, user?: UserPayload): any {
    const employee: any = { NOT: { user: { role: 'ADMIN' } } };
    if (user?.role === 'MANAGER' && user?.departmentId) {
      employee.departmentId = { in: managerDeptScope(user) };
    }
    return { date: { gte: from, lte: to }, employee };
  }

  /**
   * Headcount per branch, and the working days each branch actually has in
   * `[from, to]`. Branch is the unit because the working week is a branch
   * property; one shared calendar would make every Friday look like mass
   * absence for the Oman branch.
   */
  private async calendar(from: Date, to: Date, user?: UserPayload) {
    const byBranch = await this.prisma.employee.groupBy({
      by: ['branchId'],
      where: this.employeeWhere(user),
      _count: { _all: true },
    });

    const workingDays = new Map<string, Set<string>>();
    const headcount = new Map<string, number>();
    for (const row of byBranch) {
      const branchKey = row.branchId ?? '';
      headcount.set(branchKey, row._count._all);
      if (to.getTime() < from.getTime()) {
        workingDays.set(branchKey, new Set());
        continue;
      }
      const dates = await this.holidaysService.getWorkingDatesBetween(
        from,
        to,
        row.branchId ?? undefined,
      );
      workingDays.set(branchKey, new Set(dates.map(key)));
    }

    /** Working-day headcount for one date, summed across branches. */
    const expectedOn = (dateKey: string): number => {
      let total = 0;
      for (const [branchKey, count] of headcount) {
        if (workingDays.get(branchKey)?.has(dateKey)) total += count;
      }
      return total;
    };

    return { byBranch, headcount, workingDays, expectedOn };
  }

  /**
   * Approved leave, expanded to one entry per employee-day, but only on days
   * that were working days for that employee's branch — leave over a weekend
   * is not a day off from anything.
   */
  private async leaveByDay(
    from: Date,
    to: Date,
    workingDays: Map<string, Set<string>>,
    user?: UserPayload,
  ) {
    if (to.getTime() < from.getTime()) {
      return { byDay: new Map<string, number>(), byDept: new Map<string, number>() };
    }
    const rows = await this.prisma.leaveRequest.findMany({
      where: {
        status: 'APPROVED',
        startDate: { lte: to },
        endDate: { gte: from },
        employee: this.employeeWhere(user),
      },
      select: {
        startDate: true,
        endDate: true,
        employee: { select: { branchId: true, departmentId: true } },
      },
    });

    const byDay = new Map<string, number>();
    const byDept = new Map<string, number>();
    for (const row of rows) {
      const branchKey = row.employee?.branchId ?? '';
      const working = workingDays.get(branchKey);
      let cursor = row.startDate < from ? new Date(from) : new Date(row.startDate);
      const last = row.endDate > to ? to : row.endDate;
      while (cursor.getTime() <= last.getTime()) {
        const k = key(cursor);
        if (!working || working.has(k)) {
          byDay.set(k, (byDay.get(k) ?? 0) + 1);
          const dept = row.employee?.departmentId;
          if (dept) byDept.set(dept, (byDept.get(dept) ?? 0) + 1);
        }
        cursor = addDays(cursor, 1);
      }
    }
    return { byDay, byDept };
  }

  /** Per-date attendance counts for a range, in three grouped queries. */
  private async attendanceByDay(from: Date, to: Date, user?: UserPayload) {
    const present = new Map<string, number>();
    const absent = new Map<string, number>();
    const leave = new Map<string, number>();
    const late = new Map<string, number>();
    const hoursSum = new Map<string, number>();
    const hoursCount = new Map<string, number>();

    if (to.getTime() < from.getTime()) {
      return { present, absent, leave, late, hoursSum, hoursCount };
    }

    const where = this.attendanceWhere(from, to, user);
    const [byStatus, byLate, byHours] = await Promise.all([
      this.prisma.attendance.groupBy({
        by: ['date', 'status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.attendance.groupBy({
        by: ['date'],
        where: { ...where, isLate: true },
        _count: { _all: true },
      }),
      this.prisma.attendance.groupBy({
        by: ['date'],
        where: { ...where, workHours: { not: null } },
        _sum: { workHours: true },
        _count: { _all: true },
      }),
    ]);

    for (const row of byStatus) {
      const k = key(row.date);
      const n = row._count._all;
      if (row.status === PRESENT) present.set(k, (present.get(k) ?? 0) + n);
      else if (row.status === ABSENT) absent.set(k, (absent.get(k) ?? 0) + n);
      else if (row.status === LEAVE) leave.set(k, (leave.get(k) ?? 0) + n);
    }
    for (const row of byLate) late.set(key(row.date), row._count._all);
    for (const row of byHours) {
      hoursSum.set(key(row.date), Number(row._sum.workHours ?? 0));
      hoursCount.set(key(row.date), row._count._all);
    }

    return { present, absent, leave, late, hoursSum, hoursCount };
  }

  /**
   * One day, fully resolved. Used for today and yesterday, which are computed
   * outside the selected period so the KPI cards never drift into an average.
   */
  async daySnapshot(day: Date, user?: UserPayload): Promise<DaySnapshot> {
    const k = key(day);
    const [{ expectedOn, workingDays }, settled] = await Promise.all([
      this.calendar(day, day, user),
      this.attendancesService.hasDayEndBoundaryPassed(day),
    ]);
    const [att, leaves] = await Promise.all([
      this.attendanceByDay(day, day, user),
      this.leaveByDay(day, day, workingDays, user),
    ]);

    const present = att.present.get(k) ?? 0;
    const late = att.late.get(k) ?? 0;
    // Two sources say "on leave": the approved request, and a LEAVE attendance
    // row written by the leave module. Either alone under-counts, so take the
    // larger rather than adding them and double-counting the overlap.
    const onLeave = Math.max(att.leave.get(k) ?? 0, leaves.byDay.get(k) ?? 0);
    const recordedAbsent = att.absent.get(k) ?? 0;
    const expected = reconcileExpected(
      expectedOn(k),
      present,
      onLeave,
      recordedAbsent,
    );

    // Before the day closes, "no punch yet" is somebody in traffic. After it,
    // the calendar's expectation minus who turned up IS the absence, whether or
    // not the auto-absent cron has written a row yet.
    const derivedAbsent = Math.max(0, expected - present - onLeave);
    const absent = settled
      ? Math.max(recordedAbsent, derivedAbsent)
      : recordedAbsent;

    const notCheckedIn = settled
      ? absent
      : Math.max(0, expected - present - onLeave - recordedAbsent);

    const notCheckedOut = await this.prisma.attendance.count({
      where: {
        ...this.attendanceWhere(day, day, user),
        status: PRESENT,
        checkIn: { not: null },
        checkOut: null,
      },
    });

    const hoursCount = att.hoursCount.get(k) ?? 0;
    const avgWorkHours = hoursCount
      ? Math.round(((att.hoursSum.get(k) ?? 0) / hoursCount) * 10) / 10
      : null;

    return {
      date: k,
      expected,
      present,
      onTime: Math.max(0, present - late),
      late,
      absent,
      onLeave,
      notCheckedOut,
      notCheckedIn,
      avgWorkHours,
      presentRate: rate(present, expected),
      lateRate: rate(late, present),
      absentRate: rate(absent, expected),
      onTimeRate: rate(Math.max(0, present - late), expected),
      settled,
    };
  }

  /**
   * Everything a window adds up to, and optionally the bars that draw it.
   *
   * Called twice per request: once for the window on screen, once for the one
   * before it, which is what every "vs last week" on the page compares against.
   * The second call skips the buckets — nothing draws them.
   */
  private async aggregate(
    period: HubPeriod,
    start: Date,
    effEnd: Date,
    today: Date,
    todayOpen: boolean,
    user?: UserPayload,
    wantBuckets = true,
  ) {
    const empty = effEnd.getTime() < start.getTime();
    const buckets: TrendBucket[] = [];
    const bucketIndex = new Map<string, number>();

    let expectedTotal = 0;
    let presentTotal = 0;
    let lateTotal = 0;
    let absentTotal = 0;
    let leaveTotal = 0;
    let hoursSum = 0;
    let hoursCount = 0;
    let daysCounted = 0;

    if (empty) {
      return {
        empty,
        buckets,
        workingDays: new Map<string, Set<string>>(),
        leaveByDept: new Map<string, number>(),
        totals: {
          expected: 0,
          present: 0,
          late: 0,
          absent: 0,
          onLeave: 0,
          attendanceRate: null as number | null,
          lateRate: null as number | null,
          absentRate: null as number | null,
          avgWorkHours: null as number | null,
          lateOccurrences: 0,
          daysCounted: 0,
          bucketCount: 0,
        },
      };
    }

    const { workingDays, expectedOn } = await this.calendar(start, effEnd, user);
    const [att, leaves] = await Promise.all([
      this.attendanceByDay(start, effEnd, user),
      this.leaveByDay(start, effEnd, workingDays, user),
    ]);

    const todayKey = key(today);
    let cursor = new Date(start);
    while (cursor.getTime() <= effEnd.getTime()) {
      const k = key(cursor);
      const present = att.present.get(k) ?? 0;
      const late = att.late.get(k) ?? 0;
      const onLeave = Math.max(att.leave.get(k) ?? 0, leaves.byDay.get(k) ?? 0);
      const recordedAbsent = att.absent.get(k) ?? 0;
      const expected = reconcileExpected(
        expectedOn(k),
        present,
        onLeave,
        recordedAbsent,
      );
      // Today is still open until the day-end boundary; treating its missing
      // punches as absences would show a red bar every morning.
      const openToday = k === todayKey && todayOpen;
      const absent = openToday
        ? recordedAbsent
        : Math.max(recordedAbsent, Math.max(0, expected - present - onLeave));

      daysCounted += 1;
      expectedTotal += expected;
      presentTotal += present;
      lateTotal += late;
      absentTotal += absent;
      leaveTotal += onLeave;
      hoursSum += att.hoursSum.get(k) ?? 0;
      hoursCount += att.hoursCount.get(k) ?? 0;

      if (wantBuckets) {
        // Week/Month draw a bar per day; Year draws one per month, or twelve
        // bars would become three hundred and sixty-five.
        const bKey =
          period === 'year'
            ? `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`
            : k;
        const bLabel =
          period === 'year'
            ? MONTHS[cursor.getUTCMonth()]
            : `${MONTHS[cursor.getUTCMonth()]} ${cursor.getUTCDate()}`;

        let idx = bucketIndex.get(bKey);
        if (idx === undefined) {
          idx = buckets.length;
          bucketIndex.set(bKey, idx);
          buckets.push({
            key: bKey,
            label: bLabel,
            expected: 0,
            present: 0,
            onTime: 0,
            late: 0,
            absent: 0,
            onLeave: 0,
            attendanceRate: null,
          });
        }
        const b = buckets[idx];
        b.expected += expected;
        b.present += present;
        b.late += late;
        b.onTime += Math.max(0, present - late);
        b.absent += absent;
        b.onLeave += onLeave;
      }

      cursor = addDays(cursor, 1);
    }
    for (const b of buckets) b.attendanceRate = rate(b.present, b.expected);

    return {
      empty,
      buckets,
      workingDays,
      leaveByDept: leaves.byDept,
      totals: {
        expected: expectedTotal,
        present: presentTotal,
        late: lateTotal,
        absent: absentTotal,
        onLeave: leaveTotal,
        attendanceRate: rate(presentTotal, expectedTotal),
        lateRate: rate(lateTotal, presentTotal),
        absentRate: rate(absentTotal, expectedTotal),
        avgWorkHours: hoursCount
          ? Math.round((hoursSum / hoursCount) * 10) / 10
          : null,
        /** Every late arrival in the window, not a per-day average. */
        lateOccurrences: lateTotal,
        /** Days actually aggregated — always days, never buckets. */
        daysCounted,
        /** Bars on the chart: one per day, per hour, or per month. */
        bucketCount: buckets.length,
      },
    };
  }

  /**
   * The hub payload.
   *
   * `period` moves everything the page reports: the KPI cards, the trend, the
   * department ranking and `periodStats`. `Today` is one of the four periods
   * rather than a separate mode, so the same ‹ › arrows walk back through
   * yesterday, last week, last month or last year without the reader having to
   * learn a second control.
   *
   * `today` and `yesterday` stay in the payload regardless, because the three
   * insight panels at the foot of the page are explicitly about right now —
   * who is still clocked in, what the roster says, when people arrived.
   *
   * `anchor` is any date inside the period being viewed, which is what makes
   * the arrows work: the client just hands back `prevAnchor`/`nextAnchor` and
   * never does calendar arithmetic of its own.
   */
  async getHubSummary(
    period: HubPeriod = 'today',
    anchorParam?: string,
    user?: UserPayload,
  ) {
    assertPeriod(period);

    const companyTZ = await this.tzSvc.getCompanyTZ();
    const today = this.tzSvc.toDateKey(new Date(), companyTZ);
    const anchor = anchorParam ? parseDateKey(anchorParam) : today;

    const { start, end, prevAnchor, nextAnchor, label } = resolveRange(
      period,
      anchor,
    );

    // A day that has not happened cannot be an absence, so nothing after today
    // is ever aggregated — an in-progress month reports the days it has.
    const effEnd = end.getTime() > today.getTime() ? today : end;

    // Hoisted: it is one setting lookup, and the aggregate loops up to 366 times.
    const todayOpen = !(await this.attendancesService.hasDayEndBoundaryPassed(today));

    // The window before this one, on the same terms, so "vs last week" compares
    // like with like. Its buckets are never drawn, so they are never built.
    const prevRange = resolveRange(period, prevAnchor);
    const prevEffEnd =
      prevRange.end.getTime() > today.getTime() ? today : prevRange.end;

    const [current, previous] = await Promise.all([
      this.aggregate(period, start, effEnd, today, todayOpen, user, true),
      this.aggregate(
        period,
        prevRange.start,
        prevEffEnd,
        today,
        todayOpen,
        user,
        false,
      ),
    ]);

    const departments = await this.departmentBreakdown(
      start,
      effEnd,
      current.workingDays,
      current.leaveByDept,
      user,
      current.empty,
    );

    // `today` rides along for the one thing that cannot be historical: whether
    // the day is still open, which is what stops an unfinished morning being
    // reported as absence.
    const [todaySnap, yesterdaySnap] = await Promise.all([
      this.daySnapshot(today, user),
      this.daySnapshot(addDays(today, -1), user),
    ]);

    // Every panel reads the SELECTED window. An insight card that stayed on
    // today while the cards above it moved to August is the same lie in a
    // different place — the reader has no way to tell which clock they are on.
    const [arrivalPattern, shifts, attention] = await Promise.all([
      this.arrivalPattern(start, effEnd, companyTZ, user),
      this.shiftOverview(start, effEnd, current.totals, user),
      this.attention(start, effEnd, today, todayOpen, current.totals, user),
    ]);

    // A single day has no daily shape to draw, so its chart is the hour-by-hour
    // arrival curve instead — the only trend a day actually has.
    let trend = current.buckets;
    let trendKind: 'hour' | 'day' | 'month' =
      period === 'today' ? 'hour' : period === 'year' ? 'month' : 'day';

    if (period === 'today') {
      // The window IS the day, so its arrival pattern is already the curve.
      trend = arrivalPattern.map((h) => ({
        key: String(h.hour).padStart(2, '0'),
        label: h.label,
        // An hour expects nobody in particular — people arrive when their
        // shift starts, and the day's expectation is not divisible by hour.
        expected: 0,
        present: h.onTime + h.late,
        onTime: h.onTime,
        late: h.late,
        absent: 0,
        onLeave: 0,
        attendanceRate: null,
      }));
      current.totals.bucketCount = trend.length;
    }

    return {
      success: true,
      data: {
        period,
        anchor: key(anchor),
        range: {
          start: key(start),
          end: key(end),
          /** How much of the range has actually happened. */
          through: current.empty ? null : key(effEnd),
          label,
          prevAnchor: key(prevAnchor),
          nextAnchor: key(nextAnchor),
          /** False on the current period — there is no future to page into. */
          hasNext: nextAnchor.getTime() <= today.getTime(),
          isCurrent:
            start.getTime() <= today.getTime() && today.getTime() <= end.getTime(),
        },
        today: todaySnap,
        yesterday: yesterdaySnap,
        periodStats: current.totals,
        /** The same window, one step back. Every delta on the page reads this. */
        previousStats: previous.totals,
        previousRange: {
          start: key(prevRange.start),
          end: key(prevRange.end),
          label: prevRange.label,
        },
        /** What one bar of `trend` counts: an hour, a day, or a month. */
        trendKind,
        trend,
        departments,
        arrivalPattern,
        shifts,
        attention,
      },
    };
  }

  /**
   * Per-department attendance for the range.
   *
   * Raw SQL because the counts hang off `employee.departmentId`, which Prisma's
   * `groupBy` cannot reach from `attendance` — and raw SQL is invisible to the
   * branch-scope middleware, hence the explicit `rawBranchFilter`.
   */
  private async departmentBreakdown(
    from: Date,
    to: Date,
    workingDays: Map<string, Set<string>>,
    leaveByDept: Map<string, number>,
    user?: UserPayload,
    empty = false,
  ) {
    const [deptBranch, departments] = await Promise.all([
      this.prisma.employee.groupBy({
        by: ['departmentId', 'branchId'],
        where: this.employeeWhere(user),
        _count: { _all: true },
      }),
      this.prisma.department.findMany({ select: { id: true, name: true } }),
    ]);

    const expected = new Map<string, number>();
    const headcount = new Map<string, number>();
    for (const row of deptBranch) {
      const days = workingDays.get(row.branchId ?? '')?.size ?? 0;
      expected.set(
        row.departmentId,
        (expected.get(row.departmentId) ?? 0) + row._count._all * days,
      );
      headcount.set(
        row.departmentId,
        (headcount.get(row.departmentId) ?? 0) + row._count._all,
      );
    }

    let actuals: Array<{
      departmentId: string;
      present: bigint | number;
      late: bigint | number;
      absent: bigint | number;
      recorded: bigint | number;
    }> = [];

    if (!empty) {
      const deptScope =
        user?.role === 'MANAGER' && user?.departmentId
          ? Prisma.sql`AND e.department_id = ANY(${managerDeptScope(user)}::uuid[])`
          : Prisma.empty;

      actuals = await this.prisma.$queryRaw`
        SELECT e.department_id AS "departmentId",
               COUNT(*) FILTER (WHERE a.status = 'PRESENT') AS present,
               COUNT(*) FILTER (WHERE a.is_late)            AS late,
               COUNT(*) FILTER (WHERE a.status = 'ABSENT')  AS absent,
               COUNT(*)                                     AS recorded
        FROM attendances a
        JOIN employees e ON e.id = a.employee_id
        WHERE a.date >= ${from}::date
          AND a.date <= ${to}::date
          AND e.status = 'ACTIVE'
          AND NOT EXISTS (
            SELECT 1 FROM users u WHERE u.employee_id = e.id AND u.role = 'ADMIN'
          )
          ${deptScope}
          ${rawBranchFilter('a')}
        GROUP BY e.department_id
      `;
    }

    const actualBy = new Map(actuals.map((r) => [r.departmentId, r]));

    return departments
      .map((d) => {
        const a = actualBy.get(d.id);
        const present = Number(a?.present ?? 0);
        const late = Number(a?.late ?? 0);
        const onLeave = leaveByDept.get(d.id) ?? 0;
        const recordedAbsent = Number(a?.absent ?? 0);
        const exp = reconcileExpected(
          expected.get(d.id) ?? 0,
          present,
          onLeave,
          recordedAbsent,
        );
        const absent = Math.max(recordedAbsent, Math.max(0, exp - present - onLeave));
        return {
          id: d.id,
          name: d.name,
          headcount: headcount.get(d.id) ?? 0,
          expected: exp,
          present,
          late,
          absent,
          onLeave,
          rate: rate(present, exp),
          /**
           * Whether this department has ANY attendance row in the range. A
           * department with none is a data gap, not a staffing crisis, and a
           * ranking that puts it above a genuinely short-handed team every day
           * buries the thing the panel exists to surface.
           */
          hasData: Number(a?.recorded ?? 0) > 0,
        };
      })
      .filter((d) => d.headcount > 0)
      // Worst first among departments that actually report; the silent ones go
      // last, flagged, rather than pretending to be at 0%.
      .sort(
        (a, b) =>
          Number(b.hasData) - Number(a.hasData) ||
          (a.rate ?? 101) - (b.rate ?? 101) ||
          b.expected - a.expected,
      );
  }

  /**
   * When people actually arrived, hour by hour, split on-time against late so a
   * 9:30 spike is visible rather than averaged away.
   *
   * Over a longer window the hours ACCUMULATE across days, which is the point:
   * one morning tells you about one morning, a month tells you the shift the
   * office actually runs.
   */
  private async arrivalPattern(
    from: Date,
    to: Date,
    tz: string,
    user?: UserPayload,
  ) {
    const FROM_HOUR = 6;
    const TO_HOUR = 21;
    const pattern = [] as Array<{
      hour: number;
      label: string;
      onTime: number;
      late: number;
    }>;
    for (let h = FROM_HOUR; h <= TO_HOUR; h++) {
      const suffix = h < 12 ? 'AM' : 'PM';
      const twelve = h % 12 === 0 ? 12 : h % 12;
      pattern.push({ hour: h, label: `${twelve} ${suffix}`, onTime: 0, late: 0 });
    }
    if (to.getTime() < from.getTime()) return pattern;

    const rows = await this.prisma.attendance.findMany({
      where: {
        ...this.attendanceWhere(from, to, user),
        checkIn: { not: null },
      },
      select: { checkIn: true, isLate: true },
    });

    for (const r of rows) {
      if (!r.checkIn) continue;
      const h = this.tzSvc.localHour(r.checkIn, tz);
      // Anything outside the window lands on the nearest edge rather than
      // disappearing — a 4 AM night-shift punch is still a punch.
      const idx = Math.min(Math.max(h, FROM_HOUR), TO_HOUR) - FROM_HOUR;
      if (r.isLate) pattern[idx].late++;
      else pattern[idx].onTime++;
    }
    return pattern;
  }

  /**
   * Are people following the roster?
   *
   * Everything here is measured over the SELECTED window, so a month reports
   * rostered shift-days rather than today's headcount — the same unit as the
   * `expected` it falls back to when no roster was ever written.
   */
  private async shiftOverview(
    from: Date,
    to: Date,
    totals: { expected: number; present: number; late: number; absent: number; onLeave: number },
    user?: UserPayload,
  ) {
    const employee: any = { NOT: { user: { role: 'ADMIN' } }, status: 'ACTIVE' };
    if (user?.role === 'MANAGER' && user?.departmentId) {
      employee.departmentId = { in: managerDeptScope(user) };
    }
    const byShift =
      to.getTime() < from.getTime()
        ? []
        : await this.prisma.workSchedule.groupBy({
            by: ['shiftType'],
            where: { date: { gte: from, lte: to }, isWorkDay: true, employee },
            _count: { _all: true },
          });

    const rostered = byShift.reduce((a, r) => a + r._count._all, 0);
    // No roster written is not "nobody works" — fall back to what the branch
    // calendar expects, which is what the rest of the page divides by.
    const scheduled = rostered || totals.expected;

    return {
      /** Distinct shift patterns running in the window. */
      shiftCount: byShift.length,
      source: rostered ? 'roster' : 'calendar',
      scheduled,
      checkedIn: totals.present,
      onShift: Math.max(0, totals.present - totals.late),
      late: totals.late,
      absent: totals.absent,
      onLeave: totals.onLeave,
      yetToCheckIn: Math.max(0, scheduled - totals.present - totals.onLeave),
      shifts: byShift.map((r) => ({ type: r.shiftType, count: r._count._all })),
    };
  }

  /**
   * What to act on, with the names behind each number — a count alone sends the
   * reader off to find the list themselves.
   *
   * Counts come from aggregates and names from a capped `take`, so a year-long
   * window costs the same as a day. The two can therefore disagree in length:
   * twelve names under a count of ninety is the intended shape, not a bug.
   *
   * `notCheckedIn` is the one item that cannot be historical. "Nobody heard
   * from" is a statement about a day still in progress; once the day closes
   * those people are simply absent, and the absent item already says so. It is
   * therefore reported only when the window actually contains an open today.
   */
  private async attention(
    from: Date,
    to: Date,
    today: Date,
    todayOpen: boolean,
    totals: { late: number; absent: number },
    user?: UserPayload,
  ) {
    const empty = to.getTime() < from.getTime();
    const employeeWhere = this.employeeWhere(user);
    const attWhere = this.attendanceWhere(from, to, user);
    const NAME_CAP = 12;

    /** Distinct employee names matching a filter, capped. */
    const namesFor = async (where: any): Promise<string[]> => {
      if (empty) return [];
      const rows = await this.prisma.attendance.findMany({
        where: { ...attWhere, ...where },
        select: { employee: { select: { fullName: true } } },
        distinct: ['employeeId'],
        take: NAME_CAP,
      });
      return rows.map((r) => r.employee?.fullName).filter(Boolean) as string[];
    };

    const standardHours = Number(
      await this.settingsService.getSetting('payroll_work_hours_per_day', '8'),
    );

    const deptScope =
      user?.role === 'MANAGER' && user?.departmentId
        ? Prisma.sql`AND e.department_id = ANY(${managerDeptScope(user)}::uuid[])`
        : Prisma.empty;

    // Over-hours has to compare each row against ITS OWN rostered requirement,
    // which Prisma cannot express as a column-to-column filter. Raw SQL, and so
    // the branch envelope has to be spliced in by hand.
    const overHoursSql = (limit: Prisma.Sql) => Prisma.sql`
      FROM attendances a
      JOIN employees e ON e.id = a.employee_id
      LEFT JOIN work_schedules w
        ON w.employee_id = a.employee_id AND w.date = a.date
      WHERE a.date >= ${from}::date
        AND a.date <= ${to}::date
        AND a.work_hours IS NOT NULL
        AND a.work_hours > COALESCE(w.required_hours, ${standardHours})
        AND e.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM users u WHERE u.employee_id = e.id AND u.role = 'ADMIN'
        )
        ${deptScope}
        ${rawBranchFilter('a')}
      ${limit}
    `;

    const [
      notCheckedOutCount,
      notCheckedOutNames,
      overHoursRows,
      overHoursNames,
      lateNames,
      absentNames,
      pendingCorrections,
    ] = await Promise.all([
      empty
        ? 0
        : this.prisma.attendance.count({
            where: { ...attWhere, checkIn: { not: null }, checkOut: null },
          }),
      namesFor({ checkIn: { not: null }, checkOut: null }),
      empty
        ? []
        : (this.prisma.$queryRaw`SELECT COUNT(DISTINCT a.employee_id)::int AS n ${overHoursSql(
            Prisma.empty,
          )}` as Promise<Array<{ n: number }>>),
      empty
        ? []
        : (this.prisma.$queryRaw`SELECT DISTINCT e.full_name AS name ${overHoursSql(
            Prisma.sql`LIMIT ${NAME_CAP}`,
          )}` as Promise<Array<{ name: string }>>),
      namesFor({ isLate: true }),
      namesFor({ status: ABSENT }),
      // Deliberately NOT windowed: a queue is what is waiting NOW, and
      // "corrections raised last March" is not something anybody acts on.
      this.prisma.attendanceCorrection.count({ where: { status: 'PENDING' } }),
    ]);

    // Only meaningful while a day is still running, and only when the window
    // being looked at is the one that contains it.
    const coversToday =
      !empty && from.getTime() <= today.getTime() && today.getTime() <= to.getTime();
    let notCheckedIn: string[] = [];
    if (coversToday && todayOpen) {
      const punched = await this.prisma.attendance.findMany({
        where: this.attendanceWhere(today, today, user),
        select: { employeeId: true },
      });
      const missing = await this.prisma.employee.findMany({
        where: {
          ...(employeeWhere as any),
          id: { notIn: punched.map((r) => r.employeeId) },
        },
        select: { fullName: true, branchId: true },
        take: 200,
      });

      // Only somebody whose branch is actually open today is "not checked in".
      const openBranches = new Map<string, boolean>();
      for (const e of missing) {
        const bKey = e.branchId ?? '';
        if (!openBranches.has(bKey)) {
          const dates = await this.holidaysService.getWorkingDatesBetween(
            today,
            today,
            e.branchId ?? undefined,
          );
          openBranches.set(bKey, dates.length > 0);
        }
        if (openBranches.get(bKey)) notCheckedIn.push(e.fullName);
      }
    }

    const overHoursCount = Number(overHoursRows[0]?.n ?? 0);

    return {
      notCheckedIn: {
        count: notCheckedIn.length,
        names: notCheckedIn.slice(0, NAME_CAP),
      },
      notCheckedOut: { count: notCheckedOutCount, names: notCheckedOutNames },
      overScheduledHours: {
        count: overHoursCount,
        names: overHoursNames.map((r) => r.name),
      },
      pendingCorrections,
      // The count is the calendar's answer (which can exceed the rows written);
      // the names are only those actually marked absent, so the list can be
      // shorter than the number without either being wrong.
      absent: { count: totals.absent, names: absentNames },
      late: { count: totals.late, names: lateNames },
    };
  }
}
