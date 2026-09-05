import type { AttendanceStatus } from '@prisma/client';
import { roundDays } from './payroll-calc.util';

/**
 * How a month of attendance rows becomes a number of paid days.
 *
 * The rule is HRM's MONTHLY behaviour, kept deliberately: **the full month is
 * paid and recorded absence is clawed back**. A working day with no attendance
 * row at all is therefore PAID, not unpaid — a missing row is a gap in the
 * data, not evidence that somebody stayed home, and treating it as an absence
 * would dock a whole workforce the first time an import failed.
 *
 * That is exactly why the pre-flight raises an employee with no attendance as a
 * WARNING and a run where NOBODY has attendance as a BLOCKER: under this rule
 * the second case pays a full month against a period that was never processed,
 * and it is the only place the rule is dangerous.
 */

/** What one day's status costs the employee, in days. */
const UNPAID_WEIGHT = {
  ABSENT: 1,
  HALF_DAY: 0.5,
  // ON_LEAVE is paid. Leave & Overtime is not built yet, so there is no
  // LeaveRequest to ask whether this particular leave was approved as unpaid;
  // until it lands, leave is treated as paid and the seam is recorded in
  // docs/interconnections-payroll.md.
  ON_LEAVE: 0,
  PRESENT: 0,
  LATE: 0,
  HOLIDAY: 0,
  WEEKEND: 0,
  // Exhaustive on purpose. A new AttendanceStatus must be given a weight here
  // rather than defaulting to paid, because the default is the expensive
  // direction: an unpaid status nobody classified would be paid in full.
} satisfies Record<AttendanceStatus, number>;

export interface AttendanceDayInput {
  /** `YYYY-MM-DD`. */
  dayKey: string;
  status: AttendanceStatus;
}

export interface PaidDaysResult {
  workDays: number;
  paidDays: number;
  unpaidDays: number;
}

/**
 * Paid days for one employee over one period.
 *
 * `workingDayKeys` is the branch calendar's answer, already filtered: a weekly
 * off or a public holiday is not a working day, so an absence recorded on one
 * costs nothing. Only rows falling on a working day are counted at all.
 */
export function resolvePaidDays(
  workingDayKeys: string[],
  days: AttendanceDayInput[],
): PaidDaysResult {
  const workingSet = new Set(workingDayKeys);
  const seen = new Set<string>();
  let unpaid = 0;

  for (const day of days) {
    if (!workingSet.has(day.dayKey)) continue;
    // One row per day. A duplicate import must not dock the same day twice.
    if (seen.has(day.dayKey)) continue;
    seen.add(day.dayKey);
    unpaid += UNPAID_WEIGHT[day.status];
  }

  const workDays = workingDayKeys.length;
  const unpaidDays = roundDays(Math.min(unpaid, workDays));
  return { workDays, paidDays: roundDays(workDays - unpaidDays), unpaidDays };
}
