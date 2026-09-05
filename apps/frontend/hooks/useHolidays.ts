'use client';

import { useQuery } from '@tanstack/react-query';
import holidayService from '@/services/holidayService';

export const holidayKeys = {
  all: ['holidays'] as const,
  list: (params: { year?: number; branchId?: string }) =>
    [...holidayKeys.all, 'list', params] as const,
};

export function useHolidays(params: { year?: number; branchId?: string } = {}) {
  return useQuery({
    queryKey: holidayKeys.list(params),
    queryFn: () => holidayService.list(params),
  });
}
