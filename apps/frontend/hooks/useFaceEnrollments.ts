'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import faceEnrollmentService from '@/services/faceEnrollmentService';
import type { CreateFaceEnrollmentPayload } from '@/types/attendance';

export const faceEnrollmentKeys = {
  all: ['face-enrollments'] as const,
  list: () => [...faceEnrollmentKeys.all, 'list'] as const,
  employee: (employeeId: string) =>
    [...faceEnrollmentKeys.all, 'employee', employeeId] as const,
};

export function useFaceEnrollments() {
  return useQuery({
    queryKey: faceEnrollmentKeys.list(),
    queryFn: () => faceEnrollmentService.list(),
  });
}

export function useEmployeeFaceEnrollments(employeeId: string | undefined) {
  return useQuery({
    queryKey: faceEnrollmentKeys.employee(employeeId!),
    queryFn: () => faceEnrollmentService.forEmployee(employeeId!),
    enabled: !!employeeId,
  });
}

export function useCreateFaceEnrollment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateFaceEnrollmentPayload) =>
      faceEnrollmentService.create(payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: faceEnrollmentKeys.all }),
  });
}

export function useDeleteFaceEnrollment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => faceEnrollmentService.remove(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: faceEnrollmentKeys.all }),
  });
}
