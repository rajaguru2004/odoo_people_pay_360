'use client';

import { useQuery } from '@tanstack/react-query';
import axiosInstance from '@/lib/axios';
import { useBranchStore } from '@/store/branchStore';
import type { KpiStat } from '@/components/module-landing/StatCard';
import type { HubDelta } from '@/types/moduleHub';

/**
 * The one read behind a module hub.
 *
 * Finance, Talent and Workplace each used to fan out four to six requests from
 * the browser, and two of Talent's counted rows off a page. One aggregate per
 * hub removes both problems, so the hook that fetches it is the same three
 * lines every time and lives here rather than three times.
 *
 * `branchId` is in the query key because a branch switch has to re-fetch.
 */
export function useModuleHub<T>(name: string, path: string) {
  const branchId = useBranchStore((s) => s.selectedBranchId) ?? undefined;

  const query = useQuery({
    queryKey: ['module', name, branchId ?? 'all', 'hub'],
    queryFn: () => axiosInstance.get(path).then((r: any) => (r?.data ?? r) as T),
    // A minute. None of these three answers a "right now" question the way the
    // attendance hub does, so there is nothing to gain from a tighter window.
    staleTime: 60_000,
  });

  return {
    summary: query.data as T | undefined,
    loading: query.isLoading,
    fetching: query.isFetching,
    /**
     * The failed-read flag every KPI checks FIRST. A failure yields `null`,
     * which `StatCard` renders as an em dash — never a zero, which is a claim
     * the data does not support.
     */
    hubFailed: query.isError,
  };
}

/**
 * A `KpiStat.delta`, or nothing.
 *
 * Returns `undefined` — so no badge is drawn — when the server could not
 * establish a baseline, and when the change is exactly zero. Some hub figures
 * genuinely have no history to reconstruct from (asset status, and the pending
 * letter queue, since `LetterRequest` carries no `rejectedAt`). Those cards say
 * so in their footnote rather than showing a badge that reads as "unchanged".
 */
export function toDelta(
  delta: HubDelta | null | undefined,
  goodDirection: 'up' | 'down',
  label: string,
  display?: (absolute: number) => string,
): KpiStat['delta'] {
  if (!delta || delta.absolute === 0) return undefined;
  return {
    value: delta.value,
    direction: delta.direction,
    goodDirection,
    display: display
      ? display(Math.abs(delta.absolute))
      : `${Math.abs(delta.value).toFixed(1)}%`,
    label,
  };
}

/** Whole days since a timestamp, or 0 when there is nothing to age. */
export function ageInDays(iso: string | null | undefined): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}
