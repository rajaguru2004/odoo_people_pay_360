'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import leaveService from '@/services/leaveService';
import { balanceKeys, leaveKeys } from './useLeaveRequests';

export function useLeaveBalances(year?: number) {
  return useQuery({
    queryKey: balanceKeys.list(year),
    queryFn: () => leaveService.allBalances(year),
  });
}

export function useEmployeeLeaveBalance(
  employeeId: string | undefined,
  year?: number,
) {
  return useQuery({
    queryKey: balanceKeys.employee(employeeId!, year),
    queryFn: () => leaveService.balance(employeeId!, year),
    enabled: !!employeeId,
  });
}

export function useCompanyLeaveOverview(year?: number) {
  return useQuery({
    queryKey: balanceKeys.overview(year),
    queryFn: () => leaveService.companyOverview(year),
  });
}

export function useLeaveAccrualHistory(
  params: { employeeId?: string; year?: number; month?: number } = {},
) {
  return useQuery({
    queryKey: balanceKeys.accruals(params),
    queryFn: () => leaveService.accrualHistory(params),
  });
}

/**
 * Editing an allocation changes what somebody is entitled to, which the leave
 * form checks before it lets a request through — so both subtrees go.
 */
export function useUpdateTypeBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      employeeId,
      year,
      leaveTypeKey,
      allocated,
      carriedOver,
    }: {
      employeeId: string;
      year: number;
      leaveTypeKey: string;
      allocated: number;
      carriedOver?: number;
    }) =>
      leaveService.updateTypeBalance(employeeId, year, leaveTypeKey, {
        allocated,
        carriedOver,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: balanceKeys.all });
      void queryClient.invalidateQueries({ queryKey: leaveKeys.all });
    },
  });
}

export function useUpdateBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      employeeId,
      year,
      annualLeave,
      sickLeave,
    }: {
      employeeId: string;
      year: number;
      annualLeave?: number;
      sickLeave?: number;
    }) =>
      leaveService.updateBalance(employeeId, year, { annualLeave, sickLeave }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: balanceKeys.all });
    },
  });
}

export function useInitBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, year }: { employeeId: string; year: number }) =>
      leaveService.initBalance(employeeId, year),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: balanceKeys.all });
    },
  });
}

export function useRunLeaveAccrual() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => leaveService.runAccrual(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: balanceKeys.all });
    },
  });
}

export function useAccrueForEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      employeeId,
      daysToAdd,
      notes,
    }: {
      employeeId: string;
      daysToAdd: number;
      notes?: string;
    }) => leaveService.accrueForEmployee(employeeId, { daysToAdd, notes }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: balanceKeys.all });
    },
  });
}

export function useSetDefaultAllocations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (year: number) => leaveService.setDefaultAllocations(year),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: balanceKeys.all });
    },
  });
}
