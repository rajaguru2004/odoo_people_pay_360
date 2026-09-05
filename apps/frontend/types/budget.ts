export type BudgetStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED';

export interface Budget {
  id: string;
  name: string;
  fiscalYear: number;
  startDate: string;
  endDate: string;
  branchId: string;
  currency: string;
  status: BudgetStatus;
  branch?: { id: string; code: string; name: string } | null;
  lines?: BudgetLine[];
  _count?: { lines: number };
}

export interface BudgetLine {
  id: string;
  budgetId: string;
  /** null = the company-wide fallback line for a category. */
  departmentId: string | null;
  category: string;
  plannedAmount: string | number;
  notes: string | null;
  department?: { id: string; name: string } | null;
}

/**
 * One row of the variance report.
 *
 * `committed` counts only OPEN commitments. Once the money is paid its
 * commitment is REALIZED and it appears under `actual` instead — which is why
 * the two can be added without double-counting.
 */
export interface VarianceRow {
  budgetLineId: string;
  departmentId: string | null;
  departmentName: string;
  category: string;
  planned: number;
  committed: number;
  actual: number;
  remaining: number;
  /** (committed + actual) / planned. Over 1 means over budget. */
  utilization: number;
}

export interface VarianceReport {
  budget: {
    id: string;
    name: string;
    fiscalYear: number;
    startDate: string;
    endDate: string;
    currency: string;
    status: BudgetStatus;
    branch?: { id: string; code: string; name: string } | null;
  };
  rows: VarianceRow[];
  totals: {
    planned: number;
    committed: number;
    actual: number;
    remaining: number;
  };
  /** Real spend with no budget line to attach to — an over-run, not an under-spend. */
  unbudgeted: Array<{
    departmentId: string | null;
    category: string;
    actual: number;
  }>;
}

export interface CreateBudgetData {
  name: string;
  fiscalYear: number;
  startDate: string;
  endDate: string;
  branchId: string;
  currency?: string;
  status?: BudgetStatus;
}

export interface UpsertBudgetLineData {
  departmentId?: string;
  category: string;
  plannedAmount: number;
  notes?: string;
}
