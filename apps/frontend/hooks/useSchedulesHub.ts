'use client';

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import calendarService from '@/services/calendarService';
import { useBranchStore } from '@/store/branchStore';
import type { HubPeriod, SchedulesHubSummary } from '@/types/schedulesHub';

/**
 * The Schedules hub's data.
 *
 * One aggregate (`GET /calendar/hub-summary`) answers everything the page
 * draws. It replaces the two-request `useSchedulesHub` in `useSimpleHubs.ts`,
 * which asked `/calendar/coverage-stats` for a hard-coded Monday–Sunday window
 * and had no way to move it — the page had no period selector at all.
 *
 * The Week / Month / Year tabs and the ‹ › arrows both move one piece of state,
 * the `anchor`: any date inside the period being viewed. The server hands back
 * the previous and next anchors, so the client never does calendar arithmetic
 * and never has to know that "the month before March 1st" is not "30 days ago".
 *
 * Week is the default. Scheduling decisions are operational and short-term.
 */
export function useSchedulesHub() {
  const branchId = useBranchStore((s) => s.selectedBranchId) ?? undefined;
  const [period, setPeriod] = useState<HubPeriod>('week');
  /** undefined = "the current period", which is what the server defaults to. */
  const [anchor, setAnchor] = useState<string | undefined>(undefined);

  const query = useQuery({
    queryKey: ['module', 'schedules', branchId ?? 'all', period, anchor ?? 'current'],
    queryFn: () => calendarService.getHubSummary(period, anchor).then((r) => r.data),
    // A roster changes when somebody edits it, not continuously — longer than
    // the attendance hub's 30s, which is about who is clocked in right now.
    staleTime: 120_000,
    // Keep the previous window on screen while the next one loads, so paging
    // with ‹ › does not blank the whole page between clicks.
    placeholderData: (prev?: SchedulesHubSummary) => prev,
  });

  const summary = query.data as SchedulesHubSummary | undefined;

  /** Step the period one window back or forward, using the server's anchors. */
  const step = useCallback(
    (direction: -1 | 1) => {
      if (!summary) return;
      if (direction === 1 && !summary.range.hasNext) return;
      setAnchor(direction === 1 ? summary.range.nextAnchor : summary.range.prevAnchor);
    },
    [summary],
  );

  const changePeriod = useCallback((next: HubPeriod) => {
    setPeriod(next);
    // Switching Week → Month keeps no anchor: the reader asked for a different
    // question, not for the same window in a different shape.
    setAnchor(undefined);
  }, []);

  return {
    summary,
    period,
    changePeriod,
    step,
    /** True while looking at anything other than the current period. */
    isPast: summary ? !summary.range.isCurrent : false,
    resetToCurrent: useCallback(() => setAnchor(undefined), []),
    loading: query.isLoading,
    fetching: query.isFetching,
    hubFailed: query.isError,
  };
}
