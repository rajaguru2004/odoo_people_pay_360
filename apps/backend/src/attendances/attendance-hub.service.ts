import { BadRequestException, Injectable } from '@nestjs/common';
import { AttendanceStatus, ShiftType } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import {
  AttendanceCalendarService,
  type ResolvedBranchConfig,
  type ResolvedHoliday,
} from './attendance-calendar.service';
import {
  dayKeyToDate,
  isWeeklyOff,
  parseDayKey,
  rate,
  round2,
  toDayKey,
  UNASSIGNED_DEPARTMENT,
} from './attendance-calendar.util';
import { HUB_PERIODS, type HubPeriod } from './dto/hub-summary.dto';

/**
 * The Time & Attendance hub, in one request.
 *
 * Kept out of AttendancesService because it answers a different question. That
 * service is about rows — find one, punch one, correct one. This is about the
 * shape of a workforce over a window, and the two share nothing but the table.
 *
 * The rule the whole page rests on: EVERY rate divides by `expected` — the
 * working calendar minus approved leave — and never by headcount. Somebody
 * whose branch is closed, or who is on approved leave, was never going to
 * punch, and counting them would invent an absence every weekend. When there is
 * nothing to divide by the rate is `null`, not `0`: nought per cent is the
 * claim that everybody failed to turn up, which is a different statement and a
 * false one.
 */

export interface HubDaySnapshot {
  date: string;
  expected: number;
  present: number;
  onTime: number;
  late: number;
  absent: number;
  onLeave: number;
  notCheckedOut: number;
  notCheckedIn: number;
  avgWorkHours: number | null;
  presentRate: number | null;
  lateRate: number | null;
  absentRate: number | null;
  onTimeRate: number | null;
  /** False until the branch's office end has passed. Before it, "absent" is a
   * prediction rather than a fact. */
  settled: boolean;
}

export interface HubPeriodStats {
  expected: number;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  attendanceRate: number | null;
  lateRate: number | null;
  absentRate: number | null;
  avgWorkHours: number | null;
  lateOccurrences: number;
  daysCounted: number;
  bucketCount: number;
}

