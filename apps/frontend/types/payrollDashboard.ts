/**
 * The lifecycle of a payroll run as the analytics endpoint reports it.
 *
 * Declared here rather than imported from `./payroll`, because that module's
 * `PayrollStatus` describes main's approval lifecycle (DRAFT, PENDING_APPROVAL,
 * APPROVED, REJECTED, LOCKED) — a different set of states for a different
 * model. Keeping them apart stops a rename in one from silently retyping the
 * other; the analytics response owns this vocabulary.
 */
export type PayrollRunStatus =
  | 'DRAFT'
  | 'CALCULATED'
  | 'APPROVED'
  | 'PAID'
  | 'CANCELLED';

/**
 * The analytics page's response contract.
 *
 * Mirrors `PayrollDashboardSummary` in
 * `apps/backend/src/payroll/payroll-dashboard.service.ts`. Every nullable field
 * here is nullable on purpose and carries the reason: `null` means the question
 * could not be answered, and the page prints an em dash for it. A `0` in its
 * place would be a claim the data does not support.
 */

export type DashboardMonths = 6 | 12;

export interface DashboardFilterOption {
  value: string;
  label: string;
}

export interface DashboardAppliedFilters {
  months: number;
  /** `YYYY-MM`. The period the server actually answered for. */
  period: string;
  departmentId: string | null;
  employmentType: string | null;
}

export interface DashboardFilters {
  /**
   * The RESOLVED slicers, echoed back.
   *
   * The filter row renders these rather than what it asked for, so a defaulted
   * period — the page opens on the latest locked run, not on today — shows the
   * month the numbers are actually about.
   */
  applied: DashboardAppliedFilters;
  departments: DashboardFilterOption[];
  employmentTypes: DashboardFilterOption[];
}

export interface DashboardPeriodRef {
  label: string;
  periodStart: string;
  periodEnd: string;
}

export interface DashboardMoney {
  currency: string;
  /**
   * Currencies in the window that are NOT `currency`.
   *
   * Their months are excluded from the totals rather than added in: OMR plus
   * KWD is not money. The page discloses them instead of quietly drawing a
   * shorter line.
   */
  otherCurrencies: string[];
  gross: number;
  net: number;
  deductions: number;
  employerCost: number;
  previousNet: number;
  /** `null` when the previous period paid nothing — no comparison to make. */
  changePct: number | null;
  /** `null` when nobody was paid: an average of nothing is not zero. */
  averageNet: number | null;
}

export interface DashboardTrendBucket {
  key: string;
  /** Server-formatted — `Aug 2026`. The browser does no calendar maths. */
  label: string;
  gross: number;
  net: number;
  deductions: number;
  employeeCount: number;
  /** Running total from the start of the window. Server-owned. */
  cumulativeNet: number;
}

export interface DashboardBridgeStep {
  key: string;
  label: string;
  amount: number;
  /** `total` starts at zero; `add`/`subtract` float off the running balance. */
  kind: 'total' | 'add' | 'subtract';
}

export interface DashboardBridge {
  steps: DashboardBridgeStep[];
  gross: number;
  deductions: number;
  net: number;
  /**
   * What the per-payslip net floor added back.
   *
   * Each payslip floors its own net at zero, so across a run
   * `Σnet ≥ Σgross − Σdeductions`. This is the gap, and it is drawn as its own
   * step — a bridge whose bars do not reach its final column is the one thing a
   * bridge cannot get wrong. Zero in the ordinary case.
   */
  netFloorResidual: number;
}

export interface DashboardFunnelStage {
  stage: 'DRAFT' | 'CALCULATED' | 'APPROVED' | 'PAID';
  /** The reader's word for the stage — `Computed`, `Validated`. */
  label: string;
  /**
   * Runs that have reached AT LEAST this stage, read from the run's timestamps
   * rather than its current status.
   *
   * Monotonically decreasing by construction, which is what makes it a funnel:
   * counting the status a run is in right now gives a shape that goes up and
   * down. A rejected run sits back in `DRAFT` but genuinely was computed once,
   * and `calculatedAt` still says so. `CANCELLED` runs are in no stage at all.
   */
  reached: number;
}

export interface DashboardComponentBucket {
  key: string;
  label: string;
  amount: number;
}

export interface DashboardDepartmentRow {
  /** `null` for the Unassigned row — employees in no department. */
  id: string | null;
  name: string;
  headcount: number;
  gross: number;
  deductions: number;
  net: number;
  employerCost: number;
  totalCost: number;
  /** Share of total cost; `null` when the total is zero. */
  share: number | null;
  avgNet: number | null;
}

export interface DashboardAttendanceRow {
  departmentId: string | null;
  name: string;
  present: number;
  late: number;
  absent: number;
  halfDay: number;
  onLeave: number;
  /** Event days only — `HOLIDAY` and `WEEKEND` are not attendance. */
  total: number;
  healthPct: number | null;
}

export interface DashboardCoverage {
  present: number;
  late: number;
  absent: number;
  halfDay: number;
  onLeave: number;
  expected: number;
  attendanceRate: number | null;
  payrollCompletion: number | null;
  activeEmployees: number;
}

export type DashboardAttentionSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface DashboardAttentionItem {
  code: string;
  severity: DashboardAttentionSeverity;
  /** The true total. `names` is a capped sample — never read its length. */
  count: number;
  names: string[];
  message: string;
}

export interface PayrollDashboardSummary {
  filters: DashboardFilters;
  period: DashboardPeriodRef;
  previousPeriod: DashboardPeriodRef;
  money: DashboardMoney;
  payslips: { total: number; employeesPaid: number };
  timeOff: { approvedDays: number; approvedRequests: number };
  overtime: { approvedHours: number };
  coverage: DashboardCoverage;
  runs: {
    byStatus: Record<PayrollRunStatus, number>;
    inWindow: number;
    funnel: DashboardFunnelStage[];
  };
  trend: DashboardTrendBucket[];
  departments: DashboardDepartmentRow[];
  components: DashboardComponentBucket[];
  bridge: DashboardBridge;
  attendance: DashboardAttendanceRow[];
  attention: DashboardAttentionItem[];
}

/** What the filter row sends. Every value is validated server-side. */
export interface PayrollDashboardQuery {
  months?: DashboardMonths;
  period?: string;
  departmentId?: string;
  employmentType?: string;
}
