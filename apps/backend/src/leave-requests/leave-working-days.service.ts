import { Injectable } from '@nestjs/common';
import {
  AttendanceCalendarService,
  type ResolvedBranchConfig,
} from '../attendances/attendance-calendar.service';
import { toDayKey } from '../attendances/attendance-calendar.util';

/**
 * How many of the days between two dates the employee was actually due to work.
 *
 * Leave duration and the LEAVE attendance rows written on approval must agree,
 * and both have to answer the same question: which of these dates does the
 * employee's branch calendar call a working day? Asking the calendar service
 * rather than counting weekdays is what keeps a Friday-Saturday weekend and a
 * branch-specific national holiday out of the count.
 */
@Injectable()
export class LeaveWorkingDaysService {
  constructor(private readonly calendar: AttendanceCalendarService) {}

  /** The dates in `[start, end]` the employee's branch expects them to work. */
  async workingDatesBetween(
    startDate: Date,
    endDate: Date,
    branchId: string | null | undefined,
  ): Promise<Date[]> {
    if (endDate < startDate) return [];

    const fromKey = toDayKey(startDate);
    const toKey = toDayKey(endDate);
    const [configs, holidays] = await Promise.all([
      this.calendar.branchConfigs(),
      this.calendar.holidayIndex(fromKey, toKey),
    ]);
    const config: ResolvedBranchConfig = this.calendar.configFor(
      configs,
      branchId,
    );

    const dates: Date[] = [];
    // Iterate on UTC midnights: a date-only column is stored there, and
    // stepping in local time drifts a day across a DST boundary.
    for (
      let cursor = new Date(startDate.getTime());
      cursor <= endDate;
      cursor = new Date(cursor.getTime() + 86_400_000)
    ) {
      const dayKey = toDayKey(cursor);
      if (this.calendar.isBranchWorkingDay(config, dayKey, holidays)) {
        dates.push(new Date(`${dayKey}T00:00:00.000Z`));
      }
    }
    return dates;
  }

  /** The count of those dates — the duration a leave request is charged. */
  async workDaysBetween(
    startDate: Date,
    endDate: Date,
    branchId: string | null | undefined,
  ): Promise<number> {
    return (await this.workingDatesBetween(startDate, endDate, branchId))
      .length;
  }
}
