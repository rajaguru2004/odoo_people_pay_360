/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HolidaysService } from '../holidays/holidays.service';
import { getBranchContext } from '../common/branch/branch-context';
import { managerDeptScope } from '../common/services/manager-scope.util';
import { rowsConflict } from './calendar.service';
import {
  addDays,
  assertPeriod,
  bucketOf,
  eachDay,
  key,
  MONTHS,
  parseDateKey,
  rate,
  resolveRange,
  trendKindFor,
  type HubPeriod,
} from '../common/hub/hub-range.util';

/**
 * The Schedules module hub — is the roster actually covered?
 *
 * Same shape as `attendance-hub.service.ts`: a period + anchor window, the
 * window before it for every delta on the page, trend buckets, a ranking, and
 * an action queue. Only the meaning of each slot differs.
 *
 * ## What this module can and cannot answer
 *
 * `WorkSchedule` is one row per employee per date with a **required**
 * `employeeId`. There is no capacity column, no shift template, no roster
 * pattern and no shift→branch or shift→department link — so an "open shift"
 * (a shift with nobody on it) and an "over-capacity shift" are **not
 * representable**, and neither is an hourly staffing requirement. The client
 * asked for all three; what ships instead is the nearest thing the data
 * actually supports, and the names say so rather than implying a demand model
 * that does not exist:
 *
 *   Open shifts        → COVERAGE GAPS: working days whose scheduled headcount
 *                        is below the window's own median.
 *   Over capacity      → the conflicts the roster IS happy to contain:
 *                        rostered on a holiday, on a weekly off, or overlapping.
 *   Required vs actual → ON SHIFT BY HOUR, against a flat active-headcount
 *                        baseline. It says how the day is staffed, not whether
 *                        that is enough — nothing stores "enough".
 *
 * Every rate divides by the ACTIVE, non-admin headcount and goes through
 * `rate()`, which returns `null` rather than 0% when there is nothing to divide
 * by. 0% is a claim that nobody was scheduled; "unknown" is the truth.
 */

/** The caller, as the controller knows them. */
export interface HubUser {
  role?: string;
  departmentId?: string;
  managedDepartmentIds?: string[];
}

/** How many names an action item carries before it becomes a list, not a task. */
const NAME_CAP = 12;

/** The six values `ShiftType` can take, in the order a scheduler reads them. */
const SHIFT_ORDER = ['MORNING', 'AFTERNOON', 'FULL_DAY', 'NIGHT', 'CUSTOM', 'FLEXIBLE'];

export interface SchedulesPeriodStats {
  activeHeadcount: number;
  scheduledEmployees: number;
  unscheduled: number;
  shiftRows: number;
  workingDays: number;
  scheduledToday: number;
  coverageRate: number | null;
  coverageGaps: number;
  conflicts: {
    onHoliday: number;
    onWeeklyOff: number;
    overlaps: number;
    total: number;
  };
}

