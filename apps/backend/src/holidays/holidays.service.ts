import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  dayKeyToDate,
  toDayKey,
} from '../attendances/attendance-calendar.util';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';
import { ListHolidaysDto } from './dto/list-holidays.dto';

const HOLIDAY_INCLUDE = {
  branch: { select: { id: true, code: true, name: true } },
} satisfies Prisma.HolidayInclude;

@Injectable()
export class HolidaysService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The calendar one branch actually observes.
   *
   * With a `branchId` the answer is the company-wide rows PLUS that branch's,
   * and where both land on the same date the branch row wins. That is how a
   * national holiday observed in one country and not another is expressed —
   * the alternative is a second complete calendar per branch, which then has to
   * be kept in step by hand for every date that is shared.
   *
   * Without a `branchId` nothing is collapsed: the management screen is editing
   * the rows themselves and has to see both.
   */
  async findAll(query: ListHolidaysDto) {
    const rows = await this.prisma.holiday.findMany({
      where: {
        ...(query.year ? { year: query.year } : {}),
        ...(query.branchId
          ? { OR: [{ branchId: null }, { branchId: query.branchId }] }
          : {}),
      },
      include: HOLIDAY_INCLUDE,
      orderBy: { date: 'asc' },
    });

    if (!query.branchId) return rows;

    const byDate = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = toDayKey(row.date);
      const held = byDate.get(key);
      if (!held || (row.branchId && !held.branchId)) byDate.set(key, row);
    }
    return [...byDate.values()].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );
  }

  async findOne(id: string) {
    const holiday = await this.prisma.holiday.findUnique({
      where: { id },
      include: HOLIDAY_INCLUDE,
    });
    if (!holiday) throw new NotFoundException('Holiday not found');
    return holiday;
  }

  async create(dto: CreateHolidayDto) {
    const date = dayKeyToDate(dto.date);
    await this.assertNoDuplicate(date, dto.branchId ?? null);

    return this.prisma.holiday.create({
      data: {
        name: dto.name,
        date,
        // Derived rather than asked for: a `year` that disagrees with `date`
        // would silently drop the row out of its own calendar.
        year: Number(dto.date.slice(0, 4)),
        branchId: dto.branchId ?? null,
        isRecurring: dto.isRecurring ?? false,
        description: dto.description ?? null,
      },
      include: HOLIDAY_INCLUDE,
    });
  }

  async update(id: string, dto: UpdateHolidayDto) {
    const holiday = await this.findOne(id);
    const date = dto.date ? dayKeyToDate(dto.date) : holiday.date;
    const branchId =
      dto.branchId === undefined ? holiday.branchId : (dto.branchId ?? null);

    if (
      date.getTime() !== holiday.date.getTime() ||
      branchId !== holiday.branchId
    ) {
      await this.assertNoDuplicate(date, branchId, id);
    }

    return this.prisma.holiday.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.date ? { date, year: Number(dto.date.slice(0, 4)) } : {}),
        ...(dto.branchId !== undefined ? { branchId } : {}),
        ...(dto.isRecurring !== undefined
          ? { isRecurring: dto.isRecurring }
          : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
      },
      include: HOLIDAY_INCLUDE,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.holiday.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Two rows for the same date and scope are a duplicate, not an override.
   *
   * A branch row beside a company-wide one IS meaningful and is allowed — that
   * is the whole override mechanism — so the check is scoped to the pair.
   */
  private async assertNoDuplicate(
    date: Date,
    branchId: string | null,
    exceptId?: string,
  ) {
    const clash = await this.prisma.holiday.findFirst({
      where: {
        date,
        branchId,
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true, name: true },
    });
    if (clash) {
      throw new ConflictException(
        `${clash.name} is already recorded on ${toDayKey(date)} for this calendar`,
      );
    }
  }
}
