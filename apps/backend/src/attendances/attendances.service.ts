import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceStatus, Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import type { Principal } from '../auth/auth.service';
import {
  AttendanceCalendarService,
  type DayCalendar,
} from './attendance-calendar.service';
import {
  computeStatus,
  dayKeyToDate,
  haversineMetres,
  rate,
  resolveZone,
  round2,
  toDayKey,
  UNASSIGNED_DEPARTMENT,
} from './attendance-calendar.util';
import { ListAttendancesDto } from './dto/list-attendances.dto';
import { CheckInDto } from './dto/check-in.dto';
import { CheckOutDto } from './dto/check-out.dto';
import { CreateAttendanceDto } from './dto/create-attendance.dto';
import { UpdateAttendanceDto } from './dto/update-attendance.dto';
import { BulkAttendanceDto } from './dto/bulk-attendance.dto';
import { AttendanceSummaryDto } from './dto/attendance-summary.dto';
import { EmployeeHistoryDto } from './dto/employee-history.dto';

const ATTENDANCE_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
      department: { select: { id: true, name: true } },
      branch: { select: { id: true, code: true, name: true } },
    },
  },
  branch: { select: { id: true, code: true, name: true } },
} satisfies Prisma.AttendanceInclude;

/** The branch fields a punch needs beyond the calendar's. */
const PUNCH_BRANCH_SELECT = {
  id: true,
  name: true,
  timezone: true,
  officeStartTime: true,
  officeEndTime: true,
  graceMinutes: true,
  weeklyOffDays: true,
  geofencingEnabled: true,
  latitude: true,
  longitude: true,
  geofenceRadiusM: true,
} satisfies Prisma.BranchSelect;

/** Statuses that mean somebody was at work in some measure. */
const WORKED: AttendanceStatus[] = ['PRESENT', 'LATE', 'HALF_DAY'];

/** Roles entitled to read attendance for somebody other than themselves. */
const MANAGEMENT_ROLES: UserRole[] = [
  UserRole.ADMIN,
  UserRole.HR_MANAGER,
  UserRole.PAYROLL_OFFICER,
  UserRole.MANAGER,
];

