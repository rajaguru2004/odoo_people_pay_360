'use client';

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import leaveService from '@/services/leaveService';
import { useBranchStore } from '@/store/branchStore';
import type { HubPeriod, LeaveHubSummary } from '@/types/leaveHub';

/**
 * The Leave & Overtime hub's data.
 *
 * One aggregate (`GET /leave-requests/hub-summary`) answers everything the page
 * draws. It replaces a three-request fan-out — `/dashboard/overview`,
 * `/leave-balances/company-overview` and `/overtime/report/:month/:year` — none
 * of which a period selector could move: the first is unwindowed, the second
 * year-only and the third month-only. The old page therefore had no selector at
 * all, and its "OT hours" card was permanently the current calendar month
 * whatever else was on screen.
 *
 * The derived helpers went with them. `leaveLiability()` summed remaining days
 * across leave types in the browser and `topOvertimeEarners()` sorted an object
 * keyed by employee id; both are now `periodStats.remaining` and
 * `overtime.topEmployees`, computed where the rows already are.
 *
 * Month is the default: leave accrues monthly and payroll consumes overtime
 * monthly, so that is the cycle these numbers are read in.
 */
export function useLeaveHub() {
  const branchId = useBranchStore((s) => s.selectedBranchId) ?? undefined;
  const [period, setPeriod] = useState<HubPeriod>('month');
  /** undefined = "the current period", which is what the server defaults to. */
  const [anchor, setAnchor] = useState<string | undefined>(undefined);

  const query = useQuery({
    queryKey: ['module', 'leave', branchId ?? 'all', period, anchor ?? 'current'],
    queryFn: () => leaveService.getHubSummary(period, anchor).then((r) => r.data),
    staleTime: 60_000,
    // Keep the previous window on screen while the next one loads, so paging
    // with ‹ › does not blank the whole page between clicks.
    placeholderData: (prev?: LeaveHubSummary) => prev,
  });

  const summary = query.data as LeaveHubSummary | undefined;

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
    // Switching Month → Year keeps no anchor: the reader asked for a different
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
