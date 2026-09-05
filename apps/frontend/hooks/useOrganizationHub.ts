'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import organizationService from '@/services/organizationService';
import type {
  OrganizationHubSummary,
  TrendMonths,
} from '@/types/organizationHub';

export const organizationHubKeys = {
  all: ['organization-hub'] as const,
  summary: (months: TrendMonths) =>
    [...organizationHubKeys.all, 'summary', months] as const,
};

export function useOrganizationHub() {
  const [months, setMonths] = useState<TrendMonths>(6);

  const query = useQuery({
    queryKey: organizationHubKeys.summary(months),
    queryFn: () => organizationService.hubSummary(months).then((r) => r.data),
    staleTime: 60_000,
    // Keeps the previous window on screen while the next loads, so the page
    // does not blank out when the reader flips 6M to 12M.
    placeholderData: (previous?: OrganizationHubSummary) => previous,
  });

  return {
    summary: query.data,
    months,
    setMonths,
    loading: query.isLoading,
    fetching: query.isFetching,
    /**
     * Load-bearing. Every figure on the hub reads `null` rather than `0` when
     * this is true — an empty organisation and an unreachable endpoint are
     * different claims, and printing 0 for both tells the reader something
     * false about one of them.
     */
    failed: query.isError,
  };
}
