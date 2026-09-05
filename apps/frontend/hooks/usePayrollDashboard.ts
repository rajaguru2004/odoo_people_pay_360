'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import payrollDashboardService from '@/services/payrollDashboardService';
import type {
  DashboardMonths,
  PayrollDashboardQuery,
  PayrollDashboardSummary,
} from '@/types/payrollDashboard';

export const payrollDashboardKeys = {
  all: ['payroll-dashboard'] as const,
  summary: (query: PayrollDashboardQuery) =>
    [...payrollDashboardKeys.all, 'summary', query] as const,
};

const MONTHS: DashboardMonths[] = [6, 12];

/**
 * The analytics page's filters, its data, and the URL that carries both.
 *
 * **The slicers live in the query string.** A filtered dashboard has to survive
 * a refresh, a back button and a pasted link: without that, drilling from a
 * department bar into the payslip list strands the reader with no way back to
 * the view they left, and nobody can send a colleague the thing they are
 * looking at. `router.replace` rather than `push`, so moving a filter four
 * times does not put four entries between the reader and the page they came
 * from.
 *
 * **One query for the whole page.** Every visual reads this response, so a
 * filter change refreshes all of them together and no two panels can be
 * answering for different periods.
 */
export function usePayrollDashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const filters = useMemo<PayrollDashboardQuery>(() => {
    const months = Number(params.get('months'));
    return {
      months: MONTHS.includes(months as DashboardMonths)
        ? (months as DashboardMonths)
        : undefined,
      period: params.get('period') ?? undefined,
      departmentId: params.get('departmentId') ?? undefined,
      employmentType: params.get('employmentType') ?? undefined,
    };
  }, [params]);

  const setFilter = useCallback(
    (key: keyof PayrollDashboardQuery, value: string | undefined) => {
      const next = new URLSearchParams(params.toString());
      // An empty value REMOVES the key rather than writing an empty one, so
      // "All departments" produces a clean URL instead of `departmentId=`,
      // which the server would have to decide how to read.
      if (value) next.set(key, value);
      else next.delete(key);

      const search = next.toString();
      router.replace(search ? `${pathname}?${search}` : pathname, {
        scroll: false,
      });
    },
    [params, pathname, router],
  );

  const reset = useCallback(() => {
    router.replace(pathname, { scroll: false });
  }, [pathname, router]);

  const query = useQuery({
    queryKey: payrollDashboardKeys.summary(filters),
    queryFn: () => payrollDashboardService.summary(filters).then((r) => r.data),
    staleTime: 60_000,
    // Holds the current answer on screen while the next loads. Without it every
    // filter change blanks twelve panels at once and the page jumps.
    placeholderData: (previous?: PayrollDashboardSummary) => previous,
  });

  return {
    summary: query.data,
    filters,
    setFilter,
    reset,
    /** True only on the very first load — the skeleton pass. */
    loading: query.isLoading,
    /** True while a filter change is in flight and stale marks are still up. */
    refetching: query.isFetching && !query.isLoading,
    failed: query.isError,
  };
}
