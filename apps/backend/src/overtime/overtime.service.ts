import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OvertimeDayType,
  OvertimeType,
  Prisma,
  RequestStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import {
  assertCanAccessRequestOf,
  isInManagerScope,
  managerDepartmentIds,
} from '../common/utils/manager-scope.util';
import { dayKeyToDate } from '../attendances/attendance-calendar.util';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import type { Principal } from '../auth/auth.service';
import { WorkingDaysService } from '../leave-requests/working-days.service';
import { OvertimePolicyService } from '../overtime-policy/overtime-policy.service';
import type { ResolvedOvertimeConfig } from '../overtime-policy/overtime-policy.types';
import { CreateOvertimeDto } from './dto/create-overtime.dto';
import { ApproveOvertimeDto } from './dto/approve-overtime.dto';
import { RejectOvertimeDto } from './dto/reject-overtime.dto';
import { ListOvertimeDto } from './dto/list-overtime.dto';
import {
  parseThresholdMinutes,
  splitOvertimeHours,
} from './overtime-calc.util';

const OVERTIME_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
      position: true,
      branchId: true,
      departmentId: true,
      supervisorId: true,
      employmentType: true,
      overtimePolicyId: true,
      department: { select: { id: true, name: true } },
      branch: { select: { id: true, code: true, name: true } },
    },
  },
  overtimePolicy: { select: { id: true, name: true } },
  approver: { select: { id: true, email: true } },
  editedBy: { select: { id: true, email: true } },
} satisfies Prisma.OvertimeRequestInclude;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The payable shape of one worked window, before anything is written. */
export interface OvertimeBreakdown {
  hours: number;
  regularHours: number;
  lateHours: number;
  doubleHours: number;
  doubleLateHours: number;
  dayType: OvertimeDayType;
  foodAllowance: number;
  otType: OvertimeType;
}

/**
 * Overtime: filing it, deciding it, and reporting on it.
 *
 * The arithmetic lives in `overtime-calc.util.ts` and the rules that feed it in
 * `OvertimePolicyService`. What is here is everything that needs a database: the
 * caps, the day classification, the guards, and the exact ORDER in which an
 * approval writes.
 */
