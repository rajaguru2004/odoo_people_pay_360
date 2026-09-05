import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ShiftType } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import {
  AttendanceCalendarService,
  type ResolvedBranchConfig,
  type ResolvedHoliday,
} from '../attendances/attendance-calendar.service';
import {
  dayKeyToDate,
  isWeeklyOff,
  parseDayKey,
  toDayKey,
} from '../attendances/attendance-calendar.util';
import {
  SHIFT_LABELS,
  formatWallClock12h,
  median,
  shiftHours,
  windowsConflict,
} from './shift-window.util';

/**
 * The caller, as the controller knows them.
 *
 * Authorization here is expressed against this rather than against a role
 * string alone, because two of the rules — self-access and department scope —
 * need the caller's identity and not just their rank.
 *
 * `employeeId` is nullable on purpose: `User.employeeId` is optional, and an
 * administrator who is not a member of staff is the ordinary reason for it.
 * Typing it as required is what lets it be passed straight into a Prisma filter,
 * where `undefined` is rejected and the caller gets a 500 on a route their own
 * role grants them.
 */
export interface ScheduleActor {
  employeeId?: string | null;
  role: string;
  departmentId?: string | null;
  branchId?: string | null;
}

/** Roles that may read and roster anybody. */
const PRIVILEGED_ROLES = ['ADMIN', 'HR_MANAGER'];

/** Roles that may name somebody else on a "my calendar" request. */
const MAY_OVERRIDE_TARGET = [
  'ADMIN',
  'HR_MANAGER',
  'PAYROLL_OFFICER',
  'MANAGER',
];

/** How many names an action item carries before it becomes a list, not a task. */
const NAME_CAP = 12;

/** One thing that happens to a person on one day, as the calendar draws it. */
export interface ScheduleEvent {
  id: string;
  date: string;
  title: string;
  type: 'shift' | 'leave' | 'holiday' | 'weekly-off';
  shiftType: ShiftType | null;
  /** Wall clock, "HH:MM". Null for an all-day marker. */
  startTime: string | null;
  endTime: string | null;
  hours: number | null;
  allDay: boolean;
  isWorkDay: boolean;
  notes: string | null;
}

const EMPLOYEE_CARD_SELECT = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  status: true,
  branchId: true,
  departmentId: true,
  department: { select: { id: true, name: true } },
  branch: { select: { id: true, code: true, name: true } },
} satisfies Prisma.EmployeeSelect;

export const fullNameOf = (e: {
  firstName?: string | null;
  lastName?: string | null;
}): string => [e.firstName, e.lastName].filter(Boolean).join(' ');

/**
 * Everything the Schedules module reads.
 *
 * Kept apart from `WorkSchedulesService`, which owns the ROWS — create one,
 * edit one, delete one. This service answers questions about the roster as a
 * whole: what a person's month looks like, whether a window is covered, which
 * days collide. The two share the table and nothing else, and splitting them is
 * what keeps a calendar query out of the write path's transaction.
 *
 * ## What this module can and cannot answer
 *
 * `WorkSchedule` is one row per employee per date with a REQUIRED `employeeId`.
 * There is no capacity column, no shift template, no roster pattern and no
 * shift→branch link — so an "open shift" (a shift with nobody on it), an
 * over-capacity shift and an hourly staffing REQUIREMENT are not representable.
 * What ships instead is the nearest thing the data supports, named for what it
 * actually measures rather than implying a demand model that does not exist:
 *
 *   Open shifts        → COVERAGE GAPS: working days whose scheduled headcount
 *                        sits below the window's own median.
 *   Over capacity      → the conflicts the roster IS happy to contain: rostered
 *                        on a holiday, on a weekly off, or overlapping.
 *   Required vs actual → ON SHIFT BY HOUR, against a flat active-headcount
 *                        baseline. It says how the day is staffed, not whether
 *                        that is enough — nothing stores "enough".
 */
