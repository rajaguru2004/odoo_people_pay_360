'use client';

import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import employeeService from '@/services/employeeService';
import visaService from '@/services/visaService';
import type { PeopleHubSummary } from '@/types/peopleHub';
import type { TrendMonths } from '@/types/organizationHub';
import type { LegalDocument, LegalDocumentSummary } from '@/types/legalDocument';

export type { TrendMonths };

/** Days from now until `iso`, negative once it is in the past. */
export function daysUntil(
  iso: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.ceil((then - now) / 86_400_000);
}

/** Guards every rate this module reads: null and NaN both mean "not known". */
export function knownRate(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The People hub's data.
 *
 * One aggregate answers the lifecycle — headcount and its status split, joiners
 * and leavers with the previous month to compare against, contract and
 * probation deadlines, open terminations, and the trend.
 *
 * **Permits stay on their own two queries, deliberately.** `/legal-documents/*`
 * answers 403 for a role that may not see them. Keeping them separate is what
 * lets the two permit cards go quiet while every other card on the page keeps
 * working; folding them into the aggregate would let one module's 403 blank the
 * whole screen.
 */
export function usePeopleHub(expiryWindowDays = 30) {
  const [months, setMonths] = useState<TrendMonths>(6);

  const results = useQueries({
    queries: [
      {
        queryKey: ['people-hub', 'summary', months] as const,
        queryFn: () =>
          employeeService.hubSummary(months).then((r) => r.data),
        staleTime: 60_000,
        placeholderData: (previous?: PeopleHubSummary) => previous,
      },
      {
        queryKey: ['people-hub', 'visa-summary'] as const,
        queryFn: () => visaService.summary().then((r) => r.data),
        staleTime: 60_000,
      },
      {
        queryKey: ['people-hub', 'visa-expiring', expiryWindowDays] as const,
        queryFn: () =>
          visaService.expiring(expiryWindowDays).then((r) => r.data),
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

    visaSummary: visaSummary.data as LegalDocumentSummary | undefined,
    visaExpiring: (visaExpiring.data ?? []) as LegalDocument[],
    visaLoading: visaExpiring.isLoading || visaSummary.isLoading,
    /** The whole permit module is unreachable — its cards are dropped rather
     *  than shown empty. */
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
