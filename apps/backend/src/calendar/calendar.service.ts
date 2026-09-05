import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ShiftType, UserRole } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { withFullName } from '../common/utils/employee-name.util';
import { dayKeysBetween, isoWeekdayOf } from './calendar-day.util';
import type { Principal } from '../auth/auth.service';

/** Roles allowed to read somebody else's calendar. */
const MAY_OVERRIDE_TARGET: UserRole[] = [
  UserRole.ADMIN,
  UserRole.HR_MANAGER,
  UserRole.MANAGER,
];

const SHIFT_LABELS: Record<ShiftType, string> = {
  MORNING: 'Morning',
  AFTERNOON: 'Afternoon',
  FULL_DAY: 'Full Day',
  NIGHT: 'Night',
  FLEXIBLE: 'Flexible',
};

/** One thing that happens to somebody on one day. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** Wall clock, never an instant: `2026-09-05` or `2026-09-05T08:00:00`. */
  startDate: string;
  endDate: string;
  type: 'work' | 'leave' | 'overtime' | 'holiday';
  allDay: boolean;
  description: string | null;
  shiftType?: ShiftType;
  startTime?: string | null;
  endTime?: string | null;
  requiredHours?: number | null;
}

/** `YYYY-MM-DD` from a date-only column, without a zone conversion on the way. */
function dayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The employee's own work calendar.
 *
 * Four lanes: the shift they are rostered, the leave that cancels it, the
 * overtime they were approved for and the holiday their branch observes.
 * Reading the roster as a whole — coverage, conflicts, the scheduling hub —
 * belongs to the Schedules module; this one answers "what does MY month look
 * like", which is the question the self-service screen asks.
 */
