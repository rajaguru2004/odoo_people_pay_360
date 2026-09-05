import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';
import { getBranchContext } from '../common/branch/branch-context';

@Injectable()
export class HolidaysService {
  constructor(private prisma: PrismaService) {}

  // ── Branch-scope helpers ──────────────────────────────────────────────

  /** Parse a CSV of weekday numbers ("5,6") into a clean 0–6 array. */
  private parseDays(csv: string): number[] {
    return csv
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  }

  /**
   * Resolve which weekday numbers (0=Sun … 6=Sat) are non-working for a branch.
   * Precedence: branch.weeklyOffDays (if set) → global calendar_weekly_holidays
   * → [0] (Sunday only).
   *
   * PUBLIC because it is the only branch-aware answer to "which days are the
   * weekend here", and screens were reading the global `calendar_weekly_holidays`
   * setting directly for want of one — so an Oman branch resting Fri/Sat was
   * shaded Sat/Sun. `/calendar/overview` now serves the resolved value to the
   * schedule matrix rather than letting it guess.
   */
  async getWeeklyOffDays(branchId?: string): Promise<number[]> {
    if (branchId) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { weeklyOffDays: true },
      });
      if (branch?.weeklyOffDays != null) {
        return this.parseDays(branch.weeklyOffDays);
      }
    }
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: 'calendar_weekly_holidays' },
    });
    const parsed = setting?.value ? this.parseDays(setting.value) : [];
    return parsed.length ? parsed : [0];
  }

  /**
   * Prisma `where` fragment selecting holidays visible for a branch scope:
   * always company-wide (branchId null) plus the given branch's own rows.
   */
  private branchHolidayFilter(branchId?: string): any {
    return branchId
      ? { OR: [{ branchId: null }, { branchId }] }
      : { branchId: null };
  }

  /**
   * Restrict a listing to what the current caller may see. An explicit
   * branchId filter (admin viewing one branch) wins; otherwise fall back to the
   * request's branch context (global callers see everything, scoped callers see
   * company-wide + their accessible branches).
   */
  private listScopeWhere(explicitBranchId?: string): any {
    if (explicitBranchId) {
      return { OR: [{ branchId: null }, { branchId: explicitBranchId }] };
    }
    const ctx = getBranchContext();
    if (ctx && !ctx.isAllBranches && !ctx.isGlobal) {
      const ids = ctx.effectiveBranchId
        ? [ctx.effectiveBranchId]
        : ctx.accessibleBranchIds;
      return { OR: [{ branchId: null }, { branchId: { in: ids } }] };
    }
    return {};
  }

  // ── CRUD ──────────────────────────────────────────────────────────────

  async create(dto: CreateHolidayDto) {
    const branchId = dto.branchId ?? null;
    const date = new Date(dto.date);

    const existing = await this.prisma.holiday.findFirst({
      where: { date, branchId },
    });
    if (existing) {
      throw new ConflictException(
        'A holiday already exists on this date for this scope',
      );
    }

    const holiday = await this.prisma.holiday.create({
      data: {
        name: dto.name,
        date,
        year: dto.year ?? date.getUTCFullYear(),
        isRecurring: dto.isRecurring || false,
        branchId,
        description: dto.description ?? null,
      },
    });

    return {
      success: true,
      message: 'Holiday created successfully',
      data: holiday,
    };
  }

  async findAll(year?: number, branchId?: string) {
    const where: any = { ...this.listScopeWhere(branchId) };
    if (year) where.year = Number(year);

    const holidays = await this.prisma.holiday.findMany({
      where,
      orderBy: { date: 'asc' },
      include: { branch: { select: { id: true, code: true, name: true } } },
    });

    return {
      success: true,
      data: holidays,
      meta: { total: holidays.length, year: year || 'all' },
    };
  }

  async findByYear(year: number) {
    return this.findAll(year);
  }

  async findOne(id: string) {
    const holiday = await this.prisma.holiday.findUnique({
      where: { id },
      include: { branch: { select: { id: true, code: true, name: true } } },
    });
    if (!holiday) throw new NotFoundException('Holiday not found');
    return { success: true, data: holiday };
  }

  async update(id: string, dto: UpdateHolidayDto) {
    const existing = await this.prisma.holiday.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Holiday not found');

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.date !== undefined) {
      data.date = new Date(dto.date);
      data.year = new Date(dto.date).getUTCFullYear();
    }
    if (dto.year !== undefined) data.year = dto.year;
    if (dto.isRecurring !== undefined) data.isRecurring = dto.isRecurring;
    if (dto.branchId !== undefined) data.branchId = dto.branchId ?? null;
    if (dto.description !== undefined) data.description = dto.description ?? null;

    // Guard the partial-unique constraint (date, scope) with a friendly error.
    const nextDate = data.date ?? existing.date;
    const nextBranch =
      data.branchId !== undefined ? data.branchId : existing.branchId;
    const clash = await this.prisma.holiday.findFirst({
      where: { date: nextDate, branchId: nextBranch, id: { not: id } },
    });
    if (clash) {
      throw new ConflictException(
        'Another holiday already exists on this date for this scope',
      );
    }

    const holiday = await this.prisma.holiday.update({ where: { id }, data });
    return {
      success: true,
      message: 'Holiday updated successfully',
      data: holiday,
    };
  }

  async delete(id: string) {
    const holiday = await this.prisma.holiday.findUnique({ where: { id } });
    if (!holiday) throw new NotFoundException('Holiday not found');

    await this.prisma.holiday.delete({ where: { id } });
    return { success: true, message: 'Holiday deleted successfully' };
  }

  // ── Recurring / copy-year ──────────────────────────────────────────────

  /**
   * Copy holidays from one year into another, shifting each date to the target
   * year (same month/day). Existing rows in the target scope are skipped.
   */
  async copyYear(
    fromYear: number,
    toYear: number,
    branchId?: string,
    onlyRecurring = false,
  ) {
    const where: any = { year: fromYear };
    if (branchId) where.branchId = branchId;
    if (onlyRecurring) where.isRecurring = true;

    const source = await this.prisma.holiday.findMany({ where });

    const data = source.map((h) => {
      const d = new Date(h.date);
      return {
        name: h.name,
        date: new Date(Date.UTC(toYear, d.getUTCMonth(), d.getUTCDate())),
        year: toYear,
        isRecurring: h.isRecurring,
        branchId: h.branchId,
        description: h.description,
      };
    });

    const result = data.length
      ? await this.prisma.holiday.createMany({ data, skipDuplicates: true })
      : { count: 0 };

    return {
      success: true,
      message: `Copied ${result.count} holiday(s) from ${fromYear} to ${toYear}`,
      data: {
        created: result.count,
        skipped: source.length - result.count,
        total: source.length,
      },
    };
  }

  /**
   * Seed a fresh year from the previous year's recurring holidays.
   * (Replaces the old hardcoded, mislabeled holiday list.)
   */
  async initYearHolidays(year: number) {
    return this.copyYear(year - 1, year, undefined, true);
  }

  // ── Work-day engine (single source of truth) ───────────────────────────

  /** Holiday rows within an inclusive [start, end] range for a branch scope. */
  async getHolidaysInRange(startDate: Date, endDate: Date, branchId?: string) {
    return this.prisma.holiday.findMany({
      where: {
        date: { gte: startDate, lte: endDate },
        ...this.branchHolidayFilter(branchId),
      },
      orderBy: { date: 'asc' },
    });
  }

  /** Is the given date a holiday for the branch (company-wide or branch-specific)? */
  async isHoliday(date: Date, branchId?: string): Promise<boolean> {
    const holiday = await this.prisma.holiday.findFirst({
      where: { date, ...this.branchHolidayFilter(branchId) },
    });
    return !!holiday;
  }

  /**
   * Is the given date a weekly-off (rest) day for the branch? Uses the branch's
   * configured Branch.weeklyOffDays (→ global calendar_weekly_holidays → Sunday).
   *
   * IMPORTANT: Prisma reads Postgres DATE columns as midnight in the server's
   * local timezone. On an IST (+5:30) server "2026-08-24" is returned as
   * 2026-08-23T18:30:00.000Z, so a raw getUTCDay() would yield 0 (Sunday)
   * instead of 1 (Monday). Normalising to UTC noon (+12 h) moves any date past
   * the local-midnight offset before deriving the day-of-week, so the result is
   * always correct regardless of the server's timezone.
   */
  async isWeeklyOff(date: Date, branchId?: string): Promise<boolean> {
    const offDays = await this.getWeeklyOffDays(branchId);
    // Shift by 12 h so that dates returned as local midnight in UTC still
    // resolve to the correct UTC calendar day.
    const noonNormalized = new Date(date.getTime() + 12 * 60 * 60 * 1000);
    return offDays.includes(noonNormalized.getUTCDay());
  }

  /**
   * Full breakdown of a month for a branch: total days, working days, weekly-off
   * days and holidays (holidays that fall on a weekly-off day are counted as
   * weekend, not double-counted).
   */
  async getWorkDaysBreakdown(month: number, year: number, branchId?: string) {
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));
    const totalDays = endDate.getUTCDate();

    const weeklyOff = await this.getWeeklyOffDays(branchId);

    const holidayList = await this.prisma.holiday.findMany({
      where: {
        date: { gte: startDate, lte: endDate },
        ...this.branchHolidayFilter(branchId),
      },
      orderBy: { date: 'asc' },
    });
    const holidaySet = new Set(
      holidayList.map((h) => h.date.toISOString().split('T')[0]),
    );

    let workDays = 0;
    let weekends = 0;
    let holidays = 0;
    // The dates behind the `holidays` count — i.e. holidayList minus the ones
    // that landed on a weekly-off day. holidayList itself keeps every row, so it
    // cannot be used where "a holiday that displaced a working day" is meant.
    const holidayDates: string[] = [];
    const current = new Date(startDate);

    while (current <= endDate) {
      const dayOfWeek = current.getUTCDay();
      const dateStr = current.toISOString().split('T')[0];

      if (weeklyOff.includes(dayOfWeek)) {
        weekends++;
      } else if (holidaySet.has(dateStr)) {
        holidays++;
        holidayDates.push(dateStr);
      } else {
        workDays++;
      }
      current.setUTCDate(current.getUTCDate() + 1);
    }

    return {
      month,
      year,
      branchId: branchId ?? null,
      totalDays,
      workDays,
      weekends,
      holidays,
      holidayList,
      holidayDates,
    };
  }

  /**
   * The public-holiday dates (YYYY-MM-DD, UTC) in a month for a branch,
   * EXCLUDING holidays that fall on a weekly-off day — those are already rest
   * days and must not be paid a second time.
   *
   * This is the source of the paid-holiday day count for daily-wage staff, who
   * are otherwise paid strictly for days worked.
   */
  async getPaidHolidayDatesInMonth(
    month: number,
    year: number,
    branchId?: string,
  ): Promise<string[]> {
    const { holidayDates } = await this.getWorkDaysBreakdown(
      month,
      year,
      branchId,
    );
    return holidayDates;
  }

  /** Working days in a month for a branch (excludes weekly-off days + holidays). */
  async getWorkDaysInMonth(
    month: number,
    year: number,
    branchId?: string,
  ): Promise<number> {
    const { workDays } = await this.getWorkDaysBreakdown(month, year, branchId);
    return workDays;
  }

  /**
   * The actual working dates within an inclusive [start, end] range for a branch
   * (excludes weekly-off days + holidays). UTC date-normalized.
   */
  async getWorkingDatesBetween(
    startDate: Date,
    endDate: Date,
    branchId?: string,
  ): Promise<Date[]> {
    const start = new Date(
      Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate(),
      ),
    );
    const end = new Date(
      Date.UTC(
        endDate.getUTCFullYear(),
        endDate.getUTCMonth(),
        endDate.getUTCDate(),
      ),
    );

    const weeklyOff = await this.getWeeklyOffDays(branchId);
    const holidayList = await this.prisma.holiday.findMany({
      where: {
        date: { gte: start, lte: end },
        ...this.branchHolidayFilter(branchId),
      },
      select: { date: true },
    });
    const holidaySet = new Set(
      holidayList.map((h) => h.date.toISOString().split('T')[0]),
    );

    const dates: Date[] = [];
    const current = new Date(start);
    while (current <= end) {
      const dayOfWeek = current.getUTCDay();
      const dateStr = current.toISOString().split('T')[0];
      if (!weeklyOff.includes(dayOfWeek) && !holidaySet.has(dateStr)) {
        dates.push(new Date(current));
      }
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return dates;
  }

  /** Count of working days within an inclusive [start, end] range for a branch. */
  async getWorkDaysBetween(
    startDate: Date,
    endDate: Date,
    branchId?: string,
  ): Promise<number> {
    const dates = await this.getWorkingDatesBetween(startDate, endDate, branchId);
    return dates.length;
  }
}
