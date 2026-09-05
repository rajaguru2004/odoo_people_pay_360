'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { payrollHubService } from '@/services/payrollExtensionsService';
import { useBranchStore } from '@/store/branchStore';
import type { PayrollHubSummary, PayrollTrendMonths } from '@/types/payrollHub';

/**
 * The Payroll hub's data.
 *
 * One aggregate replaces the seven browser-side requests this page used to
 * make. Five of those were `/payrolls/reports/*` endpoints that load every
 * payroll item and every payslip line for a period in order to add up four
 * numbers, and one of them — `register` — was where the open-runs card got its
 * count, off a list the server caps at twenty rows.
 *
 * The reporting period is NOT a parameter. The server resolves it to the newest
 * month that actually holds a run and labels what it picked, because runs are
 * generated after a month ends: a hub pinned to the calendar month reads empty
 * for the first days of every month. The trailing window is the only thing the
 * reader can move, and it moves the trend panel alone.
 *
 * `lib/react-query.tsx` already invalidates everything on a branch switch, so
 * the branch dimension is handled for free — the branch id is still in the key
 * so two branches cannot share a cache entry.
 */

/**
 * The period a payroll screen is about: the month being run right now.
 *
 * Kept exported although this hub no longer uses it — `hooks/useFinanceHub.ts`
 * imports it for the loan-recovery cycle, which genuinely is "this month".
 */
export function currentPeriod(now = new Date()): { month: number; year: number } {
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

export function usePayrollHub() {
  const branchId = useBranchStore((s) => s.selectedBranchId) ?? undefined;
  const [months, setMonths] = useState<PayrollTrendMonths>(6);

  const query = useQuery({
    queryKey: ['module', 'payroll', branchId ?? 'all', 'hub', months],
    queryFn: () => payrollHubService.getHubSummary(months).then((r) => r.data),
    staleTime: 60_000,
    // Keeps the previous window on screen while the next one loads, so the page
    // does not blank out when the reader flips 6M to 12M.
    placeholderData: (prev) => prev,
  });

  return {
    summary: query.data as PayrollHubSummary | undefined,
    months,
    setMonths,
    loading: query.isLoading,
    fetching: query.isFetching,
    /**
     * Load-bearing. A failed read must print an em dash, never 0, and must
     * never reach the attention strip's all-clear: "every run is locked and
     * everyone can be paid" is the worst possible guess when the question was
     * never actually answered.
     */
    failed: query.isError,
  };
}
