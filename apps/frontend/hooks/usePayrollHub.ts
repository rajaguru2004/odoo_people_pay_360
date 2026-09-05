'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import payrollRunService from '@/services/payrollRunService';
import type { PayrollHubSummary, TrendMonths } from '@/types/payrollHub';

export type { TrendMonths };

export const payrollHubKeys = {
  all: ['payroll-hub'] as const,
  summary: (months: TrendMonths) =>
    [...payrollHubKeys.all, 'summary', months] as const,
};

/**
 * The Payroll hub's data, and the trend window that moves it.
 *
 * ONE request answers the whole landing page — the pipeline counts, the money,
 * the coverage, the attention list and the trend — rather than the page fanning
 * out to the list endpoints and counting rows off them. A queue longer than one
 * page would otherwise be under-reported on the one card whose job is to say
 * how much work is waiting.
 *
 * `months` is 6 or 12 and nothing else: the server refuses any other window
 * with a 400 rather than silently answering for a period nobody asked about.
 */
export function usePayrollHub(initialMonths: TrendMonths = 6) {
  const [months, setMonths] = useState<TrendMonths>(initialMonths);

  const query = useQuery({
    queryKey: payrollHubKeys.summary(months),
    queryFn: () => payrollRunService.hubSummary(months).then((r) => r.data),
    staleTime: 60_000,
    // Keeps the current window on screen while the next loads, so switching
    // 6 ↔ 12 does not blank the page.
    placeholderData: (previous?: PayrollHubSummary) => previous,
  });

  return {
    summary: query.data,
    months,
    setMonths,
    loading: query.isLoading,
    fetching: query.isFetching,
    failed: query.isError,
  };
}
