/**
 * The Schedules module hub payload — `GET /calendar/hub-summary`.
 *
 * Same envelope as `types/attendanceHub.ts`: a period + anchor window, the
 * window before it for every delta on the page, trend buckets, a ranking and an
 * action queue. The Week / Month / Year selector moves all of it together.
 *
 * Week is the default here. Scheduling is operational and short-term — "is next
 * week covered" is the question this module is opened with, not "how did 2026
 * go".
 *
 * ## What the numbers can and cannot mean
 *
 * `WorkSchedule` is one row per employee per date with a REQUIRED `employeeId`,
 * and the schema carries no capacity column, no shift template and no roster
 * pattern. So there is no such thing as an unfilled shift or an over-capacity
 * one, and nothing stores an hourly staffing requirement. Three fields here are
 * the honest substitutes, and they are named for what they actually measure:
 *
 *   `coverageGaps`  — working days whose scheduled headcount is below the
 *                     window's own median. NOT "open shifts".
 *   `status`        — assigned / unassigned / the three conflict kinds. NOT
 *                     "over capacity".
 *   `staffCoverage` — how many people are on shift each hour, against a flat
 *                     active-headcount baseline. It says how the day is
 *                     staffed, never whether that is enough.
 *
 * Every rate is `number | null`. `null` means there was nothing to divide by;
 * 0% is a claim that nobody was scheduled, which is a different fact.
 */

import type { HubPeriod } from './attendanceHub';

export type { HubPeriod };

export interface SchedulesConflictSample {
  employeeId: string;
  fullName: string | null;
  date: string;
  /** Present only on a holiday conflict — the holiday somebody is rostered on. */
  holiday?: string;
}

export interface SchedulesPeriodStats {
  /** ACTIVE, non-admin employees in the caller's scope. Every rate's denominator. */
  activeHeadcount: number;
  /** Distinct employees with at least one work-day shift in the window. */
  scheduledEmployees: number;
  unscheduled: number;
  /** Rows in `work_schedules`, which is NOT the same as people scheduled. */
  shiftRows: number;
  /** Days at least one branch was open. Holidays and weekly-offs excluded. */
  workingDays: number;
  scheduledToday: number;
  coverageRate: number | null;
  /** Working days below the window's own median. See the file header. */
  coverageGaps: number;
  conflicts: {
    onHoliday: number;
    onWeeklyOff: number;
    overlaps: number;
    total: number;
  };
}

export interface SchedulesTrendBucket {
  key: string;
  label: string;
  /** Who the branch calendar says should be at work. Zero on a closed day. */
  expected: number;
  scheduled: number;
  /** `max(0, expected - scheduled)` — never negative on a day people worked closed. */
  unassigned: number;
  coverageRate: number | null;
}

export interface SchedulesShiftMix {
  /** One of MORNING | AFTERNOON | FULL_DAY | NIGHT | CUSTOM | FLEXIBLE. */
  type: string;
  count: number;
  employees: number;
  share: number | null;
}

export interface SchedulesDepartment {
  id: string;
  name: string;
  headcount: number;
  scheduled: number;
  unscheduled: number;
  rate: number | null;
  /**
   * False only when the department has nobody ACTIVE in it — there is nothing
   * to divide by. A department with people and no roster is genuinely 0%
   * covered, and that is the most actionable number on the panel.
   */
  hasData: boolean;
}

export interface SchedulesHubSummary {
  period: HubPeriod;
  anchor: string;
  range: {
    start: string;
    end: string;
    through: string;
    label: string;
    prevAnchor: string;
    nextAnchor: string;
    hasNext: boolean;
    isCurrent: boolean;
  };
  periodStats: SchedulesPeriodStats;
  previousStats: SchedulesPeriodStats;
  previousRange: { start: string; end: string; label: string };
  trendKind: 'hour' | 'day' | 'month';
  trend: SchedulesTrendBucket[];
  shiftMix: SchedulesShiftMix[];
  status: {
    assigned: number;
    unassigned: number;
    onHoliday: number;
    onWeeklyOff: number;
    overlaps: number;
  };
  staffCoverage: {
    activeBaseline: number;
    /** FLEXIBLE shifts have no window, so they cannot sit on an hour axis. */
    flexibleExcluded: number;
    hours: Array<{ hour: number; label: string; onShift: number }>;
  };
  departments: SchedulesDepartment[];
  attention: {
    unassigned: { count: number; names: string[] };
    onHoliday: { count: number; samples: SchedulesConflictSample[] };
    onWeeklyOff: { count: number; samples: SchedulesConflictSample[] };
    overlaps: { count: number; samples: SchedulesConflictSample[] };
    thinnestDay: { date: string; label: string; scheduled: number } | null;
  };
  holidays: Array<{ date: string; name: string }>;
  /** Day numbers, Sunday-first, as `Branch.weeklyOffDays` stores them. */
  weeklyOffDays: number[];
}
