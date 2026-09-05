'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import payrollRunService from '@/services/payrollRunService';
import payrollReportService from '@/services/payrollReportService';
import { payslipKeys } from './usePayslips';
import { payrollHubKeys } from './usePayrollHub';
import type {
  CreatePayrollRunPayload,
  PayrollCostGroupBy,
  PayrollRunListQuery,
  PreflightPayload,
  RejectPayrollRunPayload,
} from '@/types/payroll';

/**
 * One root, so invalidation targets the whole subtree.
 *
 * Every mutation below invalidates `payrollKeys.all` rather than a guessed key:
 * a lifecycle move changes the list, the detail AND the counts, and a hand-built
 * key that missed one leaves a screen quoting a status the server has left.
 */
export const payrollKeys = {
  all: ['payroll-runs'] as const,
  list: (query: PayrollRunListQuery) =>
    [...payrollKeys.all, 'list', query] as const,
  detail: (id: string) => [...payrollKeys.all, 'detail', id] as const,
  reports: () => [...payrollKeys.all, 'reports'] as const,
  register: (runId: string) =>
    [...payrollKeys.reports(), 'register', runId] as const,
  cost: (runId: string, groupBy: PayrollCostGroupBy) =>
    [...payrollKeys.reports(), 'cost', runId, groupBy] as const,
  statutory: (runId: string) =>
    [...payrollKeys.reports(), 'statutory', runId] as const,
  ytd: (employeeId: string, year: number) =>
    [...payrollKeys.reports(), 'ytd', employeeId, year] as const,
};

export function usePayrollRuns(query: PayrollRunListQuery = {}) {
  return useQuery({
    queryKey: payrollKeys.list(query),
    queryFn: () => payrollRunService.list(query),
  });
}

export function usePayrollRun(id: string | undefined) {
  return useQuery({
    queryKey: payrollKeys.detail(id!),
    queryFn: () => payrollRunService.get(id!),
    enabled: !!id,
  });
}

/**
 * A run's payslips and its status move together, so every mutation clears the
 * whole payroll subtree and the payslip subtree with it.
 */
function useRunMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  alsoHub = false,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: payrollKeys.all });
      void queryClient.invalidateQueries({ queryKey: payslipKeys.all });
      // The hub's money counts APPROVED and PAID runs only, so a lifecycle move
      // across that line changes every figure on the landing page.
      if (alsoHub) {
        void queryClient.invalidateQueries({ queryKey: payrollHubKeys.all });
      }
    },
  });
}

/**
 * Pre-flight. A MUTATION despite writing nothing, because it is a POST the user
 * fires deliberately — running it on render would ask the server to price a
 * period nobody has chosen yet.
 */
export function usePreflightPayrollRun() {
  return useMutation({
    mutationFn: (payload: PreflightPayload) =>
      payrollRunService.preflight(payload),
  });
}

export function useCreatePayrollRun() {
  return useRunMutation((payload: CreatePayrollRunPayload) =>
    payrollRunService.create(payload),
  );
}

export function useCalculatePayrollRun() {
  return useRunMutation((id: string) => payrollRunService.calculate(id));
}

export function useApprovePayrollRun() {
  return useRunMutation((id: string) => payrollRunService.approve(id), true);
}

export function useRejectPayrollRun() {
  return useRunMutation(
    ({ id, payload }: { id: string; payload: RejectPayrollRunPayload }) =>
      payrollRunService.reject(id, payload),
    true,
  );
}

export function useMarkPayrollRunPaid() {
  return useRunMutation((id: string) => payrollRunService.markPaid(id), true);
}

export function useCancelPayrollRun() {
  return useRunMutation((id: string) => payrollRunService.cancel(id), true);
}

export function useDeletePayrollRun() {
  return useRunMutation((id: string) => payrollRunService.remove(id), true);
}

/**
 * The `.xlsx` download.
 *
 * A mutation, not a query: it is an action the user takes, it caches nothing,
 * and the interceptor hands a blob response back UNTOUCHED — the file is
 * `res.data`, not `res.data.data`.
 */
export function useExportPayrollRun() {
  return useMutation({
    mutationFn: (id: string) => payrollRunService.exportXlsx(id),
  });
}

// ── Reports ─────────────────────────────────────────────────────────────────
// Run-scoped, so they hang off the same root: recalculating a run makes every
// report of it stale, and one `payrollKeys.all` invalidation catches them.

export function usePayrollRegister(runId: string | undefined) {
  return useQuery({
    queryKey: payrollKeys.register(runId!),
    queryFn: () => payrollReportService.register(runId!).then((r) => r.data),
    enabled: !!runId,
  });
}

export function usePayrollCost(
  runId: string | undefined,
  groupBy: PayrollCostGroupBy = 'department',
) {
  return useQuery({
    queryKey: payrollKeys.cost(runId!, groupBy),
    queryFn: () =>
      payrollReportService.cost(runId!, groupBy).then((r) => r.data),
    enabled: !!runId,
  });
}

export function usePayrollStatutory(runId: string | undefined) {
  return useQuery({
    queryKey: payrollKeys.statutory(runId!),
    queryFn: () => payrollReportService.statutory(runId!).then((r) => r.data),
    enabled: !!runId,
  });
}

export function useEmployeeYtd(employeeId: string | undefined, year: number) {
  return useQuery({
    queryKey: payrollKeys.ytd(employeeId!, year),
    queryFn: () => payrollReportService.ytd(employeeId!, year).then((r) => r.data),
    enabled: !!employeeId,
  });
}
