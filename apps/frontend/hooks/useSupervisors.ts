'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import supervisorService from '@/services/supervisorService';
import { employeeKeys } from './useEmployees';
import type {
  AssignSupervisorPayload,
  BulkAssignSupervisorPayload,
} from '@/types/supervisor';

export const supervisorKeys = {
  all: ['supervisors'] as const,
  myTeam: () => [...supervisorKeys.all, 'my-team'] as const,
  reports: (supervisorId: string) => [...supervisorKeys.all, 'reports', supervisorId] as const,
  of: (employeeId: string) => [...supervisorKeys.all, 'of', employeeId] as const,
};

export function useMySupervisees() {
  return useQuery({
    queryKey: supervisorKeys.myTeam(),
    queryFn: () => supervisorService.myTeam(),
  });
}

export function useSupervisorReports(supervisorId: string | undefined) {
  return useQuery({
    queryKey: supervisorKeys.reports(supervisorId!),
    queryFn: () => supervisorService.reports(supervisorId!),
    enabled: !!supervisorId,
  });
}

/**
 * Both subtrees are invalidated after every write.
 *
 * The supervisor link lives on the employee row, so a reassignment changes what
 * the directory says as well as what the hierarchy says. Invalidating only
 * `supervisorKeys` leaves the employee list showing the previous supervisor
 * until something else happens to refetch it.
 */
function useSupervisorMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: supervisorKeys.all });
      queryClient.invalidateQueries({ queryKey: employeeKeys.all });
    },
  });
}

export function useAssignSupervisor() {
  return useSupervisorMutation((payload: AssignSupervisorPayload) =>
    supervisorService.assign(payload),
  );
}

export function useBulkAssignSupervisor() {
  return useSupervisorMutation((payload: BulkAssignSupervisorPayload) =>
    supervisorService.bulkAssign(payload),
  );
}

export function useUnassignSupervisor() {
  return useSupervisorMutation((employeeId: string) => supervisorService.unassign(employeeId));
}
