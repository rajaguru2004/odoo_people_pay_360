import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';

/** Milliseconds in twelve hours — see `isoWeekdayOf`. */
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

/**
 * "Which days does this branch actually work, and how many of them are in this
 * range?"
 *
 * Leave duration and overtime day classification both rest on this and nothing
 * else. A leave request spanning a Thursday to a Sunday in Muscat costs two
 * days, not four, and an overtime shift on the plant's shutdown day is paid at
 * the holiday tier — both answers come from here.
 *
 * ## Why it lives in `leave-requests/` rather than in `holidays/`
 *
 * These are branch-calendar questions and by rights belong beside the Holiday
 * model. `holidays/` is another module's code and this branch does not edit it,
 * so the helpers live here and are exported by `LeaveRequestsModule` for the
 * overtime module to import. `docs/interconnections-leave-overtime.md` records
 * the move for whoever owns `holidays/` to accept.
 *
 * ## Why not `AttendanceCalendarService`
 *
 * That service answers for one EMPLOYEE on one DAY, resolving a WorkSchedule
 * override and a timezone on the way. Leave duration is a BRANCH question over a
 * RANGE: a personal roster row saying "this Friday you work" does not make the
 * Friday cost a leave day, because the request was priced against the branch
 * calendar the approver was looking at.
 */
@Injectable()
export class WorkingDaysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  /**
   * ISO weekday (1 = Monday … 7 = Sunday) for a date-only column.
   *
   * The twelve-hour shift is load-bearing. Postgres `DATE` values arrive through
   * the driver as midnight in the SERVER's zone, so on a +05:30 server the row
   * `2026-08-24` comes back as `2026-08-23T18:30:00Z` and a raw UTC weekday
   * reports Sunday for a Monday — every leave request would then be priced
   * against the wrong calendar, silently, and only east of Greenwich. Moving the
   * instant to the middle of the day puts it past any such offset in either
   * direction before the weekday is taken.
   */
  static isoWeekdayOf(date: Date): number {
    const noon = new Date(date.getTime() + TWELVE_HOURS_MS);
    return ((noon.getUTCDay() + 6) % 7) + 1;
  }

  /** Parse `"5,6"` into a clean ISO-weekday array, dropping anything else. */
  static parseWeeklyOffCsv(csv: string): number[] {
    return csv
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  }

  /**
   * Which ISO weekdays are non-working for a branch.
   *
   * Precedence: the branch's own `weeklyOffDays` → the company-wide
   * `attendance_weekly_off_days` setting → Friday and Saturday.
   *
   * An EMPTY `Branch.weeklyOffDays` means "inherit", not "this branch works
   * seven days" — that is what the column's default `[]` documents, and reading
   * it the other way round would make every day of a leave request billable at
   * a branch nobody has configured yet.
   */
  async getWeeklyOffDays(branchId?: string | null): Promise<number[]> {
    if (branchId) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { weeklyOffDays: true },
      });
      if (branch?.weeklyOffDays?.length) {
        return branch.weeklyOffDays.filter((n) => n >= 1 && n <= 7);
      }
    }

    // The global setting is still a CSV string — it is edited on the settings
    // screen as text — so it is the one place a parser is needed.
    const raw = await this.settings.get('attendance_weekly_off_days');
    const parsed = raw ? WorkingDaysService.parseWeeklyOffCsv(raw) : [];
    return parsed.length ? parsed : [5, 6];
  }

  /**
   * The `where` fragment selecting holidays a branch observes.
   *
   * `OR: [{ branchId: null }, { branchId }]` rather than a plain equality: a
   * company-wide holiday is stored with a NULL branch, and `branchId = x` never
   * matches NULL in SQL — so the plain form would silently drop every national
   * holiday and price a leave request over New Year as four working days.
   */
  private holidayScope(branchId?: string | null) {
    return branchId
      ? { OR: [{ branchId: null }, { branchId }] }
      : { branchId: null };
  }

  /** Is this date a holiday at this branch (company-wide or branch-specific)? */
  async isHoliday(date: Date, branchId?: string | null): Promise<boolean> {
    const found = await this.prisma.holiday.findFirst({
      where: { date, ...this.holidayScope(branchId) },
      select: { id: true },
    });
    return Boolean(found);
  }

  /** Is this date one of the branch's weekly rest days? */
  async isWeeklyOff(date: Date, branchId?: string | null): Promise<boolean> {
    const offDays = await this.getWeeklyOffDays(branchId);
    return offDays.includes(WorkingDaysService.isoWeekdayOf(date));
  }

  /**
   * Every working date in an inclusive range, weekly-off days and holidays
   * removed, normalised to UTC midnight so the values can be written straight
   * into a `@db.Date` column.
   *
   * Returns the DATES rather than a count because the approval needs both: the
   * count prices the request, and the list is what ON_LEAVE attendance rows are
   * written for. Deriving one from the other twice is how the two disagree.
   */
  async getWorkingDatesBetween(
    startDate: Date,
    endDate: Date,
    branchId?: string | null,
  ): Promise<Date[]> {
    const start = toUtcMidnight(startDate);
    const end = toUtcMidnight(endDate);
    if (end.getTime() < start.getTime()) return [];

    const [weeklyOff, holidays] = await Promise.all([
      this.getWeeklyOffDays(branchId),
      this.prisma.holiday.findMany({
        where: {
          date: { gte: start, lte: end },
          ...this.holidayScope(branchId),
        },
        select: { date: true },
      }),
    ]);

    const holidayKeys = new Set(
      holidays.map((h) => toUtcMidnight(h.date).toISOString().slice(0, 10)),
    );

    const dates: Date[] = [];
    for (
      let cursor = new Date(start);
      cursor.getTime() <= end.getTime();
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
    ) {
      const key = cursor.toISOString().slice(0, 10);
      const weekday = WorkingDaysService.isoWeekdayOf(cursor);
      if (!weeklyOff.includes(weekday) && !holidayKeys.has(key)) {
        dates.push(new Date(cursor));
      }
    }
    return dates;
  }

  /** How many working days an inclusive range contains at this branch. */
  async getWorkDaysBetween(
    startDate: Date,
    endDate: Date,
    branchId?: string | null,
  ): Promise<number> {
    const dates = await this.getWorkingDatesBetween(
      startDate,
      endDate,
      branchId,
    );
    return dates.length;
  }
}

/**
 * A date-only value at UTC midnight, taken from the middle of its own day.
 *
 * Same reason as `isoWeekdayOf`: a `DATE` that arrives as the previous evening
 * in UTC would be truncated to the previous day.
 */
function toUtcMidnight(date: Date): Date {
  const noon = new Date(date.getTime() + TWELVE_HOURS_MS);
  return new Date(
    Date.UTC(noon.getUTCFullYear(), noon.getUTCMonth(), noon.getUTCDate()),
  );
}
