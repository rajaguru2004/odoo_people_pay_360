import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import holidayService from '@/services/holidayService';
import { CreateHolidayData, UpdateHolidayData, CopyYearData } from '@/types/holiday';

interface HolidayFilters {
  year?: number;
  branchId?: string;
}

export function useHolidays(filters: HolidayFilters = {}, enabled: boolean = true) {
  return useQuery({
    queryKey: ['holidays', filters.year ?? 'all', filters.branchId ?? 'all-scopes'],
    queryFn: () => holidayService.getAll(filters),
    staleTime: 5 * 60 * 1000, // holidays change rarely
    enabled,
  });
}

export function useCreateHoliday() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateHolidayData) => holidayService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['holidays'] });
    },
  });
}

export function useUpdateHoliday() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateHolidayData }) =>
      holidayService.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['holidays'] });
    },
  });
}

export function useDeleteHoliday() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => holidayService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['holidays'] });
    },
  });
}

export function useCopyHolidayYear() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CopyYearData) => holidayService.copyYear(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['holidays'] });
    },
  });
}
