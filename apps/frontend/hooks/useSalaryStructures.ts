'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import salaryStructureService from '@/services/salaryStructureService';
import { payrollHubKeys } from './usePayrollHub';
import type {
  CreateSalaryStructurePayload,
  SalaryStructureListQuery,
  UpdateSalaryStructurePayload,
} from '@/types/salaryStructure';

export const salaryStructureKeys = {
  all: ['salary-structures'] as const,
  list: (query: SalaryStructureListQuery) =>
    [...salaryStructureKeys.all, 'list', query] as const,
  detail: (id: string) => [...salaryStructureKeys.all, 'detail', id] as const,
  byEmployee: (employeeId: string) =>
    [...salaryStructureKeys.all, 'employee', employeeId] as const,
};

export function useSalaryStructures(query: SalaryStructureListQuery = {}) {
  return useQuery({
    queryKey: salaryStructureKeys.list(query),
    queryFn: () => salaryStructureService.list(query),
  });
}

export function useSalaryStructure(id: string | undefined) {
  return useQuery({
    queryKey: salaryStructureKeys.detail(id!),
    queryFn: () => salaryStructureService.get(id!),
    enabled: !!id,
  });
}

/**
 * One employee's structure.
 *
 * `retry: false` because the ordinary answer for somebody never assigned one is
 * a 404, and that is information the form wants immediately — retrying it three
 * times only delays an empty form.
 */
export function useEmployeeSalaryStructure(employeeId: string | undefined) {
  return useQuery({
    queryKey: salaryStructureKeys.byEmployee(employeeId!),
    queryFn: () => salaryStructureService.getByEmployee(employeeId!),
    enabled: !!employeeId,
    retry: false,
  });
}

/**
 * Nobody can be paid without a structure, so the hub's
 * `employees.withoutStructure` moves whenever one is created or removed.
 */
function useStructureMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: salaryStructureKeys.all });
      void queryClient.invalidateQueries({ queryKey: payrollHubKeys.all });
    },
  });
}

export function useCreateSalaryStructure() {
  return useStructureMutation((payload: CreateSalaryStructurePayload) =>
    salaryStructureService.create(payload),
  );
}

export function useUpdateSalaryStructure() {
  return useStructureMutation(
    ({ id, payload }: { id: string; payload: UpdateSalaryStructurePayload }) =>
      salaryStructureService.update(id, payload),
  );
}

export function useDeleteSalaryStructure() {
  return useStructureMutation((id: string) => salaryStructureService.remove(id));
}
