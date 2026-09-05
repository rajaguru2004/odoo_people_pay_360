import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import branchService from '@/services/branchService';

// `enabled` gates the request: only ADMIN/HR_MANAGER with global access may list
// all branches. Scoped/employee users would get a 403, so callers pass `false`
// to skip the fetch entirely instead of triggering a forbidden background call.
// `includeInactive` is part of the key: the two lists are different responses
// and must not share a cache entry, or toggling it would show stale rows. The
// mutations below invalidate the `['branches']` prefix, which still covers both.
export function useBranches(
  enabled: boolean = true,
  includeInactive: boolean = false,
) {
  return useQuery({
    queryKey: ['branches', { includeInactive }],
    queryFn: () => branchService.getAll(includeInactive),
    staleTime: 5 * 60 * 1000, // branches change rarely
    enabled,
  });
}

export function useBranch(id: string) {
  return useQuery({
    queryKey: ['branches', id],
    queryFn: () => branchService.getById(id),
    staleTime: 5 * 60 * 1000,
    enabled: !!id,
  });
}

export function useCreateBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => branchService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['branches'] });
    },
  });
}

export function useUpdateBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) =>
      branchService.update(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['branches', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['branches'] });
    },
  });
}

export function useDeleteBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => branchService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['branches'] });
    },
  });
}
