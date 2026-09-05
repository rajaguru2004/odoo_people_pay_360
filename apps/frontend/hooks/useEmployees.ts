import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import employeeService from '@/services/employeeService';
import { Employee, QueryEmployeesParams } from '@/types/employee';

export function useEmployees(params?: QueryEmployeesParams) {
    return useQuery({
        queryKey: ['employees', params],
        queryFn: () => employeeService.getAll(params),
        staleTime: 2 * 60 * 1000, // 2 minutes
        placeholderData: (previousData) => previousData, // Keep previous data while fetching new
    });
}

export function useEmployee(id: string) {
    return useQuery({
        queryKey: ['employees', id],
        queryFn: () => employeeService.getById(id),
        staleTime: 5 * 60 * 1000, // 5 minutes
        enabled: !!id, // Only fetch if id exists
    });
}

export function useCreateEmployee() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: any) => employeeService.create(data),
        onSuccess: () => {
            // Invalidate and refetch employees list
            queryClient.invalidateQueries({ queryKey: ['employees'] });
        },
    });
}

export function useUpdateEmployee() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, data }: { id: string; data: any }) =>
            employeeService.update(id, data),
        onSuccess: (_, variables) => {
            // Invalidate specific employee and list
            queryClient.invalidateQueries({ queryKey: ['employees', variables.id] });
            queryClient.invalidateQueries({ queryKey: ['employees'] });
        },
    });
}

export function useEmployeeStatistics() {
    return useQuery({
        queryKey: ['employees', 'statistics'],
        queryFn: () => employeeService.getStatistics(),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

export function useDeleteEmployee() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: string) => employeeService.delete(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['employees'] });
        },
    });
}
