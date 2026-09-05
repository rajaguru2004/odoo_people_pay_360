/**
 * The Time & Attendance module hub payload — `GET /attendances/hub-summary`.
 *
 * The Today / Week / Month / Year selector moves everything the page REPORTS:
 * the KPI cards, the trend, the department ranking, `periodStats`. `Today` is
 * one of the four periods rather than a separate mode, so the ‹ › arrows walk
 * back through yesterday, last week, last month or last year with one control.
 *
 * `today` and `yesterday` ride along regardless, because the three panels at
 * the foot of the page are explicitly about right now — who is still clocked
 * in, what today's roster says, when people arrived this morning.
 *
 * Every rate divides by `expected` — the branch's working calendar minus
 * approved leave — never by headcount. A rate is `null` when there was nothing
 * to divide by; 0% is a claim that everybody failed to turn up.
 */

export type HubPeriod = 'today' | 'week' | 'month' | 'year';

export interface HubDaySnapshot {
  date: string;
  expected: number;
  present: number;
  onTime: number;
  late: number;
  absent: number;
  onLeave: number;
  notCheckedOut: number;
  notCheckedIn: number;
  avgWorkHours: number | null;
  presentRate: number | null;
  lateRate: number | null;
  absentRate: number | null;
  onTimeRate: number | null;
  /** False until the configured attendance day-end passes. */
  settled: boolean;
}

export interface HubTrendBucket {
  key: string;
  label: string;
  expected: number;
  present: number;
  onTime: number;
  late: number;
  absent: number;
  onLeave: number;
  attendanceRate: number | null;
}

export interface HubDepartment {
  id: string;
  name: string;
  headcount: number;
  expected: number;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  rate: number | null;
  /** False when the department filed no attendance at all in the range. */
  hasData: boolean;
}

export interface HubNamedCount {
  count: number;
  names: string[];
}

export interface HubPeriodStats {
  expected: number;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  attendanceRate: number | null;
  lateRate: number | null;
  absentRate: number | null;
  avgWorkHours: number | null;
  lateOccurrences: number;
  /** Days actually aggregated — always days, never chart buckets. */
  daysCounted: number;
  /** Bars on the chart: one per hour, day, or month. */
  bucketCount: number;
}

export interface AttendanceHubSummary {
  period: HubPeriod;
  anchor: string;
  range: {
    start: string;
    end: string;
    /** How much of the range has happened; null for a period entirely ahead. */
    through: string | null;
    label: string;
    prevAnchor: string;
    nextAnchor: string;
    hasNext: boolean;
    isCurrent: boolean;
  };
  today: HubDaySnapshot;
  yesterday: HubDaySnapshot;
  periodStats: HubPeriodStats;
  /** The same window, one step back. Every delta on the page reads this. */
  previousStats: HubPeriodStats;
  previousRange: { start: string; end: string; label: string };
  /** What one bar of `trend` counts. A single day's chart is hourly. */
  trendKind: 'hour' | 'day' | 'month';
  trend: HubTrendBucket[];
  departments: HubDepartment[];
  arrivalPattern: Array<{ hour: number; label: string; onTime: number; late: number }>;
  shifts: {
    shiftCount: number;
    source: 'roster' | 'calendar';
    scheduled: number;
    checkedIn: number;
    onShift: number;
    late: number;
    absent: number;
    onLeave: number;
    yetToCheckIn: number;
    shifts: Array<{ type: string; count: number }>;
  };
  attention: {
    notCheckedIn: HubNamedCount;
    notCheckedOut: HubNamedCount;
    overScheduledHours: HubNamedCount;
    pendingCorrections: number;
    absent: HubNamedCount;
    late: HubNamedCount;
  };
}
