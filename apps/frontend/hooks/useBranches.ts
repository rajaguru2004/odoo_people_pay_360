'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import branchService from '@/services/branchService';
import type { CreateBranchPayload, UpdateBranchPayload } from '@/types/branch';

export const branchKeys = {
  all: ['branches'] as const,
  list: (includeInactive: boolean) =>
    [...branchKeys.all, 'list', includeInactive] as const,
  detail: (id: string) => [...branchKeys.all, 'detail', id] as const,
};

export function useBranches(includeInactive = false) {
  return useQuery({
    queryKey: branchKeys.list(includeInactive),
    queryFn: () => branchService.list(includeInactive),
  });
}

export function useBranch(id: string | undefined) {
  return useQuery({
    queryKey: branchKeys.detail(id!),
    queryFn: () => branchService.get(id!),
    enabled: !!id,
  });
}

export function useCreateBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateBranchPayload) => branchService.create(payload),
    // The whole subtree, not one list key: the new row belongs on every filter
    // and page that could contain it, and guessing which is how a create ends
    // up invisible until a hard refresh.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: branchKeys.all }),
  });
}

export function useUpdateBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateBranchPayload }) =>
      branchService.update(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: branchKeys.all }),
  });
}

export function useDeleteBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => branchService.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: branchKeys.all }),
  });
}
