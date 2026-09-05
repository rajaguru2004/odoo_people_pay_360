'use client';

import { useQuery } from '@tanstack/react-query';
import calendarService from '@/services/calendarService';

export const calendarKeys = {
  all: ['calendar'] as const,
  range: (startDate: string, endDate: string, employeeId?: string) =>
    [...calendarKeys.all, 'range', startDate, endDate, employeeId ?? 'me'] as const,
  stats: (month: number, year: number, employeeId?: string) =>
    [...calendarKeys.all, 'stats', year, month, employeeId ?? 'me'] as const,
};

export function useMyCalendar(
  startDate: string,
  endDate: string,
  employeeId?: string,
) {
  return useQuery({
    queryKey: calendarKeys.range(startDate, endDate, employeeId),
    queryFn: () => calendarService.myCalendar(startDate, endDate, employeeId),
  });
}

export function useCalendarStats(
  month: number,
  year: number,
  employeeId?: string,
) {
  return useQuery({
    queryKey: calendarKeys.stats(month, year, employeeId),
    queryFn: () => calendarService.stats(month, year, employeeId),
  });
}
