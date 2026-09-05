'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import attendanceService from '@/services/attendanceService';
import type {
  AttendanceListQuery,
  BulkAttendancePayload,
  CheckInPayload,
  CreateAttendancePayload,
  MonthlyReportQuery,
  UpdateAttendancePayload,
} from '@/types/attendance';

export const attendanceKeys = {
  all: ['attendances'] as const,
  list: (query: AttendanceListQuery) =>
    [...attendanceKeys.all, 'list', query] as const,
  detail: (id: string) => [...attendanceKeys.all, 'detail', id] as const,
  today: () => [...attendanceKeys.all, 'today'] as const,
  summary: (params: Record<string, unknown>) =>
    [...attendanceKeys.all, 'summary', params] as const,
  monthly: (query: MonthlyReportQuery) =>
    [...attendanceKeys.all, 'monthly', query] as const,
  employee: (employeeId: string, params: Record<string, unknown>) =>
    [...attendanceKeys.all, 'employee', employeeId, params] as const,
};

export function useAttendances(query: AttendanceListQuery = {}) {
  return useQuery({
    queryKey: attendanceKeys.list(query),
    queryFn: () => attendanceService.list(query),
  });
}

export function useAttendance(id: string | undefined) {
  return useQuery({
    queryKey: attendanceKeys.detail(id!),
    queryFn: () => attendanceService.get(id!),
    enabled: !!id,
  });
}

/**
 * The month the attendance log grid draws.
 *
 * `placeholderData` keeps the previous month on screen while the next one
 * loads. Without it the grid unmounts on every press of the stepper and the
 * page jumps back to the top, which makes walking back through the year feel
 * like six separate page loads.
 */
export function useMonthlyAttendance(query: MonthlyReportQuery) {
  return useQuery({
    queryKey: attendanceKeys.monthly(query),
    queryFn: () => attendanceService.monthlyReport(query),
    placeholderData: (previous) => previous,
  });
}

export function useTodayAttendance() {
  return useQuery({
    queryKey: attendanceKeys.today(),
    queryFn: () => attendanceService.today(),
    // Today's board is the one screen people leave open. Half a minute is short
    // enough that a colleague's arrival shows up, long enough not to poll the
    // aggregate to death.
    refetchInterval: 30_000,
  });
}

export function useAttendanceSummary(params: {
  startDate: string;
  endDate: string;
  departmentId?: string;
  branchId?: string;
}) {
  return useQuery({
    queryKey: attendanceKeys.summary(params),
    queryFn: () => attendanceService.summary(params),
    enabled: Boolean(params.startDate && params.endDate),
  });
}

export function useEmployeeAttendance(
  employeeId: string | undefined,
  params: { startDate?: string; endDate?: string } = {},
) {
  return useQuery({
    queryKey: attendanceKeys.employee(employeeId!, params),
    queryFn: () => attendanceService.forEmployee(employeeId!, params),
    enabled: !!employeeId,
  });
}

export function useCheckIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CheckInPayload = {}) =>
      attendanceService.checkIn(payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: attendanceKeys.all }),
  });
}

export function useCheckOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CheckInPayload = {}) =>
      attendanceService.checkOut(payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: attendanceKeys.all }),
  });
}

export function useCreateAttendance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAttendancePayload) =>
      attendanceService.create(payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: attendanceKeys.all }),
  });
}

export function useUpdateAttendance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: UpdateAttendancePayload;
    }) => attendanceService.update(id, payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: attendanceKeys.all }),
  });
}

export function useBulkAttendance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: BulkAttendancePayload) =>
      attendanceService.bulk(payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: attendanceKeys.all }),
  });
}