@Injectable()
export class OvertimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: OvertimePolicyService,
    private readonly systemSettings: SystemSettingsService,
    private readonly workingDays: WorkingDaysService,
  ) {}

  // ── Filing ─────────────────────────────────────────────────────────────────

  async create(
    employeeId: string | null,
    dto: CreateOvertimeDto,
    user: Principal,
  ) {
    // An ADMIN account need not be linked to an employee record. Passing an
    // undefined id straight through reached `findUnique({ where: { id:
    // undefined } })`, which is a 500 carrying the Prisma invocation and the
    // absolute source path of this file to the caller.
    if (!employeeId) {
      throw new BadRequestException(
        'This request needs an employee. Your account is not linked to one, so name the employee explicitly.',
      );
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        branchId: true,
        departmentId: true,
        employmentType: true,
        overtimePolicyId: true,
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const cfg = await this.settings.resolveOvertimeConfig(employee);
    if (!cfg.enabled) {
      throw new BadRequestException(
        'Overtime is switched off for this company',
      );
    }
    if (user.role === UserRole.EMPLOYEE && !cfg.allowEmployeeSubmit) {
      throw new ForbiddenException(
        'Filing your own overtime is disabled. Ask your supervisor to record it for you.',
      );
    }
    if (!cfg.eligible) {
      throw new ForbiddenException(
        'This employee is not eligible for overtime under their assigned policy',
      );
    }

    const reason = (dto.reason ?? '').trim();
    if (cfg.requireReason && !reason) {
      throw new BadRequestException('A reason for the overtime is required');
    }

    const { startTime, endTime } = this.readWindow(dto.startTime, dto.endTime);

    // The typed figure is checked against the window rather than trusted. A
    // tenth of an hour of slack covers rounding in the browser; anything more is
    // a disagreement the employee has to resolve, not one the server should
    // silently settle in either direction.
    const windowHours = (endTime.getTime() - startTime.getTime()) / 3_600_000;
    if (Math.abs(windowHours - dto.hours) > 0.1) {
      throw new BadRequestException(
        `Hours do not match the times given. The window is ${windowHours.toFixed(2)}h, you entered ${dto.hours}h.`,
      );
    }

    const date = dayKeyToDate(dto.date.slice(0, 10));
    const { dayType, isDoubleOtDay } = await this.classifyDay(
      date,
      employee.branchId,
      cfg,
    );

    // A rest day allows a full shift; an ordinary weekday allows the few hours
    // after it. One cap for both would either forbid rest-day work or wave
    // through a fourteen-hour Tuesday.
    const dailyCap = isDoubleOtDay
      ? cfg.maxHoursPerDoubleDay
      : cfg.maxHoursPerDay;
    if (dto.hours > dailyCap) {
      throw new BadRequestException(
        `Daily overtime limit exceeded (${dailyCap}h). Filed: ${dto.hours}h`,
      );
    }

    await this.assertOutsideWorkHours(startTime, cfg, isDoubleOtDay);
    await this.assertWithinPeriodCaps(employeeId, date, dto.hours, cfg);

    const existing = await this.prisma.overtimeRequest.findFirst({
      where: {
        employeeId,
        date,
        status: { in: [RequestStatus.PENDING, RequestStatus.APPROVED] },
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'An overtime request already exists for this date',
      );
    }

    const breakdown = this.computeBreakdown(startTime, endTime, dayType, cfg);

    return this.prisma.overtimeRequest.create({
      data: {
        employeeId,
        date,
        startTime,
        endTime,
        hours: breakdown.hours,
        regularHours: breakdown.regularHours,
        lateHours: breakdown.lateHours,
        doubleHours: breakdown.doubleHours,
        doubleLateHours: breakdown.doubleLateHours,
        dayType: breakdown.dayType,
        otType: breakdown.otType,
        foodAllowance: breakdown.foodAllowance,
        // The governing policy is snapshotted at filing, and again at approval,
        // so payroll monetizes against the rules that classified these hours.
        overtimePolicyId: cfg.policyId,
        reason,
        status: RequestStatus.PENDING,
      },
      include: OVERTIME_INCLUDE,
    });
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  async findAll(query: ListOvertimeDto, user: Principal) {
    const { page, limit, skip, take } = resolvePagination(query);
    const scope = await managerDepartmentIds(this.prisma, user);
    const insensitive = Prisma.QueryMode.insensitive;

    const where: Prisma.OvertimeRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.otType ? { otType: query.otType } : {}),
      ...this.dateWindow(query),
      ...this.scopeToCaller(query.employeeId, user, scope),
      ...(query.search
        ? {
            OR: [
              { reason: { contains: query.search, mode: insensitive } },
              {
                employee: {
                  firstName: { contains: query.search, mode: insensitive },
                },
              },
              {
                employee: {
                  lastName: { contains: query.search, mode: insensitive },
                },
              },
              {
                employee: {
                  employeeCode: { contains: query.search, mode: insensitive },
                },
              },
            ],
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.overtimeRequest.findMany({
        where,
        include: OVERTIME_INCLUDE,
        skip,
        take,
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.overtimeRequest.count({ where }),
    ]);

    return paginated(data, total, page, limit);
  }

  /**
   * Queue health.
   *
   * `avgDecisionHours` is null when nothing has ever been decided — zero would
   * read as "decided instantly", which is the opposite of the truth for a queue
   * nobody has opened.
   */
  async stats(user: Principal) {
    const scope = await managerDepartmentIds(this.prisma, user);
    const where = this.scopeToCaller(undefined, user, scope);

    const [byStatus, decided, approvedHours] = await Promise.all([
      this.prisma.overtimeRequest.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.overtimeRequest.findMany({
        where: { ...where, approvedAt: { not: null } },
        select: { createdAt: true, approvedAt: true },
      }),
      this.prisma.overtimeRequest.aggregate({
        where: { ...where, status: RequestStatus.APPROVED },
        _sum: { hours: true },
      }),
    ]);

    const count = (status: RequestStatus) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;

    const hours = decided.map(
      (row) =>
        ((row.approvedAt as Date).getTime() - row.createdAt.getTime()) /
        3_600_000,
    );

    return {
      pending: count(RequestStatus.PENDING),
      approved: count(RequestStatus.APPROVED),
      rejected: count(RequestStatus.REJECTED),
      cancelled: count(RequestStatus.CANCELLED),
      total: byStatus.reduce((a, row) => a + row._count._all, 0),
      approvedHours: Number(approvedHours._sum.hours ?? 0),
      avgDecisionHours: hours.length
        ? Math.round((hours.reduce((a, h) => a + h, 0) / hours.length) * 100) /
          100
        : null,
    };
  }

  /**
   * One request, with the live breakdown the review screen draws.
   *
   * The preview is computed HERE rather than in the browser. A client-side
   * recompute reads the global settings and so ignores both the employee's
   * overtime policy and the branch-aware rest-day/holiday classification — which
   * is how a request the server classified as LATE with a food allowance renders
   * as REGULAR with a blank allowance on the page that decides it.
   */
  async findOne(id: string, user: Principal, opts?: { withPreview?: boolean }) {
    const overtime = await this.loadOrThrow(id);
    const scope = await managerDepartmentIds(this.prisma, user);
    assertCanAccessRequestOf(user, overtime.employee, scope);

    if (!opts?.withPreview) return overtime;
    return { ...overtime, preview: await this.buildPreview(overtime) };
  }

  // ── Deciding ───────────────────────────────────────────────────────────────

  async approve(id: string, user: Principal, dto?: ApproveOvertimeDto) {
    const overtime = await this.loadOrThrow(id);
    await this.assertMayDecide(overtime, user);
    if (overtime.status !== RequestStatus.PENDING) {
      throw new BadRequestException(
        `This request was already ${overtime.status.toLowerCase()} and cannot be approved`,
      );
    }

    // Corrections are persisted BEFORE the decision is recorded, and the
    // finalize step below then recomputes from the STORED window — which is now
    // the corrected one. Writing them the other way round would have the
    // approval freeze the numbers the employee filed and then overwrite the
    // times underneath them, so the hours and the window would disagree.
    if (this.hasApproverEdit(dto)) {
      await this.applyApproverEdit(id, dto, user, overtime);
    }

    return this.finalizeApproval(id, user.id);
  }

  /**
   * A dry run of an approver's corrections. Nothing is written.
   *
   * It exists because the browser cannot answer the question: the figure depends
   * on the employee's policy and on the branch calendar, neither of which the
   * page has. An approver about to change the money has to see the real number
   * before they commit to it.
   */
  async previewApproverEdit(
    id: string,
    dto: ApproveOvertimeDto,
    user: Principal,
  ) {
    const overtime = await this.loadOrThrow(id);
    await this.assertMayDecide(overtime, user);
    if (overtime.status !== RequestStatus.PENDING) {
      throw new BadRequestException('Only a pending request can be edited');
    }
    await this.assertApproverEditEnabled();

    const resolved = await this.resolveApproverEdit(overtime, dto);
    const tier = this.tierFor(resolved.cfg, resolved.breakdown.dayType);

    // Shaped exactly like `buildPreview`'s return, so the review screen reads
    // one object whether it is showing the request as filed or as corrected.
    return {
      ...resolved.breakdown,
      foodAllowance: resolved.effectiveFood,
      foodAllowanceOverride: resolved.foodAllowanceOverride ?? null,
      siteAllowance:
        resolved.siteAllowance ?? Number(overtime.siteAllowance ?? 0),
      startTime: resolved.startTime,
      endTime: resolved.endTime,
      isDoubleOtDay: resolved.breakdown.dayType !== OvertimeDayType.WEEKDAY,
      regularRate: resolved.cfg.regularRate,
      lateRate: resolved.cfg.lateRate,
      doubleRate: tier ? tier.regularRate : resolved.cfg.doubleRate,
      doubleLateRate: tier ? tier.lateRate : resolved.cfg.doubleRate,
      policyId: resolved.cfg.policyId,
      policyName: resolved.cfg.policyName,
    };
  }

  async reject(id: string, user: Principal, dto: RejectOvertimeDto) {
    const overtime = await this.loadOrThrow(id);
    await this.assertMayDecide(overtime, user);
    if (overtime.status !== RequestStatus.PENDING) {
      throw new BadRequestException(
        `This request was already ${overtime.status.toLowerCase()} and cannot be rejected`,
      );
    }

    return this.prisma.overtimeRequest.update({
      where: { id },
      data: {
        status: RequestStatus.REJECTED,
        approverId: user.id,
        approvedAt: new Date(),
        rejectedReason: dto.rejectedReason,
      },
      include: OVERTIME_INCLUDE,
    });
  }

  /** Withdrawn by the person who filed it, or by an administrator. */
  async cancel(id: string, user: Principal) {
    const overtime = await this.loadOrThrow(id);
    const isOwner =
      Boolean(user.employeeId) && overtime.employeeId === user.employeeId;
    if (!isOwner && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Only the employee who filed this request can withdraw it',
      );
    }
    if (overtime.status !== RequestStatus.PENDING) {
      throw new BadRequestException(
        `This request was already ${overtime.status.toLowerCase()} and can no longer be withdrawn`,
      );
    }

    return this.prisma.overtimeRequest.update({
      where: { id },
      data: { status: RequestStatus.CANCELLED },
      include: OVERTIME_INCLUDE,
    });
  }

  // ── Reporting ──────────────────────────────────────────────────────────────

  /** Approved hours for one employee in one month — what payroll asks for. */
  async getApprovedOvertimeHours(
    employeeId: string,
    month: number,
    year: number,
  ) {
    const result = await this.prisma.overtimeRequest.aggregate({
      where: {
        employeeId,
        status: RequestStatus.APPROVED,
        date: { gte: monthStart(year, month), lte: monthEnd(year, month) },
      },
      _sum: {
        hours: true,
        regularHours: true,
        lateHours: true,
        doubleHours: true,
        doubleLateHours: true,
        foodAllowance: true,
        siteAllowance: true,
      },
    });

    return {
      employeeId,
      month,
      year,
      hours: Number(result._sum.hours ?? 0),
      regularHours: Number(result._sum.regularHours ?? 0),
      lateHours: Number(result._sum.lateHours ?? 0),
      doubleHours: Number(result._sum.doubleHours ?? 0),
      doubleLateHours: Number(result._sum.doubleLateHours ?? 0),
      foodAllowance: Number(result._sum.foodAllowance ?? 0),
      siteAllowance: Number(result._sum.siteAllowance ?? 0),
    };
  }

  /**
   * A month's overtime, aggregated in the DATABASE.
   *
   * Counted rather than measured off a page: the previous implementation reduced
   * the first page of a paginated list, so any month with more than twenty
   * requests reported the wrong money on the one screen whose job is to say how
   * much overtime cost.
   */
  async getMonthlyReport(month: number, year: number, user: Principal) {
    const scope = await managerDepartmentIds(this.prisma, user);
    const where: Prisma.OvertimeRequestWhereInput = {
      date: { gte: monthStart(year, month), lte: monthEnd(year, month) },
      ...this.scopeToCaller(undefined, user, scope),
    };

    const [byStatus, approvedTotals, byEmployee] = await Promise.all([
      this.prisma.overtimeRequest.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.overtimeRequest.aggregate({
        where: { ...where, status: RequestStatus.APPROVED },
        _sum: {
          hours: true,
          regularHours: true,
          lateHours: true,
          doubleHours: true,
          doubleLateHours: true,
          foodAllowance: true,
          siteAllowance: true,
        },
      }),
      this.prisma.overtimeRequest.groupBy({
        by: ['employeeId'],
        where,
        _count: { _all: true },
        _sum: { hours: true },
      }),
    ]);

    // One extra query for the names, rather than a join per grouped row.
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: byEmployee.map((r) => r.employeeId) } },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        department: { select: { id: true, name: true } },
      },
    });
    const byId = new Map(employees.map((e) => [e.id, e]));

    const count = (status: RequestStatus) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;

    return {
      month,
      year,
      summary: {
        totalRequests: byStatus.reduce((a, row) => a + row._count._all, 0),
        pending: count(RequestStatus.PENDING),
        approved: count(RequestStatus.APPROVED),
        rejected: count(RequestStatus.REJECTED),
        cancelled: count(RequestStatus.CANCELLED),
        totalHours: Number(approvedTotals._sum.hours ?? 0),
        regularHours: Number(approvedTotals._sum.regularHours ?? 0),
        lateHours: Number(approvedTotals._sum.lateHours ?? 0),
        doubleHours: Number(approvedTotals._sum.doubleHours ?? 0),
        doubleLateHours: Number(approvedTotals._sum.doubleLateHours ?? 0),
        foodAllowance: Number(approvedTotals._sum.foodAllowance ?? 0),
        siteAllowance: Number(approvedTotals._sum.siteAllowance ?? 0),
      },
      byEmployee: byEmployee
        .map((row) => ({
          employee: byId.get(row.employeeId) ?? null,
          requests: row._count._all,
          hours: Number(row._sum.hours ?? 0),
        }))
        .sort((a, b) => b.hours - a.hours),
    };
  }

  // ── Internals: the window and its classification ───────────────────────────

  /**
   * Read the two instants a request was filed with.
   *
   * An end at or before the start is read as CROSSING MIDNIGHT rather than as
   * nonsense: a caller may legitimately send both timestamps on the same
   * calendar date for a 22:00–02:00 shift. The day-boundary clamp downstream
   * still caps how far such a shift is actually payable.
   */
  private readWindow(startIso: string, endIso: string) {
    const startTime = new Date(startIso);
    let endTime = new Date(endIso);
    if (endTime.getTime() <= startTime.getTime()) {
      endTime = new Date(endTime.getTime() + MS_PER_DAY);
    }
    if (endTime.getTime() <= startTime.getTime()) {
      throw new BadRequestException(
        'The end time must be after the start time',
      );
    }
    return { startTime, endTime };
  }

  /**
   * Is this a weekday, a rest day or a public holiday at this branch?
   *
   * A holiday beats a weekly-off day when a date is both — the premium the
   * company advertises for a holiday is the higher claim, and paying the rest-day
   * tier on Eid because it fell on a Friday is the sort of thing an employee
   * notices before payroll does.
   *
   * `holidayBehavior: IGNORE` skips the holiday lookup entirely: for daily-wage
   * staff a public holiday is an ordinary working day, and the request falls
   * through to the weekly-off or weekday classification with no premium.
   */
  private async classifyDay(
    date: Date,
    branchId: string | null,
    cfg: ResolvedOvertimeConfig,
  ): Promise<{ dayType: OvertimeDayType; isDoubleOtDay: boolean }> {
    const [isHoliday, isRestDay] = await Promise.all([
      cfg.holidayBehavior === 'IGNORE'
        ? Promise.resolve(false)
        : this.workingDays.isHoliday(date, branchId),
      this.workingDays.isWeeklyOff(date, branchId),
    ]);

    const dayType = isHoliday
      ? OvertimeDayType.HOLIDAY
      : isRestDay
        ? OvertimeDayType.SUNDAY
        : OvertimeDayType.WEEKDAY;

    return {
      dayType,
      isDoubleOtDay: cfg.doubleOtEnabled && dayType !== OvertimeDayType.WEEKDAY,
    };
  }

  private tierFor(cfg: ResolvedOvertimeConfig, dayType: OvertimeDayType) {
    if (dayType === OvertimeDayType.HOLIDAY) return cfg.holiday;
    if (dayType === OvertimeDayType.SUNDAY) return cfg.sunday;
    return null;
  }

  /**
   * The payable split, the food allowance and the headline tier for a window.
   *
   * Pure given a config: the only reason it is a method is that it reads nothing
   * else. Shared by filing, by the live preview and by the approval that freezes
   * the numbers, so what the approver saw is what gets written.
   */
  computeBreakdown(
    startTime: Date,
    endTime: Date,
    dayType: OvertimeDayType,
    cfg: ResolvedOvertimeConfig,
  ): OvertimeBreakdown {
    const isDoubleOtDay =
      cfg.doubleOtEnabled && dayType !== OvertimeDayType.WEEKDAY;
    const effectiveDayType = isDoubleOtDay ? dayType : OvertimeDayType.WEEKDAY;
    const tier = this.tierFor(cfg, effectiveDayType);

    const split = splitOvertimeHours(
      startTime,
      endTime,
      isDoubleOtDay,
      parseThresholdMinutes(cfg.lateThreshold),
      parseThresholdMinutes(cfg.dayEndBoundary, 23 * 60 + 59),
      parseThresholdMinutes(tier?.lateThreshold ?? cfg.lateThreshold),
    );

    // The food allowance has its OWN threshold, evaluated against the CLAMPED
    // end: an allowance for working through dinner should not be granted for
    // hours the day boundary already refused to pay.
    const foodThresholdMinutes = parseThresholdMinutes(
      cfg.foodAllowanceThreshold,
    );
    const foodThresholdInstant = new Date(
      Date.UTC(
        startTime.getUTCFullYear(),
        startTime.getUTCMonth(),
        startTime.getUTCDate(),
        Math.floor(foodThresholdMinutes / 60),
        foodThresholdMinutes % 60,
      ),
    );
    const pastFoodThreshold =
      split.effectiveEnd.getTime() > foodThresholdInstant.getTime();

    let foodAllowance = 0;
    if (cfg.foodAllowanceEnabled && split.totalHours > 0) {
      if (isDoubleOtDay) {
        if (pastFoodThreshold || cfg.doubleFoodAllowanceAnyTime) {
          foodAllowance = cfg.foodAllowanceAmount;
        }
      } else if (pastFoodThreshold) {
        foodAllowance = cfg.foodAllowanceAmount;
      }
    }

    const otType = isDoubleOtDay
      ? split.isLate
        ? OvertimeType.DOUBLE_LATE
        : OvertimeType.DOUBLE
      : split.isLate
        ? OvertimeType.LATE
        : OvertimeType.REGULAR;

    return {
      hours: split.totalHours,
      regularHours: split.regularHours,
      lateHours: split.lateHours,
      doubleHours: split.doubleHours,
      doubleLateHours: split.doubleLateHours,
      dayType: effectiveDayType,
      foodAllowance,
      otType,
    };
  }

  /**
   * Overtime has to start OUTSIDE the working day.
   *
   * Otherwise ordinary paid hours can be claimed twice — once as salary and once
   * as overtime. Held against the approver's correction as well as the
   * employee's submission, or editing a request becomes the way around the rule.
   *
   * The start is read in UTC wall clock, because that is how it is stored.
   */
  private async assertOutsideWorkHours(
    startTime: Date,
    cfg: ResolvedOvertimeConfig,
    isDoubleOtDay: boolean,
  ): Promise<void> {
    // A rest day has no working hours to overlap, when the policy says so.
    if (isDoubleOtDay && cfg.doubleOtAllowAnytime) return;

    const startMinutes =
      startTime.getUTCHours() * 60 + startTime.getUTCMinutes();
    // The start of the working day comes from the attendance settings, the same
    // place `cfg.shiftEndTime` does: the ordinary working day is one fact, and
    // two ends of it read from two places drift.
    const workStart = parseThresholdMinutes(
      await this.systemSettings.get('attendance_office_start'),
      8 * 60,
    );
    const workEnd = parseThresholdMinutes(cfg.shiftEndTime, 17 * 60);

    if (startMinutes >= workStart && startMinutes < workEnd) {
      throw new BadRequestException(
        `Overtime has to start outside regular working hours (${minutesToClock(workStart)}–${minutesToClock(workEnd)})`,
      );
    }
  }

  /**
   * The monthly and yearly ceilings.
   *
   * PENDING is counted alongside APPROVED: two pending requests that each fit
   * under the cap can together break it, and a check that ignored them would
   * approve both. `excludeId` exists for the approver edit — the row being
   * edited is itself PENDING and therefore already inside these sums, so
   * counting it would charge the employee twice and refuse an edit that LOWERS
   * the hours.
   */
  private async assertWithinPeriodCaps(
    employeeId: string,
    date: Date,
    hours: number,
    cfg: ResolvedOvertimeConfig,
    excludeId?: string,
  ) {
    const month = date.getUTCMonth() + 1;
    const year = date.getUTCFullYear();

    const [monthly, yearly] = await Promise.all([
      this.sumHours(
        employeeId,
        monthStart(year, month),
        monthEnd(year, month),
        excludeId,
      ),
      this.sumHours(
        employeeId,
        new Date(Date.UTC(year, 0, 1)),
        new Date(Date.UTC(year, 11, 31)),
        excludeId,
      ),
    ]);

    if (monthly + hours > cfg.maxHoursPerMonth) {
      throw new BadRequestException(
        `Monthly overtime limit exceeded (${cfg.maxHoursPerMonth}h). Already filed: ${monthly}h, this request: ${hours}h.`,
      );
    }
    if (yearly + hours > cfg.maxHoursPerYear) {
      throw new BadRequestException(
        `Yearly overtime limit exceeded (${cfg.maxHoursPerYear}h). Already filed: ${yearly}h, this request: ${hours}h.`,
      );
    }
  }

  private async sumHours(
    employeeId: string,
    from: Date,
    to: Date,
    excludeId?: string,
  ): Promise<number> {
    const result = await this.prisma.overtimeRequest.aggregate({
      where: {
        employeeId,
        status: { in: [RequestStatus.PENDING, RequestStatus.APPROVED] },
        ...(excludeId ? { id: { not: excludeId } } : {}),
        date: { gte: from, lte: to },
      },
      _sum: { hours: true },
    });
    return Number(result._sum.hours ?? 0);
  }

  // ── Internals: the approver edit ───────────────────────────────────────────

  /** Does this body actually ask for a change, or is it a plain approve? */
  private hasApproverEdit(dto?: ApproveOvertimeDto): dto is ApproveOvertimeDto {
    if (!dto) return false;
    return (
      dto.startTime !== undefined ||
      dto.endTime !== undefined ||
      dto.foodAllowance !== undefined ||
      dto.siteAllowance !== undefined ||
      dto.siteAllowanceNote !== undefined ||
      dto.approverNote !== undefined
    );
  }

  private async assertApproverEditEnabled(): Promise<void> {
    const cfg = await this.settings.configForPolicyId(null);
    if (!cfg.approverEditEnabled) {
      throw new BadRequestException(
        'Editing an overtime request while approving it is disabled',
      );
    }
  }

  /**
   * Validate a proposed correction and return what it would produce.
   *
   * Pure — nothing is written — so the same routine backs both the dry-run
   * preview the review screen calls on every keystroke and the real edit. Two
   * implementations of "what would this change to" is two answers.
   */
  private async resolveApproverEdit(
    overtime: OvertimeWithEmployee,
    dto: ApproveOvertimeDto,
  ) {
    const { startTime, endTime } = this.readWindow(
      dto.startTime ?? overtime.startTime.toISOString(),
      dto.endTime ?? overtime.endTime.toISOString(),
    );

    const cfg = await this.settings.resolveOvertimeConfig(overtime.employee);
    if (!cfg.eligible) {
      throw new ForbiddenException(
        'This employee is not eligible for overtime under their assigned policy',
      );
    }

    const { dayType, isDoubleOtDay } = await this.classifyDay(
      overtime.date,
      overtime.employee.branchId,
      cfg,
    );
    await this.assertOutsideWorkHours(startTime, cfg, isDoubleOtDay);

    const breakdown = this.computeBreakdown(startTime, endTime, dayType, cfg);

    // The window can clamp to nothing at the day boundary. An approver who moves
    // a shift past it would otherwise approve a request worth zero hours and
    // nobody would find out until the payslip.
    if (breakdown.hours <= 0) {
      throw new BadRequestException(
        'The corrected window has no payable overtime hours',
      );
    }

    const dailyCap = isDoubleOtDay
      ? cfg.maxHoursPerDoubleDay
      : cfg.maxHoursPerDay;
    if (breakdown.hours > dailyCap) {
      throw new BadRequestException(
        `Daily overtime limit exceeded (${dailyCap}h). Corrected to: ${breakdown.hours}h`,
      );
    }

    await this.assertWithinPeriodCaps(
      overtime.employeeId,
      overtime.date,
      breakdown.hours,
      cfg,
      overtime.id,
    );

    // Food allowance: absent leaves the policy in charge; a value, 0 included,
    // wins. Overriding it while the policy pays no food allowance at all would
    // be inventing a payment, so that is refused rather than quietly honoured.
    let foodAllowanceOverride: number | undefined;
    if (dto.foodAllowance !== undefined) {
      if (!cfg.foodAllowanceEnabled) {
        throw new BadRequestException(
          'Food allowance is disabled by the overtime policy for this employee',
        );
      }
      foodAllowanceOverride = dto.foodAllowance;
    }

    let siteAllowance: number | undefined;
    if (
      dto.siteAllowance !== undefined ||
      dto.siteAllowanceNote !== undefined
    ) {
      if (!cfg.siteAllowanceEnabled) {
        throw new BadRequestException('Site allowance is disabled');
      }
      siteAllowance = dto.siteAllowance ?? 0;
      // 0 means "no ceiling", the convention every maximum in this app uses.
      if (cfg.siteAllowanceMax > 0 && siteAllowance > cfg.siteAllowanceMax) {
        throw new BadRequestException(
          `Site allowance exceeds the maximum of ${cfg.siteAllowanceMax}`,
        );
      }
    }

    return {
      cfg,
      breakdown,
      startTime,
      endTime,
      foodAllowanceOverride,
      siteAllowance,
      effectiveFood:
        foodAllowanceOverride !== undefined
          ? foodAllowanceOverride
          : breakdown.foodAllowance,
    };
  }

  /**
   * Persist a correction.
   *
   * Only the times, the food override, the site allowance and the notes are
   * written. The tier buckets are NOT: they are derived, and
   * {@link finalizeApproval} recomputes them from the stored window a moment
   * later — which is now the corrected one.
   */
  private async applyApproverEdit(
    id: string,
    dto: ApproveOvertimeDto,
    user: Principal,
    overtime: OvertimeWithEmployee,
  ) {
    await this.assertApproverEditEnabled();

    // Optimistic concurrency. Two approvers can hold the same request open, and
    // last-write-wins would let one silently discard the other's correction —
    // with both of them believing they had made the change.
    if (dto.expectedUpdatedAt) {
      const seen = new Date(dto.expectedUpdatedAt).getTime();
      if (seen !== overtime.updatedAt.getTime()) {
        throw new ConflictException(
          'This request was changed by someone else. Reload it and review the current values.',
        );
      }
    }

    const resolved = await this.resolveApproverEdit(overtime, dto);

    const data: Prisma.OvertimeRequestUpdateInput = {
      startTime: resolved.startTime,
      endTime: resolved.endTime,
      editedBy: { connect: { id: user.id } },
      editedAt: new Date(),
    };
    if (resolved.foodAllowanceOverride !== undefined) {
      data.foodAllowanceOverride = resolved.foodAllowanceOverride;
    }
    if (resolved.siteAllowance !== undefined) {
      data.siteAllowance = resolved.siteAllowance;
      data.siteAllowanceNote = dto.siteAllowanceNote?.trim() || null;
    }
    if (dto.approverNote !== undefined) {
      data.approverNote = dto.approverNote?.trim() || null;
    }
    // First edit only: keep what the employee actually filed, so a second
    // approver's correction cannot overwrite the original with an edited value.
    if (!overtime.originalStartTime) {
      data.originalStartTime = overtime.startTime;
      data.originalEndTime = overtime.endTime;
    }

    return this.prisma.overtimeRequest.update({ where: { id }, data });
  }

  /**
   * Freeze the numbers and record the decision.
   *
   * The breakdown is RECOMPUTED from the stored window against the live policy,
   * so an approved request always reflects the rules in force when it was
   * approved — including any correction just written.
   *
   * Two things about the update payload are load-bearing:
   *
   *   • `foodAllowance` takes the override when there is one. Null is not "no
   *     allowance", it means nobody overrode it, which is why the column is
   *     nullable and why the test is against `null` rather than falsiness.
   *   • `siteAllowance` is deliberately ABSENT. It is approver-granted with
   *     nothing to recompute it from, so naming it here would zero it on every
   *     approval.
   */
  private async finalizeApproval(id: string, approverId: string) {
    const overtime = await this.loadOrThrow(id);
    const cfg = await this.settings.resolveOvertimeConfig(overtime.employee);

    // Re-checked at approval: a policy change or a reassignment between filing
    // and approval must not let an ineligible employee's request into payroll.
    if (!cfg.eligible) {
      throw new ForbiddenException(
        'This employee is no longer eligible for overtime under their assigned policy',
      );
    }

    const { dayType } = await this.classifyDay(
      overtime.date,
      overtime.employee.branchId,
      cfg,
    );
    const breakdown = this.computeBreakdown(
      overtime.startTime,
      overtime.endTime,
      dayType,
      cfg,
    );

    return this.prisma.overtimeRequest.update({
      where: { id },
      data: {
        status: RequestStatus.APPROVED,
        approverId,
        approvedAt: new Date(),
        hours: breakdown.hours,
        regularHours: breakdown.regularHours,
        lateHours: breakdown.lateHours,
        doubleHours: breakdown.doubleHours,
        doubleLateHours: breakdown.doubleLateHours,
        dayType: breakdown.dayType,
        otType: breakdown.otType,
        foodAllowance:
          overtime.foodAllowanceOverride !== null
            ? overtime.foodAllowanceOverride
            : breakdown.foodAllowance,
        overtimePolicyId: cfg.policyId,
      },
      include: OVERTIME_INCLUDE,
    });
  }

  // ── Internals: preview, loading, guards ────────────────────────────────────

  /**
   * The breakdown plus the rates that monetize it.
   *
   * A PENDING request shows what approval WILL persist under today's rules. A
   * DECIDED one shows the FROZEN numbers, monetized by the policy snapshot the
   * row carries — recomputing those would show an approver a figure that no
   * longer matches the payslip.
   *
   * A failure degrades to `null` rather than propagating: the page falls back to
   * showing the request without its preview instead of losing the request.
   */
  private async buildPreview(overtime: OvertimeWithEmployee) {
    try {
      const decided = overtime.status !== RequestStatus.PENDING;
      const cfg = decided
        ? await this.settings.configForPolicyId(overtime.overtimePolicyId)
        : await this.settings.resolveOvertimeConfig(overtime.employee);

      const breakdown = decided
        ? frozenBreakdown(overtime)
        : this.computeBreakdown(
            overtime.startTime,
            overtime.endTime,
            (
              await this.classifyDay(
                overtime.date,
                overtime.employee.branchId,
                cfg,
              )
            ).dayType,
            cfg,
          );

      const tier = this.tierFor(cfg, breakdown.dayType);

      return {
        ...breakdown,
        // An override outranks the recomputed figure here for the same reason it
        // does at approval: the page must show what will actually be paid.
        foodAllowance:
          !decided && overtime.foodAllowanceOverride !== null
            ? Number(overtime.foodAllowanceOverride)
            : breakdown.foodAllowance,
        foodAllowanceOverride:
          overtime.foodAllowanceOverride === null
            ? null
            : Number(overtime.foodAllowanceOverride),
        // Never recomputed, only ever carried — see finalizeApproval.
        siteAllowance: Number(overtime.siteAllowance ?? 0),
        isDoubleOtDay: breakdown.dayType !== OvertimeDayType.WEEKDAY,
        regularRate: cfg.regularRate,
        lateRate: cfg.lateRate,
        doubleRate: tier ? tier.regularRate : cfg.doubleRate,
        doubleLateRate: tier ? tier.lateRate : cfg.doubleRate,
        policyId: cfg.policyId,
        policyName: cfg.policyName,
      };
    } catch {
      return null;
    }
  }

  private async loadOrThrow(id: string) {
    const overtime = await this.prisma.overtimeRequest.findUnique({
      where: { id },
      include: OVERTIME_INCLUDE,
    });
    if (!overtime) throw new NotFoundException('Overtime request not found');
    return overtime;
  }

  /**
   * Who may decide.
   *
   * ADMIN and HR always; a MANAGER inside the departments they run; and the
   * SUPERVISOR named on the employee's own record, whatever role they hold — the
   * single-approver model in `Employee.supervisorId` is the whole point, and a
   * supervisor who cannot approve is a queue that never empties.
   *
   * Nobody decides their own request, however senior. An approval is a second
   * pair of eyes or it is nothing.
   */
  private async assertMayDecide(
    overtime: OvertimeWithEmployee,
    user: Principal,
  ): Promise<void> {
    if (user.employeeId && overtime.employeeId === user.employeeId) {
      throw new ForbiddenException(
        'You cannot decide your own overtime request',
      );
    }
    if (user.role === UserRole.ADMIN || user.role === UserRole.HR_MANAGER) {
      return;
    }
    if (user.employeeId && overtime.employee.supervisorId === user.employeeId) {
      return;
    }
    if (user.role === UserRole.MANAGER) {
      const scope = await managerDepartmentIds(this.prisma, user);
      if (isInManagerScope(scope, overtime.employee.departmentId)) return;
    }
    throw new ForbiddenException(
      'You are not an approver for this overtime request',
    );
  }

  /**
   * An EMPLOYEE only ever sees their own; a MANAGER only their departments'.
   *
   * Built from the PRINCIPAL, never from the query string: a scope that trusts
   * `?employeeId=` is one edited URL away from being no scope at all. The
   * principal's own id is ANDed with whatever was asked for, so naming somebody
   * else narrows the result to nothing and can never widen it.
   */
  private scopeToCaller(
    requested: string | undefined,
    user: Principal,
    scope: string[] | null,
  ): Prisma.OvertimeRequestWhereInput {
    if (user.role === UserRole.EMPLOYEE) {
      if (!user.employeeId) {
        throw new ForbiddenException(
          'Your account is not linked to an employee record',
        );
      }
      const clauses: Prisma.OvertimeRequestWhereInput[] = [
        { employeeId: user.employeeId },
      ];
      if (requested) clauses.push({ employeeId: requested });
      return { AND: clauses };
    }

    if (scope !== null) {
      // A manager also sees their OWN requests, which sit outside the
      // departments they manage — they report to somebody else.
      const own = user.employeeId ? [{ employeeId: user.employeeId }] : [];
      return {
        AND: [
          { OR: [{ employee: { departmentId: { in: scope } } }, ...own] },
          ...(requested ? [{ employeeId: requested }] : []),
        ],
      };
    }

    return requested ? { employeeId: requested } : {};
  }

  private dateWindow(query: ListOvertimeDto): Prisma.OvertimeRequestWhereInput {
    if (query.startDate || query.endDate) {
      return {
        date: {
          ...(query.startDate ? { gte: dayKeyToDate(query.startDate) } : {}),
          ...(query.endDate ? { lte: dayKeyToDate(query.endDate) } : {}),
        },
      };
    }
    if (query.month && query.year) {
      return {
        date: {
          gte: monthStart(query.year, query.month),
          lte: monthEnd(query.year, query.month),
        },
      };
    }
    return {};
  }
}

