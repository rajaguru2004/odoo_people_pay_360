import type { ShiftType } from './attendance';

/**
 * The Schedules module: the roster as a plan, rather than attendance as a record.
 *
 * ## Why the periods differ from the Time & Attendance hub
 *
 * There is no `today`. "Who is rostered today" is a calendar screen, and a
 * scheduler opens this module to ask whether the coming WEEK is covered — so
 * `week` leads and is the default. And unlike attendance, every window here
 * spans its full range whether or not it has arrived: a roster is a plan, and
 * reading ahead is the entire point of it.
 *
 * ## Three things the API deliberately does not claim
 *
 * `WorkSchedule` is one row per employee per date with a required `employeeId`.
 * There is no capacity column and no hourly demand anywhere in the schema, so an
 * open shift, an over-capacity shift and a staffing REQUIREMENT are not
 * representable. Every name below says what it actually measures:
 *
 *   Coverage gaps    working days below the window's own median headcount
 *   Conflicts        rostered on a holiday, on a weekly off, or overlapping
 *   Staff coverage   people on shift by hour, against a flat headcount baseline
 */

export type SchedulePeriod = 'week' | 'month' | 'year';

/** One thing that happens to a person on one day, as the calendar draws it. */
export interface ScheduleEvent {
  id: string;
  date: string;
  title: string;
  type: 'shift' | 'leave' | 'holiday' | 'weekly-off';
  shiftType: ShiftType | null;
  /** Wall clock, "HH:MM". Null on an all-day marker. */
  startTime: string | null;
  endTime: string | null;
  hours: number | null;
  allDay: boolean;
  isWorkDay: boolean;
  notes: string | null;
}

export interface EmployeeCalendar {
  employee: {
    id: string;
    employeeCode: string;
    fullName: string;
    avatarUrl: string | null;
    status: string;
    branchId: string | null;
    departmentId: string | null;
    department: { id: string; name: string } | null;
    branch: { id: string; code: string; name: string } | null;
  } | null;
  range: { startDate: string; endDate: string };
  calendar?: {
    zone: string;
    officeStart: string;
    officeEnd: string;
    weeklyOffDays: number[];
  };
  events: ScheduleEvent[];
}

export interface ScheduleStats {
  month: number;
  year: number;
  range: { startDate: string; endDate: string };
  /** Days the ROSTER claims. A plain working day with no row is not one. */
  workDays: number;
  scheduledHours: number;
  leaveDays: number;
  holidays: number;
  weeklyOffDays: number;
  /** Days the branch calendar alone calls working — the roster's denominator. */
  branchWorkingDays: number;
}

/** One branch's working week, as the overview grid shades it. */
export interface BranchCalendar {
  branchId: string | null;
  zone: string;
  officeStart: string;
  officeEnd: string;
  /** ISO weekdays, 1 = Monday … 7 = Sunday. Empty means none configured. */
  weeklyOffDays: number[];
}

export interface OverviewEmployee {
  id: string;
  employeeCode: string;
  fullName: string;
  avatarUrl: string | null;
  status: string;
  branchId: string | null;
  branchName: string | null;
  departmentId: string | null;
  departmentName: string | null;
}

export interface OverviewShift {
  id: string;
  employeeId: string;
  date: string;
  shiftType: ShiftType;
  startTime: string | null;
  endTime: string | null;
  isWorkDay: boolean;
  notes: string | null;
  hours: number;
}

export interface ScheduleOverview {
  range: { startDate: string; endDate: string };
  employees: OverviewEmployee[];
  schedules: OverviewShift[];
  leaves: Array<{ id: string; employeeId: string; date: string }>;
  holidays: Array<{
    id: string;
    date: string;
    name: string;
    branchId: string | null;
  }>;
  branchCalendars: BranchCalendar[];
}

export interface ConflictSample {
  employeeId: string;
  fullName: string;
  date: string;
  reason: string;
}

export interface ScheduleCoverage {
  window: { startDate: string; endDate: string };
  activeHeadcount: number;
  scheduledEmployees: number;
  unscheduled: number;
  shifts: number;
  byDay: Array<{
    date: string;
    scheduled: number;
    expected: number;
    isWorkingDay: boolean;
  }>;
  thinnestDay: {
    date: string;
    scheduled: number;
    expected: number;
    isWorkingDay: boolean;
  } | null;
  conflicts: {
    onHoliday: number;
    onWeeklyOff: number;
    overlaps: number;
    total: number;
    samples: ConflictSample[];
  };
}

export interface ScheduleConflictReport {
  hasConflicts: boolean;
  conflicts: Array<{
    id: string;
    date: string;
    shiftType: ShiftType;
    startTime: string | null;
    endTime: string | null;
    employee: { id: string; employeeCode: string; fullName: string };
  }>;
}

// ── The hub ──────────────────────────────────────────────────────────────────

export interface SchedulePeriodStats {
  activeHeadcount: number;
  scheduledEmployees: number;
  unscheduled: number;
  /** Rows, not people. Somebody rostered five days is five rows. */
  shiftRows: number;
  workingDays: number;
  /** Never period-scoped: what somebody standing in the office at 9am needs. */
  scheduledToday: number;
  coverageRate: number | null;
  coverageGaps: number;
  conflicts: {
    onHoliday: number;
    onWeeklyOff: number;
    overlaps: number;
    total: number;
  };
}

export interface ScheduleTrendBucket {
  key: string;
  label: string;
  /** What the branch calendars expected. Zero on a day every branch was shut. */
  expected: number;
  scheduled: number;
  /** Never negative — somebody on a closed day is a conflict, not negative gap. */
  unassigned: number;
  coverageRate: number | null;
}

export interface ScheduleShiftMix {
  type: ShiftType;
  count: number;
  employees: number;
  share: number | null;
}

export interface ScheduleDepartment {
  id: string;
  name: string;
  headcount: number;
  scheduled: number;
  unscheduled: number;
  rate: number | null;
  /** False only when the department has nobody active — nothing to divide by. */
  hasData: boolean;
}

export interface StaffCoverage {
  activeBaseline: number;
  /** Rows with no window to place on an hour axis. Reported, not hidden. */
  flexibleExcluded: number;
  hours: Array<{ hour: number; label: string; onShift: number }>;
}

export interface ScheduleAttention {
  unassigned: { count: number; names: string[] };
  onHoliday: { count: number; samples: ConflictSample[] };
  onWeeklyOff: { count: number; samples: ConflictSample[] };
  overlaps: { count: number; samples: ConflictSample[] };
  thinnestDay: { date: string; label: string; scheduled: number } | null;
}

export interface SchedulesHubSummary {
  period: SchedulePeriod;
  anchor: string;
  range: {
    start: string;
    end: string;
    /** The whole window — a roster is legitimately read ahead of today. */
    through: string;
    label: string;
    prevAnchor: string;
    nextAnchor: string;
    /** False only a year past today, where the roster is empty by definition. */
    hasNext: boolean;
    isCurrent: boolean;
  };
  periodStats: SchedulePeriodStats;
  previousStats: SchedulePeriodStats;
  previousRange: { start: string; end: string; label: string };
  trendKind: 'day' | 'month';
  trend: ScheduleTrendBucket[];
  shiftMix: ScheduleShiftMix[];
  status: {
    assigned: number;
    unassigned: number;
    onHoliday: number;
    onWeeklyOff: number;
    overlaps: number;
  };
  staffCoverage: StaffCoverage;
  departments: ScheduleDepartment[];
  attention: ScheduleAttention;
  holidays: Array<{ date: string; name: string }>;
}