@Injectable()
export class SchedulesHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly holidays: HolidaysService,
  ) {}

  /** ACTIVE, non-admin, and inside the caller's department scope if a manager. */
  private employeeWhere(user?: HubUser): Prisma.EmployeeWhereInput {
    const where: any = { status: 'ACTIVE', NOT: { user: { role: 'ADMIN' } } };
    if (user?.role === 'MANAGER' && user?.departmentId) {
      where.departmentId = { in: managerDeptScope(user as any) };
    }
    return where;
  }

  /**
   * Working days per branch, and the branch headcount behind them.
   *
   * Branch is the unit because the working week is a branch property — one
   * shared calendar would report every Friday in Muscat as a coverage hole.
   * Mirrors `attendance-hub.service.ts`'s `calendar()`; the shapes are
   * deliberately the same so the two hubs' numbers can be compared.
   */
  private async calendar(from: Date, to: Date, user?: HubUser) {
    const byBranch = await this.prisma.employee.groupBy({
      by: ['branchId'],
      where: this.employeeWhere(user),
      _count: { _all: true },
    });

    const headcount = new Map<string, number>();
    const workingDays = new Map<string, Set<string>>();
    for (const row of byBranch) {
      const branchKey = row.branchId ?? '';
      headcount.set(branchKey, row._count._all);
      if (to.getTime() < from.getTime()) {
        workingDays.set(branchKey, new Set());
        continue;
      }
      const dates = await this.holidays.getWorkingDatesBetween(
        from,
        to,
        row.branchId ?? undefined,
      );
      workingDays.set(branchKey, new Set(dates.map(key)));
    }

    /** How many people the calendar says should be at work on one date. */
    const expectedOn = (dateKey: string): number => {
      let total = 0;
      for (const [branchKey, count] of headcount) {
        if (workingDays.get(branchKey)?.has(dateKey)) total += count;
      }
      return total;
    };

    /** True when at least one branch was open — the day counts as a working day. */
    const anyBranchOpen = (dateKey: string): boolean => {
      for (const days of workingDays.values()) if (days.has(dateKey)) return true;
      return false;
    };

    const total = [...headcount.values()].reduce((a, b) => a + b, 0);
    return { headcount, workingDays, expectedOn, anyBranchOpen, activeHeadcount: total };
  }

  /**
   * Every schedule row in the window, with the fields four panels need.
   *
   * One query rather than four: the shift mix, the hourly curve, the department
   * ranking and the overlap sweep all read the same rows, and four passes over
   * the same table is four chances for them to disagree about the window.
   */
  private async rows(from: Date, to: Date, user?: HubUser) {
    return this.prisma.workSchedule.findMany({
      where: {
        date: { gte: from, lte: to },
        isWorkDay: true,
        employee: this.employeeWhere(user),
      },
      select: {
        employeeId: true,
        date: true,
        shiftType: true,
        startTime: true,
        endTime: true,
        employee: {
          select: {
            fullName: true,
            branchId: true,
            departmentId: true,
            department: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    });
  }

  async getHubSummary(
    period: HubPeriod = 'week',
    anchorParam?: string,
    user?: HubUser,
  ) {
    assertPeriod(period);

    const today = parseDateKey(key(new Date()));
    const anchor = anchorParam ? parseDateKey(anchorParam) : today;
    const { start, end, prevAnchor, nextAnchor, label } = resolveRange(period, anchor);
    const prevRange = resolveRange(period, prevAnchor);

    const [current, previous] = await Promise.all([
      this.aggregate(period, start, end, user),
      this.aggregate(period, prevRange.start, prevRange.end, user, false),
    ]);

    return {
      success: true,
      data: {
        period,
        anchor: key(anchor),
        range: {
          start: key(start),
          end: key(end),
          // The roster is a PLAN, so unlike attendance it is legitimately read
          // ahead of today: "is next week covered" is the question this module
          // exists for. `through` therefore spans the whole window.
          through: key(end),
          label,
          prevAnchor: key(prevAnchor),
          nextAnchor: key(nextAnchor),
          // Forward paging stops one window past today — a roster three years
          // out is empty by definition, and paging into it reads as broken.
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
        shiftMix: current.shiftMix,
        status: current.status,
        staffCoverage: current.staffCoverage,
        departments: current.departments,
        attention: current.attention,
        holidays: current.holidays,
        weeklyOffDays: current.weeklyOffDays,
      },
    };
  }

  /**
   * Everything a window adds up to, and optionally the panels that draw it.
   *
   * Called twice per request — once for the visible window, once for the one
   * before it, which is what every "vs last week" on the page compares against.
   * The second call skips the panels; nothing draws them.
   */
  private async aggregate(
    period: HubPeriod,
    start: Date,
    end: Date,
    user?: HubUser,
    wantPanels = true,
  ) {
    const cal = await this.calendar(start, end, user);
    const rows = await this.rows(start, end, user);

    const ctx = getBranchContext();
    const branchId = ctx?.effectiveBranchId ?? undefined;
    const [holidayRows, weeklyOffDays] = await Promise.all([
      this.holidays.getHolidaysInRange(start, end, branchId),
      this.holidays.getWeeklyOffDays(branchId),
    ]);
    const holidays = holidayRows.map((h: any) => ({
      date: key(new Date(h.date)),
      name: h.name as string,
    }));
    const holidayByDate = new Map<string, string>(holidays.map((h) => [h.date, h.name]));
    const offDays = new Set<number>(weeklyOffDays);

    const days = eachDay(start, end);
    const todayKey = key(parseDateKey(key(new Date())));

    // ── per-day and per-employee tallies ────────────────────────────────────
    const scheduledEmployees = new Set<string>();
    const perDay = new Map<string, Set<string>>();
    const onHoliday: Array<{ employeeId: string; fullName: string | null; date: string; holiday: string }> = [];
    const onWeeklyOff: Array<{ employeeId: string; fullName: string | null; date: string }> = [];
    const overlaps: Array<{ employeeId: string; fullName: string | null; date: string }> = [];
    const byShift = new Map<string, { count: number; employees: Set<string> }>();
    const byDept = new Map<string, { id: string; name: string; scheduled: Set<string> }>();
    /** employeeId+date → the rows on it, for the overlap sweep. */
    const perEmployeeDay = new Map<string, typeof rows>();

    for (const row of rows) {
      const day = key(new Date(row.date));
      scheduledEmployees.add(row.employeeId);
      if (!perDay.has(day)) perDay.set(day, new Set());
      perDay.get(day)!.add(row.employeeId);

      const holiday = holidayByDate.get(day);
      if (holiday) {
        onHoliday.push({
          employeeId: row.employeeId,
          fullName: row.employee?.fullName ?? null,
          date: day,
          holiday,
        });
      }
      // getUTCDay() is Sunday-first, matching how weekly offs are stored.
      if (offDays.has(new Date(row.date).getUTCDay())) {
        onWeeklyOff.push({
          employeeId: row.employeeId,
          fullName: row.employee?.fullName ?? null,
          date: day,
        });
      }

      const shift = byShift.get(row.shiftType) ?? { count: 0, employees: new Set<string>() };
      shift.count += 1;
      shift.employees.add(row.employeeId);
      byShift.set(row.shiftType, shift);

      const dept = row.employee?.department;
      if (dept) {
        const d = byDept.get(dept.id) ?? { id: dept.id, name: dept.name, scheduled: new Set<string>() };
        d.scheduled.add(row.employeeId);
        byDept.set(dept.id, d);
      }

      const edKey = `${row.employeeId}|${day}`;
      if (!perEmployeeDay.has(edKey)) perEmployeeDay.set(edKey, [] as typeof rows);
      perEmployeeDay.get(edKey)!.push(row);
    }

    // ── overlap sweep, with the ONE half-open rule from calendar.service ────
    // Per employee-day rather than per employee-window: two shifts on different
    // dates cannot overlap, and comparing them would be O(n²) over the month.
    for (const [edKey, bucket] of perEmployeeDay) {
      if (bucket.length < 2) continue;
      let collided = false;
      for (let i = 0; i < bucket.length && !collided; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          if (rowsConflict(bucket[i], bucket[j])) {
            collided = true;
            break;
          }
        }
      }
      if (collided) {
        const [employeeId, date] = edKey.split('|');
        overlaps.push({
          employeeId,
          fullName: bucket[0].employee?.fullName ?? null,
          date,
        });
      }
    }

    // ── the numbers the KPI row reads ───────────────────────────────────────
    const workingDayKeys = days.map(key).filter((k) => cal.anyBranchOpen(k));
    const scheduledCounts = workingDayKeys.map((k) => perDay.get(k)?.size ?? 0);

    // Coverage gaps: working days whose headcount sits below the window's OWN
    // median. Not an absolute threshold — a six-person branch and a
    // six-hundred-person one have different normals, and a fixed number would
    // shout at one and stay silent for the other. Under three working days
    // there is no meaningful middle, so it reports nothing rather than noise.
    const coverageGaps =
      scheduledCounts.length >= 3
        ? scheduledCounts.filter((n) => n < median(scheduledCounts)).length
        : 0;

    const activeHeadcount = cal.activeHeadcount;
    const stats: SchedulesPeriodStats = {
      activeHeadcount,
      scheduledEmployees: scheduledEmployees.size,
      unscheduled: Math.max(0, activeHeadcount - scheduledEmployees.size),
      shiftRows: rows.length,
      workingDays: workingDayKeys.length,
      scheduledToday: perDay.get(todayKey)?.size ?? 0,
      coverageRate: rate(scheduledEmployees.size, activeHeadcount),
      coverageGaps,
      conflicts: {
        onHoliday: onHoliday.length,
        onWeeklyOff: onWeeklyOff.length,
        overlaps: overlaps.length,
        total: onHoliday.length + onWeeklyOff.length + overlaps.length,
      },
    };

    if (!wantPanels) {
      return {
        stats,
        trend: [],
        shiftMix: [],
        status: emptyStatus(),
        staffCoverage: emptyCoverage(activeHeadcount),
        departments: [],
        attention: emptyAttention(),
        holidays,
        weeklyOffDays,
      };
    }

    // ── the main chart: scheduled against expected, per bucket ──────────────
    const buckets = new Map<string, { key: string; label: string; expected: number; scheduled: number }>();
    for (const day of days) {
      const k = key(day);
      const b = bucketOf(period, day);
      const entry = buckets.get(b.key) ?? { key: b.key, label: b.label, expected: 0, scheduled: 0 };
      // A holiday or a weekly off expects NOBODY. Without this a closed Friday
      // draws a full-height "unassigned" bar and the week reads as a disaster.
      entry.expected += cal.expectedOn(k);
      entry.scheduled += perDay.get(k)?.size ?? 0;
      buckets.set(b.key, entry);
    }
    const trend = [...buckets.values()].map((b) => ({
      key: b.key,
      label: b.label,
      expected: b.expected,
      scheduled: b.scheduled,
      // Never negative: people rostered on a closed day are a CONFLICT, counted
      // above, not negative unassignment.
      unassigned: Math.max(0, b.expected - b.scheduled),
      coverageRate: coverageOf(b.scheduled, b.expected),
    }));

    // ── right-side: where the workforce is concentrated ─────────────────────
    const shiftMix = SHIFT_ORDER.filter((type) => byShift.has(type)).map((type) => {
      const s = byShift.get(type)!;
      return {
        type,
        count: s.count,
        employees: s.employees.size,
        share: rate(s.employees.size, scheduledEmployees.size),
      };
    });

    // ── bottom-left donut: what the roster's rows actually are ──────────────
    // Conflicting employee-days are counted once each; `assigned` is what is
    // left, so the five slices sum to something the caption can name.
    const conflictedEmployees = new Set<string>([
      ...onHoliday.map((c) => c.employeeId),
      ...onWeeklyOff.map((c) => c.employeeId),
      ...overlaps.map((c) => c.employeeId),
    ]);
    const status = {
      assigned: Math.max(0, scheduledEmployees.size - conflictedEmployees.size),
      unassigned: stats.unscheduled,
      onHoliday: new Set(onHoliday.map((c) => c.employeeId)).size,
      onWeeklyOff: new Set(onWeeklyOff.map((c) => c.employeeId)).size,
      overlaps: new Set(overlaps.map((c) => c.employeeId)).size,
    };

    // ── bottom-middle: how the day is staffed, hour by hour ─────────────────
    const staffCoverage = this.staffCoverage(rows, activeHeadcount, days.length);

    // ── right-side ranking: which departments are thin ──────────────────────
    const [deptHeadcount, deptNames] = await Promise.all([
      this.prisma.employee.groupBy({
        by: ['departmentId'],
        where: this.employeeWhere(user),
        _count: { _all: true },
      }),
      // Names come from the DEPARTMENT table, not from the roster.
      //
      // Learning them from `byDept` only works for departments that actually
      // have a shift in the window — and the ones that do NOT are exactly the
      // rows this panel exists to show. The first screenshot caught it: a
      // department with two people and no roster rendered as a bar labelled
      // "—" at 0%, which reads as broken data rather than as the department
      // most in need of rostering.
      this.prisma.department.findMany({ select: { id: true, name: true } }),
    ]);
    const nameOf = new Map(deptNames.map((d) => [d.id, d.name]));
    const departments = deptHeadcount
      .filter((d) => d.departmentId)
      .map((d) => {
        const hit = byDept.get(d.departmentId!);
        const scheduled = hit?.scheduled.size ?? 0;
        const headcount = d._count._all;
        return {
          id: d.departmentId!,
          name: nameOf.get(d.departmentId!) ?? hit?.name ?? '—',
          headcount,
          scheduled,
          unscheduled: Math.max(0, headcount - scheduled),
          rate: coverageOf(scheduled, headcount),
          // Deliberately NOT the attendance hub's rule.
          //
          // There, a department that filed nothing is UNKNOWN — the punches
          // simply did not arrive, and 0% would be a fabricated failure. Here
          // the absence of a roster row IS the fact: nobody was scheduled, that
          // is genuinely 0% covered, and it is the most actionable number this
          // panel carries. Printing an em dash over it would hide exactly the
          // department somebody needs to go and roster.
          //
          // What is unknowable is a department with no ACTIVE people in it:
          // there is nothing to divide by, so `rate` is null and this is false.
          hasData: headcount > 0,
        };
      })
      // Worst coverage first. A department with nobody in it sorts last — it is
      // not a coverage problem, it is an empty row.
      .sort((a, b) => {
        if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
        return (a.rate ?? 101) - (b.rate ?? 101) || b.headcount - a.headcount;
      });

    // ── the action queue ────────────────────────────────────────────────────
    const unscheduledNames = await this.unscheduledNames(scheduledEmployees, user);
    const workingWithCounts = workingDayKeys.map((k) => ({
      date: k,
      scheduled: perDay.get(k)?.size ?? 0,
    }));
    const thinnest = workingWithCounts.length
      ? workingWithCounts.reduce((min, d) => (d.scheduled < min.scheduled ? d : min))
      : null;

    const attention = {
      unassigned: { count: stats.unscheduled, names: unscheduledNames },
      onHoliday: { count: onHoliday.length, samples: onHoliday.slice(0, NAME_CAP) },
      onWeeklyOff: { count: onWeeklyOff.length, samples: onWeeklyOff.slice(0, NAME_CAP) },
      overlaps: { count: overlaps.length, samples: overlaps.slice(0, NAME_CAP) },
      thinnestDay: thinnest
        ? {
            date: thinnest.date,
            label: labelForDate(thinnest.date),
            scheduled: thinnest.scheduled,
          }
        : null,
    };

    return {
      stats,
      trend,
      shiftMix,
      status,
      staffCoverage,
      departments,
      attention,
      holidays,
      weeklyOffDays,
    };
  }

  /**
   * How many people are on shift in each hour of the day.
   *
   * The client asked for "required vs scheduled". Nothing stores a requirement,
   * so this draws what IS scheduled against a flat active-headcount baseline —
   * the shape of the day, and how much of the workforce it uses.
   *
   * A NIGHT shift running 22:00→06:00 covers hours on both sides of midnight
   * and is counted in both, because a scheduler looking at "who is on at 2 AM"
   * means it literally.
   *
   * FLEXIBLE rows have no window at all (`requiredHours` across any sessions),
   * so they cannot be placed on an hour axis. They are excluded and COUNTED, so
   * the panel can say "12 flexible not shown" rather than quietly under-drawing
   * the morning.
   */
  private staffCoverage(rows: ScheduleRowLike[], activeBaseline: number, dayCount: number) {
    const perHour = new Array<number>(24).fill(0);
    let flexibleExcluded = 0;

    for (const row of rows) {
      if (row.shiftType === 'FLEXIBLE' || !row.startTime || !row.endTime) {
        flexibleExcluded += 1;
        continue;
      }
      const startHour = row.startTime.getUTCHours();
      const endRaw = row.endTime.getUTCHours() + (row.endTime.getUTCMinutes() > 0 ? 1 : 0);
      // An end at or before the start means the shift crossed midnight.
      const span = endRaw > startHour ? endRaw - startHour : 24 - startHour + endRaw;
      for (let i = 0; i < Math.min(span, 24); i++) {
        perHour[(startHour + i) % 24] += 1;
      }
    }

    // Averaged over the window's days, so a month does not read as thirty times
    // the staffing of a day. A single-day window divides by one and is exact.
    const divisor = Math.max(1, dayCount);
    return {
      activeBaseline,
      flexibleExcluded,
      hours: perHour.map((count, hour) => ({
        hour,
        label: hourLabel(hour),
        onShift: Math.round((count / divisor) * 10) / 10,
      })),
    };
  }

  /** Who has no shift at all — the people who will not know to turn up. */
  private async unscheduledNames(
    scheduled: Set<string>,
    user?: HubUser,
  ): Promise<string[]> {
    const rows = await this.prisma.employee.findMany({
      where: {
        ...this.employeeWhere(user),
        ...(scheduled.size ? { id: { notIn: [...scheduled] } } : {}),
      },
      select: { fullName: true },
      orderBy: { fullName: 'asc' },
      take: NAME_CAP,
    });
    return rows.map((r) => r.fullName).filter(Boolean) as string[];
  }
}

/**
 * Scheduled against expected, reconciled so the rate can never exceed 100%.
 *
 * Two facts collide here. The calendar is per BRANCH — branch A rests Saturday,
 * branch B rests Thursday — so `expected` for a given day counts only the
 * branches that were open. But the roster is company-wide, and somebody from a
 * closed branch can legitimately be rostered on that day. Divide one by the
 * other and a Saturday with three people on it against two expected reports
 * **150% covered**, which the e2e suite caught on real data.
 *
 * The same shape as `reconcileExpected` in `attendance-hub.service.ts:81-89`,
 * which exists because the attendance rate once read 106% for exactly this
 * reason. Taking `max(expected, scheduled)` can only ever RAISE the
 * denominator, so it never hides an unassigned person — it only stops a rate
 * claiming more than everybody.
 *
 * A day the calendar expects NOBODY has no coverage rate at all: 100% would say
 * the day was fully staffed and 0% that it was abandoned, and neither is a
 * claim about a day the branch was shut. `expected` stays 0 so the bar draws no
 * unassigned block, and the rate reports unknown.
 */
function coverageOf(scheduled: number, expected: number): number | null {
  if (expected <= 0) return null;
  return rate(scheduled, Math.max(expected, scheduled));
}

/** The middle value — the window's own normal, whatever its size. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function hourLabel(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

function labelForDate(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The rows `staffCoverage` reads, named so the method is testable in isolation. */
interface ScheduleRowLike {
  shiftType: string;
  startTime: Date | null;
  endTime: Date | null;
}

const emptyStatus = () => ({
  assigned: 0,
  unassigned: 0,
  onHoliday: 0,
  onWeeklyOff: 0,
  overlaps: 0,
});

const emptyCoverage = (activeBaseline: number) => ({
  activeBaseline,
  flexibleExcluded: 0,
  hours: Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: hourLabel(hour),
    onShift: 0,
  })),
});

const emptyAttention = () => ({
  unassigned: { count: 0, names: [] as string[] },
  onHoliday: { count: 0, samples: [] as any[] },
  onWeeklyOff: { count: 0, samples: [] as any[] },
  overlaps: { count: 0, samples: [] as any[] },
  thinnestDay: null as { date: string; label: string; scheduled: number } | null,
});
