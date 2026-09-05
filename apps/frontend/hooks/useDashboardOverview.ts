'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dashboardService from '@/services/dashboardService';
import type {
  DashboardMonths,
  DashboardOverview,
  DashboardOverviewQuery,
} from '@/types/dashboardOverview';

/**
 * Query keys as an object so invalidation targets the SUBTREE.
 *
 * `dashboardKeys.all` invalidates every window at once, which is what a mutation
 * elsewhere in the app (approving a leave request, locking a run) actually
 * wants: it has no idea whether the reader is on the 6- or the 12-month view,
 * and a guessed literal key would refresh one and leave the other stale.
 */
export const dashboardKeys = {
  all: ['dashboard'] as const,
  overview: (query: DashboardOverviewQuery) =>
    [...dashboardKeys.all, 'overview', query] as const,
};

/**
 * The main dashboard's data, and its one slicer.
 *
 * **The trend window stays in local state, not the URL.** The payroll analytics
 * hook puts its filters in the query string because that page has five of them
 * and a reader drilling out of a chart has to be able to get back to the exact
 * view they left. This page has ONE, it is a presentation choice rather than a
 * subset of the data, and `/dashboard` is the app's landing route — writing
 * `?months=6` onto it on first paint would make the home page's URL depend on a
 * default nobody chose.
 *
 * **One query for the whole page.** Every panel reads this single response, so
 * the KPI row, the charts and the two action panels can never be answering for
 * different periods, and a section the caller is not entitled to is absent from
 * one payload rather than a 403 on one of five requests.
 */
export function useDashboardOverview(initialMonths: DashboardMonths = 6) {
  const [months, setMonths] = useState<DashboardMonths>(initialMonths);

  const query = useQuery({
    queryKey: dashboardKeys.overview({ months }),
    queryFn: () => dashboardService.overview({ months }).then((r) => r.data),
    staleTime: 60_000,
    // Holds the current answer on screen while the next window loads. Without
    // it, switching 6 → 12 blanks the KPI row and every panel under it, and the
    // page jumps under the pointer that just clicked.
    placeholderData: (previous?: DashboardOverview) => previous,
  });

  return {
    overview: query.data,
    months,
    setMonths,
    /** True only on the very first load — the skeleton pass. */
    loading: query.isLoading,
    /** True while a window change is in flight and stale marks are still up. */
    refetching: query.isFetching && !query.isLoading,
    failed: query.isError,
  };
}
