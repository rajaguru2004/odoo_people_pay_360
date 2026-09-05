import { BadRequestException, Injectable } from '@nestjs/common';
import { ShiftType } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import {
  parseDayKey,
  rate,
  toDayKey,
} from '../attendances/attendance-calendar.util';
import {
  SchedulesService,
  dayKeysBetween,
  type ConflictSample,
  type ScheduleActor,
} from './schedules.service';
import {
  MAX_FORWARD_DAYS,
  bucketOf,
  isSchedulePeriod,
  labelForDayKey,
  resolveScheduleRange,
  trendKindFor,
} from './schedule-range.util';
import { SCHEDULE_PERIODS, type SchedulePeriod } from './dto/hub-summary.dto';
import {
  SHIFT_ORDER,
  addToHourlyTally,
  coverageRate,
  hourLabel,
} from './shift-window.util';

/**
 * The Schedules module hub — is the roster actually covered?
 *
 * Same shape as `attendance-hub.service.ts`: a period + anchor window, the
 * window before it for every delta on the page, trend buckets, a ranking and an
 * action queue. Only the meaning of each slot differs, and the periods
 * themselves differ — see `schedule-range.util.ts` for why a roster is read
 * ahead of today where attendance never is.
 *
 * Every rate divides by the ACTIVE headcount in the caller's scope and goes
 * through `rate()`, which returns `null` rather than 0% when there is nothing to
 * divide by. Nought per cent is the claim that nobody was scheduled; "unknown"
 * is the truth.
 */

/** How many names an action item carries before it becomes a list, not a task. */
const NAME_CAP = 12;

export interface SchedulePeriodStats {
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
  onHoliday: { count: 0, samples: [] as ConflictSample[] },
  onWeeklyOff: { count: 0, samples: [] as ConflictSample[] },
  overlaps: { count: 0, samples: [] as ConflictSample[] },
  thinnestDay: null as {
    date: string;
    label: string;
    scheduled: number;
  } | null,
});

