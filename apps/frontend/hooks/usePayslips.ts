'use client';

import { useQuery } from '@tanstack/react-query';
import payrollService from '@/services/payrollService';

export const payslipKeys = {
  all: ['payslips'] as const,
  list: (year?: number) => [...payslipKeys.all, 'list', year ?? 'recent'] as const,
  detail: (id: string) => [...payslipKeys.all, 'detail', id] as const,
  ytd: (year: number) => [...payslipKeys.all, 'ytd', year] as const,
  structure: (employeeId: string) =>
    [...payslipKeys.all, 'structure', employeeId] as const,
};

export function useMyPayslips(year?: number) {
  return useQuery({
    queryKey: payslipKeys.list(year),
    queryFn: () => payrollService.myPayslips(year),
    // Keeps the current year on screen while another one loads, so stepping
    // through the years does not blank the table and jump the page.
    placeholderData: (previous) => previous,
  });
}

export function useMyPayslip(id: string | undefined) {
  return useQuery({
    queryKey: payslipKeys.detail(id!),
    queryFn: () => payrollService.myPayslip(id!),
    enabled: !!id,
  });
}

export function useYtdSummary(year: number) {
  return useQuery({
    queryKey: payslipKeys.ytd(year),
    queryFn: () => payrollService.ytdSummary(year),
  });
}

/**
 * The standing salary structure.
 *
 * `retry: false` because the interesting failure is a 404 — plenty of people
 * have payslips and no structure on record — and retrying it three times only
 * delays the empty state the screen is going to show anyway.
 */
export function useSalaryStructure(employeeId: string | undefined) {
  return useQuery({
    queryKey: payslipKeys.structure(employeeId!),
    queryFn: () => payrollService.salaryStructure(employeeId!),
    enabled: !!employeeId,
    retry: false,
  });
}
