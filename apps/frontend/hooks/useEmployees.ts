'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import employeeService from '@/services/employeeService';
import type { CreateEmployeePayload, EmployeeListQuery } from '@/types/employee';

export const employeeKeys = {
  all: ['employees'] as const,
  list: (query: EmployeeListQuery) => [...employeeKeys.all, 'list', query] as const,
  detail: (id: string) => [...employeeKeys.all, 'detail', id] as const,
};

export function useEmployees(query: EmployeeListQuery = {}) {
  return useQuery({
    queryKey: employeeKeys.list(query),
    queryFn: () => employeeService.list(query),
  });
}

export function useEmployee(id: string | undefined) {
  return useQuery({
    queryKey: employeeKeys.detail(id!),
    queryFn: () => employeeService.get(id!),
    enabled: !!id,
  });
}

export function useCreateEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateEmployeePayload) => employeeService.create(payload),
    // Invalidate the whole `employees` subtree rather than one list key: the new
    // row belongs on every filter and page that could contain it, and guessing
    // which is how a create ends up invisible until a hard refresh.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: employeeKeys.all }),
  });
}
