'use client';

import { useCallback, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import axiosInstance from '@/lib/axios';
import attendanceService from '@/services/attendanceService';
import { useBranchStore } from '@/store/branchStore';
import type { AttendanceHubSummary, HubPeriod } from '@/types/attendanceHub';

/**
 * The Time & Attendance hub's data.
 *
 * One aggregate (`/attendances/hub-summary`) answers everything the page draws
 * except the correction queue's AGE, which `/attendance-corrections/stats`
 * already computes in the database — three requests waiting a week is a worse
 * state than ten waiting an hour, and a count cannot say so.
 *
 * The Today / Week / Month / Year tabs and the ‹ › arrows both move one piece
 * of state, the `anchor`: any date inside the period being viewed. The server
 * hands back the previous and next anchors, so the client never does calendar
 * arithmetic and never has to know that "the month before March 1st" is not
 * "30 days ago".
 */

export interface CorrectionStats {
  pending: number;
  olderThan3Days: number;
  oldestPendingAt: string | null;
  /** Null when nothing has been decided in the last 30 days. */
  avgResolutionHours: number | null;
  decidedSampleSize: number;
}

/** Guards every rate this module reads: null and NaN both mean "not known". */
export function knownRate(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Whole days between then and now — how stale a queued request is. */
export function ageInDays(iso: string, now = Date.now()): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

/**
 * Percentage-point change between two rates, or `undefined` when either side is
 * unknown. Deliberately NOT a percentage OF the old rate: attendance moving
 * from 40% to 44% is "up 4 points", and calling it "up 10%" invites the reader
 * to think ten people.
 */
export function pointsChange(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | undefined {
  const a = knownRate(current);
  const b = knownRate(previous);
  if (a === undefined || b === undefined) return undefined;
  return Math.round((a - b) * 10) / 10;
}

export function useTimeHub() {
  const branchId = useBranchStore((s) => s.selectedBranchId) ?? undefined;
  // Today by default: the question an HR manager opens this page with is "who
  // is in", not "how did August go".
  const [period, setPeriod] = useState<HubPeriod>('today');
  /** undefined = "the current period", which is what the server defaults to. */
  const [anchor, setAnchor] = useState<string | undefined>(undefined);

  const key = ['module', 'time', branchId ?? 'all'] as const;

  const results = useQueries({
    queries: [
      {
        queryKey: [...key, 'hub', period, anchor ?? 'current'],
        queryFn: () =>
          attendanceService.getHubSummary(period, anchor).then((r) => r.data),
        // Shorter than the other hubs: this one is about right now, and a
        // minute-old "who is still clocked in" is a different answer.
        staleTime: 30_000,
        refetchInterval: 60_000,
        // Keep the previous window on screen while the next one loads, so
        // paging with ‹ › does not blank the whole page between clicks.
        placeholderData: (prev?: AttendanceHubSummary) => prev,
      },
      {
        queryKey: [...key, 'correctionStats'],
        queryFn: () =>
          axiosInstance
            .get('/attendance-corrections/stats')
            .then((r: any) => r?.data ?? r),
        staleTime: 60_000,
      },
    ],
  });

  const [hub, corrections] = results;
  const summary = hub.data as AttendanceHubSummary | undefined;
  const stats = corrections.data as CorrectionStats | undefined;

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
    corrections: stats,
    pendingCorrections: stats?.pending ?? summary?.attention.pendingCorrections ?? 0,
    /** The queue's worst wait, which is the number that decides whether to act. */
    oldestCorrectionDays: stats?.oldestPendingAt ? ageInDays(stats.oldestPendingAt) : 0,
    loading: hub.isLoading,
    fetching: hub.isFetching,
    correctionsLoading: corrections.isLoading,
    correctionsFailed: corrections.isError,
    hubFailed: hub.isError,
  };
}
