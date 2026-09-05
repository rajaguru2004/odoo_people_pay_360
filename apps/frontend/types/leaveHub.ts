/**
 * `GET /leave-requests/hub-summary` — the Leave & Overtime hub payload.
 *
 * Two questions on one page, because they are the same trade: hours the company
 * owes against hours it has bought.
 *
 * Every rate is `null` rather than 0% when there was nothing to divide by. An
 * empty month and a month where nothing was approved are different claims, and a
 * card printing 0.0% for both has told the reader something false about one of
 * them — the frontend renders `null` as an em dash.
 *
 * Balance figures are YEAR facts (a week does not have an entitlement), scoped
 * to the year the window ENDS in.
 */

export type HubPeriod = 'today' | 'week' | 'month' | 'year';

export interface LeaveHubRange {
  start: string;
  end: string;
  /** The window clipped at today — what "so far" means on a current period. */
  through: string;
  /** Formatted on the server, so the browser does no calendar maths. */
  label: string;
  prevAnchor: string;
  nextAnchor: string;
  /** Leave is filed ahead, so one window forward is legitimate. */
  hasNext: boolean;
  isCurrent: boolean;
}

export interface LeaveHubStats {
  requests: number;
  approved: number;
  pending: number;
  rejected: number;
  cancelled: number;
  approvalRate: number | null;
  /** Prorated to the part of each request inside the window. */
  leaveDays: number;
  onLeaveToday: number;
  activeHeadcount: number;
  onLeaveTodayRate: number | null;
  pendingOlderThanTwoDays: number;
  allocated: number;
  carriedOver: number;
  used: number;
  remaining: number;
  utilisation: number | null;
  averageBalance: number | null;
  overtimeHours: number;
  overtimeRequests: number;
  overtimeEmployees: number;
  /** Divided by the employees WITH overtime, not by headcount. */
  avgOvertimePerEmployee: number | null;
  topLeaveType: string | null;
}

export interface LeaveHubTrendBucket {
  key: string;
  label: string;
  approved: number;
  pending: number;
  rejected: number;
  cancelled: number;
  total: number;
}

export interface LeaveHubTypeRow {
  key: string;
  name: string;
  requests: number;
  days: number;
  share: number | null;
}

export interface LeaveHubBalanceRow {
  key: string;
  name: string;
  allocated: number;
  used: number;
  carriedOver: number;
  remaining: number;
  utilisation: number | null;
  employeeCount: number;
}

export interface LeaveHubOvertimeBucket {
  key: string;
  label: string;
  hours: number;
}

export interface LeaveHubNamedHours {
  id: string;
  name: string;
  hours: number;
}

/** A named sample beside the true count — the count is never `names.length`. */
export interface LeaveHubAttentionItem {
  count: number;
  names: string[];
}

export interface LeaveHubSummary {
  period: HubPeriod;
  anchor: string;
  range: LeaveHubRange;
  periodStats: LeaveHubStats;
  previousStats: LeaveHubStats;
  previousRange: { start: string; end: string; label: string };
  trendKind: 'hour' | 'day' | 'month';
  trend: LeaveHubTrendBucket[];
  leaveTypes: LeaveHubTypeRow[];
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
    byType: LeaveHubBalanceRow[];
  };
  overtime: {
    /** False when the company does not track overtime at all — draw nothing,
     *  rather than a panel of zeros that reads as "nobody worked late". */
    enabled: boolean;
    totalHours: number;
    trend: LeaveHubOvertimeBucket[];
    byDepartment: LeaveHubNamedHours[];
    topEmployees: LeaveHubNamedHours[];
    topDepartment: LeaveHubNamedHours | null;
    topEmployee: LeaveHubNamedHours | null;
  };
  attention: {
    pending: LeaveHubAttentionItem;
    stale: LeaveHubAttentionItem;
    onLeaveToday: LeaveHubAttentionItem;
    highOvertime: LeaveHubAttentionItem;
  };
}