@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  /**
   * Whose calendar a request should return.
   *
   * The override is honoured for the privileged roles only, and only THEN is
   * the guard consulted. It is never applied to the id the caller's own token
   * carries: guarding self-service is how "my calendar" breaks for everybody
   * the moment a scope filter moves.
   */
  async resolveCalendarTarget(
    user: Principal,
    requestedEmployeeId?: string,
  ): Promise<string | undefined> {
    const employeeId = user?.employeeId ?? undefined;
    if (!requestedEmployeeId) return employeeId;
    if (requestedEmployeeId === employeeId) return employeeId;
    if (!MAY_OVERRIDE_TARGET.includes(user?.role)) {
      throw new ForbiddenException('You may only view your own calendar');
    }

    const subject = await this.prisma.employee.findUnique({
      where: { id: requestedEmployeeId },
      select: { id: true, departmentId: true },
    });
    // 404 rather than 403 on both refusals below: a manager must not be able to
    // enumerate the company by probing which ids come back forbidden.
    if (!subject) throw new NotFoundException('Employee not found');

    if (user.role === UserRole.MANAGER) {
      const scope = await this.managedDepartmentIds(user);
      if (!subject.departmentId || !scope.includes(subject.departmentId)) {
        throw new NotFoundException('Employee not found');
      }
    }
    return requestedEmployeeId;
  }

  async getEmployeeCalendar(
    employeeId: string | undefined,
    startDate: string,
    endDate: string,
  ): Promise<CalendarEvent[]> {
    // A user account need not be attached to an employee record. An empty
    // calendar rather than an exception: passing `undefined` into a Prisma
    // filter is rejected by the client and surfaces as a 500 on a route the
    // caller's own role grants them.
    if (!employeeId) return [];

    const from = new Date(`${startDate.slice(0, 10)}T00:00:00.000Z`);
    const to = new Date(`${endDate.slice(0, 10)}T00:00:00.000Z`);

    const [schedules, leaves, overtimes, employee] = await Promise.all([
      this.prisma.workSchedule.findMany({
        where: { employeeId, date: { gte: from, lte: to } },
        orderBy: { date: 'asc' },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          employeeId,
          status: 'APPROVED',
          startDate: { lte: to },
          endDate: { gte: from },
        },
      }),
      this.prisma.overtimeRequest.findMany({
        where: {
          employeeId,
          status: 'APPROVED',
          date: { gte: from, lte: to },
        },
      }),
      this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { branchId: true },
      }),
    ]);

    const holidays = await this.holidaysInRange(
      from,
      to,
      employee?.branchId ?? null,
    );

    const events: CalendarEvent[] = [];

    for (const schedule of schedules) {
      const date = dayKey(schedule.date);
      const flexible = schedule.shiftType === ShiftType.FLEXIBLE;
      const requiredHours =
        schedule.requiredHours != null ? Number(schedule.requiredHours) : null;
      // A flexible shift has no window to place on a time axis, and a fixed one
      // with a missing wall clock has nothing to draw either, so both become
      // all-day markers rather than blocks from midnight to midnight.
      const hasWindow = !flexible && schedule.startTime && schedule.endTime;
      events.push({
        id: schedule.id,
        title: flexible
          ? `Work - Flexible (${requiredHours ?? '?'}h)`
          : `Work - ${SHIFT_LABELS[schedule.shiftType]}`,
        startDate: hasWindow ? `${date}T${schedule.startTime}:00` : date,
        endDate: hasWindow ? `${date}T${schedule.endTime}:00` : date,
        type: 'work',
        allDay: !hasWindow,
        description: schedule.notes,
        shiftType: schedule.shiftType,
        startTime: schedule.startTime,
        endTime: schedule.endTime,
        requiredHours,
      });
    }

    for (const leave of leaves) {
      events.push({
        id: leave.id,
        title: `Leave - ${leave.leaveType}`,
        startDate: dayKey(leave.startDate),
        endDate: dayKey(leave.endDate),
        type: 'leave',
        allDay: true,
        description: leave.reason,
      });
    }

    for (const overtime of overtimes) {
      const date = dayKey(overtime.date);
      events.push({
        id: overtime.id,
        title: `Overtime - ${Number(overtime.hours)}h`,
        startDate: overtime.startTime.toISOString(),
        endDate: overtime.endTime.toISOString(),
        type: 'overtime',
        allDay: false,
        description: `${overtime.reason} (${date})`,
      });
    }

    for (const holiday of holidays) {
      const date = dayKey(holiday.date);
      events.push({
        id: holiday.id,
        title: holiday.name,
        startDate: date,
        endDate: date,
        type: 'holiday',
        allDay: true,
        description: holiday.description ?? 'Holiday',
      });
    }

    events.sort((a, b) => a.startDate.localeCompare(b.startDate));
    return events;
  }

  async getCalendarStats(
    employeeId: string | undefined,
    month: number,
    year: number,
  ) {
    if (!employeeId) {
      return { workDays: 0, leaveDays: 0, overtimeHours: 0, holidays: 0 };
    }

    const start = DateTime.fromObject({ year, month, day: 1 }, { zone: 'utc' });
    const from = start.toJSDate();
    const to = start.endOf('month').startOf('day').toJSDate();

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { branchId: true },
    });

    const [workDays, leaveSum, overtimeSum, holidays] = await Promise.all([
      this.prisma.workSchedule.count({
        where: { employeeId, date: { gte: from, lte: to }, isWorkDay: true },
      }),
      this.prisma.leaveRequest.aggregate({
        where: {
          employeeId,
          status: 'APPROVED',
          startDate: { lte: to },
          endDate: { gte: from },
        },
        _sum: { totalDays: true },
      }),
      this.prisma.overtimeRequest.aggregate({
        where: {
          employeeId,
          status: 'APPROVED',
          date: { gte: from, lte: to },
        },
        _sum: { hours: true },
      }),
      this.holidaysInRange(from, to, employee?.branchId ?? null),
    ]);

    return {
      workDays,
      leaveDays: Number(leaveSum._sum.totalDays ?? 0),
      overtimeHours: Number(overtimeSum._sum.hours ?? 0),
      holidays: holidays.length,
    };
  }

  /**
   * The whole matrix for a window: every roster row, every approved absence,
   * every approved overtime, and the calendar the branches keep.
   *
   * One request rather than one per employee — a month of a hundred people is
   * three thousand cells, and a screen that fetched each row separately would
   * spend longer waiting than drawing.
   */
  async getOverviewCalendar(startDate: string, endDate: string) {
    const from = new Date(`${startDate.slice(0, 10)}T00:00:00.000Z`);
    const to = new Date(`${endDate.slice(0, 10)}T00:00:00.000Z`);

    const [schedules, leaves, overtimes, holidays, weeklyOffDays] =
      await Promise.all([
        this.prisma.workSchedule.findMany({
          where: { date: { gte: from, lte: to } },
        }),
        this.prisma.leaveRequest.findMany({
          where: {
            status: 'APPROVED',
            startDate: { lte: to },
            endDate: { gte: from },
          },
        }),
        this.prisma.overtimeRequest.findMany({
          where: { status: 'APPROVED', date: { gte: from, lte: to } },
        }),
        this.holidaysInRange(from, to, null),
        this.defaultWeeklyOffDays(),
      ]);

    return {
      schedules: schedules.map((row) => ({
        id: row.id,
        employeeId: row.employeeId,
        date: dayKey(row.date),
        shiftType: row.shiftType,
        startTime: row.startTime,
        endTime: row.endTime,
        requiredHours:
          row.requiredHours != null ? Number(row.requiredHours) : null,
        isWorkDay: row.isWorkDay,
      })),
      leaves: leaves.map((row) => ({
        id: row.id,
        employeeId: row.employeeId,
        startDate: dayKey(row.startDate),
        endDate: dayKey(row.endDate),
        leaveType: row.leaveType,
      })),
      overtimes: overtimes.map((row) => ({
        id: row.id,
        employeeId: row.employeeId,
        date: dayKey(row.date),
        hours: Number(row.hours),
      })),
      holidays: holidays.map((row) => ({
        id: row.id,
        date: dayKey(row.date),
        name: row.name,
        branchId: row.branchId,
      })),
      weeklyOffDays,
    };
  }

  /**
   * Whether the window is actually covered, and where it is not.
   *
   * Three questions a scheduler opens the module with, none of which a schedule
   * COUNT answers: who has no shift at all (they will not know to turn up), who
   * is rostered on a company holiday, and who is rostered on their weekly off.
   * The last two are conflicts the roster is perfectly happy to contain — the
   * per-employee conflict check only fires while somebody is editing one
   * person, so nothing else ever sweeps the week as a whole.
   */
  async coverageStats(startDate: string, endDate: string) {
    const from = new Date(`${startDate.slice(0, 10)}T00:00:00.000Z`);
    const to = new Date(`${endDate.slice(0, 10)}T00:00:00.000Z`);

    const [schedules, activeHeadcount, holidays, weeklyOffDays] =
      await Promise.all([
        this.prisma.workSchedule.findMany({
          where: { date: { gte: from, lte: to }, isWorkDay: true },
          select: {
            employeeId: true,
            date: true,
            employee: { select: { firstName: true, lastName: true } },
          },
        }),
        this.prisma.employee.count({ where: { status: 'ACTIVE' } }),
        this.holidaysInRange(from, to, null),
        this.defaultWeeklyOffDays(),
      ]);

    const holidayByDate = new Map(
      holidays.map((holiday) => [dayKey(holiday.date), holiday.name]),
    );
    const offDays = new Set(weeklyOffDays);

    const scheduled = new Set<string>();
    const perDay = new Map<string, number>();
    const onHoliday: Array<{
      employeeId: string;
      fullName: string;
      date: string;
      holiday: string;
    }> = [];
    const onWeeklyOff: Array<{
      employeeId: string;
      fullName: string;
      date: string;
    }> = [];

    for (const row of schedules) {
      const date = dayKey(row.date);
      scheduled.add(row.employeeId);
      perDay.set(date, (perDay.get(date) ?? 0) + 1);

      const fullName = withFullName(row.employee).fullName;
      const holiday = holidayByDate.get(date);
      if (holiday) {
        onHoliday.push({ employeeId: row.employeeId, fullName, date, holiday });
      }
      // `offDays` holds ISO weekday numbers, 1 = Monday, matching how a branch
      // stores its rest days. Somebody rostered on one is the second conflict
      // this sweep exists to surface.
      if (offDays.has(isoWeekdayOf(date))) {
        onWeeklyOff.push({ employeeId: row.employeeId, fullName, date });
      }
    }

    // Every date in the window, including the ones with nothing on them — a day
    // missing from the roster is the very thing this is looking for.
    const byDay = dayKeysBetween(startDate, endDate).map((date) => ({
      date,
      scheduled: perDay.get(date) ?? 0,
    }));
    const workingDays = byDay.filter((day) => !holidayByDate.has(day.date));
    const thinnestDay = workingDays.length
      ? workingDays.reduce((min, day) =>
          day.scheduled < min.scheduled ? day : min,
        )
      : null;

    return {
      window: { startDate, endDate },
      activeHeadcount,
      scheduledEmployees: scheduled.size,
      unscheduled: Math.max(0, activeHeadcount - scheduled.size),
      shifts: schedules.length,
      byDay,
      thinnestDay,
      conflicts: {
        onHoliday: onHoliday.length,
        onWeeklyOff: onWeeklyOff.length,
        samples: [...onHoliday.slice(0, 5), ...onWeeklyOff.slice(0, 5)],
      },
    };
  }

  /**
   * Company-wide holidays plus the branch's own, the branch row winning on a
   * shared date — that is how a national holiday observed in one country and
   * not another is expressed without a second calendar.
   */
  private async holidaysInRange(from: Date, to: Date, branchId: string | null) {
    const where: Prisma.HolidayWhereInput = {
      date: { gte: from, lte: to },
      ...(branchId ? { OR: [{ branchId: null }, { branchId }] } : {}),
    };
    const rows = await this.prisma.holiday.findMany({
      where,
      orderBy: [{ date: 'asc' }, { branchId: 'desc' }],
    });

    if (!branchId) return rows;
    const byDate = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = dayKey(row.date);
      const held = byDate.get(key);
      // `branchId: 'desc'` puts the branch row first, so the company-wide row
      // never overwrites it.
      if (!held) byDate.set(key, row);
    }
    return [...byDate.values()];
  }

  /** ISO weekday numbers, 1 = Monday. The company-wide default. */
  private async defaultWeeklyOffDays(): Promise<number[]> {
    const raw = await this.settings.get('attendance_weekly_off_days');
    return (raw ?? '')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  }

  /** The departments a manager speaks for: the ones they head, plus their own. */
  private async managedDepartmentIds(user: Principal): Promise<string[]> {
    const ids = new Set<string>();
    if (user.departmentId) ids.add(user.departmentId);
    if (user.employeeId) {
      const headed = await this.prisma.department.findMany({
        where: { managerId: user.employeeId },
        select: { id: true },
      });
      headed.forEach((department) => ids.add(department.id));
    }
    return [...ids];
  }
}
