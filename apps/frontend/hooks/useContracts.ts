'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import contractService from '@/services/contractService';
import { employeeKeys } from './useEmployees';
import type { RequestStatus, ReviewPayload } from '@/types/common';
import type {
  ContractListQuery,
  CreateContractPayload,
  CreateTerminationPayload,
  UpdateContractPayload,
} from '@/types/contract';

export const contractKeys = {
  all: ['contracts'] as const,
  list: (query: ContractListQuery) =>
    [...contractKeys.all, 'list', query] as const,
  detail: (id: string) => [...contractKeys.all, 'detail', id] as const,
  expiring: (days: number) =>
    [...contractKeys.all, 'expiring', days] as const,
  terminations: (query: { status?: RequestStatus; page?: number }) =>
    [...contractKeys.all, 'terminations', query] as const,
};

export function useContracts(query: ContractListQuery = {}) {
  return useQuery({
    queryKey: contractKeys.list(query),
    queryFn: () => contractService.list(query),
  });
}

export function useContract(id: string | undefined) {
  return useQuery({
    queryKey: contractKeys.detail(id!),
    queryFn: () => contractService.get(id!),
    enabled: !!id,
  });
}

export function useExpiringContracts(days = 30) {
  return useQuery({
    queryKey: contractKeys.expiring(days),
    queryFn: () => contractService.expiring(days),
  });
}

export function useCreateContract() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateContractPayload) =>
      contractService.create(payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useUpdateContract() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: UpdateContractPayload;
    }) => contractService.update(id, payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useRenewContract() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: CreateContractPayload;
    }) => contractService.renew(id, payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useTerminations(
  query: { status?: RequestStatus; page?: number } = {},
) {
  return useQuery({
    queryKey: contractKeys.terminations(query),
    queryFn: () => contractService.listTerminations(query),
  });
}

export function useCreateTermination() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTerminationPayload) =>
      contractService.createTermination(payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useReviewTermination() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ReviewPayload }) =>
      contractService.reviewTermination(id, payload),
    // Approving ends employment: the contract AND the employee record both
    // change, so the directory is stale too.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contractKeys.all });
      void queryClient.invalidateQueries({ queryKey: employeeKeys.all });
    },
  });
}
