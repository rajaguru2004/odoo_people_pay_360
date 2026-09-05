'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import trainingService from '@/services/trainingService';
import { vaultKeys } from './useVault';
import type {
  CreateCourseData,
  CreateSessionData,
  RecordAttendanceData,
} from '@/types/training';

export const trainingKeys = {
  all: ['training'] as const,
  stats: () => [...trainingKeys.all, 'stats'] as const,
  courses: (activeOnly: boolean) =>
    [...trainingKeys.all, 'courses', activeOnly] as const,
  sessions: (params: { status?: string; from?: string; to?: string }) =>
    [...trainingKeys.all, 'sessions', params] as const,
  nominations: (params: { sessionId?: string; status?: string }) =>
    [...trainingKeys.all, 'nominations', params] as const,
  mine: () => [...trainingKeys.all, 'mine'] as const,
};

export function useTrainingStats(enabled = true) {
  return useQuery({
    queryKey: trainingKeys.stats(),
    queryFn: () => trainingService.stats(),
    enabled,
  });
}

export function useCourses(activeOnly = false) {
  return useQuery({
    queryKey: trainingKeys.courses(activeOnly),
    queryFn: () => trainingService.listCourses(activeOnly),
  });
}

export function useTrainingSessions(
  params: { status?: string; from?: string; to?: string } = {},
) {
  return useQuery({
    queryKey: trainingKeys.sessions(params),
    queryFn: () => trainingService.listSessions(params),
  });
}

export function useNominations(
  params: { sessionId?: string; status?: string } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: trainingKeys.nominations(params),
    queryFn: () => trainingService.listNominations(params),
    enabled,
  });
}

export function useMyTraining() {
  return useQuery({
    queryKey: trainingKeys.mine(),
    queryFn: () => trainingService.mine(),
  });
}

function invalidateTraining(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient.invalidateQueries({ queryKey: trainingKeys.all });
}

export function useCreateCourse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateCourseData) => trainingService.createCourse(payload),
    onSuccess: () => invalidateTraining(queryClient),
  });
}

export function useCreateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSessionData) =>
      trainingService.createSession(payload),
    onSuccess: () => invalidateTraining(queryClient),
  });
}

export function useNominate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      sessionId: string;
      employeeId: string;
      justification?: string;
    }) => trainingService.nominate(payload),
    onSuccess: () => invalidateTraining(queryClient),
  });
}

export function useDecideNomination() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      decision,
      remarks,
    }: {
      id: string;
      decision: 'approve' | 'reject';
      remarks?: string;
    }) =>
      decision === 'approve'
        ? trainingService.approve(id, remarks)
        : trainingService.reject(id, remarks),
    onSuccess: () => invalidateTraining(queryClient),
  });
}

export function useRecordAttendance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: RecordAttendanceData }) =>
      trainingService.recordAttendance(id, payload),
    onSuccess: (_result, { payload }) => {
      void invalidateTraining(queryClient);
      // A recorded certificate becomes a vault item, so the documents screen
      // is stale the moment attendance is filed.
      if (payload.certificateUrl) {
        void queryClient.invalidateQueries({ queryKey: vaultKeys.all });
      }
    },
  });
}

export function useCancelNomination() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => trainingService.cancel(id),
    onSuccess: () => invalidateTraining(queryClient),
  });
}
