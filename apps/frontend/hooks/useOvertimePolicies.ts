'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import overtimePolicyService, {
  type SavePolicyPayload,
} from '@/services/overtimePolicyService';
import { overtimeKeys } from './useOvertime';

export const policyKeys = {
  all: ['overtime-policies'] as const,
  list: () => [...policyKeys.all, 'list'] as const,
  detail: (id: string) => [...policyKeys.all, 'detail', id] as const,
  resolved: (employeeId: string) =>
    [...policyKeys.all, 'resolved', employeeId] as const,
};

export function useOvertimePolicies() {
  return useQuery({
    queryKey: policyKeys.list(),
    queryFn: () => overtimePolicyService.list(),
  });
}

export function useOvertimePolicy(id: string | undefined) {
  return useQuery({
    queryKey: policyKeys.detail(id!),
    queryFn: () => overtimePolicyService.get(id!),
    enabled: !!id,
  });
}

/** Which policy governs one employee, and which tier of the chain produced it. */
export function useResolvedOvertimePolicy(employeeId: string | undefined) {
  return useQuery({
    queryKey: policyKeys.resolved(employeeId!),
    queryFn: () => overtimePolicyService.resolve(employeeId!),
    enabled: !!employeeId,
  });
}

/**
 * Every policy write invalidates the OVERTIME subtree as well.
 *
 * A pending request's preview is priced against the live policy, so editing a
 * rate changes what the review screen says the request is worth — a page still
 * showing the old figure would have an approver agreeing to a number that is no
 * longer the one being paid.
 */
function invalidateAll(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: policyKeys.all });
  void queryClient.invalidateQueries({ queryKey: overtimeKeys.all });
}

export function useCreateOvertimePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: SavePolicyPayload) =>
      overtimePolicyService.create(payload),
    onSuccess: () => invalidateAll(queryClient),
  });
}

export function useUpdateOvertimePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: Partial<SavePolicyPayload>;
    }) => overtimePolicyService.update(id, payload),
    onSuccess: () => invalidateAll(queryClient),
  });
}

export function useSetDefaultOvertimePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => overtimePolicyService.setDefault(id),
    onSuccess: () => invalidateAll(queryClient),
  });
}

export function useSetOvertimePolicyActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      overtimePolicyService.setActive(id, isActive),
    onSuccess: () => invalidateAll(queryClient),
  });
}

export function useDeleteOvertimePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => overtimePolicyService.remove(id),
    onSuccess: () => invalidateAll(queryClient),
  });
}

export function useAssignOvertimePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      employeeId: string;
      employmentType?: string;
      overtimePolicyId?: string | null;
    }) => overtimePolicyService.assign(payload),
    onSuccess: () => invalidateAll(queryClient),
  });
}
