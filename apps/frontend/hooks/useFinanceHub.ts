'use client';

import { useModuleHub } from './useModuleHub';
import type { FinanceHubSummary } from '@/types/financeHub';

/**
 * The money the company has committed, and the trips it has approved.
 *
 * This used to fire parallel requests and re-derive its figures in the browser,
 * which is how the page came to hold a second — and divergent — definition of
 * every number on it. One server-side aggregate removes both the fan-out and the
 * chance of the two answers disagreeing.
 */
export function useFinanceHub() {
  return useModuleHub<FinanceHubSummary>('finance', '/finance/hub-summary');
}
