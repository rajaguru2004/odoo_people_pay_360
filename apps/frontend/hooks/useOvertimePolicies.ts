'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import overtimePolicyService from '@/services/overtimePolicyService';
import type {
  CreateOvertimePolicyPayload,
  UpdateOvertimePolicyPayload,
} from '@/types/overtime';

export const overtimePolicyKeys = {
  all: ['overtime-policies'] as const,
  list: () => [...overtimePolicyKeys.all, 'list'] as const,
  detail: (id: string) => [...overtimePolicyKeys.all, 'detail', id] as const,
  resolution: (employeeId: string) =>
    [...overtimePolicyKeys.all, 'resolution', employeeId] as const,
};

export function useOvertimePolicies(enabled = true) {
  return useQuery({
    queryKey: overtimePolicyKeys.list(),
    queryFn: () => overtimePolicyService.list(),
    enabled,
  });
}

/**
 * Every write invalidates the whole subtree rather than the one row it touched.
 *
 * Promoting a policy to the company default demotes whichever policy held it,
 * and deleting one moves its assignees onto their fallback — both change rows
 * the mutation never named.
 */
function useOvertimePolicyMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: overtimePolicyKeys.all }),
  });
}

export function useCreateOvertimePolicy() {
  return useOvertimePolicyMutation((payload: CreateOvertimePolicyPayload) =>
    overtimePolicyService.create(payload),
  );
}

export function useUpdateOvertimePolicy() {
  return useOvertimePolicyMutation(
    ({ id, payload }: { id: string; payload: UpdateOvertimePolicyPayload }) =>
      overtimePolicyService.update(id, payload),
  );
}

export function useSetDefaultOvertimePolicy() {
  return useOvertimePolicyMutation((id: string) => overtimePolicyService.setDefault(id));
}

export function useSetOvertimePolicyActive() {
  return useOvertimePolicyMutation(({ id, isActive }: { id: string; isActive: boolean }) =>
    overtimePolicyService.setActive(id, isActive),
  );
}

export function useDeleteOvertimePolicy() {
  return useOvertimePolicyMutation((id: string) => overtimePolicyService.remove(id));
}
