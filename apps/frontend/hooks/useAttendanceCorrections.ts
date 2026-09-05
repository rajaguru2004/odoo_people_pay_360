'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import attendanceCorrectionService from '@/services/attendanceCorrectionService';
import type { ReviewPayload } from '@/types/common';
import type {
  CorrectionListQuery,
  CreateCorrectionPayload,
} from '@/types/attendance';
import { attendanceKeys } from './useAttendance';

export const correctionKeys = {
  all: ['attendance-corrections'] as const,
  list: (query: CorrectionListQuery) =>
    [...correctionKeys.all, 'list', query] as const,
  detail: (id: string) => [...correctionKeys.all, 'detail', id] as const,
  stats: () => [...correctionKeys.all, 'stats'] as const,
};

export function useCorrections(query: CorrectionListQuery = {}) {
  return useQuery({
    queryKey: correctionKeys.list(query),
    queryFn: () => attendanceCorrectionService.list(query),
  });
}

export function useCorrection(id: string | undefined) {
  return useQuery({
    queryKey: correctionKeys.detail(id!),
    queryFn: () => attendanceCorrectionService.get(id!),
    enabled: !!id,
  });
}

export function useCorrectionStats() {
  return useQuery({
    queryKey: correctionKeys.stats(),
    queryFn: () => attendanceCorrectionService.stats(),
  });
}

export function useCreateCorrection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateCorrectionPayload) =>
      attendanceCorrectionService.create(payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: correctionKeys.all }),
  });
}

export function useReviewCorrection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ReviewPayload }) =>
      attendanceCorrectionService.review(id, payload),
    // Approving rewrites the attendance row itself, so the logs, today's board
    // and every report built on them are stale as well as the queue.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: correctionKeys.all });
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    },
  });
}

export function useCancelCorrection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => attendanceCorrectionService.cancel(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: correctionKeys.all }),
  });
}
