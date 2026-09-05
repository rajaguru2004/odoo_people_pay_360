'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import leaveService from '@/services/leaveService';
import { attendanceKeys } from './useAttendance';
import type { CreateLeavePayload, LeaveListQuery } from '@/types/leave';

/**
 * Query keys as a tree, so an invalidation targets the whole subtree rather than
 * a guessed key. `leaveKeys.all` after a decision refreshes the list, the queue,
 * the stats and every detail page at once — because all four are now wrong.
 */
export const leaveKeys = {
  all: ['leave-requests'] as const,
  list: (query: LeaveListQuery) => [...leaveKeys.all, 'list', query] as const,
  mine: (query: LeaveListQuery) => [...leaveKeys.all, 'mine', query] as const,
  pending: (query: LeaveListQuery) =>
    [...leaveKeys.all, 'pending', query] as const,
  detail: (id: string) => [...leaveKeys.all, 'detail', id] as const,
  stats: () => [...leaveKeys.all, 'stats'] as const,
  teamBalances: () => [...leaveKeys.all, 'team-balances'] as const,
  types: () => ['leave-types'] as const,
};

export const balanceKeys = {
  all: ['leave-balances'] as const,
  list: (year: number | undefined) => [...balanceKeys.all, 'list', year] as const,
  employee: (employeeId: string, year: number | undefined) =>
    [...balanceKeys.all, 'employee', employeeId, year] as const,
  overview: (year: number | undefined) =>
    [...balanceKeys.all, 'overview', year] as const,
  accruals: (params: Record<string, unknown>) =>
    [...balanceKeys.all, 'accruals', params] as const,
};

export function useLeaveRequests(query: LeaveListQuery = {}) {
  return useQuery({
    queryKey: leaveKeys.list(query),
    queryFn: () => leaveService.list(query),
  });
}

export function useMyLeaveRequests(query: LeaveListQuery = {}) {
  return useQuery({
    queryKey: leaveKeys.mine(query),
    queryFn: () => leaveService.mine(query),
  });
}

export function usePendingLeaveRequests(query: LeaveListQuery = {}) {
  return useQuery({
    queryKey: leaveKeys.pending(query),
    queryFn: () => leaveService.pending(query),
  });
}

export function useLeaveRequest(id: string | undefined) {
  return useQuery({
    queryKey: leaveKeys.detail(id!),
    queryFn: () => leaveService.get(id!),
    enabled: !!id,
  });
}

export function useLeaveStats() {
  return useQuery({
    queryKey: leaveKeys.stats(),
    queryFn: () => leaveService.stats(),
  });
}

export function useLeaveTypes() {
  return useQuery({
    queryKey: leaveKeys.types(),
    queryFn: () => leaveService.leaveTypes(),
    // The library changes about once a year. Re-fetching it on every form open
    // costs a round trip the user waits for and answers the same thing.
    staleTime: 10 * 60_000,
  });
}

export function useTeamLeaveBalances() {
  return useQuery({
    queryKey: leaveKeys.teamBalances(),
    queryFn: () => leaveService.teamBalances(),
  });
}

export function useCreateLeaveRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateLeavePayload) => leaveService.create(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: leaveKeys.all });
    },
  });
}

/**
 * Approving moves three things: the request, the balance it spends, and the
 * attendance rows it writes. All three are invalidated, because a screen showing
 * yesterday's balance beside today's approval is the kind of disagreement nobody
 * can resolve from the page.
 */
export function useApproveLeaveRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, comment }: { id: string; comment?: string }) =>
      leaveService.approve(id, comment),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: leaveKeys.all });
      void queryClient.invalidateQueries({ queryKey: balanceKeys.all });
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    },
  });
}

export function useRejectLeaveRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, comment }: { id: string; comment: string }) =>
      leaveService.reject(id, comment),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: leaveKeys.all });
    },
  });
}

export function useCancelLeaveRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => leaveService.cancel(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: leaveKeys.all });
    },
  });
}

/**
 * One employee's headline entitlement, for a screen that shows it beside
 * something else.
 *
 * `retry: false` because a missing balance must never block the page it sits
 * on — the approver has the authoritative figure either way.
 */
export function useLeaveBalance(employeeId: string | undefined, year?: number) {
  return useQuery({
    queryKey: balanceKeys.employee(employeeId!, year),
    queryFn: () => leaveService.balance(employeeId!, year),
    enabled: !!employeeId,
    retry: false,
  });
}
