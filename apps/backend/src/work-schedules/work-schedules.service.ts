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
    await this.assertEmployeeExists(dto.employeeId);

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

  async update(id: string, dto: UpdateWorkScheduleDto) {
    await this.findOne(id);
    return this.prisma.workSchedule.update({
      where: { id },
      data: dto,
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
      select: { id: true },
    });
    const knownIds = new Set(known.map((e) => e.id));

    const results: Array<{
      employeeId: string;
      date: string;
      outcome: 'created' | 'replaced' | 'skipped' | 'failed';
      message?: string;
    }> = [];

    for (const employeeId of employeeIds) {
      if (!knownIds.has(employeeId)) {
        results.push({
          employeeId,
          date: dto.startDate,
          outcome: 'failed',
          message: 'Employee not found',
        });
        continue;
      }

      for (const dayKey of dates) {
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

  private async assertEmployeeExists(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
  }
}
