'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import employeeProfileService from '@/services/employeeProfileService';
import type { UpdateEmployeeProfilePayload } from '@/types/employeeProfile';

export const employeeProfileKeys = {
  all: ['employee-profile'] as const,
  detail: (employeeId: string) =>
    [...employeeProfileKeys.all, 'detail', employeeId] as const,
};

export function useEmployeeProfile(employeeId: string | undefined) {
  return useQuery({
    queryKey: employeeProfileKeys.detail(employeeId!),
    queryFn: () => employeeProfileService.get(employeeId!),
    enabled: !!employeeId,
  });
}

export function useUpdateEmployeeProfile(employeeId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateEmployeeProfilePayload) =>
      employeeProfileService.update(employeeId!, payload),
    // The whole subtree, not just this record: the directory and the People hub
    // read the same columns, and leaving them cached shows a stale phone number
    // on the next screen the user opens.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: employeeProfileKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
    },
  });
}
