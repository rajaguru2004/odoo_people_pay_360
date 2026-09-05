import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateScheduleDto, ShiftType } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { BulkCreateScheduleDto } from './dto/bulk-create-schedule.dto';
import { HolidaysService } from '../holidays/holidays.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { getBranchContext } from '../common/branch/branch-context';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';

/**
 * The caller, as the controller knows them. Authorization in this service is
 * expressed against this rather than against a role string alone, because two
 * of the rules (self-access, managed departments) need the caller's identity
 * and not just their rank.
 */
export interface CalendarActor {
  employeeId?: string;
  role: string;
  departmentId?: string;
  managedDepartmentIds?: string[];
}

/** The employee columns every authorization decision here is made from. */
const ACTOR_SCOPE_SELECT = {
  id: true,
  branchId: true,
  departmentId: true,
} as const;

const PRIVILEGED_ROLES = ['ADMIN', 'HR_MANAGER'];

/** The two fields the overlap rule reads, plus the type that can void it. */
export interface ShiftWindow {
  shiftType: string;
  startTime: Date | null;
  endTime: Date | null;
}

/**
 * Do two shifts on the same date collide?
 *
 * The single definition of the rule, shared by the create path, the bulk path,
 * the conflicts endpoint and the Schedules hub's window sweep. Intervals are
 * HALF-OPEN — `end == start` is a split day, not an overlap — and a FLEXIBLE
 * shift is date-level exclusive in both directions because it has no window for
 * anything to fit around.
 *
 * Module-level rather than a method so a second reader cannot grow a second
 * copy: two definitions of "overlap" is how one screen refuses a shift the
 * other reports as fine.
 */
export function rowsConflict(a: ShiftWindow, b: ShiftWindow): boolean {
  if (a.shiftType === 'FLEXIBLE' || b.shiftType === 'FLEXIBLE') return true;
  if (!a.startTime || !a.endTime || !b.startTime || !b.endTime) return false;
  return a.startTime < b.endTime && b.startTime < a.endTime;
}

@Injectable()
export class CalendarService {
  constructor(
    private prisma: PrismaService,
    private holidays: HolidaysService,
  ) {}

