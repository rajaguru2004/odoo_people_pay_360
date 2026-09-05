'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import overtimeService from '@/services/overtimeService';
import type {
  ApproveOvertimeData,
  CreateOvertimeData,
  OvertimeQuery,
  RejectOvertimeData,
} from '@/types/overtime';

export const overtimeKeys = {
  all: ['overtime'] as const,
  list: (query: OvertimeQuery) => [...overtimeKeys.all, 'list', query] as const,
  mine: (query: OvertimeQuery) => [...overtimeKeys.all, 'mine', query] as const,
  detail: (id: string) => [...overtimeKeys.all, 'detail', id] as const,
};

/** The whole queue. The server narrows it to what the caller may see. */
export function useOvertimeRequests(query: OvertimeQuery = {}) {
  return useQuery({
    queryKey: overtimeKeys.list(query),
    queryFn: () => overtimeService.getAll(query),
  });
}

export function useMyOvertimeRequests(query: OvertimeQuery = {}) {
  return useQuery({
    queryKey: overtimeKeys.mine(query),
    queryFn: () => overtimeService.getMyRequests(query),
  });
}

export function useOvertimeRequest(id: string | undefined) {
  return useQuery({
    queryKey: overtimeKeys.detail(id!),
    queryFn: () => overtimeService.getById(id!),
    enabled: !!id,
  });
}

export function useCreateOvertime() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateOvertimeData) => overtimeService.create(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: overtimeKeys.all }),
  });
}

/** HR filing on somebody else's behalf. */
export function useCreateOvertimeForEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      employeeId,
      payload,
    }: {
      employeeId: string;
      payload: CreateOvertimeData;
    }) => overtimeService.createForEmployee(employeeId, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: overtimeKeys.all }),
  });
}

export function useApproveOvertime() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload?: ApproveOvertimeData }) =>
      overtimeService.approve(id, payload),
    // The whole subtree, not just the row: a decision moves the request between
    // every status tab and changes the month's approved-hours figure with it.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: overtimeKeys.all }),
  });
}

export function useRejectOvertime() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: RejectOvertimeData }) =>
      overtimeService.reject(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: overtimeKeys.all }),
  });
}

export function useCancelOvertime() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => overtimeService.cancel(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: overtimeKeys.all }),
  });
}
