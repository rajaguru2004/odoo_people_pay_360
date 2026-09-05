import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import departmentService from '@/services/departmentService';

export function useDepartments() {
    return useQuery({
        queryKey: ['departments'],
        queryFn: () => departmentService.getAll(),
        staleTime: 5 * 60 * 1000, // 5 minutes - departments don't change often
    });
}

export function useDepartment(id: string) {
    return useQuery({
        queryKey: ['departments', id],
        queryFn: () => departmentService.getById(id),
        staleTime: 5 * 60 * 1000,
        enabled: !!id,
    });
}

export function useCreateDepartment() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: any) => departmentService.create(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['departments'] });
        },
    });
}

export function useUpdateDepartment() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, data }: { id: string; data: any }) =>
            departmentService.update(id, data),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({ queryKey: ['departments', variables.id] });
            queryClient.invalidateQueries({ queryKey: ['departments'] });
        },
    });
}

export function useDeleteDepartment() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: string) => departmentService.delete(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['departments'] });
        },
    });
}
