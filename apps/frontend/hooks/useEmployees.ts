'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import employeeService from '@/services/employeeService';
import type {
  CreateEmployeePayload,
  EmployeeListQuery,
  EmployeeStatus,
} from '@/types/employee';

export const employeeKeys = {
  all: ['employees'] as const,
  list: (query: EmployeeListQuery) =>
    [...employeeKeys.all, 'list', query] as const,
  detail: (id: string) => [...employeeKeys.all, 'detail', id] as const,
  team: (id: string) => [...employeeKeys.all, 'team', id] as const,
};

export function useEmployees(query: EmployeeListQuery = {}) {
  return useQuery({
    queryKey: employeeKeys.list(query),
    queryFn: () => employeeService.list(query),
  });
}

/** The statuses the directory counts, in the order the stats bar prints them. */
const COUNTED_STATUSES = [
  'ACTIVE',
  'ON_LEAVE',
  'SUSPENDED',
  'TERMINATED',
] as const satisfies readonly EmployeeStatus[];

/**
 * Headcount by status for the bar above the directory.
 *
 * One `limit: 1` request per status, read for its `meta.total` rather than its
 * rows. The People hub's aggregate answers the same question in a single call,
 * but that endpoint is ADMIN and HR only — a payroll officer or a manager may
 * read the directory, so reaching for it here would meet a 403 and the shared
 * permission-denied modal on every visit to a screen they are entitled to.
 * These four go through the list endpoint the page is already allowed to call.
 *
 * The four are exhaustive and mutually exclusive, so the total is their sum
 * rather than a fifth request that could disagree with them.
 *
 * `query` carries every filter EXCEPT the status one, so the tiles describe the
 * same population the list is drawn from and still add up to the total.
 */
export function useEmployeeStatusCounts(
  query: Omit<EmployeeListQuery, 'status' | 'page' | 'limit'> = {},
) {
  const base = { ...query, page: 1, limit: 1 } as const;

  // A fixed number of hooks in a fixed order — mapping over the statuses would
  // put a hook inside a loop, and the count is only stable while the array is.
  const active = useEmployees({ ...base, status: COUNTED_STATUSES[0] });
  const onLeave = useEmployees({ ...base, status: COUNTED_STATUSES[1] });
  const suspended = useEmployees({ ...base, status: COUNTED_STATUSES[2] });
  const terminated = useEmployees({ ...base, status: COUNTED_STATUSES[3] });

  const results = [active, onLeave, suspended, terminated];
  const totals = results.map((result) => result.data?.meta?.total ?? null);

  return {
    // `null` until every figure is in. A partial sum would be a workforce total
    // that is simply wrong, and it would settle to the right one a moment later
    // without ever having said it was provisional.
    total: totals.every((value) => value !== null)
      ? totals.reduce((sum: number, value) => sum + (value ?? 0), 0)
      : null,
    byStatus: {
      ACTIVE: totals[0],
      ON_LEAVE: totals[1],
      SUSPENDED: totals[2],
      TERMINATED: totals[3],
    },
    isLoading: results.some((result) => result.isLoading),
  };
}

export function useEmployee(id: string | undefined) {
  return useQuery({
    queryKey: employeeKeys.detail(id!),
    queryFn: () => employeeService.get(id!),
    enabled: !!id,
  });
}

export function useEmployeeTeam(id: string | undefined) {
  return useQuery({
    queryKey: employeeKeys.team(id!),
    queryFn: () => employeeService.team(id!),
    enabled: !!id,
  });
}

export function useCreateEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateEmployeePayload) =>
      employeeService.create(payload),
    // Invalidate the whole `employees` subtree rather than one list key: the new
    // row belongs on every filter and page that could contain it, and guessing
    // which is how a create ends up invisible until a hard refresh.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: employeeKeys.all }),
  });
}

export function useUpdateEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: Partial<CreateEmployeePayload>;
    }) => employeeService.update(id, payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: employeeKeys.all }),
  });
}

export function useTerminateEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, exitDate }: { id: string; exitDate?: string }) =>
      employeeService.terminate(id, exitDate),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: employeeKeys.all }),
  });
}
