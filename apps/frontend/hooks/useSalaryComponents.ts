'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import salaryComponentService from '@/services/salaryComponentService';
import { salaryStructureKeys } from './useSalaryStructures';
import type {
  CreateSalaryComponentPayload,
  SalaryComponentListQuery,
  UpdateSalaryComponentPayload,
} from '@/types/salaryStructure';

export const salaryComponentKeys = {
  all: ['salary-components'] as const,
  list: (query: SalaryComponentListQuery) =>
    [...salaryComponentKeys.all, 'list', query] as const,
  detail: (id: string) => [...salaryComponentKeys.all, 'detail', id] as const,
};

export function useSalaryComponents(query: SalaryComponentListQuery = {}) {
  return useQuery({
    queryKey: salaryComponentKeys.list(query),
    queryFn: () => salaryComponentService.list(query),
  });
}

export function useSalaryComponent(id: string | undefined) {
  return useQuery({
    queryKey: salaryComponentKeys.detail(id!),
    queryFn: () => salaryComponentService.get(id!),
    enabled: !!id,
  });
}

/**
 * Structures embed the component they point at, so its catalogue row changing
 * — renamed, resequenced, retired — makes every structure on screen stale too.
 */
function useComponentMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: salaryComponentKeys.all });
      void queryClient.invalidateQueries({ queryKey: salaryStructureKeys.all });
    },
  });
}

export function useCreateSalaryComponent() {
  return useComponentMutation((payload: CreateSalaryComponentPayload) =>
    salaryComponentService.create(payload),
  );
}

export function useUpdateSalaryComponent() {
  return useComponentMutation(
    ({ id, payload }: { id: string; payload: UpdateSalaryComponentPayload }) =>
      salaryComponentService.update(id, payload),
  );
}

/** Retirement. There is no delete — a component behind a payslip line has to
 *  keep resolving. */
export function useDeactivateSalaryComponent() {
  return useComponentMutation((id: string) =>
    salaryComponentService.deactivate(id),
  );
}

export function useActivateSalaryComponent() {
  return useComponentMutation((id: string) =>
    salaryComponentService.activate(id),
  );
}
