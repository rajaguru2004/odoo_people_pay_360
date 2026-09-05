'use client';

import { useQuery } from '@tanstack/react-query';
import workScheduleService from '@/services/workScheduleService';

export const workScheduleKeys = {
  all: ['work-schedules'] as const,
  list: (params: { employeeId?: string; startDate?: string; endDate?: string }) =>
    [...workScheduleKeys.all, 'list', params] as const,
};

export function useWorkSchedules(
  params: { employeeId?: string; startDate?: string; endDate?: string } = {},
) {
  return useQuery({
    queryKey: workScheduleKeys.list(params),
    queryFn: () => workScheduleService.list(params),
  });
}
