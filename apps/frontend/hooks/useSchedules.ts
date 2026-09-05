'use client';

import { useCallback, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import scheduleService from '@/services/scheduleService';
import workScheduleService, {
  type BulkSchedulePayload,
  type CreateSchedulePayload,
  type ListSchedulesParams,
  type UpdateSchedulePayload,
} from '@/services/workScheduleService';
import type { SchedulePeriod, SchedulesHubSummary } from '@/types/schedules';

/**
 * One key factory for the whole module, so an invalidation targets the SUBTREE
 * rather than a key somebody had to guess.
 *
 * Every write below invalidates `scheduleKeys.all`. That is deliberate rather
 * than lazy: one new shift changes the grid, the person's own calendar, the
 * coverage sweep and four panels on the dashboard, and a screen still showing
 * yesterday's coverage after somebody rostered a night shift is worse than a
 * refetch nobody notices.
 */
export const scheduleKeys = {
  all: ['schedules'] as const,
  hub: (period: SchedulePeriod, anchor: string | undefined) =>
    [...scheduleKeys.all, 'hub', period, anchor ?? 'now'] as const,
  overview: (params: Record<string, unknown>) =>
    [...scheduleKeys.all, 'overview', params] as const,
  calendar: (params: Record<string, unknown>) =>
    [...scheduleKeys.all, 'calendar', params] as const,
  stats: (params: Record<string, unknown>) =>
    [...scheduleKeys.all, 'stats', params] as const,
  coverage: (params: Record<string, unknown>) =>
    [...scheduleKeys.all, 'coverage', params] as const,
  conflicts: (params: Record<string, unknown>) =>
    [...scheduleKeys.all, 'conflicts', params] as const,
  rows: (params: ListSchedulesParams) =>
    [...scheduleKeys.all, 'rows', params] as const,
};

const invalidateRoster = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: scheduleKeys.all });

/**
 * The Schedules dashboard, and the period control that moves it.
 *
 * `anchor` is a date INSIDE the period rather than an offset, so stepping back
 * a month from the 31st does not land on a day that month does not have — the
 * server resolves the range and hands back the next and previous anchors for
 * the ‹ › to use.
 *
 * Defaults to `week`, unlike the attendance hub's `month`: a roster is read
 * forwards, and "is next week covered" is the question this module exists for.
 */
export function useSchedulesHub(initialPeriod: SchedulePeriod = 'week') {
  const [period, setPeriodState] = useState<SchedulePeriod>(initialPeriod);
  const [anchor, setAnchor] = useState<string | undefined>(undefined);

  const query = useQuery({
    queryKey: scheduleKeys.hub(period, anchor),
    queryFn: () => scheduleService.hubSummary(period, anchor).then((r) => r.data),
    staleTime: 60_000,
    // Keeps the previous window on screen while the next loads, so stepping
    // through weeks does not blank the page on every click.
    placeholderData: (previous?: SchedulesHubSummary) => previous,
  });

  /**
   * Changing the period clears the anchor.
   *
   * An anchor chosen inside one period is meaningless in another — the 3rd week
   * of a month is not the 3rd month of a year — and carrying it over lands the
   * reader in a window they did not pick.
   */
  const setPeriod = useCallback((next: SchedulePeriod) => {
    setPeriodState(next);
    setAnchor(undefined);
  }, []);

  const summary = query.data;

  const goPrevious = useCallback(() => {
    if (summary) setAnchor(summary.range.prevAnchor);
  }, [summary]);

  const goNext = useCallback(() => {
    if (summary?.range.hasNext) setAnchor(summary.range.nextAnchor);
  }, [summary]);

  const goCurrent = useCallback(() => setAnchor(undefined), []);

  return {
    summary,
    period,
    setPeriod,
    anchor,
    goPrevious,
    goNext,
    goCurrent,
    canGoNext: Boolean(summary?.range.hasNext),
    isCurrent: Boolean(summary?.range.isCurrent),
    loading: query.isLoading,
    fetching: query.isFetching,
    failed: query.isError,
  };
}

/** The working-schedule grid for a window. */
export function useScheduleOverview(params: {
  startDate: string;
  endDate: string;
  branchId?: string;
  departmentId?: string;
  enabled?: boolean;
}) {
  const { enabled = true, ...query } = params;
  return useQuery({
    queryKey: scheduleKeys.overview(query),
    queryFn: () => scheduleService.overview(query).then((r) => r.data),
    enabled: enabled && Boolean(query.startDate && query.endDate),
    staleTime: 30_000,
  });
}

/** One employee's calendar. Omit `employeeId` to read your own. */
export function useEmployeeCalendar(params: {
  startDate: string;
  endDate: string;
  employeeId?: string;
  enabled?: boolean;
}) {
  const { enabled = true, ...query } = params;
  return useQuery({
    queryKey: scheduleKeys.calendar(query),
    queryFn: () => scheduleService.calendar(query).then((r) => r.data),
    enabled: enabled && Boolean(query.startDate && query.endDate),
    staleTime: 30_000,
  });
}

export function useScheduleStats(params: {
  month: number;
  year: number;
  employeeId?: string;
  enabled?: boolean;
}) {
  const { enabled = true, ...query } = params;
  return useQuery({
    queryKey: scheduleKeys.stats(query),
    queryFn: () => scheduleService.stats(query).then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

export function useScheduleCoverage(params: {
  startDate: string;
  endDate: string;
  enabled?: boolean;
}) {
  const { enabled = true, ...query } = params;
  return useQuery({
    queryKey: scheduleKeys.coverage(query),
    queryFn: () => scheduleService.coverage(query).then((r) => r.data),
    enabled: enabled && Boolean(query.startDate && query.endDate),
    staleTime: 30_000,
  });
}

/** The raw roster rows, for a list rather than a calendar. */
export function useWorkScheduleRows(
  params: ListSchedulesParams,
  enabled = true,
) {
  return useQuery({
    queryKey: scheduleKeys.rows(params),
    queryFn: () => workScheduleService.list(params),
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSchedulePayload) =>
      workScheduleService.create(payload),
    onSuccess: () => invalidateRoster(client),
  });
}

export function useUpdateSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateSchedulePayload }) =>
      workScheduleService.update(id, payload),
    onSuccess: () => invalidateRoster(client),
  });
}

export function useDeleteSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workScheduleService.remove(id),
    onSuccess: () => invalidateRoster(client),
  });
}

export function useBulkSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: BulkSchedulePayload) => workScheduleService.bulk(payload),
    onSuccess: () => invalidateRoster(client),
  });
}
