/**
 * The Leave & Overtime module hub payload — `GET /leave-requests/hub-summary`.
 *
 * Same envelope as `types/attendanceHub.ts` and `types/schedulesHub.ts`: a
 * period + anchor window, the window before it for every delta on the page,
 * trend buckets, and an action queue. The Week / Month / Year selector moves all
 * of it together.
 *
 * Month is the default. Leave and overtime are read in monthly cycles — that is
 * how the balance accrues and how payroll consumes the overtime.
 *
 * ## Two things worth knowing before reading a number here
 *
 * **`leaveDays` is prorated.** A request running 28 Aug → 6 Sep belongs to both
 * months, and each month is charged only the working days that fall inside it.
 * `totalDays` on the request itself is the WHOLE request.
 *
 * **`balance` is a year fact.** A week does not have an entitlement, so the
 * balance block is always the year that `range.end` falls in, whatever period
 * is selected. Only `remaining` is derived — there is no such column —
 * as `allocated + carriedOver - used`.
 *
 * Every rate is `number | null`. `null` means there was nothing to divide by;
 * 0% is a claim, and a different one.
 */

import type { HubPeriod } from './attendanceHub';

export type { HubPeriod };

export interface LeaveHubPeriodStats {
  requests: number;
  approved: number;
  pending: number;
  rejected: number;
  /** Counted here, unlike `GET /leave-balances/company-overview`, which omits it. */
  cancelled: number;
  approvalRate: number | null;
  /** APPROVED working days inside this window only. See the file header. */
  leaveDays: number;
  onLeaveToday: number;
  activeHeadcount: number;
  onLeaveTodayRate: number | null;
  pendingOlderThan2Days: number;

  /** Year-scoped to `range.end`'s year, whatever period is selected. */
  allocated: number;
  carriedOver: number;
  used: number;
  remaining: number;
  utilisation: number | null;
  /** Remaining days per ACTIVE employee. */
  averageBalance: number | null;

  overtimeHours: number;
  overtimeRequests: number;
  /** Employees with any approved overtime — the average's denominator. */
  overtimeEmployees: number;
  avgOvertimePerEmployee: number | null;

  topLeaveType: string | null;
}

export interface LeaveTrendBucket {
  key: string;
  label: string;
  approved: number;
  pending: number;
  rejected: number;
  cancelled: number;
  total: number;
}

export interface LeaveTypeSlice {
  key: string;
  name: string;
  requests: number;
  days: number;
  share: number | null;
}

export interface LeaveTypeBalanceRow {
  key: string;
  name: string;
  allocated: number;
  used: number;
  carriedOver: number;
  remaining: number;
  utilisation: number | null;
  employeeCount: number;
}

export interface OvertimeSlice {
  id: string;
  name: string;
  hours: number;
}

export interface LeaveHubSummary {
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
  periodStats: LeaveHubPeriodStats;
  previousStats: LeaveHubPeriodStats;
  previousRange: { start: string; end: string; label: string };
  trendKind: 'hour' | 'day' | 'month';
  trend: LeaveTrendBucket[];
  leaveTypes: LeaveTypeSlice[];
  status: {
    approved: number;
    pending: number;
    rejected: number;
    cancelled: number;
  };
  balance: {
    allocated: number;
    carriedOver: number;
    used: number;
    remaining: number;
    utilisation: number | null;
    byType: LeaveTypeBalanceRow[];
  };
  overtime: {
    /**
     * The `overtime_enabled` kill switch. False → the page drops the overtime
     * KPI and panel rather than drawing zeros, which would read as "nobody
     * worked late" instead of "this company does not track overtime".
     */
    enabled: boolean;
    totalHours: number;
    trend: Array<{ key: string; label: string; hours: number }>;
    byDepartment: OvertimeSlice[];
    topEmployees: OvertimeSlice[];
    topDepartment: OvertimeSlice | null;
    topEmployee: OvertimeSlice | null;
  };
  attention: {
    pending: { count: number; names: string[] };
    /** PENDING for more than two days — a queue judged by age, not size. */
    stale: { count: number; names: string[] };
    onLeaveToday: { count: number; names: string[] };
    /** At or past a month's worth of overtime. A welfare signal. */
    highOvertime: { count: number; names: string[] };
  };
}
