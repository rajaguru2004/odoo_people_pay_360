'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import leaveService from '@/services/leaveService';
import type {
  CreateLeaveRequestData,
  LeaveRequestListQuery,
  MyLeaveRequestQuery,
} from '@/types/leave';

/**
 * One tree for the whole module.
 *
 * Balances hang off the same root as requests on purpose: approving a request
 * draws days down, so a decision has to invalidate both, and a single
 * `invalidateQueries({ queryKey: leaveKeys.all })` is the only version of that
 * which cannot be half-done.
 */
export const leaveKeys = {
  all: ['leaves'] as const,
  list: (query: LeaveRequestListQuery) => [...leaveKeys.all, 'list', query] as const,
  mine: (query: MyLeaveRequestQuery) => [...leaveKeys.all, 'mine', query] as const,
  pending: () => [...leaveKeys.all, 'pending'] as const,
  detail: (id: string) => [...leaveKeys.all, 'detail', id] as const,
  trail: (id: string) => [...leaveKeys.all, 'trail', id] as const,
  attachments: (id: string) => [...leaveKeys.all, 'attachments', id] as const,
  balances: (year?: number) => [...leaveKeys.all, 'balances', year ?? 'current'] as const,
  balance: (employeeId: string, year?: number) =>
    [...leaveKeys.all, 'balance', employeeId, year ?? 'current'] as const,
  companyOverview: (year?: number) =>
    [...leaveKeys.all, 'company-overview', year ?? 'current'] as const,
  teamBalances: () => [...leaveKeys.all, 'team-balances'] as const,
  types: () => [...leaveKeys.all, 'types'] as const,
};

export function useLeaveRequests(query: LeaveRequestListQuery = {}) {
  return useQuery({
    queryKey: leaveKeys.list(query),
    queryFn: () => leaveService.list(query),
    // Keep the previous page on screen while the next one loads: a table that
    // empties between pages reads as "no results" for the length of the request.
    placeholderData: (previous) => previous,
  });
}

export function useMyLeaveRequests(query: MyLeaveRequestQuery = {}) {
  return useQuery({
    queryKey: leaveKeys.mine(query),
    queryFn: () => leaveService.myRequests(query),
  });
}

export function usePendingLeaveRequests() {
  return useQuery({
    queryKey: leaveKeys.pending(),
    queryFn: () => leaveService.pending(),
  });
}

export function useLeaveRequest(id: string | undefined) {
  return useQuery({
    queryKey: leaveKeys.detail(id!),
    queryFn: () => leaveService.get(id!),
    enabled: !!id,
  });
}

/**
 * The approval chain over one request.
 *
 * `retry: false` because the informative answer here is often a refusal — a
 * caller with no standing on the chain — and retrying it only delays the screen
 * settling on its fallback rule.
 */
export function useLeaveApprovalTrail(id: string | undefined) {
  return useQuery({
    queryKey: leaveKeys.trail(id!),
    queryFn: () => leaveService.approvalTrail(id!),
    enabled: !!id,
    retry: false,
  });
}

export function useLeaveBalance(employeeId: string | undefined, year?: number) {
  return useQuery({
    queryKey: leaveKeys.balance(employeeId!, year),
    queryFn: () => leaveService.balance(employeeId!, year),
    enabled: !!employeeId,
    // A missing or unreadable balance must never block the screen it sits on;
    // the approver has the authoritative figure either way.
    retry: false,
  });
}

export function useLeaveBalances(year?: number) {
  return useQuery({
    queryKey: leaveKeys.balances(year),
    queryFn: () => leaveService.balances(year),
  });
}

/**
 * Company-wide totals. ADMIN and HR only, server-side.
 *
 * `enabled` is a parameter rather than something the caller wraps around the
 * hook: asking for this as a manager meets a 403 and the shared permission
 * modal, on a screen that role is otherwise entitled to.
 */
export function useCompanyLeaveOverview(year?: number, enabled = true) {
  return useQuery({
    queryKey: leaveKeys.companyOverview(year),
    queryFn: () => leaveService.companyOverview(year),
    enabled,
  });
}

export function useTeamLeaveBalances() {
  return useQuery({
    queryKey: leaveKeys.teamBalances(),
    queryFn: () => leaveService.teamBalances(),
  });
}

/**
 * The configured leave types.
 *
 * Long-lived on purpose: this is a library an admin edits a few times a year,
 * and every leave screen asks for it on mount.
 */
export function useLeaveTypes() {
  return useQuery({
    queryKey: leaveKeys.types(),
    queryFn: () => leaveService.leaveTypes(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateLeaveRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateLeaveRequestData) => leaveService.create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leaveKeys.all }),
  });
}

export function useApproveLeaveRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, comment }: { id: string; comment?: string }) =>
      leaveService.approve(id, comment),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leaveKeys.all }),
  });
}

export function useRejectLeaveRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, rejectedReason }: { id: string; rejectedReason?: string }) =>
      leaveService.reject(id, rejectedReason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leaveKeys.all }),
  });
}

export function useCancelLeaveRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => leaveService.cancel(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leaveKeys.all }),
  });
}

export function useUploadLeaveAttachment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ leaveRequestId, file }: { leaveRequestId: string; file: File }) =>
      leaveService.uploadAttachment(leaveRequestId, file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leaveKeys.all }),
  });
}

export function useDeleteLeaveAttachment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      leaveRequestId,
      attachmentId,
    }: {
      leaveRequestId: string;
      attachmentId: string;
    }) => leaveService.deleteAttachment(leaveRequestId, attachmentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leaveKeys.all }),
  });
}

export function useUpdateLeaveTypeBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      employeeId,
      year,
      leaveTypeKey,
      allocated,
      carriedOver,
    }: {
      employeeId: string;
      year: number;
      leaveTypeKey: string;
      allocated: number;
      carriedOver?: number;
    }) =>
      leaveService.updateTypeBalance(employeeId, year, leaveTypeKey, allocated, carriedOver),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leaveKeys.all }),
  });
}

export function useUpdateLeaveBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      employeeId,
      year,
      annualLeave,
      sickLeave,
    }: {
      employeeId: string;
      year: number;
      annualLeave: number;
      sickLeave?: number;
    }) => leaveService.updateBalance(employeeId, year, annualLeave, sickLeave),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leaveKeys.all }),
  });
}

export function useSetDefaultLeaveAllocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (year: number) => leaveService.setDefaultAllocation(year),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leaveKeys.all }),
  });
}