@Injectable()
export class AttendancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: AttendanceCalendarService,
  ) {}

  async findAll(query: ListAttendancesDto) {
    const { page, limit, skip, take } = resolvePagination(query);
    const insensitive = Prisma.QueryMode.insensitive;

    const where: Prisma.AttendanceWhereInput = {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...this.dateRangeWhere(query.startDate, query.endDate),
      ...(query.departmentId || query.search
        ? {
            employee: {
              ...(query.departmentId
                ? { departmentId: query.departmentId }
                : {}),
              ...(query.search
                ? {
                    OR: [
                      {
                        employeeCode: {
                          contains: query.search,
                          mode: insensitive,
                        },
                      },
                      {
                        firstName: {
                          contains: query.search,
                          mode: insensitive,
                        },
                      },
                      {
                        lastName: { contains: query.search, mode: insensitive },
                      },
                    ],
                  }
                : {}),
            },
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.attendance.findMany({
        where,
        include: ATTENDANCE_INCLUDE,
        skip,
        take,
        // Newest day first, then a stable secondary order so page 2 does not
        // reshuffle rows that share a date.
        orderBy: [{ date: 'desc' }, { employee: { employeeCode: 'asc' } }],
      }),
      this.prisma.attendance.count({ where }),
    ]);

    return paginated(data, total, page, limit);
  }

  async findOne(id: string, user?: Principal) {
    const row = await this.prisma.attendance.findUnique({
      where: { id },
      include: ATTENDANCE_INCLUDE,
    });
    if (!row) throw new NotFoundException('Attendance record not found');
    this.assertMayRead(row.employeeId, user);
    return row;
  }

  /**
   * Somebody's own record, or a management role.
   *
   * This is enforced here rather than with `@Roles` on the route because the
   * answer depends on WHOSE record it is, which a decorator cannot see. An
   * employee reading their own attendance is answering a question about
   * themselves; the same request for a colleague's id is a question about
   * somebody else, and only a manager gets to ask it.
   *
   * `user` is optional so an internal caller — the correction-approval path
   * re-reading a row it has just written — is not made to fabricate a
   * principal for a check it has already passed.
   */
  private assertMayRead(employeeId: string, user?: Principal) {
    if (!user) return;
    if (MANAGEMENT_ROLES.includes(user.role)) return;
    if (user.employeeId && user.employeeId === employeeId) return;
    throw new ForbiddenException(
      'You do not have permission to view this attendance record',
    );
  }

  /**
   * Who is in today — everyone still on the books, row or no row.
   *
   * Terminated records are excluded and nothing else is: somebody suspended or
   * on long leave is still part of "who is in today", and dropping them would
   * make the panel disagree with the headcount beside it.
   *
   * An employee with no row appears as ABSENT rather than as a fourth
   * "NOT_CHECKED_IN" status: the enum a payroll run reads has no such member,
   * and inventing one only for this endpoint would mean every consumer of the
   * status column had two vocabularies to learn. The distinction that actually
   * matters is carried alongside instead — `hasRecord` says whether anything
   * was ever written, and `settled` says whether the branch's day has closed.
   * Before it closes, "absent" is a prediction, not a fact.
   */
  async today() {
    const [configs, companyZone] = await Promise.all([
      this.calendar.branchConfigs(),
      this.calendar.companyTimezone(),
    ]);

    const employees = await this.prisma.employee.findMany({
      where: { status: { not: 'TERMINATED' } },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        position: true,
        avatarUrl: true,
        status: true,
        timezone: true,
        branchId: true,
        department: { select: { id: true, name: true } },
        branch: { select: { id: true, code: true, name: true } },
      },
      orderBy: { employeeCode: 'asc' },
    });

    // Branches in different zones can be on different calendar days at the same
    // instant, so "today" is resolved per branch and the rows for every day key
    // in play are fetched at once.
    const dayKeys = new Set<string>();
    const keyFor = new Map<string, string>();
    for (const employee of employees) {
      const config = this.calendar.configFor(configs, employee.branchId);
      const key = this.calendar.todayIn(
        employee.timezone?.trim() || config.zone,
      );
      keyFor.set(employee.id, key);
      dayKeys.add(key);
    }

    const [rows, holidayIndex] = await Promise.all([
      this.prisma.attendance.findMany({
        where: { date: { in: [...dayKeys].map(dayKeyToDate) } },
        include: ATTENDANCE_INCLUDE,
      }),
      this.calendar.holidayIndex(
        [...dayKeys].sort()[0] ?? this.calendar.todayIn(companyZone),
        [...dayKeys].sort().at(-1) ?? this.calendar.todayIn(companyZone),
      ),
    ]);

    const byEmployeeDay = new Map(
      rows.map((r) => [`${r.employeeId}|${toDayKey(r.date)}`, r]),
    );

    const now = DateTime.now();
    const records = employees.map((employee) => {
      const dayKey = keyFor.get(employee.id) as string;
      const config = this.calendar.configFor(configs, employee.branchId);
      const holiday = this.calendar.holidayOn(
        holidayIndex,
        dayKey,
        employee.branchId,
      );
      const expectedToWork = this.calendar.isBranchWorkingDay(
        config,
        dayKey,
        holidayIndex,
      );
      const settled = this.calendar.officeEndInstant(dayKey, config) <= now;
      const row = byEmployeeDay.get(`${employee.id}|${dayKey}`);

      return {
        attendanceId: row?.id ?? null,
        hasRecord: Boolean(row),
        date: dayKey,
        employee: {
          id: employee.id,
          employeeCode: employee.employeeCode,
          firstName: employee.firstName,
          lastName: employee.lastName,
          position: employee.position,
          avatarUrl: employee.avatarUrl,
          status: employee.status,
          department: employee.department,
          branch: employee.branch,
        },
        checkIn: row?.checkIn ?? null,
        checkOut: row?.checkOut ?? null,
        workHours: row?.workHours ?? null,
        expectedHours: row?.expectedHours ?? config.expectedHours,
        status:
          row?.status ??
          this.plannedStatus(employee.status, expectedToWork, holiday),
        source: row?.source ?? null,
        isLate: row?.isLate ?? false,
        lateMinutes: row?.lateMinutes ?? 0,
        isEarlyLeave: row?.isEarlyLeave ?? false,
        notes: row?.notes ?? null,
        expectedToWork,
        holiday,
        settled,
        zone: employee.timezone?.trim() || config.zone,
      };
    });

    const counted = (status: AttendanceStatus) =>
      records.filter((r) => r.status === status).length;

    // The totals ride along rather than being counted in the browser. `expected`
    // is the calendar-aware one — weekly rest, holidays, roster overrides and
    // whoever is already on leave — and deriving it client-side would mean
    // shipping the whole calendar there and having every consumer arrive at a
    // slightly different number.
    return {
      date: this.calendar.todayIn(companyZone),
      generatedAt: now.toJSDate(),
      totals: {
        headcount: records.length,
        expected: records.filter((r) => r.expectedToWork).length,
        present: counted('PRESENT'),
        late: counted('LATE'),
        halfDay: counted('HALF_DAY'),
        absent: counted('ABSENT'),
        onLeave: counted('ON_LEAVE'),
        checkedOut: records.filter((r) => r.checkOut).length,
        notCheckedIn: records.filter((r) => r.expectedToWork && !r.checkIn)
          .length,
      },
      records,
    };
  }

  /** The reports screen: totals, a per-day series and a department breakdown. */
  async summary(query: AttendanceSummaryDto) {
    const companyZone = await this.calendar.companyTimezone();
    const { startKey, endKey } = this.resolveRange(
      query.startDate,
      query.endDate,
      companyZone,
    );

    const where: Prisma.AttendanceWhereInput = {
      date: { gte: dayKeyToDate(startKey), lte: dayKeyToDate(endKey) },
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.departmentId
        ? { employee: { departmentId: query.departmentId } }
        : {}),
    };

    const [byDayStatus, byDayLate, byEmployee, totals] = await Promise.all([
      this.prisma.attendance.groupBy({
        by: ['date', 'status'],
        where,
        _count: { _all: true },
        _sum: { workHours: true },
      }),
      this.prisma.attendance.groupBy({
        by: ['date'],
        where: { ...where, isLate: true },
        _count: { _all: true },
        _sum: { lateMinutes: true },
      }),
      this.prisma.attendance.groupBy({
        by: ['employeeId', 'status'],
        where,
        _count: { _all: true },
        _sum: { workHours: true },
      }),
      this.prisma.attendance.aggregate({
        where,
        _count: { _all: true },
        _sum: { workHours: true, lateMinutes: true },
      }),
    ]);

    const employees = await this.prisma.employee.findMany({
      where: {
        status: { not: 'TERMINATED' },
        ...(query.branchId ? { branchId: query.branchId } : {}),
        ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      },
      select: {
        id: true,
        departmentId: true,
        department: { select: { id: true, name: true } },
      },
    });

    // ── Per-day series ───────────────────────────────────────────────────────
    const days = new Map<
      string,
      {
        date: string;
        present: number;
        late: number;
        absent: number;
        halfDay: number;
        onLeave: number;
        holiday: number;
        weekend: number;
        workHours: number;
        lateMinutes: number;
      }
    >();
    const dayRow = (key: string) => {
      let row = days.get(key);
      if (!row) {
        row = {
          date: key,
          present: 0,
          late: 0,
          absent: 0,
          halfDay: 0,
          onLeave: 0,
          holiday: 0,
          weekend: 0,
          workHours: 0,
          lateMinutes: 0,
        };
        days.set(key, row);
      }
      return row;
    };

    for (const group of byDayStatus) {
      const row = dayRow(toDayKey(group.date));
      const n = group._count._all;
      row.workHours = round2(row.workHours + Number(group._sum.workHours ?? 0));
      switch (group.status) {
        case 'PRESENT':
          row.present += n;
          break;
        case 'LATE':
          row.late += n;
          break;
        case 'ABSENT':
          row.absent += n;
          break;
        case 'HALF_DAY':
          row.halfDay += n;
          break;
        case 'ON_LEAVE':
          row.onLeave += n;
          break;
        case 'HOLIDAY':
          row.holiday += n;
          break;
        case 'WEEKEND':
          row.weekend += n;
          break;
      }
    }
    for (const group of byDayLate) {
      dayRow(toDayKey(group.date)).lateMinutes = group._sum.lateMinutes ?? 0;
    }

    // Each day's own rate, divided by what that day actually recorded. A day
    // with no rows at all has no rate — the chart draws a gap rather than a
    // zero, which would read as nobody turning up.
    const daily = [...days.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((row) => ({
        ...row,
        attendanceRate: rate(
          row.present + row.late + row.halfDay,
          row.present + row.late + row.halfDay + row.absent,
        ),
      }));

    // ── Per-department breakdown ─────────────────────────────────────────────
    // Attendance groups by employee, not by department: `departmentId` lives on
    // the employee, and Prisma's groupBy cannot reach across the relation. The
    // employee list is loaded anyway for headcount, so the join happens here.
    const deptOf = new Map(employees.map((e) => [e.id, e.departmentId]));
    const deptNames = new Map<string, string>();
    const headcount = new Map<string, number>();
    for (const employee of employees) {
      const key = employee.departmentId ?? '';
      headcount.set(key, (headcount.get(key) ?? 0) + 1);
      if (employee.department) deptNames.set(key, employee.department.name);
    }

    const deptStats = new Map<
      string,
      {
        present: number;
        late: number;
        absent: number;
        onLeave: number;
        workHours: number;
      }
    >();
    for (const group of byEmployee) {
      const key = deptOf.get(group.employeeId) ?? '';
      const stats = deptStats.get(key) ?? {
        present: 0,
        late: 0,
        absent: 0,
        onLeave: 0,
        workHours: 0,
      };
      const n = group._count._all;
      if (WORKED.includes(group.status)) stats.present += n;
      if (group.status === 'LATE') stats.late += n;
      if (group.status === 'ABSENT') stats.absent += n;
      if (group.status === 'ON_LEAVE') stats.onLeave += n;
      stats.workHours = round2(
        stats.workHours + Number(group._sum.workHours ?? 0),
      );
      deptStats.set(key, stats);
    }

    const departments = [...headcount.entries()]
      .map(([key, count]) => {
        const stats = deptStats.get(key);
        const present = stats?.present ?? 0;
        const absent = stats?.absent ?? 0;
        return {
          id: key || UNASSIGNED_DEPARTMENT,
          name: deptNames.get(key) ?? 'Unassigned',
          headcount: count,
          present,
          late: stats?.late ?? 0,
          absent,
          onLeave: stats?.onLeave ?? 0,
          workHours: stats?.workHours ?? 0,
          attendanceRate: rate(present, present + absent),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const present = daily.reduce(
      (a, d) => a + d.present + d.late + d.halfDay,
      0,
    );
    const absent = daily.reduce((a, d) => a + d.absent, 0);
    const records = totals._count._all;
    const workHours = round2(Number(totals._sum.workHours ?? 0));

    return {
      range: { startDate: startKey, endDate: endKey },
      totals: {
        records,
        present,
        late: daily.reduce((a, d) => a + d.late, 0),
        halfDay: daily.reduce((a, d) => a + d.halfDay, 0),
        absent,
        onLeave: daily.reduce((a, d) => a + d.onLeave, 0),
        holiday: daily.reduce((a, d) => a + d.holiday, 0),
        weekend: daily.reduce((a, d) => a + d.weekend, 0),
        workHours,
        // Averaged over the rows that actually recorded hours, not over every
        // row: dividing by days nobody worked reports a shorter working day
        // than anyone worked.
        avgWorkHours: present ? round2(workHours / present) : null,
        lateMinutes: totals._sum.lateMinutes ?? 0,
        // Divided by what was recorded, never by headcount — see the hub.
        attendanceRate: rate(present, present + absent),
      },
      daily,
      departments,
    };
  }

  /** One person's history, with the totals their own screen shows. */
  async findByEmployee(
    employeeId: string,
    query: EmployeeHistoryDto,
    user?: Principal,
  ) {
    this.assertMayRead(employeeId, user);
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        department: { select: { id: true, name: true } },
        branch: { select: { id: true, code: true, name: true } },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const companyZone = await this.calendar.companyTimezone();
    const { startKey, endKey } = this.resolveRange(
      query.startDate,
      query.endDate,
      companyZone,
    );

    const records = await this.prisma.attendance.findMany({
      where: {
        employeeId,
        date: { gte: dayKeyToDate(startKey), lte: dayKeyToDate(endKey) },
      },
      orderBy: { date: 'desc' },
    });

    const count = (status: AttendanceStatus) =>
      records.filter((r) => r.status === status).length;
    const present = records.filter((r) => WORKED.includes(r.status)).length;
    const workHours = round2(
      records.reduce((a, r) => a + Number(r.workHours ?? 0), 0),
    );

    return {
      employee,
      range: { startDate: startKey, endDate: endKey },
      summary: {
        records: records.length,
        present,
        late: count('LATE'),
        halfDay: count('HALF_DAY'),
        absent: count('ABSENT'),
        onLeave: count('ON_LEAVE'),
        workHours,
        avgWorkHours: present ? round2(workHours / present) : null,
        lateMinutes: records.reduce((a, r) => a + r.lateMinutes, 0),
        attendanceRate: rate(present, present + count('ABSENT')),
      },
      records,
    };
  }

  /** The ESS punch in. */
  async checkIn(user: Principal, dto: CheckInDto) {
    const { employee, branch, zone, dayKey, day } =
      await this.punchContext(user);

    const existing = await this.prisma.attendance.findUnique({
      where: {
        employeeId_date: {
          employeeId: employee.id,
          date: dayKeyToDate(dayKey),
        },
      },
    });
    if (existing?.checkIn) {
      throw new ConflictException(
        `You already checked in today at ${DateTime.fromJSDate(existing.checkIn, { zone }).toFormat('HH:mm')}`,
      );
    }

    this.assertInsideGeofence(branch, dto.latitude, dto.longitude);

    const now = new Date();
    const derived = computeStatus({
      checkIn: now,
      checkOut: null,
      expected: day.expectedHours,
      graceMinutes: day.graceMinutes,
      officeStart: day.officeStart,
      zone: day.zone,
    });

    const data = {
      checkIn: now,
      checkOut: null,
      status: derived.status,
      source: 'ESS' as const,
      isLate: derived.isLate,
      lateMinutes: derived.lateMinutes,
      isEarlyLeave: false,
      workHours: null,
      expectedHours: day.expectedHours,
      checkInLatitude: dto.latitude ?? null,
      checkInLongitude: dto.longitude ?? null,
      notes: dto.notes ?? null,
      // Denormalised on purpose: the row must stay with the branch where the
      // punch actually happened. Reading it through the employee instead would
      // silently rewrite last year's timesheets the day somebody transfers.
      branchId: employee.branchId,
    };

    return this.prisma.attendance.upsert({
      where: {
        employeeId_date: {
          employeeId: employee.id,
          date: dayKeyToDate(dayKey),
        },
      },
      create: { employeeId: employee.id, date: dayKeyToDate(dayKey), ...data },
      update: data,
      include: ATTENDANCE_INCLUDE,
    });
  }

  /** The ESS punch out. */
  async checkOut(user: Principal, dto: CheckOutDto) {
    const { employee, zone, dayKey } = await this.punchContext(user);

    // A night shift is checked out on the following calendar day, and the row
    // it belongs to is yesterday's. Today first, then one day back — and only
    // for a row that is genuinely still open.
    const candidates = [dayKey, this.shiftDay(dayKey, -1)];
    let row: Awaited<ReturnType<typeof this.prisma.attendance.findUnique>> =
      null;
    for (const key of candidates) {
      const found = await this.prisma.attendance.findUnique({
        where: {
          employeeId_date: { employeeId: employee.id, date: dayKeyToDate(key) },
        },
      });
      if (found?.checkIn && !found.checkOut) {
        row = found;
        break;
      }
      if (key === dayKey && found) row = found;
    }

    if (!row?.checkIn) {
      throw new BadRequestException('You have not checked in today');
    }
    if (row.checkOut) {
      throw new ConflictException(
        `You already checked out at ${DateTime.fromJSDate(row.checkOut, { zone }).toFormat('HH:mm')}`,
      );
    }

    const day = await this.calendar.resolveDay(employee.id, toDayKey(row.date));
    const now = new Date();
    const derived = computeStatus({
      checkIn: row.checkIn,
      checkOut: now,
      expected: day.expectedHours,
      graceMinutes: day.graceMinutes,
      officeStart: day.officeStart,
      zone: day.zone,
    });

    return this.prisma.attendance.update({
      where: { id: row.id },
      data: {
        checkOut: now,
        workHours: derived.workHours,
        status: derived.status,
        isLate: derived.isLate,
        lateMinutes: derived.lateMinutes,
        isEarlyLeave: derived.isEarlyLeave,
        checkOutLatitude: dto.latitude ?? null,
        checkOutLongitude: dto.longitude ?? null,
        ...(dto.notes ? { notes: dto.notes } : {}),
      },
      include: ATTENDANCE_INCLUDE,
    });
  }

  /** A row entered by hand for somebody else. */
  async create(dto: CreateAttendanceDto) {
    const context = await this.calendar.employeeContext(dto.employeeId);
    const clash = await this.prisma.attendance.findUnique({
      where: {
        employeeId_date: {
          employeeId: dto.employeeId,
          date: dayKeyToDate(dto.date),
        },
      },
    });
    if (clash) {
      throw new ConflictException(
        `An attendance record already exists for that employee on ${dto.date}`,
      );
    }

    const day = await this.calendar.resolveDay(
      dto.employeeId,
      dto.date,
      context,
    );
    const derived = this.derive(
      dto.checkIn ? new Date(dto.checkIn) : null,
      dto.checkOut ? new Date(dto.checkOut) : null,
      day,
      dto.status,
    );

    return this.prisma.attendance.create({
      data: {
        employeeId: dto.employeeId,
        date: dayKeyToDate(dto.date),
        branchId: context.branchId,
        checkIn: dto.checkIn ? new Date(dto.checkIn) : null,
        checkOut: dto.checkOut ? new Date(dto.checkOut) : null,
        expectedHours: day.expectedHours,
        notes: dto.notes ?? null,
        source: 'MANUAL',
        ...derived,
      },
      include: ATTENDANCE_INCLUDE,
    });
  }

  /**
   * Edit a row's times.
   *
   * The status is always re-derived from whatever times end up on the row. A
   * client-sent PRESENT beside a check-out that never happened is a claim the
   * payroll run would then believe, so the only statuses accepted are the ones
   * no clock can express, and those only while the row has no check-in.
   */
  async update(id: string, dto: UpdateAttendanceDto) {
    const row = await this.findOne(id);
    const day = await this.calendar.resolveDay(
      row.employeeId,
      toDayKey(row.date),
    );

    const checkIn =
      dto.checkIn === undefined
        ? row.checkIn
        : dto.checkIn === null
          ? null
          : new Date(dto.checkIn);
    const checkOut =
      dto.checkOut === undefined
        ? row.checkOut
        : dto.checkOut === null
          ? null
          : new Date(dto.checkOut);

    if (checkIn && checkOut && checkOut.getTime() < checkIn.getTime()) {
      throw new BadRequestException(
        'The check-out time is before the check-in time',
      );
    }

    return this.prisma.attendance.update({
      where: { id },
      data: {
        checkIn,
        checkOut,
        expectedHours: day.expectedHours,
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        // Stamped MANUAL because a human just decided this row. A later import
        // reads the source before it overwrites anything.
        source: 'MANUAL',
        ...this.derive(checkIn, checkOut, day, dto.status, row.status),
      },
      include: ATTENDANCE_INCLUDE,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.attendance.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Mark a set of employees for one date.
   *
   * Each employee is applied on its own so one unknown id does not throw away
   * the other forty-nine rows the operator just marked. The outcome per row
   * comes back instead, which is what the screen needs to show what landed.
   */
  async bulk(dto: BulkAttendanceDto) {
    const date = dayKeyToDate(dto.date);

    const results: Array<{
      employeeId: string;
      outcome: 'created' | 'updated' | 'failed';
      message?: string;
      attendanceId?: string;
    }> = [];

    // Last entry wins on a repeated employee: the screen sends what is on it
    // now, and inserting the same person twice in one request is a UI accident
    // rather than two decisions.
    const entries = new Map(dto.entries.map((e) => [e.employeeId, e]));

    for (const [employeeId, entry] of entries) {
      try {
        const checkIn = entry.checkIn ? new Date(entry.checkIn) : null;
        const checkOut = entry.checkOut ? new Date(entry.checkOut) : null;
        if (checkIn && checkOut && checkOut.getTime() < checkIn.getTime()) {
          throw new BadRequestException(
            'The check-out time is before the check-in time',
          );
        }

        const context = await this.calendar.employeeContext(employeeId);
        const day = await this.calendar.resolveDay(
          employeeId,
          dto.date,
          context,
        );
        const derived = this.derive(checkIn, checkOut, day, entry.status);

        const existing = await this.prisma.attendance.findUnique({
          where: { employeeId_date: { employeeId, date } },
          select: { id: true },
        });

        const row = await this.prisma.attendance.upsert({
          where: { employeeId_date: { employeeId, date } },
          create: {
            employeeId,
            date,
            branchId: context.branchId,
            checkIn,
            checkOut,
            expectedHours: day.expectedHours,
            notes: entry.notes ?? null,
            source: 'MANUAL',
            ...derived,
          },
          update: {
            checkIn,
            checkOut,
            expectedHours: day.expectedHours,
            ...(entry.notes !== undefined ? { notes: entry.notes } : {}),
            source: 'MANUAL',
            ...derived,
          },
          select: { id: true },
        });

        results.push({
          employeeId,
          outcome: existing ? 'updated' : 'created',
          attendanceId: row.id,
        });
      } catch (error) {
        results.push({
          employeeId,
          outcome: 'failed',
          message:
            error instanceof Error
              ? error.message
              : 'Could not mark this employee',
        });
      }
    }

    const failed = results
      .filter((r) => r.outcome === 'failed')
      .map((r) => ({ employeeId: r.employeeId, message: r.message ?? '' }));

    return {
      date: dto.date,
      applied: results.length - failed.length,
      created: results.filter((r) => r.outcome === 'created').length,
      updated: results.filter((r) => r.outcome === 'updated').length,
      failed,
      results,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Status, hours and lateness for a set of times.
   *
   * PRESENT, LATE and HALF_DAY are always COMPUTED from the times on the row —
   * a caller asserting one of them would be overwriting the calculation the
   * payroll run later reads. The other four say something the clock cannot
   * know, so those are the only ones a human hands us, and only for a day with
   * no punch on it. A contradiction between the two is refused rather than
   * quietly resolved: a request marking somebody ON_LEAVE with a check-in
   * beside it means the sender believes something the row cannot express.
   *
   * `current` keeps an existing non-punch verdict alive across an edit that
   * does not mention it — otherwise every approved leave day would collapse to
   * an unexplained absence the moment somebody corrected a note on it.
   */
  private derive(
    checkIn: Date | null,
    checkOut: Date | null,
    day: DayCalendar,
    requested?: AttendanceStatus,
    current?: AttendanceStatus,
  ) {
    const derived = computeStatus({
      checkIn,
      checkOut,
      expected: day.expectedHours,
      graceMinutes: day.graceMinutes,
      officeStart: day.officeStart,
      zone: day.zone,
    });

    if (requested && WORKED.includes(requested) && !checkIn) {
      throw new BadRequestException(
        `${requested} cannot be recorded without a check-in time`,
      );
    }
    if (requested && !WORKED.includes(requested) && checkIn) {
      throw new BadRequestException(
        `A record with a check-in cannot be marked ${requested}`,
      );
    }

    const inherited =
      !checkIn && current && !WORKED.includes(current) ? current : undefined;
    const status = checkIn
      ? derived.status
      : (requested ?? inherited ?? derived.status);

    return {
      status,
      workHours: derived.workHours,
      isLate: derived.isLate,
      lateMinutes: derived.lateMinutes,
      isEarlyLeave: derived.isEarlyLeave,
    };
  }

  /** Everything a punch needs: the employee, their branch, their clock, today. */
  private async punchContext(user: Principal) {
    if (!user.employeeId) {
      throw new ForbiddenException(
        'Your account is not linked to an employee record, so it cannot record attendance',
      );
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: user.employeeId },
      select: {
        id: true,
        status: true,
        timezone: true,
        branchId: true,
        branch: { select: PUNCH_BRANCH_SELECT },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    if (employee.status === 'TERMINATED') {
      throw new ForbiddenException(
        'This employee record has been terminated and cannot record attendance',
      );
    }

    // The zone has to be resolved BEFORE the day key: which calendar day a
    // punch belongs to is a question only the employee's own clock can answer,
    // and asking the server's would file an 08:00 Muscat punch under yesterday.
    const companyZone = await this.calendar.companyTimezone();
    const zone = resolveZone(employee, employee.branch, companyZone);
    const dayKey = this.calendar.todayIn(zone);
    const day = await this.calendar.resolveDay(employee.id, dayKey, employee);

    return { employee, branch: employee.branch, zone, dayKey, day };
  }

  /**
   * A punch outside the fence is refused with the distance in the message.
   *
   * "You are too far away" leaves the employee with nothing to act on; "you are
   * 480 m from Head Office, the fence is 150 m" tells them whether to walk or
   * to call HR. An incomplete fence is treated as no fence — the branches
   * service refuses to store one, and guessing a centre here would be worse.
   */
  private assertInsideGeofence(
    branch: {
      name: string;
      geofencingEnabled: boolean | null;
      latitude: Prisma.Decimal | null;
      longitude: Prisma.Decimal | null;
      geofenceRadiusM: number | null;
    } | null,
    latitude?: number,
    longitude?: number,
  ) {
    if (!branch?.geofencingEnabled) return;
    if (!branch.latitude || !branch.longitude || !branch.geofenceRadiusM)
      return;

    if (latitude === undefined || longitude === undefined) {
      throw new BadRequestException(
        `${branch.name} requires your location to check in. Enable location access and try again.`,
      );
    }

    const distance = haversineMetres(
      Number(branch.latitude),
      Number(branch.longitude),
      latitude,
      longitude,
    );
    if (distance > branch.geofenceRadiusM) {
      throw new BadRequestException(
        `You are ${Math.round(distance)} m from ${branch.name}. Check-in is allowed within ${branch.geofenceRadiusM} m.`,
      );
    }
  }

  private plannedStatus(
    employeeStatus: string,
    expectedToWork: boolean,
    holiday: { name: string } | null,
  ): AttendanceStatus {
    if (employeeStatus === 'ON_LEAVE') return 'ON_LEAVE';
    if (holiday) return 'HOLIDAY';
    if (!expectedToWork) return 'WEEKEND';
    return 'ABSENT';
  }

  private dateRangeWhere(startDate?: string, endDate?: string) {
    if (!startDate && !endDate) return {};
    return {
      date: {
        ...(startDate ? { gte: dayKeyToDate(startDate) } : {}),
        ...(endDate ? { lte: dayKeyToDate(endDate) } : {}),
      },
    };
  }

  /** Defaults to the last 30 days, ending today in the company's clock. */
  private resolveRange(
    startDate: string | undefined,
    endDate: string | undefined,
    zone: string,
  ) {
    const endKey = endDate ?? this.calendar.todayIn(zone);
    const startKey = startDate ?? this.shiftDay(endKey, -29);
    if (startKey > endKey) {
      throw new BadRequestException('startDate must not be after endDate');
    }
    return { startKey, endKey };
  }

  private shiftDay(dayKey: string, days: number): string {
    return DateTime.fromFormat(dayKey, 'yyyy-MM-dd', { zone: 'utc' })
      .plus({ days })
      .toFormat('yyyy-MM-dd');
  }
}
