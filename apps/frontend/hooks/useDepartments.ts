'use client';

import { useQuery } from '@tanstack/react-query';
import departmentService from '@/services/departmentService';

export const departmentKeys = {
  all: ['departments'] as const,
  list: (branchId?: string) => [...departmentKeys.all, 'list', branchId ?? 'all'] as const,
};

export function useDepartments(branchId?: string) {
  return useQuery({
    queryKey: departmentKeys.list(branchId),
    queryFn: () => departmentService.list(branchId),
  });
}
