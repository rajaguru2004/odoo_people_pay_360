'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import faceEnrollmentService from '@/services/faceEnrollmentService';
import type {
  CreateFaceEnrollmentPayload,
  VerifyFacePayload,
} from '@/types/attendance';

export const faceEnrollmentKeys = {
  all: ['face-enrollments'] as const,
  list: () => [...faceEnrollmentKeys.all, 'list'] as const,
  employee: (employeeId: string) =>
    [...faceEnrollmentKeys.all, 'employee', employeeId] as const,
  status: () => [...faceEnrollmentKeys.all, 'status'] as const,
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

/** Whether the signed-in employee has a template on file. */
export function useMyFaceEnrollmentStatus() {
  return useQuery({
    queryKey: faceEnrollmentKeys.status(),
    queryFn: () => faceEnrollmentService.status(),
  });
}

/**
 * Verify a captured probe.
 *
 * A mutation rather than a query on purpose: it is an event at a point in time
 * — "is this the person standing here NOW" — and caching a previous verdict is
 * exactly the wrong behaviour for a check somebody is about to punch on.
 */
export function useVerifyFace() {
  return useMutation({
    mutationFn: (payload: VerifyFacePayload) =>
      faceEnrollmentService.verify(payload),
  });
}
