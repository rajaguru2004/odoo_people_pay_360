'use client';

import { useQuery } from '@tanstack/react-query';
import payslipService from '@/services/payslipService';
import type { MyPayslipListQuery, PayslipListQuery } from '@/types/payslip';

/**
 * `mine` is its own branch of the tree, deliberately.
 *
 * `/payslips/my` and `/payslips` answer different sets to the same person — the
 * self-service list is narrowed to APPROVED and PAID runs — so caching them
 * under one key would let an admin screen's rows leak into the employee's own
 * page and show them a payslip that can still change.
 */
export const payslipKeys = {
  all: ['payslips'] as const,
  list: (query: PayslipListQuery) =>
    [...payslipKeys.all, 'list', query] as const,
  detail: (id: string) => [...payslipKeys.all, 'detail', id] as const,
  mine: () => [...payslipKeys.all, 'mine'] as const,
  myList: (query: MyPayslipListQuery) =>
    [...payslipKeys.mine(), 'list', query] as const,
  myDetail: (id: string) => [...payslipKeys.mine(), 'detail', id] as const,
  byEmployee: (employeeId: string, query: MyPayslipListQuery) =>
    [...payslipKeys.all, 'employee', employeeId, query] as const,
};

export function usePayslips(query: PayslipListQuery = {}) {
  return useQuery({
    queryKey: payslipKeys.list(query),
    queryFn: () => payslipService.list(query),
  });
}

export function usePayslip(id: string | undefined) {
  return useQuery({
    queryKey: payslipKeys.detail(id!),
    queryFn: () => payslipService.get(id!),
    enabled: !!id,
  });
}

export function useMyPayslips(query: MyPayslipListQuery = {}) {
  return useQuery({
    queryKey: payslipKeys.myList(query),
    queryFn: () => payslipService.listMine(query),
  });
}

export function useMyPayslip(id: string | undefined) {
  return useQuery({
    queryKey: payslipKeys.myDetail(id!),
    queryFn: () => payslipService.getMine(id!),
    enabled: !!id,
  });
}

export function useEmployeePayslips(
  employeeId: string | undefined,
  query: MyPayslipListQuery = {},
) {
  return useQuery({
    queryKey: payslipKeys.byEmployee(employeeId!, query),
    queryFn: () => payslipService.listByEmployee(employeeId!, query),
    enabled: !!employeeId,
  });
}
