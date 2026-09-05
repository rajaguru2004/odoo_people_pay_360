import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import {
  dayKeyToDate,
  isoWeekday,
  parseDayKey,
  toDayKey,
} from '../attendances/attendance-calendar.util';
import { resolveWindow } from '../schedules/shift-window.util';
import { CreateWorkScheduleDto } from './dto/create-work-schedule.dto';
import { UpdateWorkScheduleDto } from './dto/update-work-schedule.dto';
import { ListWorkSchedulesDto } from './dto/list-work-schedules.dto';
import { BulkWorkScheduleDto } from './dto/bulk-work-schedule.dto';

const SCHEDULE_INCLUDE = {
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
} satisfies Prisma.WorkScheduleInclude;

/** A range longer than this is a mistake in a form, not a roster. */
const MAX_BULK_DAYS = 366;

@Injectable()
export class WorkSchedulesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListWorkSchedulesDto) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.WorkScheduleWhereInput = {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.shiftType ? { shiftType: query.shiftType } : {}),
      ...(query.branchId ? { employee: { branchId: query.branchId } } : {}),
      ...(query.startDate || query.endDate
        ? {
            date: {
              ...(query.startDate
                ? { gte: dayKeyToDate(query.startDate) }
                : {}),
              ...(query.endDate ? { lte: dayKeyToDate(query.endDate) } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.workSchedule.findMany({
        where,
        include: SCHEDULE_INCLUDE,
        skip,
        take,
        orderBy: [{ date: 'asc' }, { employee: { employeeCode: 'asc' } }],
      }),
      this.prisma.workSchedule.count({ where }),
    ]);

    return paginated(data, total, page, limit);
  }

  async findOne(id: string) {
    const row = await this.prisma.workSchedule.findUnique({
      where: { id },
      include: SCHEDULE_INCLUDE,
    });
    if (!row) throw new NotFoundException('Work schedule not found');
    return row;
  }

  async create(dto: CreateWorkScheduleDto) {
    await this.assertSchedulable(dto.employeeId, dto.date);
    assertShiftShape({
      shiftType: dto.shiftType ?? 'FULL_DAY',
      startTime: dto.startTime ?? null,
      endTime: dto.endTime ?? null,
      requiredHours: dto.requiredHours ?? null,
    });

    const date = dayKeyToDate(dto.date);
    const clash = await this.prisma.workSchedule.findUnique({
      where: { employeeId_date: { employeeId: dto.employeeId, date } },
      select: { id: true, shiftType: true },
    });
    if (clash) {
      throw new ConflictException(
        `That employee is already rostered on ${dto.date} (${clash.shiftType}). Edit that shift instead of adding a second one.`,
      );
    }

    return this.prisma.workSchedule.create({
      data: {
        employeeId: dto.employeeId,
        date,
        shiftType: dto.shiftType,
        startTime: dto.startTime,
        endTime: dto.endTime,
        requiredHours: dto.requiredHours,
        isWorkDay: dto.isWorkDay,
        notes: dto.notes,
      },
      include: SCHEDULE_INCLUDE,
    });
  }

  /**
   * Edit a rostered shift.
   *
   * The shape rules are re-run against the row as it will BE, not against the
   * patch: switching a fixed shift to FLEXIBLE without sending `requiredHours`
   * has to fail, and it can only be seen to fail by resolving the merge first.
   *
   * The date rules deliberately are NOT re-run. `date` and `employeeId` are not
   * editable here, so an update never moves a row into a state the create path
   * would have refused — and re-checking them would make a note edit fail for a
   * row that was legal when it was written, because the contract has since
   * expired or the person has since gone on leave. That is a different decision
   * and not this one.
   */
  async update(id: string, dto: UpdateWorkScheduleDto) {
    const existing = await this.findOne(id);

    const merged = {
      shiftType: dto.shiftType ?? existing.shiftType,
      startTime:
        dto.startTime !== undefined ? dto.startTime : existing.startTime,
      endTime: dto.endTime !== undefined ? dto.endTime : existing.endTime,
      requiredHours:
        dto.requiredHours !== undefined
          ? dto.requiredHours
          : existing.requiredHours != null
            ? Number(existing.requiredHours)
            : null,
    };
    assertShiftShape(merged);

    // The resolved shape is written, not the patch, so switching type clears
    // the fields the new type cannot carry: FLEXIBLE has no window, and a fixed
    // window's length is its clocks rather than a stored number that can drift
    // out of step with them.
    const flexible = merged.shiftType === 'FLEXIBLE';

    return this.prisma.workSchedule.update({
      where: { id },
      data: {
        shiftType: merged.shiftType,
        startTime: flexible ? null : merged.startTime,
        endTime: flexible ? null : merged.endTime,
        requiredHours: flexible ? merged.requiredHours : null,
        ...(dto.isWorkDay !== undefined ? { isWorkDay: dto.isWorkDay } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
      include: SCHEDULE_INCLUDE,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.workSchedule.delete({ where: { id } });
    // Removing the row does not leave the day unrostered — it hands the day
    // back to the branch calendar, which is what the row was deviating from.
    return { deleted: true };
  }

  /**
   * Lay a shift pattern over a range for a set of people.
   *
   * A day already rostered is REPORTED rather than silently replaced, unless
   * the caller asked for `overwrite`. Somebody laying a March night shift over
   * a month that already has three hand-made exceptions in it wants to know
   * about those three, not to lose them.
   */
  async bulk(dto: BulkWorkScheduleDto) {
    const start = parseDayKey(dto.startDate);
    const end = parseDayKey(dto.endDate);
    if (!start || !end) {
      throw new BadRequestException('startDate and endDate must be YYYY-MM-DD');
    }
    if (start > end) {
      throw new BadRequestException('startDate must not be after endDate');
    }
    if (end.diff(start, 'days').days + 1 > MAX_BULK_DAYS) {
      throw new BadRequestException(
        `A roster pattern covers at most ${MAX_BULK_DAYS} days at a time`,
      );
    }

    // Checked ONCE, before anything is written. The pattern is the same on every
    // day it lands on, so a malformed one is a bad request rather than a batch
    // that half succeeds and reports the same error several hundred times.
    assertShiftShape({
      shiftType: dto.shiftType ?? 'FULL_DAY',
      startTime: dto.startTime ?? null,
      endTime: dto.endTime ?? null,
      requiredHours: dto.requiredHours ?? null,
    });

    const dates: string[] = [];
    for (let cursor = start; cursor <= end; cursor = cursor.plus({ days: 1 })) {
      if (dto.weekdays?.length && !dto.weekdays.includes(isoWeekday(cursor))) {
        continue;
      }
      dates.push(toDayKey(cursor));
    }

    const employeeIds = [...new Set(dto.employeeIds)];
    const known = await this.prisma.employee.findMany({
      where: { id: { in: employeeIds } },
      select: { id: true, status: true },
    });
    const statusOf = new Map(known.map((e) => [e.id, e.status]));

    // Every leave day already recorded across the whole pattern, read in one
    // query rather than one per employee-day. A month of a fifty-person pattern
    // is fifteen hundred cells, and asking the database fifteen hundred times
    // for a set that fits in memory is the difference between a click and a
    // spinner.
    const leaveDays = new Set(
      (
        await this.prisma.attendance.findMany({
          where: {
            employeeId: { in: employeeIds },
            status: 'ON_LEAVE',
            date: {
              gte: dayKeyToDate(dto.startDate),
              lte: dayKeyToDate(dto.endDate),
            },
          },
          select: { employeeId: true, date: true },
        })
      ).map((row) => `${row.employeeId}|${toDayKey(row.date)}`),
    );

    const results: Array<{
      employeeId: string;
      date: string;
      outcome: 'created' | 'replaced' | 'skipped' | 'failed';
      message?: string;
    }> = [];

    for (const employeeId of employeeIds) {
      const status = statusOf.get(employeeId);
      if (!status) {
        results.push({
          employeeId,
          date: dto.startDate,
          outcome: 'failed',
          message: 'Employee not found',
        });
        continue;
      }
      // A leaver has no future roster and a suspended employee is not expected
      // in. Reported once for the person rather than once per day of the
      // pattern — thirty identical rows say nothing the first one did not.
      if (status !== 'ACTIVE') {
        results.push({
          employeeId,
          date: dto.startDate,
          outcome: 'failed',
          message: `Only active employees can be rostered (this one is ${status})`,
        });
        continue;
      }

      for (const dayKey of dates) {
        if (leaveDays.has(`${employeeId}|${dayKey}`)) {
          results.push({
            employeeId,
            date: dayKey,
            outcome: 'skipped',
            message: 'Already recorded as a leave day',
          });
          continue;
        }

        const date = dayKeyToDate(dayKey);
        const existing = await this.prisma.workSchedule.findUnique({
          where: { employeeId_date: { employeeId, date } },
          select: { id: true },
        });

        if (existing && !dto.overwrite) {
          results.push({
            employeeId,
            date: dayKey,
            outcome: 'skipped',
            message: 'Already rostered — send overwrite to replace it',
          });
          continue;
        }

        const data = {
          shiftType: dto.shiftType ?? 'FULL_DAY',
          startTime: dto.startTime ?? null,
          endTime: dto.endTime ?? null,
          requiredHours: dto.requiredHours ?? null,
          isWorkDay: dto.isWorkDay ?? true,
          notes: dto.notes ?? null,
        };

        await this.prisma.workSchedule.upsert({
          where: { employeeId_date: { employeeId, date } },
          create: { employeeId, date, ...data },
          update: data,
        });

        results.push({
          employeeId,
          date: dayKey,
          outcome: existing ? 'replaced' : 'created',
        });
      }
    }

    return {
      range: { startDate: dto.startDate, endDate: dto.endDate },
      days: dates.length,
      employees: employeeIds.length,
      created: results.filter((r) => r.outcome === 'created').length,
      replaced: results.filter((r) => r.outcome === 'replaced').length,
      skipped: results.filter((r) => r.outcome === 'skipped').length,
      failed: results.filter((r) => r.outcome === 'failed').length,
      results,
    };
  }

  /**
   * Everything a date must satisfy before anybody can be rostered on it.
   *
   * One method, called by the single-row path, because the alternative is what
   * the original had: create checking the employee and update checking nothing,
   * so every state create refused was reachable by creating a legal row and then
   * editing it.
   *
   * The bulk path applies the same three rules but REPORTS them per row instead
   * of throwing — somebody laying a month over fifty people wants the eleven
   * cells that could not be written, not a batch that stops at the first one.
   */
  private async assertSchedulable(employeeId: string, dayKey: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        status: true,
        contracts: {
          where: { status: 'ACTIVE' },
          orderBy: { startDate: 'desc' },
          take: 1,
          select: { startDate: true, endDate: true },
        },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    if (employee.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Only active employees can be rostered (this one is ${employee.status})`,
      );
    }

    // The contract is OPTIONAL. Plenty of records predate one, and refusing to
    // roster them would make the screen unusable on exactly the data most
    // likely to need a shift. Only an existing contract's boundaries are tested.
    const date = dayKeyToDate(dayKey);
    const contract = employee.contracts[0];
    if (contract) {
      if (date < contract.startDate) {
        throw new BadRequestException(
          `${dayKey} is before this employee's contract starts`,
        );
      }
      if (contract.endDate && date > contract.endDate) {
        throw new BadRequestException(
          `${dayKey} is after this employee's contract ends`,
        );
      }
    }

    const onLeave = await this.prisma.attendance.findFirst({
      where: { employeeId, date, status: 'ON_LEAVE' },
      select: { id: true },
    });
    if (onLeave) {
      throw new BadRequestException(
        `${dayKey} is already recorded as a leave day for this employee`,
      );
    }
  }
}

/**
 * Does the shift carry the fields its own type needs?
 *
 * A FLEXIBLE shift is hours without a window, so it needs `requiredHours` and
 * nothing else. Every other type is a window, so it needs both clocks — and they
 * must differ, because equal clocks are an unconfigured pair far more often than
 * a genuine round-the-clock rota.
 *
 * What it deliberately does NOT require is `start < end`: a night shift runs
 * 22:00 to 06:00, and refusing that is how a plant's whole roster becomes
 * unenterable. `resolveWindow` reads the wrap as a midnight crossing.
 */
export function assertShiftShape(shift: {
  /** A `ShiftType`, widened so a caller holding a raw string need not cast. */
  shiftType: string;
  startTime: string | null;
  endTime: string | null;
  requiredHours: number | null;
}): void {
  if (shift.shiftType === 'FLEXIBLE') {
    if (shift.requiredHours == null) {
      throw new BadRequestException(
        'A flexible shift needs requiredHours — it has no window to measure',
      );
    }
    return;
  }

  if (!shift.startTime || !shift.endTime) {
    throw new BadRequestException(
      `A ${String(shift.shiftType).toLowerCase()} shift needs both a start and an end time`,
    );
  }

  const window = resolveWindow(shift);
  if (!window || window.durationMinutes === 0) {
    throw new BadRequestException(
      'Start and end time must differ — a shift of no length rosters nobody',
    );
  }
}