@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: AttendanceCalendarService,
  ) {}

  // ── Authorization ──────────────────────────────────────────────────────────

  /**
   * Whose calendar a "my schedule" request should return.
   *
   * The override is resolved and AUTHORIZED in one place, and it can only ever
   * narrow to an id the CALLER supplied — the token-derived default never passes
   * through the guard. That distinction is the whole rule: guarding the
   * self-service path is how "my calendar" breaks for everybody the moment an
   * administrator without a staff record signs in.
   */
  async resolveCalendarTarget(
    actor: ScheduleActor,
    requestedEmployeeId?: string,
  ): Promise<string | undefined> {
    const mayOverride = MAY_OVERRIDE_TARGET.includes(actor.role);
    if (!requestedEmployeeId || !mayOverride) {
      return actor.employeeId ?? undefined;
    }
    if (requestedEmployeeId === actor.employeeId) {
      return actor.employeeId ?? undefined;
    }

    await this.assertEmployeeViewable(actor, requestedEmployeeId);
    return requestedEmployeeId;
  }

  /**
   * Object-level authorization for reading ANOTHER employee's roster.
   *
   * A manager is refused with 404 rather than 403 because the question is about
   * EXISTENCE from their point of view: a 403 concedes that the employee is
   * real, which lets a department head enumerate the company by probing ids.
   */
  private async assertEmployeeViewable(
    actor: ScheduleActor,
    employeeId: string,
  ): Promise<void> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, departmentId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    if (PRIVILEGED_ROLES.includes(actor.role)) return;

    if (actor.role === 'MANAGER') {
      const scope = await this.managedDepartmentIds(actor);
      if (!employee.departmentId || !scope.includes(employee.departmentId)) {
        throw new NotFoundException('Employee not found');
      }
      return;
    }

    // Everyone else reads their own record only. 403 rather than 404 here: the
    // row's existence is not the secret, its contents are, and somebody who
    // followed a stale link deserves an answer they can act on.
    if (actor.employeeId !== employeeId) {
      throw new ForbiddenException('You may only view your own schedule');
    }
  }

  /**
   * The departments a manager speaks for: the ones they head, plus their own.
   *
   * Read from `Department.managerId` rather than from a claim on the token — a
   * reorganisation takes effect on the next request instead of on the next sign
   * in, and a token cannot be edited into a wider scope than the table grants.
   */
  private async managedDepartmentIds(actor: ScheduleActor): Promise<string[]> {
    if (!actor.employeeId)
      return actor.departmentId ? [actor.departmentId] : [];
    const headed = await this.prisma.department.findMany({
      where: { managerId: actor.employeeId },
      select: { id: true },
    });
    const ids = new Set(headed.map((d) => d.id));
    if (actor.departmentId) ids.add(actor.departmentId);
    return [...ids];
  }

  /**
   * The employee filter a caller's role implies.
   *
   * ACTIVE and ON_LEAVE, never TERMINATED: a leaver has no future roster and
   * counting them would report a permanent coverage hole nobody can close. A
   * manager is narrowed to the departments they head.
   */
  async employeeScope(
    actor?: ScheduleActor,
  ): Promise<Prisma.EmployeeWhereInput> {
    const where: Prisma.EmployeeWhereInput = {
      status: { in: ['ACTIVE', 'ON_LEAVE'] },
    };
    if (actor?.role === 'MANAGER') {
      where.departmentId = { in: await this.managedDepartmentIds(actor) };
    }
    return where;
  }

  // ── One person's calendar ──────────────────────────────────────────────────

  /**
   * Every event on one employee's calendar in a window.
   *
   * Four lanes, in the order a reader resolves a day: the shift they were
   * rostered, the leave that cancels it, the holiday their branch observes and
   * the weekly off their branch keeps. A day with none of the four is a plain
   * working day the branch calendar already describes, and it gets no event —
   * a row per person per day would be headcount × 365 events a year saying
   * nothing the branch calendar does not already say.
   *
   * A user account need not be attached to an employee record, so no staff
   * record means an EMPTY calendar rather than an exception: passing `undefined`
   * into a Prisma filter is rejected by the client and surfaces as a 500 on a
   * route the caller's own role grants them.
   */
  async getEmployeeCalendar(
    employeeId: string | undefined,
    startDate: string,
    endDate: string,
  ) {
    if (!employeeId) {
      return { events: [], employee: null, range: { startDate, endDate } };
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: EMPLOYEE_CARD_SELECT,
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const from = dayKeyToDate(startDate);
    const to = dayKeyToDate(endDate);

    const [schedules, leaveRows, holidayIndex, configs] = await Promise.all([
      this.prisma.workSchedule.findMany({
        where: { employeeId, date: { gte: from, lte: to } },
        orderBy: { date: 'asc' },
      }),
      // The nearest thing this schema has to an approved leave request: a day
      // the attendance record already calls leave. There is no LeaveRequest
      // model here, so a leave that has been approved but never written to a
      // day does not appear — see docs/interconnections-schedules.md.
      this.prisma.attendance.findMany({
        where: {
          employeeId,
          date: { gte: from, lte: to },
          status: 'ON_LEAVE',
        },
        select: { id: true, date: true, notes: true },
      }),
      this.calendar.holidayIndex(startDate, endDate),
      this.calendar.branchConfigs(),
    ]);

    const config = this.calendar.configFor(configs, employee.branchId);
    const events: ScheduleEvent[] = [];

    for (const row of schedules) {
      const dayKey = toDayKey(row.date);
      const hours = shiftHours({
        shiftType: row.shiftType,
        startTime: row.startTime,
        endTime: row.endTime,
        requiredHours:
          row.requiredHours != null ? Number(row.requiredHours) : null,
      });
      const flexible = row.shiftType === 'FLEXIBLE';
      events.push({
        id: row.id,
        date: dayKey,
        title: flexible
          ? `Flexible — ${hours || '?'}h`
          : `${SHIFT_LABELS[row.shiftType]} · ${formatWallClock12h(row.startTime)} – ${formatWallClock12h(row.endTime)}`,
        type: 'shift',
        shiftType: row.shiftType,
        startTime: row.startTime,
        endTime: row.endTime,
        hours: hours || null,
        // A flexible shift has no window to place on a time axis, so it draws
        // as an all-day marker rather than as a block from midnight to midnight.
        allDay: flexible || !row.startTime || !row.endTime,
        isWorkDay: row.isWorkDay,
        notes: row.notes,
      });
    }

    for (const row of leaveRows) {
      const dayKey = toDayKey(row.date);
      events.push({
        id: row.id,
        date: dayKey,
        title: 'On leave',
        type: 'leave',
        shiftType: null,
        startTime: null,
        endTime: null,
        hours: null,
        allDay: true,
        isWorkDay: false,
        notes: row.notes ?? null,
      });
    }

    for (const dayKey of dayKeysBetween(startDate, endDate)) {
      const holiday = this.calendar.holidayOn(
        holidayIndex,
        dayKey,
        employee.branchId,
      );
      if (holiday) {
        events.push({
          id: holiday.id,
          date: dayKey,
          title: holiday.name,
          type: 'holiday',
          shiftType: null,
          startTime: null,
          endTime: null,
          hours: null,
          allDay: true,
          isWorkDay: false,
          notes: null,
        });
        // A holiday outranks the weekly off it lands on. Drawing both would put
        // two grey blocks on one day and imply the person is twice as off.
        continue;
      }
      if (isWeeklyOff(parseDayKey(dayKey) as DateTime, config.weeklyOffDays)) {
        events.push({
          id: `weekly-off-${dayKey}`,
          date: dayKey,
          title: 'Weekly off',
          type: 'weekly-off',
          shiftType: null,
          startTime: null,
          endTime: null,
          hours: null,
          allDay: true,
          isWorkDay: false,
          notes: null,
        });
      }
    }

    events.sort((a, b) => a.date.localeCompare(b.date));

    return {
      employee: {
        ...employee,
        fullName: fullNameOf(employee),
      },
      range: { startDate, endDate },
      calendar: {
        zone: config.zone,
        officeStart: config.officeStart,
        officeEnd: config.officeEnd,
        weeklyOffDays: config.weeklyOffDays,
      },
      events,
    };
  }

  /**
   * One month's figures for one person, for the tiles above their calendar.
   *
   * Counted from the same four lanes the calendar draws, so a reader can check
   * the tiles against the grid and get the same answer. `workDays` counts days
   * the ROSTER claims; a plain working day with no row is not one of them,
   * which is why `branchWorkingDays` sits beside it.
   */
  async getScheduleStats(
    employeeId: string | undefined,
    month: number,
    year: number,
  ) {
    const start = DateTime.fromObject({ year, month, day: 1 }, { zone: 'utc' });
    const startKey = start.toFormat('yyyy-MM-dd');
    const endKey = start.endOf('month').toFormat('yyyy-MM-dd');

    if (!employeeId) {
      return {
        month,
        year,
        range: { startDate: startKey, endDate: endKey },
        workDays: 0,
        scheduledHours: 0,
        leaveDays: 0,
        holidays: 0,
        weeklyOffDays: 0,
        branchWorkingDays: 0,
      };
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, branchId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const [schedules, leaveDays, holidayIndex, configs] = await Promise.all([
      this.prisma.workSchedule.findMany({
        where: {
          employeeId,
          date: { gte: dayKeyToDate(startKey), lte: dayKeyToDate(endKey) },
          isWorkDay: true,
        },
        select: {
          shiftType: true,
          startTime: true,
          endTime: true,
          requiredHours: true,
        },
      }),
      this.prisma.attendance.count({
        where: {
          employeeId,
          date: { gte: dayKeyToDate(startKey), lte: dayKeyToDate(endKey) },
          status: 'ON_LEAVE',
        },
      }),
      this.calendar.holidayIndex(startKey, endKey),
      this.calendar.branchConfigs(),
    ]);

    const config = this.calendar.configFor(configs, employee.branchId);
    let holidays = 0;
    let weeklyOffDays = 0;
    let branchWorkingDays = 0;

    for (const dayKey of dayKeysBetween(startKey, endKey)) {
      const holiday = this.calendar.holidayOn(
        holidayIndex,
        dayKey,
        employee.branchId,
      );
      if (holiday) {
        holidays += 1;
        continue;
      }
      if (isWeeklyOff(parseDayKey(dayKey) as DateTime, config.weeklyOffDays)) {
        weeklyOffDays += 1;
        continue;
      }
      branchWorkingDays += 1;
    }

    const scheduledHours = schedules.reduce(
      (sum, row) =>
        sum +
        shiftHours({
          shiftType: row.shiftType,
          startTime: row.startTime,
          endTime: row.endTime,
          requiredHours:
            row.requiredHours != null ? Number(row.requiredHours) : null,
        }),
      0,
    );

    return {
      month,
      year,
      range: { startDate: startKey, endDate: endKey },
      workDays: schedules.length,
      scheduledHours: Math.round(scheduledHours * 10) / 10,
      leaveDays,
      holidays,
      weeklyOffDays,
      branchWorkingDays,
    };
  }

  // ── The company-wide matrix ────────────────────────────────────────────────

  /**
   * The working-schedule grid: every employee down the side, every day across.
   *
   * Returns the roster rows FLAT rather than pre-joined per employee. The grid
   * is headcount × days cells and the client already walks both axes to draw it;
   * shipping a nested structure would mean building the same index twice and
   * sending the employee record once per day they are rostered.
   *
   * `weeklyOffDays` and `holidays` come back per BRANCH, not as one company
   * calendar. One shared calendar would shade every Friday in Muscat as a
   * working day and no client-side fix would be possible.
   */
  async getOverview(
    startDate: string,
    endDate: string,
    filters: { branchId?: string; departmentId?: string } = {},
    actor?: ScheduleActor,
  ) {
    const from = dayKeyToDate(startDate);
    const to = dayKeyToDate(endDate);

    const where: Prisma.EmployeeWhereInput = {
      ...(await this.employeeScope(actor)),
      ...(filters.branchId ? { branchId: filters.branchId } : {}),
      ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
    };

    const [employees, configs, holidayRows] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        select: EMPLOYEE_CARD_SELECT,
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
      this.calendar.branchConfigs(),
      this.prisma.holiday.findMany({
        where: { date: { gte: from, lte: to } },
        select: { id: true, name: true, date: true, branchId: true },
        orderBy: { date: 'asc' },
      }),
    ]);

    const employeeIds = employees.map((e) => e.id);
    const [schedules, leaveRows] = employeeIds.length
      ? await Promise.all([
          this.prisma.workSchedule.findMany({
            where: {
              employeeId: { in: employeeIds },
              date: { gte: from, lte: to },
            },
            orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
          }),
          this.prisma.attendance.findMany({
            where: {
              employeeId: { in: employeeIds },
              date: { gte: from, lte: to },
              status: 'ON_LEAVE',
            },
            select: { id: true, employeeId: true, date: true },
          }),
        ])
      : [[], []];

    return {
      range: { startDate, endDate },
      employees: employees.map((e) => ({
        id: e.id,
        employeeCode: e.employeeCode,
        fullName: fullNameOf(e),
        avatarUrl: e.avatarUrl,
        status: e.status,
        branchId: e.branchId,
        branchName: e.branch?.name ?? null,
        departmentId: e.departmentId,
        departmentName: e.department?.name ?? null,
      })),
      schedules: schedules.map((s) => ({
        id: s.id,
        employeeId: s.employeeId,
        date: toDayKey(s.date),
        shiftType: s.shiftType,
        startTime: s.startTime,
        endTime: s.endTime,
        isWorkDay: s.isWorkDay,
        notes: s.notes,
        hours: shiftHours({
          shiftType: s.shiftType,
          startTime: s.startTime,
          endTime: s.endTime,
          requiredHours:
            s.requiredHours != null ? Number(s.requiredHours) : null,
        }),
      })),
      leaves: leaveRows.map((l) => ({
        id: l.id,
        employeeId: l.employeeId,
        date: toDayKey(l.date),
      })),
      holidays: holidayRows.map((h) => ({
        id: h.id,
        date: toDayKey(h.date),
        name: h.name,
        branchId: h.branchId,
      })),
      // Keyed by branch id, with `""` for the branchless. The client looks a
      // person's week up by their own branch rather than by a company default.
      branchCalendars: [...configs.entries()].map(([id, config]) => ({
        branchId: id || null,
        zone: config.zone,
        officeStart: config.officeStart,
        officeEnd: config.officeEnd,
        weeklyOffDays: config.weeklyOffDays,
      })),
    };
  }

  // ── Coverage and conflicts ─────────────────────────────────────────────────

  /**
   * Is the window actually covered, and where is it not?
   *
   * Three questions a scheduler opens this module with, none of which a schedule
   * COUNT answers:
   *
   *  - who has no shift at all (they will not know to turn up);
   *  - who is rostered on a holiday their branch observes;
   *  - who is rostered on their branch's weekly off.
   *
   * The last two are conflicts the roster is perfectly happy to contain. The
   * per-employee conflict check only fires while somebody is editing one
   * person, so without this nothing ever sweeps the window as a whole.
   */
  async coverageStats(
    startDate: string,
    endDate: string,
    actor?: ScheduleActor,
  ) {
    const window = await this.sweep(startDate, endDate, actor);

    return {
      window: { startDate, endDate },
      activeHeadcount: window.activeHeadcount,
      scheduledEmployees: window.scheduledEmployees.size,
      unscheduled: Math.max(
        0,
        window.activeHeadcount - window.scheduledEmployees.size,
      ),
      shifts: window.rows.length,
      byDay: window.byDay,
      thinnestDay: window.thinnestDay,
      conflicts: {
        onHoliday: window.onHoliday.length,
        onWeeklyOff: window.onWeeklyOff.length,
        overlaps: window.overlaps.length,
        total:
          window.onHoliday.length +
          window.onWeeklyOff.length +
          window.overlaps.length,
        samples: [
          ...window.onHoliday.slice(0, 5),
          ...window.onWeeklyOff.slice(0, 5),
          ...window.overlaps.slice(0, 5),
        ],
      },
    };
  }

  /**
   * The schedules in a range for ONE person that actually collide.
   *
   * Conflicts only ever occur within a single date, so rows are bucketed by day
   * and compared inside each bucket. Comparing across the range would be O(n²)
   * over the month for an answer that is false by construction.
   */
  async checkScheduleConflicts(
    employeeId: string,
    startDate: string,
    endDate: string,
  ) {
    const rows = await this.prisma.workSchedule.findMany({
      where: {
        employeeId,
        date: { gte: dayKeyToDate(startDate), lte: dayKeyToDate(endDate) },
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { date: 'asc' },
    });

    const byDate = new Map<string, typeof rows>();
    for (const row of rows) {
      const dayKey = toDayKey(row.date);
      const bucket = byDate.get(dayKey);
      if (bucket) bucket.push(row);
      else byDate.set(dayKey, [row]);
    }

    const colliding = new Map<string, (typeof rows)[number]>();
    for (const bucket of byDate.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          if (windowsConflict(bucket[i], bucket[j])) {
            colliding.set(bucket[i].id, bucket[i]);
            colliding.set(bucket[j].id, bucket[j]);
          }
        }
      }
    }

    const conflicts = [...colliding.values()]
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .map((row) => ({
        id: row.id,
        date: toDayKey(row.date),
        shiftType: row.shiftType,
        startTime: row.startTime,
        endTime: row.endTime,
        employee: {
          id: row.employee.id,
          employeeCode: row.employee.employeeCode,
          fullName: fullNameOf(row.employee),
        },
      }));

    return { hasConflicts: conflicts.length > 0, conflicts };
  }

  // ── The shared window sweep ────────────────────────────────────────────────

  /**
   * Everything a date window adds up to, read once.
   *
   * Both `coverageStats` and the hub summary need the same six answers over the
   * same rows. Two passes over the same table is two chances for them to
   * disagree about the window, and a hub whose KPI contradicts the coverage
   * endpoint behind the same number is worse than either being wrong alone.
   */
  async sweep(startDate: string, endDate: string, actor?: ScheduleActor) {
    const from = dayKeyToDate(startDate);
    const to = dayKeyToDate(endDate);
    const employeeWhere = await this.employeeScope(actor);

    const [rows, roster, configs, holidayIndex] = await Promise.all([
      this.prisma.workSchedule.findMany({
        where: {
          date: { gte: from, lte: to },
          isWorkDay: true,
          employee: employeeWhere,
        },
        select: {
          id: true,
          employeeId: true,
          date: true,
          shiftType: true,
          startTime: true,
          endTime: true,
          requiredHours: true,
          employee: {
            select: {
              firstName: true,
              lastName: true,
              branchId: true,
              departmentId: true,
            },
          },
        },
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      }),
      this.prisma.employee.findMany({
        where: employeeWhere,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          branchId: true,
          departmentId: true,
        },
      }),
      this.calendar.branchConfigs(),
      this.calendar.holidayIndex(startDate, endDate),
    ]);

    const dayKeys = dayKeysBetween(startDate, endDate);
    const calendar = this.branchCalendar(
      dayKeys,
      roster,
      configs,
      holidayIndex,
    );

    const scheduledEmployees = new Set<string>();
    const perDay = new Map<string, Set<string>>();
    const onHoliday: ConflictSample[] = [];
    const onWeeklyOff: ConflictSample[] = [];
    const overlaps: ConflictSample[] = [];
    const perEmployeeDay = new Map<string, typeof rows>();

    for (const row of rows) {
      const dayKey = toDayKey(row.date);
      const branchId = row.employee.branchId;
      const name = fullNameOf(row.employee);

      scheduledEmployees.add(row.employeeId);
      if (!perDay.has(dayKey)) perDay.set(dayKey, new Set());
      perDay.get(dayKey)!.add(row.employeeId);

      const holiday = this.calendar.holidayOn(holidayIndex, dayKey, branchId);
      if (holiday) {
        onHoliday.push({
          employeeId: row.employeeId,
          fullName: name,
          date: dayKey,
          reason: holiday.name,
        });
      } else if (
        isWeeklyOff(
          parseDayKey(dayKey) as DateTime,
          this.calendar.configFor(configs, branchId).weeklyOffDays,
        )
      ) {
        // `else`, not a second `if`: a holiday that lands on a weekly off is ONE
        // conflict, and counting it twice inflates every total on the page.
        onWeeklyOff.push({
          employeeId: row.employeeId,
          fullName: name,
          date: dayKey,
          reason: 'Weekly off',
        });
      }

      const bucketKey = `${row.employeeId}|${dayKey}`;
      if (!perEmployeeDay.has(bucketKey)) {
        perEmployeeDay.set(bucketKey, []);
      }
      perEmployeeDay.get(bucketKey)!.push(row);
    }

    // Per employee-day rather than per employee-window: two shifts on different
    // dates cannot overlap, and comparing them would be O(n²) over the month.
    for (const [bucketKey, bucket] of perEmployeeDay) {
      if (bucket.length < 2) continue;
      let collided = false;
      for (let i = 0; i < bucket.length && !collided; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          if (windowsConflict(bucket[i], bucket[j])) {
            collided = true;
            break;
          }
        }
      }
      if (collided) {
        const [employeeId, date] = bucketKey.split('|');
        overlaps.push({
          employeeId,
          fullName: fullNameOf(bucket[0].employee),
          date,
          reason: 'Two shifts on one day',
        });
      }
    }

    const workingDayKeys = dayKeys.filter((k) => calendar.anyBranchOpen(k));
    const byDay = dayKeys.map((dayKey) => ({
      date: dayKey,
      scheduled: perDay.get(dayKey)?.size ?? 0,
      expected: calendar.expectedOn(dayKey),
      isWorkingDay: calendar.anyBranchOpen(dayKey),
    }));

    const workingWithCounts = byDay.filter((d) => d.isWorkingDay);
    const thinnestDay = workingWithCounts.length
      ? workingWithCounts.reduce((min, d) =>
          d.scheduled < min.scheduled ? d : min,
        )
      : null;

    return {
      rows,
      roster,
      configs,
      holidayIndex,
      dayKeys,
      workingDayKeys,
      calendar,
      scheduledEmployees,
      perDay,
      perEmployeeDay,
      onHoliday,
      onWeeklyOff,
      overlaps,
      byDay,
      thinnestDay,
      activeHeadcount: roster.length,
      coverageGaps: gapsBelowMedian(
        workingDayKeys.map((k) => perDay.get(k)?.size ?? 0),
      ),
    };
  }

  /**
   * Which days each BRANCH is open, and how many people that accounts for.
   *
   * Branch is the unit because the working week is a branch property. One shared
   * calendar would report every Friday in an Oman branch as a coverage hole, and
   * a bucket that expects nobody on a closed day is what keeps a rest day from
   * drawing a full-height bar of unassignment.
   */
  private branchCalendar(
    dayKeys: string[],
    roster: Array<{ branchId: string | null }>,
    configs: Map<string, ResolvedBranchConfig>,
    holidayIndex: Map<string, ResolvedHoliday[]>,
  ) {
    const headcount = new Map<string, number>();
    for (const employee of roster) {
      const branchKey = employee.branchId ?? '';
      headcount.set(branchKey, (headcount.get(branchKey) ?? 0) + 1);
    }

    const openDays = new Map<string, Set<string>>();
    for (const branchKey of headcount.keys()) {
      const config = this.calendar.configFor(configs, branchKey || null);
      const open = new Set<string>();
      for (const dayKey of dayKeys) {
        if (this.calendar.isBranchWorkingDay(config, dayKey, holidayIndex)) {
          open.add(dayKey);
        }
      }
      openDays.set(branchKey, open);
    }

    return {
      headcount,
      /** How many people the calendar says should be at work on one date. */
      expectedOn: (dayKey: string): number => {
        let total = 0;
        for (const [branchKey, count] of headcount) {
          if (openDays.get(branchKey)?.has(dayKey)) total += count;
        }
        return total;
      },
      /** True when at least one branch was open — the day counts as a working day. */
      anyBranchOpen: (dayKey: string): boolean => {
        for (const open of openDays.values()) if (open.has(dayKey)) return true;
        return false;
      },
    };
  }

  /** Who has no shift at all — the people who will not know to turn up. */
  async unscheduledNames(
    scheduled: Set<string>,
    actor?: ScheduleActor,
  ): Promise<string[]> {
    const rows = await this.prisma.employee.findMany({
      where: {
        ...(await this.employeeScope(actor)),
        ...(scheduled.size ? { id: { notIn: [...scheduled] } } : {}),
      },
      select: { firstName: true, lastName: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: NAME_CAP,
    });
    return rows.map(fullNameOf).filter(Boolean);
  }
}

