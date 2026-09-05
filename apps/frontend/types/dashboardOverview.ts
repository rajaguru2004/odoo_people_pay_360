import type { UserRole } from './auth';
import type {
  DashboardDepartmentRow,
  DashboardTrendBucket,
  PayrollRunStatus,
} from './payrollDashboard';

/**
 * The main dashboard's response contract.
 *
 * Mirrors `DashboardOverview` in
 * `apps/backend/src/dashboard/dashboard.service.ts`.
 *
 * **`/dashboard` is the one route every role can open** — admin, HR, payroll
 * officer, manager and employee all have `VIEW_DASHBOARD`. So this payload is
 * role-aware in a specific way: a section the caller may not see is **absent**,
 * not zeroed. `sections` says which arrived.
 *
 * Absent and empty are different claims, and the distinction is the whole
 * design. A payroll block of zeroes sent to an employee would tell them the
 * company paid nothing; omitting it tells the page not to draw the panel at
 * all. Every consumer checks `sections`, never a truthy figure.
 */

/** The blocks a caller may be entitled to. */
export type DashboardSection =
  | 'workforce'
  | 'attendance'
  | 'payroll'
  | 'approvals'
  | 'compliance';

export interface DashboardWorkforceBucket {
  key: string;
  /** Server-formatted — `Aug 2026`. The browser does no calendar maths. */
  label: string;
  joiners: number;
  leavers: number;
  /**
   * Active headcount at the close of the month, or `null` where the backwards
   * walk cannot reconstruct it — see `buildWorkforceTrend`. `null` is drawn as
   * a gap in the line, never as a zero.
   */
  headcountEnd: number | null;
}

export interface DashboardWorkforce {
  headcount: number;
  joinersThisMonth: number;
  leaversThisMonth: number;
  onProbation: number;
  /** Ordered by headcount, descending. `id` is `null` for Unassigned. */
  byDepartment: Array<{ id: string | null; name: string; headcount: number }>;
  trend: DashboardWorkforceBucket[];
  /** `null` when the window opened with nobody to measure against. */
  growthPct: number | null;
}

export interface DashboardAttendance {
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  /** Expected today and not yet clocked in. Only meaningful while `!settled`. */
  notCheckedIn: number;
  /** The working calendar minus approved leave — never headcount. */
  expected: number;
  /** `null` when nobody was expected: a closed branch is not a failed one. */
  attendanceRate: number | null;
  /**
   * False until the branch's office end has passed.
   *
   * Before it, "absent" is a PREDICTION rather than a fact — somebody who has
   * not arrived at 09:30 may still arrive. The panel says so instead of
   * reporting a number that will be wrong by the afternoon.
   */
  settled: boolean;
}

export interface DashboardPayroll {
  lastRun: {
    id: string;
    label: string;
    status: PayrollRunStatus;
    net: number;
    periodStart: string;
  } | null;
  /** `null` when no run is locked for the period. Never a zero. */
  netThisPeriod: number | null;
  previousNet: number | null;
  changePct: number | null;
  employeesPaid: number;
  /**
   * Deliberately the SAME shape as the analytics page's trend, so
   * `NetSalaryTrendChart` mounts here with no adapter between them. Two shapes
   * for one series is how the same month starts reading differently on two
   * screens.
   */
  trend: DashboardTrendBucket[];
  /** Same reason: `DepartmentCostChart` takes these rows unchanged. */
  byDepartment: DashboardDepartmentRow[];
}

export type DashboardApprovalSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface DashboardApprovalItem {
  key: string;
  label: string;
  /** Counted in the database. `null` is not possible here — a queue has a size. */
  count: number;
  href: string;
  severity: DashboardApprovalSeverity;
  /** Age of the oldest item waiting; `null` when the queue is empty. */
  oldestDays: number | null;
}

export interface DashboardApprovals {
  total: number;
  items: DashboardApprovalItem[];
}

export interface DashboardExpiryItem {
  id: string;
  employeeName: string;
  /** What is expiring — a document category, a contract type, "Probation". */
  kind: string;
  /** Date-only. Render with `formatDateOnly`, never an instant parse. */
  expiryDate: string;
  /** Negative when already past. */
  daysLeft: number;
  href: string;
}

export interface DashboardExpiryGroup {
  /** The true total. `items` is a capped sample — never read its length. */
  count: number;
  items: DashboardExpiryItem[];
}

export interface DashboardCompliance {
  documents: DashboardExpiryGroup;
  contracts: DashboardExpiryGroup;
  probation: DashboardExpiryGroup;
  /** The window these were gathered over, so the panel can name it. */
  horizonDays: number;
}

/**
 * The self block, present for EVERY role.
 *
 * An employee's whole dashboard is this. It answers about the caller and nobody
 * else, which is why it is the one section with no entitlement check on it.
 */
export interface DashboardMe {
  employeeId: string | null;
  /** `null` when the account has no employee record behind it (a bare admin). */
  todayStatus: string | null;
  /** Remaining leave days across every type; `null` when no balance exists. */
  leaveBalanceDays: number | null;
  pendingOwnRequests: number;
  latestPayslip: {
    id: string;
    label: string;
    net: number;
    currency: string;
  } | null;
}

export interface DashboardOverview {
  /** Which blocks arrived. A section not listed here is absent, not empty. */
  sections: DashboardSection[];
  viewer: { role: UserRole; employeeId: string | null };
  /** Today in the COMPANY clock, as a day key. */
  today: string;
  /** The period the payroll block answers for — `August 2026`. */
  periodLabel: string;
  currency: string;

  workforce?: DashboardWorkforce;
  attendance?: DashboardAttendance;
  payroll?: DashboardPayroll;
  approvals?: DashboardApprovals;
  compliance?: DashboardCompliance;
  me: DashboardMe;
}

/** The only trend windows the dashboard offers, matching every other hub. */
export type DashboardMonths = 6 | 12;

export interface DashboardOverviewQuery {
  months?: DashboardMonths;
}