type OvertimeWithEmployee = Prisma.OvertimeRequestGetPayload<{
  include: typeof OVERTIME_INCLUDE;
}>;

/**
 * The persisted breakdown of a decided request, read back as it was written.
 *
 * A row from before the tier columns existed carries its whole total in `hours`
 * and nothing in the buckets; rebuilding the single bucket from `otType` is what
 * lets the page show the hours that actually get paid rather than four zeroes.
 */
function frozenBreakdown(overtime: {
  hours: Prisma.Decimal;
  regularHours: Prisma.Decimal;
  lateHours: Prisma.Decimal;
  doubleHours: Prisma.Decimal;
  doubleLateHours: Prisma.Decimal;
  dayType: OvertimeDayType;
  foodAllowance: Prisma.Decimal;
  otType: OvertimeType;
}): OvertimeBreakdown {
  const hours = Number(overtime.hours) || 0;
  let regularHours = Number(overtime.regularHours) || 0;
  let lateHours = Number(overtime.lateHours) || 0;
  let doubleHours = Number(overtime.doubleHours) || 0;
  let doubleLateHours = Number(overtime.doubleLateHours) || 0;

  if (
    regularHours + lateHours + doubleHours + doubleLateHours === 0 &&
    hours > 0
  ) {
    if (overtime.otType === OvertimeType.DOUBLE_LATE) doubleLateHours = hours;
    else if (overtime.otType === OvertimeType.DOUBLE) doubleHours = hours;
    else if (overtime.otType === OvertimeType.LATE) lateHours = hours;
    else regularHours = hours;
  }

  return {
    hours,
    regularHours,
    lateHours,
    doubleHours,
    doubleLateHours,
    dayType: overtime.dayType,
    foodAllowance: Number(overtime.foodAllowance) || 0,
    otType: overtime.otType,
  };
}

function monthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}

/** The last DAY of the month, at UTC midnight — these are `@db.Date` columns. */
function monthEnd(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
}

function minutesToClock(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}
