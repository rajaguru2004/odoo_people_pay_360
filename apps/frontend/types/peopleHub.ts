/**
 * `GET /employees/hub-summary` — the People hub's one payload.
 *
 * Mirrors `apps/backend/src/employees/people-hub.service.ts`.
 *
 * Work permits are deliberately absent. `/legal-documents/*` answers 403 for
 * some roles, and the hub is built to quieten two permit cards while the rest
 * of the page keeps working — folding them in here would let one module's 403
 * blank the whole dashboard.
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
    /** Raw rows — `Employee.status` is free text, not an enum. */
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
  /** Mutually exclusive and summing to the workforce: active/probation/notice/inactive. */
  statusSplit: Array<{ key: string; label: string; count: number }>;
  trend: {
    months: number;
    buckets: PeopleTrendBucket[];
    netChange: number;
    turnoverRate: number | null;
  };
}
