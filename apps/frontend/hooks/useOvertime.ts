'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import overtimeService from '@/services/overtimeService';
import { leaveHubKeys } from './useLeaveHub';
import type {
  ApproveOvertimePayload,
  CreateOvertimePayload,
  OvertimeListQuery,
} from '@/types/overtime';

export const overtimeKeys = {
  all: ['overtime'] as const,
  list: (query: OvertimeListQuery) => [...overtimeKeys.all, 'list', query] as const,
  mine: (query: OvertimeListQuery) => [...overtimeKeys.all, 'mine', query] as const,
  pending: (query: OvertimeListQuery) =>
    [...overtimeKeys.all, 'pending', query] as const,
  detail: (id: string) => [...overtimeKeys.all, 'detail', id] as const,
  stats: () => [...overtimeKeys.all, 'stats'] as const,
  report: (year: number, month: number) =>
    [...overtimeKeys.all, 'report', year, month] as const,
};

export function useOvertimeRequests(query: OvertimeListQuery = {}) {
  return useQuery({
    queryKey: overtimeKeys.list(query),
    queryFn: () => overtimeService.list(query),
  });
}

export function useMyOvertimeRequests(query: OvertimeListQuery = {}) {
  return useQuery({
    queryKey: overtimeKeys.mine(query),
    queryFn: () => overtimeService.mine(query),
  });
}

export function usePendingOvertimeRequests(query: OvertimeListQuery = {}) {
  return useQuery({
    queryKey: overtimeKeys.pending(query),
    queryFn: () => overtimeService.pending(query),
  });
}

/** Carries the server's payable breakdown, which the page must not recompute. */
export function useOvertimeRequest(id: string | undefined) {
  return useQuery({
    queryKey: overtimeKeys.detail(id!),
    queryFn: () => overtimeService.get(id!),
    enabled: !!id,
  });
}

export function useOvertimeStats() {
  return useQuery({
    queryKey: overtimeKeys.stats(),
    queryFn: () => overtimeService.stats(),
  });
}

export function useOvertimeReport(year: number, month: number) {
  return useQuery({
    queryKey: overtimeKeys.report(year, month),
    queryFn: () => overtimeService.report(year, month),
  });
}

export function useCreateOvertime() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      employeeId,
      payload,
    }: {
      /** Omit to file your own; naming somebody else is an HR privilege. */
      employeeId?: string;
      payload: CreateOvertimePayload;
    }) =>
      employeeId
        ? overtimeService.createForEmployee(employeeId, payload)
        : overtimeService.create(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: overtimeKeys.all });
      void queryClient.invalidateQueries({ queryKey: leaveHubKeys.all });
    },
  });
}

/**
 * A dry run of a correction. Deliberately a mutation rather than a query even
 * though it writes nothing: it is fired on demand from a review form, and
 * caching "what would happen if" under a key would serve a stale answer to the
 * next set of numbers typed.
 */
export function usePreviewOvertimeEdit() {
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ApproveOvertimePayload }) =>
      overtimeService.previewEdit(id, payload),
  });
}

export function useApproveOvertime() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload?: ApproveOvertimePayload }) =>
      overtimeService.approve(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: overtimeKeys.all });
      // The hub reports approved hours, so it is wrong the moment this lands.
      void queryClient.invalidateQueries({ queryKey: leaveHubKeys.all });
    },
  });
}

export function useRejectOvertime() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      overtimeService.reject(id, reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: overtimeKeys.all });
    },
  });
}

export function useCancelOvertime() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => overtimeService.cancel(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: overtimeKeys.all });
    },
  });
}