export interface HubTrendBucket {
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

export interface HubNamedCount {
  count: number;
  names: string[];
}

export interface HubRange {
  start: string;
  end: string;
  label: string;
  prevAnchor: string;
  nextAnchor: string;
}

/** One day's counts, however they were gathered. */
interface DayCounts {
  present: number;
  late: number;
  absent: number;
  onLeaveRows: number;
  hoursSum: number;
  hoursCount: number;
}

/** Statuses that mean somebody was at work in some measure. */
const WORKED: AttendanceStatus[] = ['PRESENT', 'LATE', 'HALF_DAY'];

/**
 * How many names the attention strip prints.
 *
 * `count` stays the true total. A strip that showed eight names under a count
 * of eight when there are ninety would imply the list is the whole set, and the
 * reader would stop looking.
 */
const NAME_CAP = 8;

const emptyCounts = (): DayCounts => ({
  present: 0,
  late: 0,
  absent: 0,
  onLeaveRows: 0,
  hoursSum: 0,
  hoursCount: 0,
});

const emptyStats = (): HubPeriodStats => ({
  expected: 0,
  present: 0,
  late: 0,
  absent: 0,
  onLeave: 0,
  attendanceRate: null,
  lateRate: null,
  absentRate: null,
  avgWorkHours: null,
  lateOccurrences: 0,
  daysCounted: 0,
  bucketCount: 0,
});

/** The label under a 24-hour bucket: "12 AM", "1 PM". */
export function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${hour % 12 === 0 ? 12 : hour % 12} ${suffix}`;
}

function rangeLabel(start: DateTime, end: DateTime): string {
  if (start.hasSame(end, 'day')) return start.toFormat('ccc, d LLL yyyy');
  if (start.hasSame(end, 'month')) {
    return `${start.toFormat('d')} – ${end.toFormat('d LLL yyyy')}`;
  }
  if (start.hasSame(end, 'year')) {
    return `${start.toFormat('d LLL')} – ${end.toFormat('d LLL yyyy')}`;
  }
  return `${start.toFormat('d LLL yyyy')} – ${end.toFormat('d LLL yyyy')}`;
}

/**
 * The window a period and an anchor describe, plus the anchors either side.
 *
 * The client hands `prevAnchor`/`nextAnchor` straight back on the ‹ › stepper
 * and never does calendar arithmetic of its own — which is also why every
 * bucket label below is built here rather than in the browser.
 */
export function resolveHubRange(period: HubPeriod, anchor: DateTime): HubRange {
  const key = (d: DateTime) => d.toFormat('yyyy-MM-dd');

  switch (period) {
    case 'today':
      return {
        start: key(anchor),
        end: key(anchor),
        label: rangeLabel(anchor, anchor),
        prevAnchor: key(anchor.minus({ days: 1 })),
        nextAnchor: key(anchor.plus({ days: 1 })),
      };
    case 'week': {
      // ISO weeks, Monday-first. The branch working week varies across the
      // region, but the CHART's week has to be one thing or two branches would
      // draw bars for different seven-day windows on the same axis.
      const start = anchor.startOf('week');
      const end = start.plus({ days: 6 });
      return {
        start: key(start),
        end: key(end),
        label: rangeLabel(start, end),
        prevAnchor: key(anchor.minus({ weeks: 1 })),
        nextAnchor: key(anchor.plus({ weeks: 1 })),
      };
    }
    case 'year': {
      const start = anchor.startOf('year');
      const end = anchor.endOf('year').startOf('day');
      return {
        start: key(start),
        end: key(end),
        label: start.toFormat('yyyy'),
        prevAnchor: key(anchor.minus({ years: 1 })),
        nextAnchor: key(anchor.plus({ years: 1 })),
      };
    }
    default: {
      const start = anchor.startOf('month');
      const end = anchor.endOf('month').startOf('day');
      return {
        start: key(start),
        end: key(end),
        label: start.toFormat('LLLL yyyy'),
        prevAnchor: key(anchor.minus({ months: 1 })),
        nextAnchor: key(anchor.plus({ months: 1 })),
      };
    }
  }
}

/**
 * The denominator, reconciled against what actually happened.
 *
 * The calendar is the primary source, but it is a plan and people work outside
 * it — a shift covered on a public holiday, a Saturday call-out, an employee
 * whose branch record says one thing and whose punches say another. Taken alone
 * the plan can report more than a hundred per cent attendance. Whoever the
 * calendar expected, OR whoever actually turned up, whichever is larger: this
 * can only ever RAISE the denominator, so it never hides an absence.
 */
export function reconcileExpected(
  calendarExpected: number,
  onLeave: number,
  present: number,
  recordedAbsent: number,
): number {
  return Math.max(
    Math.max(0, calendarExpected - onLeave),
    present + recordedAbsent,
  );
}

@Injectable()
export class AttendanceHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: AttendanceCalendarService,
  ) {}

  async getSummary(period: HubPeriod = 'month', anchorParam?: string) {
    if (!HUB_PERIODS.includes(period)) {
      throw new BadRequestException(
        `period must be one of ${HUB_PERIODS.join(', ')}`,
      );
    }

    const companyZone = await this.calendar.companyTimezone();
    const todayKey = this.calendar.todayIn(companyZone);

    // A malformed anchor is refused rather than quietly becoming today: the
    // stepper would then appear to work while showing a different window than
    // the URL claims, which is the kind of bug nobody reports.
    const anchor = anchorParam
      ? parseDayKey(anchorParam)
      : parseDayKey(todayKey);
    if (!anchor) {
      throw new BadRequestException('anchor must be a YYYY-MM-DD date');
    }
    const anchorKey = toDayKey(anchor);

    const range = resolveHubRange(period, anchor);
    const prevRange = resolveHubRange(
      period,
      parseDayKey(range.prevAnchor) as DateTime,
    );

    // Nothing after today is ever aggregated — a day that has not happened
    // cannot be an absence, so an in-progress month reports the days it has.
    const through = range.start > todayKey ? null : minKey(range.end, todayKey);
    const prevThrough =
      prevRange.start > todayKey ? null : minKey(prevRange.end, todayKey);

    const [configs, roster, corrections] = await Promise.all([
      this.calendar.branchConfigs(),
      this.roster(),
      this.prisma.attendanceCorrection.count({ where: { status: 'PENDING' } }),
    ]);

    const yesterdayKey = shiftDay(todayKey, -1);
    const holidayFrom = minKey(
      minKey(range.start, prevRange.start),
      yesterdayKey,
    );
    const holidayTo = maxKey(maxKey(range.end, prevRange.end), todayKey);
    const holidays = await this.calendar.holidayIndex(holidayFrom, holidayTo);

    const [current, previous, todaySnap, yesterdaySnap] = await Promise.all([
      this.window(range.start, through, configs, roster, holidays, todayKey),
      this.window(
        prevRange.start,
        prevThrough,
        configs,
        roster,
        holidays,
        todayKey,
      ),
      this.daySnapshot(todayKey, configs, roster, holidays),
      this.daySnapshot(yesterdayKey, configs, roster, holidays),
    ]);

    const trend =
      period === 'today'
        ? this.hourlyTrend(current.arrivalPattern)
        : this.bucketedTrend(current.days, period);

    const stats: HubPeriodStats = {
      ...current.stats,
      bucketCount: trend.length,
    };

    return {
      period,
      anchor: anchorKey,
      range: {
        start: range.start,
        end: range.end,
        through,
        label: range.label,
        prevAnchor: range.prevAnchor,
        nextAnchor: range.nextAnchor,
        // There is a later window to step into only when this one has already
        // finished. Testing `nextAnchor <= today` instead would strand the
        // reader on 2025 — its next anchor is a year ahead of today even though
        // 2026 exists and has begun.
        hasNext: range.end < todayKey,
        isCurrent: range.start <= todayKey && todayKey <= range.end,
      },
      today: todaySnap,
      yesterday: yesterdaySnap,
      periodStats: stats,
      /** The same window one step back, so every delta has a real comparison. */
      previousStats: previous.stats,
      previousRange: {
        start: prevRange.start,
        end: prevRange.end,
        label: prevRange.label,
      },
      /** What one bar of `trend` counts: an hour, a day or a month. */
      trendKind:
        period === 'today' ? 'hour' : period === 'year' ? 'month' : 'day',
      trend,
      departments: current.departments,
      arrivalPattern: current.arrivalPattern,
      shifts: await this.shifts(range.start, through, stats),
      attention: {
        ...current.attention,
        // Deliberately NOT windowed: a queue is what is waiting NOW, and
        // "corrections raised last March" is not something anybody acts on.
        pendingCorrections: corrections,
      },
    };
  }

  // ── Data gathering ─────────────────────────────────────────────────────────

  /** Everyone who could be expected to punch, with the fields the hub reads. */
  private roster() {
    return this.prisma.employee.findMany({
      where: { status: { in: ['ACTIVE', 'ON_LEAVE'] } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        status: true,
        branchId: true,
        departmentId: true,
      },
    });
  }

  /**
   * The calendar's expectation, day by day, for a window.
   *
   * Walked employee by employee rather than resolved with set arithmetic: a
   * WorkSchedule row overrides ONE person's day, and the plain loop is the only
   * version of this that stays readable once overrides are in it. At a
   * headcount times a year of days it is a few hundred thousand map lookups,
   * which costs less than the queries either side of it.
   */
  private async calendarExpectation(
    startKey: string,
    endKey: string,
    configs: Map<string, ResolvedBranchConfig>,
    roster: Awaited<ReturnType<AttendanceHubService['roster']>>,
    holidays: Map<string, ResolvedHoliday[]>,
  ) {
    const overrides = new Map<string, boolean>();
    if (startKey <= endKey) {
      const rows = await this.prisma.workSchedule.findMany({
        where: {
          date: { gte: dayKeyToDate(startKey), lte: dayKeyToDate(endKey) },
        },
        select: { employeeId: true, date: true, isWorkDay: true },
      });
      for (const row of rows) {
        overrides.set(`${row.employeeId}|${toDayKey(row.date)}`, row.isWorkDay);
      }
    }

    const byDay = new Map<string, number>();
    const leaveByDay = new Map<string, number>();
    const byDept = new Map<string, number>();
    const leaveByDept = new Map<string, number>();

    for (const dayKey of dayRange(startKey, endKey)) {
      const date = parseDayKey(dayKey) as DateTime;
      let expected = 0;
      let onLeave = 0;

      for (const employee of roster) {
        const config = this.calendar.configFor(configs, employee.branchId);
        const override = overrides.get(`${employee.id}|${dayKey}`);
        const working =
          override ??
          (!isWeeklyOff(date, config.weeklyOffDays) &&
            !this.calendar.holidayOn(holidays, dayKey, employee.branchId));
        if (!working) continue;

        expected += 1;
        const deptKey = employee.departmentId ?? '';
        byDept.set(deptKey, (byDept.get(deptKey) ?? 0) + 1);

        // An employee whose RECORD says they are on leave is on leave every
        // working day in the window, whether or not a row was ever written for
        // each of them.
        if (employee.status === 'ON_LEAVE') {
          onLeave += 1;
          leaveByDept.set(deptKey, (leaveByDept.get(deptKey) ?? 0) + 1);
        }
      }

      byDay.set(dayKey, expected);
      leaveByDay.set(dayKey, onLeave);
    }

    return { byDay, leaveByDay, byDept, leaveByDept };
  }

  /** Is every branch's office day over for this date? */
  private isSettled(
    dayKey: string,
    configs: Map<string, ResolvedBranchConfig>,
  ): boolean {
    const now = DateTime.now();
    for (const config of configs.values()) {
      if (this.calendar.officeEndInstant(dayKey, config) > now) return false;
    }
    return true;
  }

  /**
   * One window: totals, per-day counts, department ranking, arrival curve and
   * the attention strip.
   *
   * The current window is read ROW BY ROW — the arrival hour needs each punch
   * in its own branch's clock, and "worked more than scheduled" compares each
   * row against its own expectation, neither of which an aggregate can express.
   * A window entirely in the future reads nothing and reports nulls.
   */
  private async window(
    startKey: string,
    through: string | null,
    configs: Map<string, ResolvedBranchConfig>,
    roster: Awaited<ReturnType<AttendanceHubService['roster']>>,
    holidays: Map<string, ResolvedHoliday[]>,
    todayKey: string,
  ) {
    const arrivalPattern = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      label: hourLabel(hour),
      onTime: 0,
      late: 0,
    }));

    if (!through) {
      return {
        stats: emptyStats(),
        days: new Map<string, HubTrendBucket>(),
        departments: await this.departments(
          new Map(),
          new Map(),
          new Map(),
          roster,
        ),
        arrivalPattern,
        attention: {
          notCheckedIn: { count: 0, names: [] as string[] },
          notCheckedOut: { count: 0, names: [] as string[] },
          overScheduledHours: { count: 0, names: [] as string[] },
          absent: { count: 0, names: [] as string[] },
          late: { count: 0, names: [] as string[] },
        },
      };
    }

    const [calendar, rows] = await Promise.all([
      this.calendarExpectation(startKey, through, configs, roster, holidays),
      this.prisma.attendance.findMany({
        where: {
          date: { gte: dayKeyToDate(startKey), lte: dayKeyToDate(through) },
        },
        select: {
          employeeId: true,
          branchId: true,
          date: true,
          checkIn: true,
          checkOut: true,
          workHours: true,
          expectedHours: true,
          status: true,
          isLate: true,
        },
      }),
    ]);

    const nameOf = new Map(
      roster.map((e) => [
        e.id,
        [e.firstName, e.lastName].filter(Boolean).join(' '),
      ]),
    );
    const deptOf = new Map(roster.map((e) => [e.id, e.departmentId ?? '']));

    const counts = new Map<string, DayCounts>();
    const deptCounts = new Map<
      string,
      { present: number; late: number; absent: number; recorded: number }
    >();
    const punched = new Set<string>();
    const notCheckedOut = new Set<string>();
    const overHours = new Set<string>();
    const lateEmployees = new Set<string>();
    const absentEmployees = new Set<string>();

    for (const row of rows) {
      const dayKey = toDayKey(row.date);
      const day = counts.get(dayKey) ?? emptyCounts();
      const worked = WORKED.includes(row.status);

      if (worked) day.present += 1;
      if (row.isLate) day.late += 1;
      if (row.status === 'ABSENT') day.absent += 1;
      if (row.status === 'ON_LEAVE') day.onLeaveRows += 1;
      if (row.workHours !== null) {
        day.hoursSum += Number(row.workHours);
        day.hoursCount += 1;
      }
      counts.set(dayKey, day);

      const deptKey = deptOf.get(row.employeeId) ?? '';
      const dept = deptCounts.get(deptKey) ?? {
        present: 0,
        late: 0,
        absent: 0,
        recorded: 0,
      };
      dept.recorded += 1;
      if (worked) dept.present += 1;
      if (row.isLate) dept.late += 1;
      if (row.status === 'ABSENT') dept.absent += 1;
      deptCounts.set(deptKey, dept);

      if (row.checkIn) {
        punched.add(`${row.employeeId}|${dayKey}`);
        const zone = this.calendar.configFor(configs, row.branchId).zone;
        const hour = DateTime.fromJSDate(row.checkIn, { zone }).hour;
        if (row.isLate) arrivalPattern[hour].late += 1;
        else arrivalPattern[hour].onTime += 1;
        if (!row.checkOut) notCheckedOut.add(row.employeeId);
      }

      const owed =
        row.expectedHours !== null
          ? Number(row.expectedHours)
          : this.calendar.configFor(configs, row.branchId).expectedHours;
      if (row.workHours !== null && owed > 0 && Number(row.workHours) > owed) {
        overHours.add(row.employeeId);
      }
      if (row.isLate) lateEmployees.add(row.employeeId);
      if (row.status === 'ABSENT') absentEmployees.add(row.employeeId);
    }

    const days = new Map<string, HubTrendBucket>();
    const stats = emptyStats();

    for (const dayKey of dayRange(startKey, through)) {
      const day = counts.get(dayKey) ?? emptyCounts();
      const onLeave = Math.max(
        day.onLeaveRows,
        calendar.leaveByDay.get(dayKey) ?? 0,
      );
      const expected = reconcileExpected(
        calendar.byDay.get(dayKey) ?? 0,
        onLeave,
        day.present,
        day.absent,
      );
      // Today is still open until its office end; treating its missing punches
      // as absences would paint a red bar every morning.
      const settled = dayKey !== todayKey || this.isSettled(dayKey, configs);
      const absent = settled
        ? Math.max(day.absent, Math.max(0, expected - day.present - onLeave))
        : day.absent;

      days.set(dayKey, {
        key: dayKey,
        label: (parseDayKey(dayKey) as DateTime).toFormat('d LLL'),
        expected,
        present: day.present,
        onTime: Math.max(0, day.present - day.late),
        late: day.late,
        absent,
        onLeave,
        attendanceRate: rate(day.present, expected),
      });

      stats.daysCounted += 1;
      stats.expected += expected;
      stats.present += day.present;
      stats.late += day.late;
      stats.absent += absent;
      stats.onLeave += onLeave;
    }

    const hoursSum = [...counts.values()].reduce((a, d) => a + d.hoursSum, 0);
    const hoursCount = [...counts.values()].reduce(
      (a, d) => a + d.hoursCount,
      0,
    );
    stats.attendanceRate = rate(stats.present, stats.expected);
    stats.lateRate = rate(stats.late, stats.present);
    stats.absentRate = rate(stats.absent, stats.expected);
    stats.avgWorkHours = hoursCount ? round2(hoursSum / hoursCount) : null;
    stats.lateOccurrences = stats.late;

    // "Nobody has heard from them" is a statement about a day still running.
    // Once the day closes those people are simply absent, and the absent item
    // already says so — so this is only reported for an open today inside the
    // window being looked at.
    const notCheckedInNames: string[] = [];
    if (
      startKey <= todayKey &&
      todayKey <= through &&
      !this.isSettled(todayKey, configs)
    ) {
      const todayExpectation = await this.calendarExpectation(
        todayKey,
        todayKey,
        configs,
        roster,
        holidays,
      );
      if ((todayExpectation.byDay.get(todayKey) ?? 0) > 0) {
        for (const employee of roster) {
          if (employee.status === 'ON_LEAVE') continue;
          if (punched.has(`${employee.id}|${todayKey}`)) continue;
          const config = this.calendar.configFor(configs, employee.branchId);
          const working =
            !isWeeklyOff(
              parseDayKey(todayKey) as DateTime,
              config.weeklyOffDays,
            ) &&
            !this.calendar.holidayOn(holidays, todayKey, employee.branchId);
          if (working) notCheckedInNames.push(nameOf.get(employee.id) ?? '');
        }
      }
    }

    const named = (ids: Set<string>): HubNamedCount => ({
      count: ids.size,
      names: [...ids].slice(0, NAME_CAP).map((id) => nameOf.get(id) ?? ''),
    });

    return {
      stats,
      days,
      departments: await this.departments(
        calendar.byDept,
        calendar.leaveByDept,
        deptCounts,
        roster,
      ),
      arrivalPattern,
      attention: {
        notCheckedIn: {
          count: notCheckedInNames.length,
          names: notCheckedInNames.slice(0, NAME_CAP),
        },
        notCheckedOut: named(notCheckedOut),
        overScheduledHours: named(overHours),
        // The count is the calendar's answer, which can exceed the rows
        // actually written; the names are only those marked absent, so the list
        // can be shorter than the number without either being wrong.
        absent: {
          count: stats.absent,
          names: [...absentEmployees]
            .slice(0, NAME_CAP)
            .map((id) => nameOf.get(id) ?? ''),
        },
        late: named(lateEmployees),
      },
    };
  }

  /** Today and yesterday, computed outside the selected period on purpose. */
  private async daySnapshot(
    dayKey: string,
    configs: Map<string, ResolvedBranchConfig>,
    roster: Awaited<ReturnType<AttendanceHubService['roster']>>,
    holidays: Map<string, ResolvedHoliday[]>,
  ): Promise<HubDaySnapshot> {
    const [calendar, rows] = await Promise.all([
      this.calendarExpectation(dayKey, dayKey, configs, roster, holidays),
      this.prisma.attendance.findMany({
        where: { date: dayKeyToDate(dayKey) },
        select: {
          employeeId: true,
          checkIn: true,
          checkOut: true,
          workHours: true,
          status: true,
          isLate: true,
        },
      }),
    ]);

    let present = 0;
    let late = 0;
    let recordedAbsent = 0;
    let leaveRows = 0;
    let notCheckedOut = 0;
    let hoursSum = 0;
    let hoursCount = 0;
    const punched = new Set<string>();

    for (const row of rows) {
      if (WORKED.includes(row.status)) present += 1;
      if (row.isLate) late += 1;
      if (row.status === 'ABSENT') recordedAbsent += 1;
      if (row.status === 'ON_LEAVE') leaveRows += 1;
      if (row.checkIn) {
        punched.add(row.employeeId);
        if (!row.checkOut) notCheckedOut += 1;
      }
      if (row.workHours !== null) {
        hoursSum += Number(row.workHours);
        hoursCount += 1;
      }
    }

    const onLeave = Math.max(leaveRows, calendar.leaveByDay.get(dayKey) ?? 0);
    const expected = reconcileExpected(
      calendar.byDay.get(dayKey) ?? 0,
      onLeave,
      present,
      recordedAbsent,
    );
    const settled = this.isSettled(dayKey, configs);
    const absent = settled
      ? Math.max(recordedAbsent, Math.max(0, expected - present - onLeave))
      : recordedAbsent;
    const onTime = Math.max(0, present - late);

    return {
      date: dayKey,
      expected,
      present,
      onTime,
      late,
      absent,
      onLeave,
      notCheckedOut,
      notCheckedIn: settled
        ? absent
        : Math.max(0, expected - present - onLeave - recordedAbsent),
      avgWorkHours: hoursCount ? round2(hoursSum / hoursCount) : null,
      presentRate: rate(present, expected),
      lateRate: rate(late, present),
      absentRate: rate(absent, expected),
      onTimeRate: rate(onTime, expected),
      settled,
    };
  }

  /**
   * Per-department attendance for the window.
   *
   * `hasData` flags a department with no rows at all in the range. That is a
   * data gap, not a staffing crisis, and a ranking that puts it above a
   * genuinely short-handed team every day buries the thing the panel exists to
   * surface — so the silent ones sort last, flagged, rather than pretending to
   * be at nought per cent.
   */
  private async departments(
    calendarByDept: Map<string, number>,
    leaveByDept: Map<string, number>,
    actuals: Map<
      string,
      { present: number; late: number; absent: number; recorded: number }
    >,
    roster: Awaited<ReturnType<AttendanceHubService['roster']>>,
  ) {
    const departments = await this.prisma.department.findMany({
      select: { id: true, name: true },
    });
    const names = new Map(departments.map((d) => [d.id, d.name]));

    const headcount = new Map<string, number>();
    for (const employee of roster) {
      const key = employee.departmentId ?? '';
      headcount.set(key, (headcount.get(key) ?? 0) + 1);
    }

    return [...headcount.entries()]
      .map(([key, count]) => {
        const actual = actuals.get(key);
        const present = actual?.present ?? 0;
        const recordedAbsent = actual?.absent ?? 0;
        const onLeave = leaveByDept.get(key) ?? 0;
        const expected = reconcileExpected(
          calendarByDept.get(key) ?? 0,
          onLeave,
          present,
          recordedAbsent,
        );
        return {
          id: key || UNASSIGNED_DEPARTMENT,
          name: key ? (names.get(key) ?? 'Unknown') : 'Unassigned',
          headcount: count,
          expected,
          present,
          late: actual?.late ?? 0,
          absent: Math.max(
            recordedAbsent,
            Math.max(0, expected - present - onLeave),
          ),
          onLeave,
          rate: rate(present, expected),
          hasData: (actual?.recorded ?? 0) > 0,
        };
      })
      .sort(
        (a, b) =>
          Number(b.hasData) - Number(a.hasData) ||
          (a.rate ?? 101) - (b.rate ?? 101) ||
          b.expected - a.expected,
      );
  }

  /**
   * Is the roster being followed?
   *
   * `source` says which calendar the numbers came from: `roster` when
   * WorkSchedule rows cover the window, `calendar` when there is no roster and
   * the branch office hours are all there is to compare against. Reporting a
   * fallback as though it were a roster would make an unrostered month look
   * fully planned.
   */
  private async shifts(
    startKey: string,
    through: string | null,
    stats: HubPeriodStats,
  ) {
    const byShift = through
      ? await this.prisma.workSchedule.groupBy({
          by: ['shiftType'],
          where: {
            date: { gte: dayKeyToDate(startKey), lte: dayKeyToDate(through) },
            isWorkDay: true,
          },
          _count: { _all: true },
        })
      : ([] as Array<{ shiftType: ShiftType; _count: { _all: number } }>);

    const rostered = byShift.reduce((a, r) => a + r._count._all, 0);
    const scheduled = rostered || stats.expected;

    return {
      shiftCount: byShift.length,
      source: rostered ? 'roster' : 'calendar',
      scheduled,
      checkedIn: stats.present,
      onShift: Math.max(0, stats.present - stats.late),
      late: stats.late,
      absent: stats.absent,
      onLeave: stats.onLeave,
      yetToCheckIn: Math.max(0, scheduled - stats.present - stats.onLeave),
      shifts: byShift.map((r) => ({
        type: r.shiftType,
        count: r._count._all,
      })),
    };
  }

  // ── Trend shaping ──────────────────────────────────────────────────────────

  /**
   * A single day has no daily shape to draw, so its chart is the arrival curve
   * — the only trend one day actually has. An hour expects nobody in
   * particular, so its `expected` is 0 and its rate is null rather than a
   * fraction of a number that does not divide by hour.
   */
  private hourlyTrend(
    pattern: Array<{
      hour: number;
      label: string;
      onTime: number;
      late: number;
    }>,
  ): HubTrendBucket[] {
    return pattern.map((h) => ({
      key: String(h.hour).padStart(2, '0'),
      label: h.label,
      expected: 0,
      present: h.onTime + h.late,
      onTime: h.onTime,
      late: h.late,
      absent: 0,
      onLeave: 0,
      attendanceRate: null,
    }));
  }

  /** Week and month draw a bar per day; a year draws one per month. */
  private bucketedTrend(
    days: Map<string, HubTrendBucket>,
    period: HubPeriod,
  ): HubTrendBucket[] {
    if (period !== 'year') return [...days.values()];

    const months = new Map<string, HubTrendBucket>();
    for (const day of days.values()) {
      const date = parseDayKey(day.key) as DateTime;
      const key = date.toFormat('yyyy-MM');
      const bucket = months.get(key) ?? {
        key,
        label: date.toFormat('LLL'),
        expected: 0,
        present: 0,
        onTime: 0,
        late: 0,
        absent: 0,
        onLeave: 0,
        attendanceRate: null,
      };
      bucket.expected += day.expected;
      bucket.present += day.present;
      bucket.onTime += day.onTime;
      bucket.late += day.late;
      bucket.absent += day.absent;
      bucket.onLeave += day.onLeave;
      months.set(key, bucket);
    }
    for (const bucket of months.values()) {
      bucket.attendanceRate = rate(bucket.present, bucket.expected);
    }
    return [...months.values()];
  }
}

// ── Day-key arithmetic ───────────────────────────────────────────────────────
// Day keys are ISO, so a lexicographic comparison IS a chronological one — no
// parsing needed to decide which of two dates comes first.

function minKey(a: string, b: string): string {
  return a <= b ? a : b;
}

function maxKey(a: string, b: string): string {
  return a >= b ? a : b;
}

export function shiftDay(dayKey: string, days: number): string {
  return DateTime.fromFormat(dayKey, 'yyyy-MM-dd', { zone: 'utc' })
    .plus({ days })
    .toFormat('yyyy-MM-dd');
}

export function dayRange(startKey: string, endKey: string): string[] {
  const keys: string[] = [];
  let cursor = DateTime.fromFormat(startKey, 'yyyy-MM-dd', { zone: 'utc' });
  const last = DateTime.fromFormat(endKey, 'yyyy-MM-dd', { zone: 'utc' });
  while (cursor <= last) {
    keys.push(cursor.toFormat('yyyy-MM-dd'));
    cursor = cursor.plus({ days: 1 });
  }
  return keys;
}
