'use client';

import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import employeeService from '@/services/employeeService';
import visaService from '@/services/visaService';
import { useBranchStore } from '@/store/branchStore';
import type { PeopleHubSummary, TrendMonths } from '@/types/peopleHub';
import type { VisaRecord, VisaSummary } from '@/types/visa';

/**
 * The People hub's data.
 *
 * One aggregate (`/employees/hub-summary`) answers the lifecycle: headcount and
 * its status split, joiners and leavers with the previous month to compare
 * against, contract and probation deadlines, open terminations, and the trend.
 * It replaces five of the six requests this page used to make.
 *
 * **Permits stay on their own two queries, on purpose.** `/legal-documents/*`
 * answers 403 in installs where the visa module is not licensed, and 500 on a
 * database missing `employee_legal_documents.nationality`. Keeping them
 * separate is what lets the permit cards go quiet while every other card on the
 * page keeps working — folding them into the aggregate would let one module's
 * 403 blank the whole dashboard.
 */

export type { PeopleHubSummary, TrendMonths };

/** Days from now until `iso`, negative once it is in the past. */
export function daysUntil(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.ceil((then - now) / 86_400_000);
}

/** Guards every rate this module reads: null and NaN both mean "not known". */
export function knownRate(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function usePeopleHub(expiryWindowDays = 30) {
  const branchId = useBranchStore((s) => s.selectedBranchId) ?? undefined;
  const [months, setMonths] = useState<TrendMonths>(6);
  const key = ['module', 'people', branchId ?? 'all'] as const;

  const results = useQueries({
    queries: [
      {
        queryKey: [...key, 'hub', months],
        queryFn: () => employeeService.getPeopleHubSummary(months).then((r) => r.data),
        staleTime: 60_000,
        // Keeps the previous window on screen while the next loads, so the page
        // does not blank out when the reader flips 6M to 12M.
        placeholderData: (prev?: PeopleHubSummary) => prev,
      },
      {
        queryKey: [...key, 'visaSummary'],
        queryFn: () => visaService.getSummary().then((r) => r.data),
        staleTime: 60_000,
      },
      {
        queryKey: [...key, 'visaExpiring', expiryWindowDays],
        queryFn: () => visaService.getExpiring(expiryWindowDays).then((r) => r.data),
        staleTime: 60_000,
      },
    ],
  });

  const [hub, visaSummary, visaExpiring] = results;

  return {
    summary: hub.data as PeopleHubSummary | undefined,
    months,
    setMonths,
    loading: hub.isLoading,
    fetching: hub.isFetching,
    failed: hub.isError,

    visaSummary: visaSummary.data as VisaSummary | undefined,
    visaExpiring: (visaExpiring.data ?? []) as VisaRecord[],
    visaLoading: visaExpiring.isLoading || visaSummary.isLoading,
    /**
     * The whole permit module is unreachable — its cards have nothing to say
     * and are dropped rather than shown empty.
     */
    visaUnavailable: visaSummary.isError && visaExpiring.isError,
    /**
     * The expiry LIST alone failed, while the summary may still have answered.
     *
     * Load-bearing: an empty list and a failed request look identical
     * downstream, and "no permit expires in the next 30 days" is the single
     * most dangerous sentence this page could print when it does not know.
     */
    visaExpiringFailed: visaExpiring.isError,
  };
}