  /** Resolve an employee's branch id (null if none). */
  private async branchOf(employeeId: string): Promise<string | undefined> {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { branchId: true },
    });
    return emp?.branchId ?? undefined;
  }

  // ==================== AUTHORIZATION ====================

  /**
   * Object-level authorization for reading ANOTHER employee's calendar data.
   *
   * Only ever called with an id the CALLER supplied — never with the one their
   * own token carries. That distinction is the whole guard: applying it to the
   * self-service path would break "my calendar" for every user the moment the
   * branch picker pointed somewhere else, which is the regression the attendance
   * module shipped and had to back out of `/attendances/my`.
   *
   * Refusals are 404 rather than 403 because both dimensions here are about
   * EXISTENCE from the caller's point of view: a branch-A HR should not be able
   * to confirm that a branch-B employee exists, and a manager should not be able
   * to enumerate the company by probing department membership.
   */
  private async assertEmployeeViewable(
    actor: CalendarActor,
    employeeId: string,
  ): Promise<void> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: ACTOR_SCOPE_SELECT,
    });
    if (!employee) throw new NotFoundException('Employee not found');

    assertInBranch(employee.branchId);

    if (
      actor.role === 'MANAGER' &&
      !isDeptInManagerScope(actor, employee.departmentId)
    ) {
      throw new NotFoundException('Employee not found');
    }
  }

  /**
   * Object-level authorization for a schedule reached BY ID.
   *
   * `WorkSchedule` is scoped as a `relation` model, and the Prisma middleware
   * only AND-composes a branch predicate into the actions in
   * `BRANCH_READ_ACTIONS` — which does not include `findUnique`, and never
   * covers single-row `update`/`delete`. So every list in this module was
   * correctly scoped while every by-id door was open. This is that door.
   */
  private assertScheduleAccess(
    actor: CalendarActor,
    employee: { id: string; branchId: string | null; departmentId: string | null },
  ): void {
    // Branch first: it answers "does this exist for you", and a 404 must not be
    // overtaken by a 403 that concedes the row is real.
    assertInBranch(employee.branchId);

    if (PRIVILEGED_ROLES.includes(actor.role)) return;

    if (actor.role === 'MANAGER') {
      if (!isDeptInManagerScope(actor, employee.departmentId)) {
        throw new NotFoundException('Work schedule not found');
      }
      return;
    }

    // EMPLOYEE: self only. 403 rather than 404 here — inside their own branch
    // the row's existence is not the secret, its contents are, and an employee
    // who followed a stale link deserves an answer they can act on.
    if (!actor.employeeId || actor.employeeId !== employee.id) {
      throw new ForbiddenException(
        'You may only view your own work schedule',
      );
    }
  }

  // ==================== READS ====================

  async getEmployeeCalendar(
    employeeId: string | undefined,
    startDate: string,
    endDate: string,
  ) {
    // A user account need not be attached to an employee record —
    // `User.employeeId` is optional and a system administrator is the ordinary
    // reason for it. Their roster is empty rather than an exception: passing
    // `undefined` into a Prisma filter is rejected by the client and surfaces
    // as a 500 on a route the caller's own role grants them.
    if (!employeeId) return { success: true, data: [] };

    const events: any[] = [];

    // 1. Work schedules
    const schedules = await this.prisma.workSchedule.findMany({
      where: {
        employeeId,
        date: {
          gte: new Date(startDate),
          lte: new Date(endDate),
        },
      },
    });

    schedules.forEach((schedule) => {
      const isFlexible = schedule.shiftType === 'FLEXIBLE';
      const requiredHours =
        schedule.requiredHours != null ? Number(schedule.requiredHours) : null;
      events.push({
        id: schedule.id,
        title: isFlexible
          ? `Work - Flexible (${requiredHours ?? '?'}h)`
          : `Work - ${this.getShiftLabel(schedule.shiftType)}`,
        // Flexible shifts have no fixed window: render as an all-day marker on the date.
        startDate: isFlexible ? schedule.date : schedule.startTime,
        endDate: isFlexible ? schedule.date : schedule.endTime,
        type: 'work',
        shiftType: schedule.shiftType,
        requiredHours,
        description: schedule.notes,
        allDay: isFlexible,
      });
    });

    // 2. Leave requests (approved)
    const leaves = await this.prisma.leaveRequest.findMany({
      where: {
        employeeId,
        status: 'APPROVED',
        startDate: {
          lte: new Date(endDate),
        },
        endDate: {
          gte: new Date(startDate),
        },
      },
    });

    leaves.forEach((leave) => {
      events.push({
        id: leave.id,
        title: `Leave - ${leave.leaveType}`,
        startDate: leave.startDate,
        endDate: leave.endDate,
        type: 'leave',
        description: leave.reason,
        allDay: true,
      });
    });

    // 3. Overtime (approved)
    const overtimes = await this.prisma.overtimeRequest.findMany({
      where: {
        employeeId,
        status: 'APPROVED',
        date: {
          gte: new Date(startDate),
          lte: new Date(endDate),
        },
      },
    });

    overtimes.forEach((overtime) => {
      events.push({
        id: overtime.id,
        title: `Overtime - ${overtime.hours.toString()}h`,
        startDate: overtime.startTime,
        endDate: overtime.endTime,
        type: 'overtime',
        description: overtime.reason,
        allDay: false,
      });
    });

    // 4. Holidays (company-wide + the employee's branch)
    const holidays = await this.holidays.getHolidaysInRange(
      new Date(startDate),
      new Date(endDate),
      await this.branchOf(employeeId),
    );

    holidays.forEach((holiday) => {
      events.push({
        id: holiday.id,
        title: holiday.name,
        startDate: holiday.date,
        endDate: holiday.date,
        type: 'holiday',
        description: 'Holiday',
        allDay: true,
      });
    });

    return { success: true, data: events };
  }

  /**
   * Resolve whose calendar `my-calendar` should return, applying the override
   * rules and the authorization that goes with them.
   *
   * The override is honoured only for the three privileged roles, and only then
   * is `assertEmployeeViewable` consulted — see its own note on why the guard
   * must never touch the token-derived id.
   */
  async resolveCalendarTarget(
    actor: CalendarActor,
    requestedEmployeeId?: string,
  ): Promise<string | undefined> {
    const mayOverride = ['ADMIN', 'HR_MANAGER', 'MANAGER'].includes(actor.role);
    if (!requestedEmployeeId || !mayOverride) return actor.employeeId;
    if (requestedEmployeeId === actor.employeeId) return actor.employeeId;

    await this.assertEmployeeViewable(actor, requestedEmployeeId);
    return requestedEmployeeId;
  }

  async getCalendarStats(
    employeeId: string | undefined,
    month: number,
    year: number,
  ) {
    // Same reasoning as `getEmployeeCalendar`: no staff record, no figures.
    if (!employeeId) {
      return {
        success: true,
        data: { workDays: 0, leaveDays: 0, overtimeHours: 0, holidays: 0 },
      };
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('month must be an integer between 1 and 12');
    }
    if (!Number.isInteger(year) || year < 1970 || year > 9999) {
      throw new BadRequestException('year must be a four-digit calendar year');
    }

    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));

    // Count work days
    const workDays = await this.prisma.workSchedule.count({
      where: {
        employeeId,
        date: { gte: startDate, lte: endDate },
        isWorkDay: true,
      },
    });

    // Sum leave days (total days, not count of requests)
    const leaveAgg = await this.prisma.leaveRequest.aggregate({
      where: {
        employeeId,
        status: 'APPROVED',
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
      _sum: {
        totalDays: true,
      },
    });
    const leaveDays = Number(leaveAgg._sum.totalDays || 0);

    // Sum overtime hours
    const overtimeResult = await this.prisma.overtimeRequest.aggregate({
      where: {
        employeeId,
        status: 'APPROVED',
        date: { gte: startDate, lte: endDate },
      },
      _sum: {
        hours: true,
      },
    });

    // Count holidays (company-wide + the employee's branch)
    const holidayRows = await this.holidays.getHolidaysInRange(
      startDate,
      endDate,
      await this.branchOf(employeeId),
    );
    const holidays = holidayRows.length;

    return {
      success: true,
      data: {
        workDays,
        leaveDays,
        overtimeHours: Number(overtimeResult._sum.hours || 0),
        holidays,
      },
    };
  }

  private getShiftLabel(shiftType: string): string {
    const labels: Record<string, string> = {
      MORNING: 'Morning',
      AFTERNOON: 'Afternoon',
      FULL_DAY: 'Full Day',
      NIGHT: 'Night',
      CUSTOM: 'Custom',
      FLEXIBLE: 'Flexible',
    };
    return labels[shiftType] || shiftType;
  }

  // ==================== SCHEDULE MANAGEMENT ====================

  /**
   * The rules a date must satisfy before anyone can be rostered on it, shared
   * by create and update.
   *
   * It exists because they used to differ: `createSchedule` checked employee
   * status, the contract window and approved leave, and `updateSchedule` checked
   * none of the three — so every state create refused was reachable by creating
   * a legal schedule and then moving it. One path, one set of rules.
   */
  private async assertSchedulable(
    employeeId: string,
    dateStr: string,
  ): Promise<void> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      include: {
        contracts: {
          where: { status: 'ACTIVE' },
          orderBy: { startDate: 'desc' },
          take: 1,
        },
      },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Branch scope before anything else: an out-of-branch employee must look
    // absent, not merely unschedulable.
    assertInBranch(employee.branchId);

    if (employee.status !== 'ACTIVE') {
      throw new BadRequestException(
        'Schedules can only be created for active employees',
      );
    }

    const scheduleDate = new Date(dateStr);
    const activeContract = employee.contracts[0];

    // Contract is optional, only validate date boundaries if an active contract exists
    if (activeContract) {
      if (scheduleDate < activeContract.startDate) {
        throw new BadRequestException(
          'Work date must be after the contract start date',
        );
      }
      if (activeContract.endDate && scheduleDate > activeContract.endDate) {
        throw new BadRequestException(
          'Work date must be before the contract end date',
        );
      }
    }

    const approvedLeave = await this.prisma.leaveRequest.findFirst({
      where: {
        employeeId,
        status: 'APPROVED',
        startDate: { lte: scheduleDate },
        endDate: { gte: scheduleDate },
      },
    });

    if (approvedLeave) {
      throw new BadRequestException(
        `Cannot create work schedule on leave day (${approvedLeave.leaveType})`,
      );
    }
  }

  /**
   * Turn the unique-constraint violation into the status it actually is.
   *
   * `@@unique([employeeId, date])` closes the check-then-create race: two
   * concurrent requests both read "no conflict", both insert, and the database
   * refuses the loser. That is a conflict, not a bad request — the payload was
   * valid and simply lost.
   */
  private rethrowDuplicate(error: unknown): never {
    if ((error as { code?: string })?.code === 'P2002') {
      throw new ConflictException(
        'A work schedule already exists for this employee on this date',
      );
    }
    throw error;
  }

  async createSchedule(dto: CreateScheduleDto) {
    await this.assertSchedulable(dto.employeeId, dto.date);

    const scheduleDate = new Date(dto.date);
    const isFlexible = dto.shiftType === ShiftType.FLEXIBLE;

    // Check for conflicts (flexible shifts are date-level exclusive)
    await this.checkScheduleConflict(
      dto.employeeId,
      dto.date,
      dto.startTime,
      dto.endTime,
      undefined,
      dto.shiftType,
    );

    // Validate time range (fixed-window shifts only)
    let startTime: Date | null = null;
    let endTime: Date | null = null;
    if (!isFlexible) {
      startTime = new Date(dto.startTime as string);
      endTime = new Date(dto.endTime as string);

      if (startTime >= endTime) {
        throw new BadRequestException('Start time must be before end time');
      }
    }

    const schedule = await this.prisma.workSchedule
      .create({
        data: {
          employeeId: dto.employeeId,
          date: scheduleDate,
          shiftType: dto.shiftType,
          startTime,
          endTime,
          requiredHours: isFlexible ? dto.requiredHours : null,
          isWorkDay: dto.isWorkDay ?? true,
          notes: dto.notes,
        },
        include: {
          employee: {
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
            },
          },
        },
      })
      .catch((error) => this.rethrowDuplicate(error));

    return {
      success: true,
      data: schedule,
      message: 'Work schedule created successfully',
    };
  }

  async updateSchedule(id: string, dto: UpdateScheduleDto) {
    const existingSchedule = await this.prisma.workSchedule.findUnique({
      where: { id },
      include: { employee: { select: ACTOR_SCOPE_SELECT } },
    });

    if (!existingSchedule) {
      throw new NotFoundException('Work schedule not found');
    }
    assertInBranch(existingSchedule.employee.branchId);

    // Resolve the effective shift shape after applying the (partial) update.
    const effectiveShiftType = dto.shiftType ?? existingSchedule.shiftType;
    const willBeFlexible = effectiveShiftType === ShiftType.FLEXIBLE;

    const effectiveDate =
      dto.date ?? existingSchedule.date.toISOString().split('T')[0];
    const effectiveStart = willBeFlexible
      ? null
      : (dto.startTime ?? existingSchedule.startTime?.toISOString() ?? null);
    const effectiveEnd = willBeFlexible
      ? null
      : (dto.endTime ?? existingSchedule.endTime?.toISOString() ?? null);
    const effectiveRequiredHours = willBeFlexible
      ? (dto.requiredHours ??
        (existingSchedule.requiredHours != null
          ? Number(existingSchedule.requiredHours)
          : undefined))
      : null;

    // The same date rules create enforces. Only consulted when the update
    // actually MOVES the schedule — re-running them on an unchanged date would
    // make a note edit fail for a row that was legal when it was written (an
    // employee since gone inactive, a contract since expired), which is a
    // different decision and not this one.
    if (dto.date && effectiveDate !== existingSchedule.date.toISOString().split('T')[0]) {
      await this.assertSchedulable(existingSchedule.employeeId, effectiveDate);
    }

    // Validate required fields per shift type
    if (willBeFlexible) {
      if (effectiveRequiredHours == null) {
        throw new BadRequestException(
          'Total working hours is required for flexible shifts',
        );
      }
    } else {
      if (!effectiveStart || !effectiveEnd) {
        throw new BadRequestException(
          'Start and end time are required for non-flexible shifts',
        );
      }
      if (new Date(effectiveStart) >= new Date(effectiveEnd)) {
        throw new BadRequestException('Start time must be before end time');
      }
    }

    // If changing date, times, or shift type, check for conflicts
    if (dto.date || dto.startTime || dto.endTime || dto.shiftType) {
      await this.checkScheduleConflict(
        existingSchedule.employeeId,
        effectiveDate,
        effectiveStart ?? undefined,
        effectiveEnd ?? undefined,
        id,
        effectiveShiftType,
      );
    }

    // Update schedule (write the resolved shape so switching types clears the
    // now-irrelevant fields: flexible → null times, fixed → null requiredHours)
    const schedule = await this.prisma.workSchedule
      .update({
        where: { id },
        data: {
          ...(dto.date && { date: new Date(dto.date) }),
          ...(dto.shiftType && { shiftType: dto.shiftType }),
          startTime: effectiveStart ? new Date(effectiveStart) : null,
          endTime: effectiveEnd ? new Date(effectiveEnd) : null,
          requiredHours: effectiveRequiredHours ?? null,
          ...(dto.isWorkDay !== undefined && { isWorkDay: dto.isWorkDay }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
        },
        include: {
          employee: {
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
            },
          },
        },
      })
      .catch((error) => this.rethrowDuplicate(error));

    return {
      success: true,
      data: schedule,
      message: 'Work schedule updated successfully',
    };
  }

  async deleteSchedule(id: string) {
    const schedule = await this.prisma.workSchedule.findUnique({
      where: { id },
      include: { employee: { select: ACTOR_SCOPE_SELECT } },
    });

    if (!schedule) {
      throw new NotFoundException('Work schedule not found');
    }
    assertInBranch(schedule.employee.branchId);

    await this.prisma.workSchedule.delete({
      where: { id },
    });

    return {
      success: true,
      message: 'Work schedule deleted successfully',
    };
  }

  async getScheduleById(id: string, actor?: CalendarActor) {
    const schedule = await this.prisma.workSchedule.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
            branchId: true,
            departmentId: true,
            department: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!schedule) {
      throw new NotFoundException('Work schedule not found');
    }

    if (actor) this.assertScheduleAccess(actor, schedule.employee);

    return {
      success: true,
      data: schedule,
    };
  }

  async bulkCreateSchedules(dto: BulkCreateScheduleDto) {
    const results = {
      success: 0,
      failed: 0,
      errors: [] as any[],
    };

    // Validate all employees exist and are active.
    //
    // `findMany` IS auto-scoped by the branch middleware, so an out-of-branch
    // employee is simply absent from the map. That used to be reported as
    // "Employee not found", which is a different claim from the true one and one
    // the caller can disprove by looking them up in the directory. The two
    // reasons are separated below.
    const employeeIds = [...new Set(dto.schedules.map((s) => s.employeeId))];
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: employeeIds } },
      select: {
        id: true,
        status: true,
        contracts: {
          where: {
            status: 'ACTIVE',
          },
          orderBy: {
            startDate: 'desc',
          },
          take: 1,
        },
      },
    });

    const employeeMap = new Map(employees.map((e) => [e.id, e]));

    // Which of the missing ids exist at all, ignoring branch scope. Read
    // through a raw count so the branch middleware does not filter it too —
    // this is deliberately asking a question ABOUT scope.
    const unscopedIds = employeeIds.filter((id) => !employeeMap.has(id));
    const existsElsewhere = new Set<string>();
    if (unscopedIds.length > 0) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM employees WHERE id = ANY(${unscopedIds}::uuid[])
      `;
      rows.forEach((r) => existsElsewhere.add(r.id));
    }

    // Get all approved leaves for these employees
    const startDates = dto.schedules.map((s) => new Date(s.date));
    const minDate = new Date(Math.min(...startDates.map((d) => d.getTime())));
    const maxDate = new Date(Math.max(...startDates.map((d) => d.getTime())));

    const approvedLeaves = await this.prisma.leaveRequest.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: 'APPROVED',
        startDate: { lte: maxDate },
        endDate: { gte: minDate },
      },
      select: {
        employeeId: true,
        startDate: true,
        endDate: true,
        leaveType: true,
      },
    });

    // Create a map for quick leave lookup
    const leaveMap = new Map<string, { startDate: Date; endDate: Date }[]>();
    approvedLeaves.forEach((leave) => {
      if (!leaveMap.has(leave.employeeId)) {
        leaveMap.set(leave.employeeId, []);
      }
      leaveMap.get(leave.employeeId)!.push(leave);
    });

    for (const scheduleData of dto.schedules) {
      try {
        // Check if employee exists
        const employee = employeeMap.get(scheduleData.employeeId);
        if (!employee) {
          results.failed++;
          results.errors.push({
            employeeId: scheduleData.employeeId,
            date: scheduleData.date,
            error: existsElsewhere.has(scheduleData.employeeId)
              ? 'Employee is outside your branch access'
              : 'Employee not found',
          });
          continue;
        }

        // Check employee status
        if (employee.status !== 'ACTIVE') {
          results.failed++;
          results.errors.push({
            employeeId: scheduleData.employeeId,
            date: scheduleData.date,
            error: 'Employee is not in active status',
          });
          continue;
        }

        // Check contract
        const activeContract = employee.contracts[0];
        const scheduleDate = new Date(scheduleData.date);

        // Only validate contract boundaries if an active contract exists
        if (activeContract) {
          if (
            scheduleDate < activeContract.startDate ||
            (activeContract.endDate && scheduleDate > activeContract.endDate)
          ) {
            results.failed++;
            results.errors.push({
              employeeId: scheduleData.employeeId,
              date: scheduleData.date,
              error: 'Work date is outside the contract period',
            });
            continue;
          }
        }

        // Check for approved leave
        const employeeLeaves = leaveMap.get(scheduleData.employeeId) || [];
        const hasLeave = employeeLeaves.some(
          (leave) =>
            scheduleDate >= leave.startDate && scheduleDate <= leave.endDate,
        );

        if (hasLeave) {
          results.failed++;
          results.errors.push({
            employeeId: scheduleData.employeeId,
            date: scheduleData.date,
            error: 'Leave day has been approved',
          });
          continue;
        }

        const isFlexible = scheduleData.shiftType === ShiftType.FLEXIBLE;

        // Check for conflicts (flexible shifts are date-level exclusive)
        const hasConflict = await this.hasScheduleConflict(
          scheduleData.employeeId,
          scheduleData.date,
          scheduleData.startTime,
          scheduleData.endTime,
          undefined,
          scheduleData.shiftType,
        );

        if (hasConflict) {
          results.failed++;
          results.errors.push({
            employeeId: scheduleData.employeeId,
            date: scheduleData.date,
            error: 'Work schedule conflict',
          });
          continue;
        }

        // Validate time range (fixed-window shifts only)
        let startTime: Date | null = null;
        let endTime: Date | null = null;
        if (!isFlexible) {
          startTime = new Date(scheduleData.startTime as string);
          endTime = new Date(scheduleData.endTime as string);

          if (startTime >= endTime) {
            results.failed++;
            results.errors.push({
              employeeId: scheduleData.employeeId,
              date: scheduleData.date,
              error: 'Invalid time',
            });
            continue;
          }
        }

        // Create schedule
        await this.prisma.workSchedule.create({
          data: {
            employeeId: scheduleData.employeeId,
            date: scheduleDate,
            shiftType: scheduleData.shiftType,
            startTime,
            endTime,
            requiredHours: isFlexible ? scheduleData.requiredHours : null,
            isWorkDay: scheduleData.isWorkDay ?? true,
            notes: scheduleData.notes,
          },
        });

        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          employeeId: scheduleData.employeeId,
          date: scheduleData.date,
          error:
            (error as { code?: string })?.code === 'P2002'
              ? 'Work schedule conflict'
              : error instanceof Error
                ? error.message
                : 'Unknown error',
        });
      }
    }

    return {
      success: true,
      data: results,
      message: `Successfully created ${results.success}/${dto.schedules.length} work schedules`,
    };
  }

  /**
   * Report the schedules in a range that actually CONFLICT with each other.
   *
   * It used to return every schedule in the range labelled `conflicts`, without
   * ever consulting the overlap logic — so a perfectly ordinary roster reported
   * itself as one conflict per day, and the endpoint could not answer the only
   * question it exists to answer. It now applies the same rule create and bulk
   * apply, so the three doors agree.
   */
  async checkScheduleConflicts(
    employeeId: string,
    startDate: string,
    endDate: string,
  ) {
    const schedules = await this.prisma.workSchedule.findMany({
      where: {
        employeeId,
        date: {
          gte: new Date(startDate),
          lte: new Date(endDate),
        },
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
          },
        },
      },
      orderBy: {
        date: 'asc',
      },
    });

    // Conflicts are only ever within one date, so compare inside each day
    // rather than across the whole range.
    const byDate = new Map<string, typeof schedules>();
    for (const schedule of schedules) {
      const key = schedule.date.toISOString().slice(0, 10);
      const bucket = byDate.get(key);
      if (bucket) bucket.push(schedule);
      else byDate.set(key, [schedule]);
    }

    const conflicting = new Map<string, (typeof schedules)[number]>();
    for (const bucket of byDate.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          if (this.rowsConflict(bucket[i], bucket[j])) {
            conflicting.set(bucket[i].id, bucket[i]);
            conflicting.set(bucket[j].id, bucket[j]);
          }
        }
      }
    }

    const conflicts = [...conflicting.values()].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );

    return {
      success: true,
      data: {
        hasConflicts: conflicts.length > 0,
        conflicts,
      },
    };
  }

  // ==================== HELPER METHODS ====================

  private async checkScheduleConflict(
    employeeId: string,
    date: string,
    startTime?: string,
    endTime?: string,
    excludeId?: string,
    shiftType?: string,
  ) {
    const hasConflict = await this.hasScheduleConflict(
      employeeId,
      date,
      startTime,
      endTime,
      excludeId,
      shiftType,
    );

    if (hasConflict) {
      throw new BadRequestException(
        'Work schedule overlaps with an existing one',
      );
    }
  }

  /**
   * Do two shifts on the same date collide? Delegates to the module-level
   * `rowsConflict` — the one definition, now also read by the Schedules hub,
   * which sweeps the rule across a window rather than one employee at a time.
   */
  private rowsConflict(
    a: ShiftWindow,
    b: ShiftWindow,
  ): boolean {
    return rowsConflict(a, b);
  }

  private async hasScheduleConflict(
    employeeId: string,
    date: string,
    startTime?: string,
    endTime?: string,
    excludeId?: string,
    shiftType?: string,
  ): Promise<boolean> {
    const scheduleDate = new Date(date);

    const existingSchedules = await this.prisma.workSchedule.findMany({
      where: {
        employeeId,
        date: scheduleDate,
        ...(excludeId && { id: { not: excludeId } }),
      },
    });

    if (existingSchedules.length === 0) {
      return false;
    }

    const incoming = {
      shiftType: shiftType ?? ShiftType.CUSTOM,
      startTime: startTime ? new Date(startTime) : null,
      endTime: endTime ? new Date(endTime) : null,
    };

    return existingSchedules.some((schedule) =>
      this.rowsConflict(incoming, schedule),
    );
  }

  async getOverviewCalendar(startDateStr: string, endDateStr: string) {
    const start = new Date(startDateStr);
    const end = new Date(endDateStr);

    // 1. Work schedules
    const schedules = await this.prisma.workSchedule.findMany({
      where: {
        date: {
          gte: start,
          lte: end,
        },
      },
    });

    // 2. Approved leaves
    const leaves = await this.prisma.leaveRequest.findMany({
      where: {
        status: 'APPROVED',
        startDate: {
          lte: end,
        },
        endDate: {
          gte: start,
        },
      },
    });

    // 3. Approved overtime requests
    const overtimes = await this.prisma.overtimeRequest.findMany({
      where: {
        status: 'APPROVED',
        date: {
          gte: start,
          lte: end,
        },
      },
    });

    // 4. Holidays and the work week, for the branch currently in context.
    //
    // The matrix used to shade weekends from the GLOBAL
    // `calendar_weekly_holidays` setting because this endpoint told it nothing,
    // which is wrong wherever a branch keeps its own week — an Oman branch
    // resting Fri/Sat was shaded Sat/Sun and no client-side fix was possible.
    // With no branch narrowed (the all-branches view) the resolver falls back to
    // the global setting, so that case behaves exactly as before.
    const ctx = getBranchContext();
    const branchId = ctx?.effectiveBranchId ?? undefined;
    const [holidays, weeklyOffDays] = await Promise.all([
      this.holidays.getHolidaysInRange(start, end, branchId),
      this.holidays.getWeeklyOffDays(branchId),
    ]);

    return {
      success: true,
      data: {
        schedules: schedules.map((s) => ({
          id: s.id,
          employeeId: s.employeeId,
          date: s.date.toISOString().split('T')[0],
          shiftType: s.shiftType,
          startTime: s.startTime,
          endTime: s.endTime,
          requiredHours:
            s.requiredHours != null ? Number(s.requiredHours) : null,
          isWorkDay: s.isWorkDay,
        })),
        leaves: leaves.map((l) => ({
          id: l.id,
          employeeId: l.employeeId,
          startDate: l.startDate.toISOString().split('T')[0],
          endDate: l.endDate.toISOString().split('T')[0],
          leaveType: l.leaveType,
        })),
        overtimes: overtimes.map((o) => ({
          id: o.id,
          employeeId: o.employeeId,
          date: o.date.toISOString().split('T')[0],
          hours: Number(o.hours),
        })),
        holidays: holidays.map((h) => ({
          id: h.id,
          date: h.date.toISOString().split('T')[0],
          name: h.name,
          branchId: h.branchId,
        })),
        weeklyOffDays,
      },
    };
  }

  /**
   * Whether the coming week is actually covered, and where it is not.
   *
   * Three questions a scheduler opens this module with, none of which a
   * schedule COUNT answers:
   *
   *  - who has no shift at all this week (they will not know to turn up);
   *  - who is rostered on a company holiday;
   *  - who is rostered on their branch's weekly off.
   *
   * The last two are conflicts the roster is perfectly happy to contain — the
   * existing conflict check is per-employee and only fires when somebody is
   * editing one person, so nothing ever swept the week as a whole.
   */
  async coverageStats(startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const ctx = getBranchContext();
    const branchId = ctx?.effectiveBranchId ?? undefined;

    const [schedules, activeHeadcount, holidays, weeklyOffDays] = await Promise.all([
      this.prisma.workSchedule.findMany({
        where: { date: { gte: start, lte: end }, isWorkDay: true },
        select: {
          employeeId: true,
          date: true,
          employee: { select: { fullName: true } },
        },
      }),
      this.prisma.employee.count({ where: { status: 'ACTIVE' } }),
      this.holidays.getHolidaysInRange(start, end, branchId),
      this.holidays.getWeeklyOffDays(branchId),
    ]);

    const key = (d: Date) => d.toISOString().split('T')[0];
    const holidayByDate = new Map(holidays.map((h: any) => [key(new Date(h.date)), h.name]));
    const offDays = new Set(weeklyOffDays);

    const scheduled = new Set<string>();
    const perDay = new Map<string, number>();
    const onHoliday: Array<{ employeeId: string; fullName: string | null; date: string; holiday: string }> = [];
    const onWeeklyOff: Array<{ employeeId: string; fullName: string | null; date: string }> = [];

    for (const s of schedules) {
      scheduled.add(s.employeeId);
      const day = key(new Date(s.date));
      perDay.set(day, (perDay.get(day) ?? 0) + 1);

      const holiday = holidayByDate.get(day);
      if (holiday) {
        onHoliday.push({
          employeeId: s.employeeId,
          fullName: s.employee?.fullName ?? null,
          date: day,
          holiday,
        });
      }
      // getDay() is Sunday-first, matching how weekly offs are stored.
      if (offDays.has(new Date(s.date).getUTCDay())) {
        onWeeklyOff.push({
          employeeId: s.employeeId,
          fullName: s.employee?.fullName ?? null,
          date: day,
        });
      }
    }

    // Every date in the window, including the ones with nothing on them — a
    // day missing from the roster is the very thing this is looking for.
    const byDay: Array<{ date: string; scheduled: number }> = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const day = key(d);
      byDay.push({ date: day, scheduled: perDay.get(day) ?? 0 });
    }
    const workingDays = byDay.filter((d) => !holidayByDate.has(d.date));
    const thinnest = workingDays.length
      ? workingDays.reduce((min, d) => (d.scheduled < min.scheduled ? d : min))
      : null;

    return {
      success: true,
      data: {
        window: { startDate, endDate },
        activeHeadcount,
        scheduledEmployees: scheduled.size,
        // Assumes every scheduled employee is an active one; a schedule that
        // outlives a person's record makes this read slightly low.
        unscheduled: Math.max(0, activeHeadcount - scheduled.size),
        shifts: schedules.length,
        byDay,
        thinnestDay: thinnest,
        conflicts: {
          onHoliday: onHoliday.length,
          onWeeklyOff: onWeeklyOff.length,
          samples: [...onHoliday.slice(0, 5), ...onWeeklyOff.slice(0, 5)],
        },
      },
    };
  }
}
