/**
 * `GET /organization/hub-summary` — the Organization hub's one payload.
 *
 * Mirrors `apps/backend/src/organization-hub/organization-hub.service.ts`.
 * Every rate is `number | null`, never `0` as a stand-in for "not known": an
 * empty branch and an empty company are different claims, and a card printing
 * 0.0% for both has told the reader something false about one of them.
 */

/** Trend windows the panel offers. Anything else is refused by the server. */
export type TrendMonths = 6 | 12;

export interface OrgUnitRow {
  id: string;
  name: string;
  employees: number;
  /** Percentage of the active workforce, or null when there is nobody to divide by. */
  share: number | null;
}

export interface OrgGrowthBucket {
  /** `YYYY-MM`. */
  key: string;
  /** `Aug 2026` — the server owns the label so the browser does no calendar maths. */
  label: string;
  joiners: number;
  leavers: number;
  net: number;
  headcountEnd: number | null;
}

export interface OrganizationHubSummary {
  months: number;
  headcount: { active: number; inactive: number; total: number };
  branches: {
    total: number;
    withoutManager: number;
    rows: OrgUnitRow[];
  };
  departments: {
    total: number;
    withoutHead: number;
    /** People whose department has no head — they have no approver. */
    unmanagedHeadcount: number;
    rows: OrgUnitRow[];
    headless: Array<{ id: string; name: string; employees: number }>;
  };
  managers: {
    /** The union, not the sum: one person can wear all three hats. */
    total: number;
    deptHeads: number;
    branchManagers: number;
    supervisors: number;
    widestSpan: {
      supervisorId: string | null;
      name: string;
      department: string | null;
      reports: number;
    } | null;
  };
  changeRequests: {
    pending: number;
    approved: number;
    rejected: number;
    cancelled: number;
    total: number;
  };
  /** `noBranch` only — `Employee.departmentId` is NOT NULL, so it has no twin. */
  unassigned: { noBranch: number };
  growth: {
    months: number;
    buckets: OrgGrowthBucket[];
    netChange: number;
    growthPct: number | null;
  };
}
