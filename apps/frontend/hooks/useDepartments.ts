'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import departmentService from '@/services/departmentService';
import type {
  CreateDepartmentPayload,
  UpdateDepartmentPayload,
} from '@/types/department';

export const departmentKeys = {
  all: ['departments'] as const,
  list: (params: { branchId?: string; includeInactive?: boolean }) =>
    [...departmentKeys.all, 'list', params] as const,
  detail: (id: string) => [...departmentKeys.all, 'detail', id] as const,
  tree: (branchId?: string) =>
    [...departmentKeys.all, 'tree', branchId ?? 'all'] as const,
  statistics: () => [...departmentKeys.all, 'statistics'] as const,
};

export function useDepartments(
  params: { branchId?: string; includeInactive?: boolean } = {},
) {
  return useQuery({
    queryKey: departmentKeys.list(params),
    queryFn: () => departmentService.list(params),
  });
}

export function useDepartment(id: string | undefined) {
  return useQuery({
    queryKey: departmentKeys.detail(id!),
    queryFn: () => departmentService.get(id!),
    enabled: !!id,
  });
}

export function useDepartmentTree(branchId?: string) {
  return useQuery({
    queryKey: departmentKeys.tree(branchId),
    queryFn: () => departmentService.tree(branchId),
  });
}

export function useDepartmentStatistics() {
  return useQuery({
    queryKey: departmentKeys.statistics(),
    queryFn: () => departmentService.statistics(),
  });
}

export function useCreateDepartment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateDepartmentPayload) =>
      departmentService.create(payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: departmentKeys.all }),
  });
}

export function useUpdateDepartment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: UpdateDepartmentPayload;
    }) => departmentService.update(id, payload),
    // Reparenting moves a node, so the tree and the statistics both change —
    // invalidating only the detail key would leave the org chart drawing the
    // old shape.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: departmentKeys.all }),
  });
}

export function useDeleteDepartment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => departmentService.remove(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: departmentKeys.all }),
  });
}
