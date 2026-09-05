'use client';

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import attendanceService from '@/services/attendanceService';
import type { AttendanceHubSummary, HubPeriod } from '@/types/attendanceHub';

export const attendanceHubKeys = {
  all: ['attendance-hub'] as const,
  summary: (period: HubPeriod, anchor: string | undefined) =>
    [...attendanceHubKeys.all, 'summary', period, anchor ?? 'now'] as const,
};

/**
 * The Time & Attendance hub's data, and the period control that moves it.
 *
 * One selector drives everything the page reports. `anchor` is a date INSIDE
 * the period rather than an offset, so stepping back a month from the 31st does
 * not land on a day that month does not have — the server resolves the range
 * and hands back the next and previous anchors for the ‹ › to use.
 */
export function useAttendanceHub(initialPeriod: HubPeriod = 'month') {
  const [period, setPeriodState] = useState<HubPeriod>(initialPeriod);
  const [anchor, setAnchor] = useState<string | undefined>(undefined);

  const query = useQuery({
    queryKey: attendanceHubKeys.summary(period, anchor),
    queryFn: () =>
      attendanceService.hubSummary(period, anchor).then((r) => r.data),
    staleTime: 60_000,
    // Keeps the previous window on screen while the next loads, so stepping
    // through months does not blank the page on every click.
    placeholderData: (previous?: AttendanceHubSummary) => previous,
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
    // The anchors come back WITH the window, so there is nowhere to step until
    // the first payload has landed. `canGoPrevious` keeps the control dim over
    // exactly that gap rather than letting a press disappear into this guard.
    if (summary) setAnchor(summary.range.prevAnchor);
  }, [summary]);

  const goNext = useCallback(() => {
    // `hasNext` is false in the current period. Without this guard the stepper
    // walks into the future and reports a window that has not happened.
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
    canGoPrevious: Boolean(summary),
    canGoNext: Boolean(summary?.range.hasNext),
    isCurrent: Boolean(summary?.range.isCurrent),
    loading: query.isLoading,
    fetching: query.isFetching,
    failed: query.isError,
  };
}
