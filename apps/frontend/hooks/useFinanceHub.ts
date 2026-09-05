'use client';

import { useModuleHub } from './useModuleHub';
import type { FinanceHubSummary } from '@/types/financeHub';

/**
 * The money the company owes its staff, has lent them, and has committed.
 *
 * This used to fire five parallel requests and re-derive the loan aging buckets
 * in the browser from `overdueAmount`/`daysOverdue` — field names the server has
 * never sent. The Overdue KPI printed a formatted zero, every row fell into the
 * `1–30` bucket at amount 0, and each attention pill read "overdue by 0 days".
 * The server sends `amountDue`/`overdueDays` and a ready-made `buckets` object;
 * the hub now reads that instead of computing a second, wrong answer.
 */
export function useFinanceHub() {
  return useModuleHub<FinanceHubSummary>('finance', '/finance/hub-summary');
}
