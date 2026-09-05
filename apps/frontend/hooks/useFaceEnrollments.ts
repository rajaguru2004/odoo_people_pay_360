'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import faceEnrollmentService from '@/services/faceEnrollmentService';
import type {
  CreateFaceEnrollmentPayload,
  RegisterFacePayload,
  VerifyFacePayload,
} from '@/types/attendance';

export const faceEnrollmentKeys = {
  all: ['face-enrollments'] as const,
  list: () => [...faceEnrollmentKeys.all, 'list'] as const,
  employee: (employeeId: string) =>
    [...faceEnrollmentKeys.all, 'employee', employeeId] as const,
  status: () => [...faceEnrollmentKeys.all, 'status'] as const,
  mine: () => [...faceEnrollmentKeys.all, 'mine'] as const,
  counts: () => [...faceEnrollmentKeys.all, 'counts'] as const,
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

/** The signed-in employee's own gallery. */
export function useMyFaceEnrollments() {
  return useQuery({
    queryKey: faceEnrollmentKeys.mine(),
    queryFn: () => faceEnrollmentService.mine(),
  });
}

/** Per-employee template counts for the enrolment table. HR only. */
export function useFaceEnrollmentCounts(enabled = true) {
  return useQuery({
    queryKey: faceEnrollmentKeys.counts(),
    queryFn: () => faceEnrollmentService.counts(),
    enabled,
  });
}

/**
 * Enrol from a captured photo.
 *
 * Invalidates the whole subtree rather than a guessed key: one capture moves
 * the gallery, the status card AND the per-employee counts, and a screen still
 * showing 2/3 after the third capture is the bug this avoids.
 */
export function useRegisterFace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: RegisterFacePayload) =>
      faceEnrollmentService.register(payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: faceEnrollmentKeys.all }),
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
