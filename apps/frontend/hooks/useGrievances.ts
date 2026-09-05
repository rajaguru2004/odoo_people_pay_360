'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import grievanceService from '@/services/grievanceService';
import type { CreateGrievanceData } from '@/types/grievance';

export const grievanceKeys = {
  all: ['grievances'] as const,
  list: (status?: string) => [...grievanceKeys.all, 'list', status ?? 'all'] as const,
  detail: (id: string) => [...grievanceKeys.all, 'detail', id] as const,
  stats: () => [...grievanceKeys.all, 'stats'] as const,
};

export function useGrievances(status?: string) {
  return useQuery({
    queryKey: grievanceKeys.list(status),
    queryFn: () => grievanceService.list(status),
  });
}

export function useGrievance(id: string | undefined) {
  return useQuery({
    queryKey: grievanceKeys.detail(id!),
    queryFn: () => grievanceService.get(id!),
    enabled: !!id,
  });
}

export function useGrievanceStats(enabled = true) {
  return useQuery({
    queryKey: grievanceKeys.stats(),
    queryFn: () => grievanceService.stats(),
    enabled,
  });
}

function invalidateGrievances(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient.invalidateQueries({ queryKey: grievanceKeys.all });
}

export function useRaiseGrievance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateGrievanceData) => grievanceService.create(payload),
    onSuccess: () => invalidateGrievances(queryClient),
  });
}

export function useUpdateGrievance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: {
        status?: string;
        assignedToId?: string;
        resolution?: string;
        note?: string;
      };
    }) => grievanceService.update(id, payload),
    onSuccess: () => invalidateGrievances(queryClient),
  });
}

export function useAddGrievanceNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      note,
      isInternal,
    }: {
      id: string;
      note: string;
      isInternal: boolean;
    }) => grievanceService.addNote(id, note, isInternal),
    onSuccess: () => invalidateGrievances(queryClient),
  });
}

export function useWithdrawGrievance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => grievanceService.withdraw(id),
    onSuccess: () => invalidateGrievances(queryClient),
  });
}
