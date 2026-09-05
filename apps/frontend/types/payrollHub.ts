/**
 * The contract of `GET /payrolls/hub-summary`.
 *
 * Mirrors `apps/backend/src/payrolls/payroll-hub.service.ts`. Two conventions
 * run through the whole shape and the page depends on both:
 *
 *  - **`null` means unknown, never zero.** A section the server could not
 *    compute — no wage file has ever been produced, a branch with no banking
 *    country — arrives as `null`. The page renders an em dash for it and is
 *    forbidden from printing an all-clear over it.
 *  - **Money means LOCKED.** Every figure under `money`, `composition` and the
 *    `net` of a trend bucket comes from locked runs only, because a DRAFT total
 *    is money that has not moved. Non-locked work shows up as *counts* — runs
 *    in progress, employees in an open run — never as an amount.
 */

/** The trailing windows the trend panel offers. Anything else is refused with 400. */
export type PayrollTrendMonths = 6 | 12;

/** Every state a payroll run can be in. Matches the `PayrollStatus` enum. */
export const PAYROLL_RUN_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'LOCKED',
] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

/** The earning columns of a payslip, in the order the panel lists them. */
export const PAYROLL_EARNING_KEYS = [
  'baseSalary',
  'allowances',
  'bonus',
  'overtimePay',
  'foodAllowance',
  'siteAllowance',
  'reimbursement',
  'leaveEncashment',
] as const;

/** The deduction columns. The first six are `register`'s definition verbatim. */
export const PAYROLL_DEDUCTION_KEYS = [
  'deduction',
  'insurance',
  'tax',
  'advanceLoanDeduction',
  'garnishment',
  'otherRecovery',
] as const;

export type PayrollMoneyKey =
  | (typeof PAYROLL_EARNING_KEYS)[number]
  | (typeof PAYROLL_DEDUCTION_KEYS)[number];

export interface PayrollCompositionRow {
  key: PayrollMoneyKey;
  amount: number;
}

export interface PayrollHubEmployee {
  id: string;
  employeeCode: string;
  fullName: string;
}

export interface PayrollHubRunRef {
  id: string;
  month: number;
  year: number;
  /** `Aug 2026` — already formatted by the server, so the browser does no calendar maths. */
  label: string;
}

export interface PayrollPendingRun extends PayrollHubRunRef {
  submittedAt: string | null;
}

export interface PayrollTrendBucket {
  /** `YYYY-MM`, stable across locales and safe as a React key. */
  key: string;
  label: string;
  month: number;
  year: number;
  /**
   * `null` when no run in this month is locked. Drawing 0 would put a
   * floor-height bar on the chart that reads as "we paid nobody that month",
   * which is a different and much louder claim than "not finalised yet".
   */
  net: number | null;
  /** Gross for the month — the same eight earning columns `composition` sums. */
  gross: number | null;
  /** The statutory employee contribution (SPF / EPF / CPF, per country). */
  statutory: number | null;
  employees: number;
  runs: number;
  lockedRuns: number;
  locked: boolean;
}

export interface PayrollReadiness {
  /**
   * `run` when the anchor month holds payslips — the people actually about to
   * be paid. `active` when it does not, so the panel can say it is describing
   * the workforce rather than a run.
   */
  population: 'run' | 'active';
  total: number;
  ready: number;
  /**
   * `null` when nobody could be judged — a branch with no banking country has
   * no required fields, so "100% ready" there would be a fabricated all-clear.
   */
  readyRate: number | null;
  noBankRecord: number;
  incompleteFields: number;
  pendingChange: number;
  bankInactive: number;
  countryNotAllowed: number;
  /** Counted, excluded from `readyRate`, and named as unknown on the panel. */
  unknown: number;
  names: PayrollHubEmployee[];
}

export interface PayrollHubSummary {
  months: PayrollTrendMonths;
  anchor: {
    month: number;
    year: number;
    label: string;
    /**
     * Which rule picked the period. Runs are generated after a month ends, so
     * the hub anchors on the newest month that actually holds one — and says
     * so, rather than leaving the reader to guess why it is showing July.
     */
    resolvedFrom: 'latest-run' | 'current-month';
    previous: { month: number; year: number; label: string };
  };
  runs: {
    /** Counts by status inside the trend window — what the pipeline donut draws. */
    windowByStatus: Partial<Record<PayrollRunStatus, number>>;
    /**
     * Every run ever, at any status. Load-bearing for one distinction the page
     * cannot otherwise draw: "every run is locked" and "there are no runs at
     * all" both leave `inProgress` at 0, and only one of them is good news.
     */
    total: number;
    locked: number;
    /**
     * Unwindowed queue counts. A queue is what is waiting NOW: an open run from
     * four months ago is exactly the one somebody needs to be told about, so
     * these deliberately do not follow the 6M/12M toggle.
     */
    inProgress: number;
    pendingApproval: number;
    approvedNotLocked: number;
    draft: number;
    rejected: number;
    oldestPendingAt: string | null;
    draftForClosedPeriod: number;
    pending: PayrollPendingRun[];
    rejectedRuns: PayrollHubRunRef[];
  };
  money: {
    net: number | null;
    previousNet: number | null;
    /**
     * Gross, the statutory line, and total deductions for the anchor, each with
     * the previous month beside it. Same locked-only rule as `net`: a month
     * with nothing locked is `null`, never 0.
     */
    gross: number | null;
    previousGross: number | null;
    statutory: number | null;
    previousStatutory: number | null;
    deductions: number | null;
    previousDeductions: number | null;
    currency: string;
  };
  employees: {
    paid: number;
    inOpenRun: number;
    active: number;
    notInAnyRun: number;
    names: PayrollHubEmployee[];
  };
  readiness: PayrollReadiness | null;
  trend: PayrollTrendBucket[];
  composition: {
    earnings: PayrollCompositionRow[];
    deductions: PayrollCompositionRow[];
    grossReported: number;
    deductionsTotal: number;
    net: number | null;
    /**
     * `Σearnings − Σdeductions − Σnet`. Non-zero means the payslip columns do
     * not reconcile with what was actually paid — the panel prints it rather
     * than hiding it inside a rounded bar.
     */
    residual: number;
  };
  carryForward: { outstanding: number };
  settlements: { draft: number; awaitingPayment: number; openPayout: number } | null;
  wps: {
    lastFileAt: string | null;
    lastFileStatus: string | null;
    lastFileName: string | null;
    rejected: number;
  } | null;
  /**
   * Legacy company-wide runs (`branchId = null`). `Payroll` is `'direct'` in the
   * branch scope map, so these are invisible to every scoped query — including
   * every other figure in this payload. Surfaced so the page can say "N runs are
   * not shown here" instead of letting them vanish.
   */
  unscopedLegacyRuns: number;
}
