import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import contractService from '@/services/contractService';

interface ContractQueryParams {
    page?: number;
    limit?: number;
    employeeId?: string;
    status?: string;
    type?: string;
}

export function useContracts(params?: ContractQueryParams) {
    return useQuery({
        queryKey: ['contracts', params],
        queryFn: () => contractService.getAll(params),
        staleTime: 2 * 60 * 1000, // 2 minutes
        placeholderData: (previousData) => previousData,
    });
}

export function useContract(id: string) {
    return useQuery({
        queryKey: ['contracts', id],
        queryFn: () => contractService.getById(id),
        staleTime: 5 * 60 * 1000,
        enabled: !!id,
    });
}

export function useExpiringContracts(days: number = 30) {
    return useQuery({
        queryKey: ['contracts', 'expiring', days],
        queryFn: () => contractService.getExpiring(days),
        staleTime: 60 * 60 * 1000, // 1 hour
    });
}

export function useCreateContract() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: any) => contractService.create(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['contracts'] });
            queryClient.invalidateQueries({ queryKey: ['employees'] });
            queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        },
    });
}

export function useUpdateContract() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, data }: { id: string; data: any }) =>
            contractService.update(id, data),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({ queryKey: ['contracts', variables.id] });
            queryClient.invalidateQueries({ queryKey: ['contracts'] });
            queryClient.invalidateQueries({ queryKey: ['employees'] });
            queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        },
    });
}

export function useDeleteContract() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: string) => contractService.delete(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['contracts'] });
            queryClient.invalidateQueries({ queryKey: ['employees'] });
            queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        },
    });
}
