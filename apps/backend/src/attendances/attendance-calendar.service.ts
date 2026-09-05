import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ShiftType } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_GRACE_MINUTES,
  DEFAULT_OFFICE_END,
  DEFAULT_OFFICE_START,
  dayKeyToDate,
  expectedHours,
  isWeeklyOff,
  parseDayKey,
  parseWallClock,
  resolveZone,
  toDayKey,
} from './attendance-calendar.util';

/** A branch's working day with every inherited value already filled in. */
export interface ResolvedBranchConfig {
  branchId: string | null;
  zone: string;
  officeStart: string;
  officeEnd: string;
  graceMinutes: number;
  weeklyOffDays: number[];
  expectedHours: number;
}

/** A holiday as the calendar reads it: the branch row wins on a shared date. */
export interface ResolvedHoliday {
  id: string;
  name: string;
  branchId: string | null;
}

export interface DayCalendar {
  date: string;
  zone: string;
  officeStart: string;
  officeEnd: string;
  graceMinutes: number;
  /** Hours the day asks for — the roster's number when there is one. */
  expectedHours: number;
  isWorkingDay: boolean;
  isWeeklyOff: boolean;
  holiday: ResolvedHoliday | null;
  schedule: {
    id: string;
    shiftType: ShiftType;
    isWorkDay: boolean;
    startTime: string | null;
    endTime: string | null;
  } | null;
  /** Which calendar actually decided the day. */
  source: 'schedule' | 'branch';
}

/**
 * The roster row the day composer reads.
 *
 * Structural rather than a Prisma payload type so a caller may hand over a row
 * it selected for its own reasons, and so `requiredHours` can arrive as the
 * Decimal Prisma returns or as the number a test writes.
 */
export interface RosterOverride {
  id: string;
  shiftType: ShiftType;
  isWorkDay: boolean;
  startTime: string | null;
  endTime: string | null;
  requiredHours: Prisma.Decimal | number | null;
}

/** The shift window a day is measured against — wall clocks plus their zone. */
export interface ShiftWindow {
  zone: string;
  officeStart: string;
  officeEnd: string;
}

/** The key `scheduleIndex` files a roster row under. */
export function rosterKey(employeeId: string, dayKey: string): string {
  return `${employeeId}|${dayKey}`;
}

const EMPLOYEE_CALENDAR_SELECT = {
  id: true,
  timezone: true,
  branchId: true,
  branch: {
    select: {
      id: true,
      timezone: true,
      officeStartTime: true,
      officeEndTime: true,
      graceMinutes: true,
      weeklyOffDays: true,
    },
  },
} satisfies Prisma.EmployeeSelect;

export type EmployeeCalendarContext = Prisma.EmployeeGetPayload<{
  select: typeof EMPLOYEE_CALENDAR_SELECT;
}>;

/** The key a branchless employee's config is filed under. */
const NO_BRANCH = '';

/**
 * Answers "what was this person supposed to work that day, and in which clock".
 *
 * Split out of AttendancesService because four other places need the same
 * answer — the punch endpoints, the correction approval, the reports and the
 * hub — and a rule that lives in one of them is a rule the other three will
 * eventually disagree with.
 */
