import type { HubDelta, HubWindow } from './moduleHub';

/** `GET /finance/hub-summary`. */
export interface FinanceHubSummary {
  window: HubWindow;
  travel: FinanceTravel;
  budgets: FinanceBudgets;
}

export interface FinanceTravel {
  pending: number;
  onTripToday: number;
  upcoming30Days: number;
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
