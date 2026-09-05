'use client';

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import leaveService from '@/services/leaveService';
import type { HubPeriod, LeaveHubSummary } from '@/types/leaveHub';

export const leaveHubKeys = {
  all: ['leave-hub'] as const,
  summary: (period: HubPeriod, anchor: string | undefined) =>
    [...leaveHubKeys.all, 'summary', period, anchor ?? 'now'] as const,
};

/**
 * The Leave & Overtime hub's data, and the period control that moves it.
 *
 * `anchor` is a date INSIDE the period rather than an offset, so stepping back a
 * month from the 31st does not land on a day that month does not have. The
 * server resolves the range and hands back the anchors for the ‹ › to use, which
 * is also why the browser never does the calendar arithmetic itself.
 *
 * Opens on Month rather than Today: "leave filed today" is not a question
 * anybody opens this module with.
 */
export function useLeaveHub(initialPeriod: HubPeriod = 'month') {
  const [period, setPeriodState] = useState<HubPeriod>(initialPeriod);
  const [anchor, setAnchor] = useState<string | undefined>(undefined);

  const query = useQuery({
    queryKey: leaveHubKeys.summary(period, anchor),
    queryFn: () => leaveService.hubSummary(period, anchor).then((r) => r.data),
    staleTime: 60_000,
    // Keeps the previous window on screen while the next loads, so stepping
    // through months does not blank the page on every click.
    placeholderData: (previous?: LeaveHubSummary) => previous,
  });

  /**
   * Changing the period clears the anchor.
   *
   * An anchor chosen inside one period is meaningless in another — the 3rd week
   * of a month is not the 3rd month of a year — and carrying it over lands the
   * reader in a window they did not pick.
   */
  const setPeriod = useCallback((next: HubPeriod) => {
    setPeriodState(next);
    setAnchor(undefined);
  }, []);

  const summary = query.data;

  const goPrevious = useCallback(() => {
    if (summary) setAnchor(summary.range.prevAnchor);
  }, [summary]);

  const goNext = useCallback(() => {
    // Leave is filed ahead, so `hasNext` is true for one window beyond today and
    // false past that: paging into a year of guaranteed emptiness reads as a
    // broken page rather than as an empty one.
    if (summary?.range.hasNext) setAnchor(summary.range.nextAnchor);
  }, [summary]);

  const goToday = useCallback(() => setAnchor(undefined), []);

  return {
    summary,
    period,
    setPeriod,
    anchor,
    goPrevious,
    goNext,
    goToday,
    canGoNext: Boolean(summary?.range.hasNext),
    isCurrent: Boolean(summary?.range.isCurrent),
    loading: query.isLoading,
    fetching: query.isFetching,
    failed: query.isError,
  };
}
