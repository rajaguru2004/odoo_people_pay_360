'use client';

import { useQuery } from '@tanstack/react-query';
import vaultService from '@/services/vaultService';

export const vaultKeys = {
  all: ['document-vault'] as const,
  mine: () => [...vaultKeys.all, 'mine'] as const,
  employee: (employeeId: string) =>
    [...vaultKeys.all, 'employee', employeeId] as const,
};

export function useMyVault() {
  return useQuery({
    queryKey: vaultKeys.mine(),
    queryFn: () => vaultService.mine(),
  });
}

export function useEmployeeVault(employeeId: string | undefined) {
  return useQuery({
    queryKey: vaultKeys.employee(employeeId!),
    queryFn: () => vaultService.forEmployee(employeeId!),
    enabled: !!employeeId,
  });
}