export interface ConflictSample {
  employeeId: string;
  fullName: string;
  date: string;
  reason: string;
}

/**
 * Working days whose headcount sits below the window's OWN median.
 *
 * Not an absolute threshold: a six-person branch and a six-hundred-person one
 * have different normals, and a fixed number would shout at one and stay silent
 * for the other. Under three working days there is no meaningful middle, so it
 * reports nothing rather than noise.
 */
export function gapsBelowMedian(counts: number[]): number {
  if (counts.length < 3) return 0;
  const middle = median(counts);
  return counts.filter((n) => n < middle).length;
}

/**
 * Every day key in a closed range.
 *
 * Day keys are ISO, so a lexicographic comparison IS a chronological one — but
 * the walk itself goes through luxon rather than through `Date` arithmetic, so
 * a month boundary is the calendar's business and not this function's.
 */
export function dayKeysBetween(startKey: string, endKey: string): string[] {
  const keys: string[] = [];
  let cursor = DateTime.fromFormat(startKey, 'yyyy-MM-dd', { zone: 'utc' });
  const last = DateTime.fromFormat(endKey, 'yyyy-MM-dd', { zone: 'utc' });
  if (!cursor.isValid || !last.isValid) return keys;
  while (cursor <= last) {
    keys.push(cursor.toFormat('yyyy-MM-dd'));
    cursor = cursor.plus({ days: 1 });
  }
  return keys;
}
