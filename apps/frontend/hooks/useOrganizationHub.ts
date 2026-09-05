'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import organizationService from '@/services/organizationService';
import { useBranchStore } from '@/store/branchStore';
import type { OrganizationHubSummary, TrendMonths } from '@/types/organizationHub';

/**
 * The Organization hub's data.
 *
 * One aggregate replaces the six browser-side requests this page used to make,
 * one of which counted rows off a list endpoint that sends no pagination meta —
 * so the pending-change-request card silently under-reported any queue longer
 * than a page.
 *
 * The trailing window is the ONLY thing the reader can move here. The page
 * header carries no period filter: everything else on this hub is a fact about
 * the structure right now, and a Week/Month/Year selector over "how many
 * departments have no head" would be a control with nothing to control.
 */

/** Percentage-point helper — null and NaN both mean "not known". */
export function knownShare(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function useOrganizationHub() {
  const branchId = useBranchStore((s) => s.selectedBranchId) ?? undefined;
  const [months, setMonths] = useState<TrendMonths>(6);

  const query = useQuery({
    queryKey: ['module', 'organization', branchId ?? 'all', 'hub', months],
    queryFn: () => organizationService.getHubSummary(months).then((r) => r.data),
    staleTime: 60_000,
    // Keeps the previous window on screen while the next one loads, so the
    // whole page does not blank out when the reader flips 6M to 12M.
    placeholderData: (prev) => prev,
  });

  return {
    summary: query.data as OrganizationHubSummary | undefined,
    months,
    setMonths,
    loading: query.isLoading,
    fetching: query.isFetching,
    /**
     * Load-bearing: a failed read must print an em dash, never 0. "No
     * department is missing a head" is the worst possible guess when the
     * question was never actually answered.
     */
    failed: query.isError,
  };
}
