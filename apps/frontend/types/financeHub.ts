import type { HubDelta, HubTrendBucket, HubWindow } from './moduleHub';

/** `GET /finance/hub-summary`. */
export interface FinanceHubSummary {
  window: HubWindow;
  reimbursements: FinanceReimbursements;
  travel: FinanceTravel;
  loans: FinanceLoans;
  budgets: FinanceBudgets;
  trendKind: 'month';
  /** Twelve months of settled expense; segments are `travel|training|other`. */
  trend: HubTrendBucket[];
}

export interface FinanceStatusFigure {
  count: number;
  amount: number;
}

export interface FinanceReimbursements {
  pendingCount: number;
  pendingAmount: number;
  olderThan7Days: number;
  /** `status='PAID'` with `paidAt` in the window — money that actually left. */
  paidCount: number;
  paidAmount: number;
  prevPaidAmount: number;
  paidDelta: HubDelta | null;
  /** Every status in `PENDING|APPROVED|PAID|REJECTED|CANCELLED`, zero-filled. */
  byStatus: Record<string, FinanceStatusFigure>;
  byCategory: Array<{ key: string; label: string; amount: number }>;
}

export interface FinanceTravel {
  pending: number;
  onTripToday: number;
  upcoming30Days: number;
  /**
   * Per diem only. There is no travel-actuals column, no expense table and no
   * settlement step in this schema, so the only real travel money is the
   * per-diem claim travel raises on approval. `estimatedCost` is an estimate
   * and never appears here.
   */
  perDiemPaidAmount: number;
  prevPerDiemPaidAmount: number;
  perDiemDelta: HubDelta | null;
}

export interface FinanceLoanStatusRow {
  status: string;
  type: string;
  count: number;
  principal: number;
  repaid: number;
  writtenOff: number;
  waived: number;
  /** Only a debt-bearing status carries outstanding; the rest report 0. */
  isDebt: boolean;
  outstanding: number;
}

export interface FinanceOverdueRow {
  loanId: string;
  referenceNo: string | null;
  employeeName: string;
  /** The server's own field name. Reading `daysOverdue` is the defect this replaced. */
  overdueDays: number;
  /** The server's own field name. Reading `overdueAmount` is the defect this replaced. */
  amountDue: number;
  bucket: '1-30' | '31-60' | '61-90' | '90+';
}

export interface FinanceLoans {
  outstanding: number;
  principal: number;
  accounts: number;
  /** `null` when the ledger holds nothing at or before the baseline date. */
  outstandingAsOfPrev: number | null;
  outstandingDelta: HubDelta | null;
  byStatus: FinanceLoanStatusRow[];
  overdue: {
    count: number;
    amount: number;
    buckets: Record<string, { count: number; amount: number }>;
    top: FinanceOverdueRow[];
  };
}

export interface FinanceBudgetRow {
  budgetId: string;
  name: string;
  fiscalYear: number;
  planned: number;
  committed: number;
  actual: number;
  remaining: number;
  /** `null` when nothing is planned — a rate off zero is not a rate. */
  utilization: number | null;
}

export interface FinanceBudgets {
  budgets: number;
  overBudget: number;
  planned: number;
  committed: number;
  actual: number;
  remaining: number;
  utilization: number | null;
  prevUtilization: number | null;
  utilizationDelta: HubDelta | null;
  rows: FinanceBudgetRow[];
}