@Injectable()
export class AttendanceCalendarService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The company clock, which is the bottom of the inheritance chain.
   *
   * One company per deployment, created by the seed; resolving it here keeps a
   * company id out of every signature that only ever wants its timezone.
   */
  async companyTimezone(): Promise<string> {
    const company = await this.prisma.company.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { timezone: true },
    });
    return company?.timezone?.trim() || 'UTC';
  }

  /** Today, as the given zone sees it — "YYYY-MM-DD". */
  todayIn(zone: string): string {
    return DateTime.now().setZone(zone).toFormat('yyyy-MM-dd');
  }

  /**
   * Every branch's working day, plus a branchless entry for employees who have
   * not been assigned one. Loaded in a single query because the hub and the
   * "who is in today" panel both need all of them at once.
   */
  async branchConfigs(): Promise<Map<string, ResolvedBranchConfig>> {
    const [companyZone, branches] = await Promise.all([
      this.companyTimezone(),
      this.prisma.branch.findMany({
        select: {
          id: true,
          timezone: true,
          officeStartTime: true,
          officeEndTime: true,
          graceMinutes: true,
          weeklyOffDays: true,
        },
      }),
    ]);

    const configs = new Map<string, ResolvedBranchConfig>();
    configs.set(NO_BRANCH, this.resolveBranch(null, companyZone));
    for (const branch of branches) {
      configs.set(branch.id, this.resolveBranch(branch, companyZone));
    }
    return configs;
  }

  /** The config for one branch id, falling back to the company defaults. */
  configFor(
    configs: Map<string, ResolvedBranchConfig>,
    branchId: string | null | undefined,
  ): ResolvedBranchConfig {
    return (
      configs.get(branchId ?? NO_BRANCH) ??
      configs.get(NO_BRANCH) ?? {
        branchId: null,
        zone: 'UTC',
        officeStart: DEFAULT_OFFICE_START,
        officeEnd: DEFAULT_OFFICE_END,
        graceMinutes: DEFAULT_GRACE_MINUTES,
        weeklyOffDays: [],
        expectedHours: expectedHours(DEFAULT_OFFICE_START, DEFAULT_OFFICE_END),
      }
    );
  }

  private resolveBranch(
    branch: {
      id: string;
      timezone: string | null;
      officeStartTime: string | null;
      officeEndTime: string | null;
      graceMinutes: number | null;
      weeklyOffDays: number[];
    } | null,
    companyZone: string,
  ): ResolvedBranchConfig {
    const officeStart = branch?.officeStartTime?.trim() || DEFAULT_OFFICE_START;
    const officeEnd = branch?.officeEndTime?.trim() || DEFAULT_OFFICE_END;
    return {
      branchId: branch?.id ?? null,
      zone: resolveZone(null, branch, companyZone),
      officeStart,
      officeEnd,
      graceMinutes: branch?.graceMinutes ?? DEFAULT_GRACE_MINUTES,
      weeklyOffDays: branch?.weeklyOffDays ?? [],
      expectedHours: expectedHours(officeStart, officeEnd),
    };
  }

  /** Employee plus the branch fields the calendar reads, in one query. */
  async employeeContext(employeeId: string): Promise<EmployeeCalendarContext> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: EMPLOYEE_CALENDAR_SELECT,
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
  }

  /**
   * Holidays in a date range, indexed by day key.
   *
   * A branch-specific row and a company-wide one can both land on a date; the
   * branch row wins, which is how a national holiday observed in one country
   * and not another is expressed without maintaining a second calendar.
   */
  async holidayIndex(
    fromKey: string,
    toKey: string,
  ): Promise<Map<string, ResolvedHoliday[]>> {
    const rows = await this.prisma.holiday.findMany({
      where: {
        date: { gte: dayKeyToDate(fromKey), lte: dayKeyToDate(toKey) },
      },
      select: { id: true, name: true, date: true, branchId: true },
    });

    const index = new Map<string, ResolvedHoliday[]>();
    for (const row of rows) {
      const key = toDayKey(row.date);
      const bucket = index.get(key) ?? [];
      bucket.push({ id: row.id, name: row.name, branchId: row.branchId });
      index.set(key, bucket);
    }
    return index;
  }

  /** The holiday in force at a branch on a date, branch row first. */
  holidayOn(
    index: Map<string, ResolvedHoliday[]>,
    dayKey: string,
    branchId: string | null | undefined,
  ): ResolvedHoliday | null {
    const rows = index.get(dayKey);
    if (!rows?.length) return null;
    return (
      rows.find((h) => h.branchId && h.branchId === branchId) ??
      rows.find((h) => h.branchId === null) ??
      null
    );
  }

  /** Does the branch calendar alone call this date a working day? */
  isBranchWorkingDay(
    config: ResolvedBranchConfig,
    dayKey: string,
    holidayIndex: Map<string, ResolvedHoliday[]>,
  ): boolean {
    const date = parseDayKey(dayKey);
    if (!date) return false;
    if (isWeeklyOff(date, config.weeklyOffDays)) return false;
    return !this.holidayOn(holidayIndex, dayKey, config.branchId);
  }

  /**
   * The instant a day's shift closes, in the branch's own clock.
   *
   * An end at or before the start belongs to the following morning, so a night
   * shift's day is not reported as over the moment it begins.
   */
  officeEndInstant(dayKey: string, window: ShiftWindow): DateTime {
    const start = parseWallClock(window.officeStart) ?? 0;
    const end = parseWallClock(window.officeEnd) ?? 0;
    const base = DateTime.fromFormat(dayKey, 'yyyy-MM-dd', {
      zone: window.zone,
    }).set({ hour: Math.floor(end / 60), minute: end % 60 });
    return end <= start ? base.plus({ days: 1 }) : base;
  }

  /**
   * Roster rows for a set of people over a range, keyed by employee and day.
   *
   * The batched twin of the lookup inside `resolveDay`. A month's report asks
   * the same question for every person on every day, and one query per cell is
   * several hundred round trips for a report nobody would wait for.
   */
  async scheduleIndex(
    employeeIds: string[],
    fromKey: string,
    toKey: string,
  ): Promise<Map<string, RosterOverride>> {
    const index = new Map<string, RosterOverride>();
    if (employeeIds.length === 0) return index;

    const rows = await this.prisma.workSchedule.findMany({
      where: {
        employeeId: { in: employeeIds },
        date: { gte: dayKeyToDate(fromKey), lte: dayKeyToDate(toKey) },
      },
      select: {
        id: true,
        employeeId: true,
        date: true,
        shiftType: true,
        isWorkDay: true,
        startTime: true,
        endTime: true,
        requiredHours: true,
      },
    });

    for (const row of rows) {
      index.set(rosterKey(row.employeeId, toDayKey(row.date)), row);
    }
    return index;
  }

  /**
   * The day's verdict from inputs the caller has already loaded.
   *
   * Split out of `resolveDay` so one day and a whole month reach the same
   * answer by the same route: `resolveDay` fetches for a single cell, a report
   * fetches in bulk, and both end here. A second copy of this precedence is a
   * second definition of what a working day is, and the two drift the first
   * time a roster rule changes.
   *
   * A WorkSchedule row beats the branch calendar outright — deviating from the
   * branch calendar is the only reason such a row is ever written, so treating
   * it as a hint the branch could override would make the table pointless.
   */
  composeDay(input: {
    dayKey: string;
    zone: string;
    branchConfig: ResolvedBranchConfig;
    holiday: ResolvedHoliday | null;
    schedule: RosterOverride | null;
  }): DayCalendar {
    const { dayKey, zone, branchConfig, holiday, schedule } = input;
    const weeklyOff = isWeeklyOff(
      parseDayKey(dayKey) ?? DateTime.fromMillis(0),
      branchConfig.weeklyOffDays,
    );

    if (schedule) {
      const officeStart = schedule.startTime?.trim() || branchConfig.officeStart;
      const officeEnd = schedule.endTime?.trim() || branchConfig.officeEnd;
      return {
        date: dayKey,
        zone,
        officeStart,
        officeEnd,
        graceMinutes: branchConfig.graceMinutes,
        expectedHours: schedule.requiredHours
          ? Number(schedule.requiredHours)
          : expectedHours(officeStart, officeEnd),
        isWorkingDay: schedule.isWorkDay,
        isWeeklyOff: weeklyOff,
        holiday,
        schedule: {
          id: schedule.id,
          shiftType: schedule.shiftType,
          isWorkDay: schedule.isWorkDay,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
        },
        source: 'schedule',
      };
    }

    return {
      date: dayKey,
      zone,
      officeStart: branchConfig.officeStart,
      officeEnd: branchConfig.officeEnd,
      graceMinutes: branchConfig.graceMinutes,
      expectedHours: branchConfig.expectedHours,
      isWorkingDay: !weeklyOff && !holiday,
      isWeeklyOff: weeklyOff,
      holiday,
      schedule: null,
      source: 'branch',
    };
  }

  /**
   * The full picture for one employee on one date.
   *
   * Loads the three inputs the composer needs and hands them straight over, so
   * the precedence between a roster row and the branch calendar is stated once.
   */
  async resolveDay(
    employeeId: string,
    dayKey: string,
    context?: EmployeeCalendarContext,
  ): Promise<DayCalendar> {
    const employee = context ?? (await this.employeeContext(employeeId));
    const [companyZone, holidayIndex, schedule] = await Promise.all([
      this.companyTimezone(),
      this.holidayIndex(dayKey, dayKey),
      this.prisma.workSchedule.findUnique({
        where: { employeeId_date: { employeeId, date: dayKeyToDate(dayKey) } },
        select: {
          id: true,
          shiftType: true,
          isWorkDay: true,
          startTime: true,
          endTime: true,
          requiredHours: true,
        },
      }),
    ]);

    return this.composeDay({
      dayKey,
      zone: resolveZone(employee, employee.branch, companyZone),
      branchConfig: this.resolveBranch(employee.branch, companyZone),
      holiday: this.holidayOn(holidayIndex, dayKey, employee.branchId),
      schedule,
    });
  }
}