@Injectable()
export class SchedulesHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedules: SchedulesService,
  ) {}

  async getSummary(
    period: SchedulePeriod = 'week',
    anchorParam?: string,
    actor?: ScheduleActor,
  ) {
    if (!isSchedulePeriod(period)) {
      throw new BadRequestException(
        `period must be one of ${SCHEDULE_PERIODS.join(', ')}`,
      );
    }

    const todayKey = DateTime.utc().toFormat('yyyy-MM-dd');
    // A malformed anchor is refused rather than quietly becoming today: the
    // stepper would then appear to work while showing a different window than
    // the URL claims, which is the kind of bug nobody reports.
    const anchor = parseDayKey(anchorParam ?? todayKey);
    if (!anchor) {
      throw new BadRequestException('anchor must be a YYYY-MM-DD date');
    }

    const range = resolveScheduleRange(period, anchor);
    const previousRange = resolveScheduleRange(
      period,
      parseDayKey(range.prevAnchor) as DateTime,
    );

    const [current, previous] = await Promise.all([
      this.window(period, range.start, range.end, todayKey, actor, true),
      this.window(
        period,
        previousRange.start,
        previousRange.end,
        todayKey,
        actor,
        false,
      ),
    ]);

    const forwardLimit = DateTime.fromFormat(todayKey, 'yyyy-MM-dd', {
      zone: 'utc',
    }).plus({ days: MAX_FORWARD_DAYS });

    return {
      period,
      anchor: toDayKey(anchor),
      range: {
        start: range.start,
        end: range.end,
        // The roster is a PLAN, so unlike attendance it is legitimately read
        // ahead of today: "is next week covered" is the question this module
        // exists for. `through` therefore spans the whole window.
        through: range.end,
        label: range.label,
        prevAnchor: range.prevAnchor,
        nextAnchor: range.nextAnchor,
        hasNext:
          (parseDayKey(range.nextAnchor) as DateTime).toMillis() <=
          forwardLimit.toMillis(),
        isCurrent: range.start <= todayKey && todayKey <= range.end,
      },
      periodStats: current.stats,
      previousStats: previous.stats,
      previousRange: {
        start: previousRange.start,
        end: previousRange.end,
        label: previousRange.label,
      },
      trendKind: trendKindFor(period),
      trend: current.trend,
      shiftMix: current.shiftMix,
      status: current.status,
      staffCoverage: current.staffCoverage,
      departments: current.departments,
      attention: current.attention,
      holidays: current.holidays,
    };
  }

  /**
   * One window: totals, and optionally the panels that draw it.
   *
   * Called twice per request — once for the visible window, once for the one
   * before it, which is what every "vs last week" on the page compares against.
   * The second call skips the panels; nothing draws them.
   */
  private async window(
    period: SchedulePeriod,
    startKey: string,
    endKey: string,
    todayKey: string,
    actor: ScheduleActor | undefined,
    wantPanels: boolean,
  ) {
    const sweep = await this.schedules.sweep(startKey, endKey, actor);

    const stats: SchedulePeriodStats = {
      activeHeadcount: sweep.activeHeadcount,
      scheduledEmployees: sweep.scheduledEmployees.size,
      unscheduled: Math.max(
        0,
        sweep.activeHeadcount - sweep.scheduledEmployees.size,
      ),
      shiftRows: sweep.rows.length,
      workingDays: sweep.workingDayKeys.length,
      scheduledToday: sweep.perDay.get(todayKey)?.size ?? 0,
      coverageRate: rate(sweep.scheduledEmployees.size, sweep.activeHeadcount),
      coverageGaps: sweep.coverageGaps,
      conflicts: {
        onHoliday: sweep.onHoliday.length,
        onWeeklyOff: sweep.onWeeklyOff.length,
        overlaps: sweep.overlaps.length,
        total:
          sweep.onHoliday.length +
          sweep.onWeeklyOff.length +
          sweep.overlaps.length,
      },
    };

    const holidays = [...sweep.holidayIndex.entries()]
      .flatMap(([date, rows]) => rows.map((h) => ({ date, name: h.name })))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (!wantPanels) {
      return {
        stats,
        trend: [],
        shiftMix: [],
        status: emptyStatus(),
        staffCoverage: emptyCoverage(sweep.activeHeadcount),
        departments: [],
        attention: emptyAttention(),
        holidays,
      };
    }

    // ── the main chart: scheduled against expected, per bucket ───────────────
    const buckets = new Map<
      string,
      { key: string; label: string; expected: number; scheduled: number }
    >();
    for (const dayKey of sweep.dayKeys) {
      const date = parseDayKey(dayKey) as DateTime;
      const bucket = bucketOf(period, date);
      const entry = buckets.get(bucket.key) ?? {
        key: bucket.key,
        label: bucket.label,
        expected: 0,
        scheduled: 0,
      };
      // A holiday or a weekly off expects NOBODY. Without this a closed Friday
      // draws a full-height "unassigned" bar and the week reads as a disaster.
      entry.expected += sweep.calendar.expectedOn(dayKey);
      entry.scheduled += sweep.perDay.get(dayKey)?.size ?? 0;
      buckets.set(bucket.key, entry);
    }

    const trend = [...buckets.values()].map((b) => ({
      key: b.key,
      label: b.label,
      expected: b.expected,
      scheduled: b.scheduled,
      // Never negative: people rostered on a closed day are a CONFLICT, counted
      // above, not negative unassignment.
      unassigned: Math.max(0, b.expected - b.scheduled),
      coverageRate: coverageRate(b.scheduled, b.expected),
    }));

    // ── where the workforce is concentrated ──────────────────────────────────
    const byShift = new Map<
      ShiftType,
      { count: number; employees: Set<string> }
    >();
    for (const row of sweep.rows) {
      const entry = byShift.get(row.shiftType) ?? {
        count: 0,
        employees: new Set<string>(),
      };
      entry.count += 1;
      entry.employees.add(row.employeeId);
      byShift.set(row.shiftType, entry);
    }
    const shiftMix = SHIFT_ORDER.filter((type) => byShift.has(type)).map(
      (type) => {
        const entry = byShift.get(type)!;
        return {
          type,
          count: entry.count,
          employees: entry.employees.size,
          share: rate(entry.employees.size, sweep.scheduledEmployees.size),
        };
      },
    );

    // ── what the roster's people actually are ────────────────────────────────
    // Conflicting employees are counted once each and `assigned` is what is
    // left, so the five slices sum to something the caption can name.
    const conflictedEmployees = new Set<string>([
      ...sweep.onHoliday.map((c) => c.employeeId),
      ...sweep.onWeeklyOff.map((c) => c.employeeId),
      ...sweep.overlaps.map((c) => c.employeeId),
    ]);
    const status = {
      assigned: Math.max(
        0,
        sweep.scheduledEmployees.size - conflictedEmployees.size,
      ),
      unassigned: stats.unscheduled,
      onHoliday: new Set(sweep.onHoliday.map((c) => c.employeeId)).size,
      onWeeklyOff: new Set(sweep.onWeeklyOff.map((c) => c.employeeId)).size,
      overlaps: new Set(sweep.overlaps.map((c) => c.employeeId)).size,
    };

    // ── the departments panel and the action queue ───────────────────────────
    const [departments, unscheduledNames] = await Promise.all([
      this.departments(sweep, actor),
      this.schedules.unscheduledNames(sweep.scheduledEmployees, actor),
    ]);

    const attention = {
      unassigned: { count: stats.unscheduled, names: unscheduledNames },
      onHoliday: {
        count: sweep.onHoliday.length,
        samples: sweep.onHoliday.slice(0, NAME_CAP),
      },
      onWeeklyOff: {
        count: sweep.onWeeklyOff.length,
        samples: sweep.onWeeklyOff.slice(0, NAME_CAP),
      },
      overlaps: {
        count: sweep.overlaps.length,
        samples: sweep.overlaps.slice(0, NAME_CAP),
      },
      thinnestDay: sweep.thinnestDay
        ? {
            date: sweep.thinnestDay.date,
            label: labelForDayKey(sweep.thinnestDay.date),
            scheduled: sweep.thinnestDay.scheduled,
          }
        : null,
    };

    return {
      stats,
      trend,
      shiftMix,
      status,
      staffCoverage: this.staffCoverage(
        sweep.rows,
        sweep.activeHeadcount,
        sweep.dayKeys.length,
      ),
      departments,
      attention,
      holidays,
    };
  }

  /**
   * How many people are on shift in each hour of the day.
   *
   * The brief asked for "required vs scheduled". Nothing stores a requirement,
   * so this draws what IS scheduled against a flat active-headcount baseline —
   * the shape of the day, and how much of the workforce it uses.
   *
   * Averaged over the window's days, so a month does not read as thirty times
   * the staffing of a day. A single-day window divides by one and is exact.
   *
   * FLEXIBLE rows have no window to place on an hour axis. They are excluded and
   * COUNTED, so the panel can say "12 flexible not shown" rather than quietly
   * under-drawing the morning.
   */
  private staffCoverage(
    rows: Array<{
      shiftType: ShiftType;
      startTime: string | null;
      endTime: string | null;
    }>,
    activeBaseline: number,
    dayCount: number,
  ) {
    const perHour = new Array<number>(24).fill(0);
    let flexibleExcluded = 0;

    for (const row of rows) {
      if (!addToHourlyTally(row, perHour)) flexibleExcluded += 1;
    }

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

  /**
   * Which departments are thin.
   *
   * Names come from the DEPARTMENT table, not from the roster. Learning them
   * from the schedule rows only works for departments that actually have a shift
   * in the window — and the ones that do NOT are exactly the rows this panel
   * exists to show.
   *
   * A department with nobody rostered is genuinely 0% covered, and that is
   * deliberately NOT the attendance hub's rule. There, a department that filed
   * nothing is unknown — the punches simply did not arrive. Here the absence of
   * a roster row IS the fact, and it is the most actionable number the panel
   * carries. What remains unknowable is a department with nobody active in it:
   * there is nothing to divide by, so its rate is null.
   */
  private async departments(
    sweep: Awaited<ReturnType<SchedulesService['sweep']>>,
    actor?: ScheduleActor,
  ) {
    const [headcounts, names] = await Promise.all([
      this.prisma.employee.groupBy({
        by: ['departmentId'],
        where: await this.schedules.employeeScope(actor),
        _count: { _all: true },
      }),
      this.prisma.department.findMany({ select: { id: true, name: true } }),
    ]);

    const nameOf = new Map(names.map((d) => [d.id, d.name]));
    const scheduledByDept = new Map<string, Set<string>>();
    for (const row of sweep.rows) {
      const deptId = row.employee.departmentId;
      if (!deptId) continue;
      if (!scheduledByDept.has(deptId)) scheduledByDept.set(deptId, new Set());
      scheduledByDept.get(deptId)!.add(row.employeeId);
    }

    return (
      headcounts
        .filter((d) => d.departmentId)
        .map((d) => {
          const headcount = d._count._all;
          const scheduled = scheduledByDept.get(d.departmentId!)?.size ?? 0;
          return {
            id: d.departmentId!,
            name: nameOf.get(d.departmentId!) ?? 'Unknown',
            headcount,
            scheduled,
            unscheduled: Math.max(0, headcount - scheduled),
            rate: coverageRate(scheduled, headcount),
            hasData: headcount > 0,
          };
        })
        // Worst coverage first. A department with nobody in it sorts last — it is
        // not a coverage problem, it is an empty row.
        .sort((a, b) => {
          if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
          return (a.rate ?? 101) - (b.rate ?? 101) || b.headcount - a.headcount;
        })
    );
  }
}

/** Re-exported so a spec can walk a window without reaching into the service. */
export { dayKeysBetween };
