/**
 * `GET /employees/hub-summary` — the People hub's one payload.
 *
 * Work permits are deliberately absent. `/legal-documents/*` can answer 403 for
 * a role that may not see them, and the hub is built to quieten two permit
 * cards while the rest of the page keeps working — folding them in here would
 * let one module's 403 blank the whole screen.
 */
export type { TrendMonths } from './organizationHub';

export interface PeopleTrendBucket {
  key: string;
  label: string;
  joiners: number;
  leavers: number;
  net: number;
  headcountEnd: number | null;
}

export interface PeopleHubSummary {
  months: number;
  headcount: {
    active: number;
    inactive: number;
    byStatus: Array<{ status: string; count: number }>;
  };
  lifecycle: {
    joinersThisMonth: number;
    leaversThisMonth: number;
    netChangeThisMonth: number;
    /** So a delta names a window the reader could go and check. */
    previousMonth: { joiners: number; leavers: number };
    startingSoon: Array<{
      id: string;
      fullName: string;
      startDate: string;
      department: string | null;
    }>;
    probationEndingSoon: Array<{
      contractId: string;
      employeeId: string | null;
      fullName: string | null;
      endDate: string;
    }>;
  };
  contracts: {
    total: number;
    active: number;
    expired: number;
    expiringSoon: number;
    expiring: Array<{
      id: string;
      employeeId: string | null;
      fullName: string | null;
      endDate: string | null;
      daysUntilExpiry: number;
    }>;
  };
  terminations: { awaitingApproval: number; thisMonth: number };
  /** Mutually exclusive and summing to the workforce. */
  statusSplit: Array<{ key: string; label: string; count: number }>;
  trend: {
    months: number;
    buckets: PeopleTrendBucket[];
    netChange: number;
    /** Leavers over average headcount; null when there is nothing to divide by. */
    turnoverRate: number | null;
  };
}
