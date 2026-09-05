import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import leaveService from '@/services/leaveService';

interface LeaveRequestQueryParams {
    page?: number;
    limit?: number;
    employeeId?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
}

export function useLeaveRequests(params?: LeaveRequestQueryParams) {
    return useQuery({
        queryKey: ['leave-requests', params],
        queryFn: () => leaveService.getAll(params),
        staleTime: 60 * 1000, // 1 minute
        placeholderData: (previousData) => previousData,
    });
}

export function useLeaveRequest(id: string) {
    return useQuery({
        queryKey: ['leave-requests', id],
        queryFn: () => leaveService.getById(id),
        staleTime: 2 * 60 * 1000,
        enabled: !!id,
    });
}

export function useCreateLeaveRequest() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: any) => leaveService.create(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['leave-requests'] });
            queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        },
    });
}

export function useUpdateLeaveRequest() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: string) => leaveService.cancel(id),
        onSuccess: (_, id) => {
            queryClient.invalidateQueries({ queryKey: ['leave-requests', id] });
            queryClient.invalidateQueries({ queryKey: ['leave-requests'] });
            queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        },
    });
}

export function useApproveLeaveRequest() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: string) => leaveService.approve(id),
        onSuccess: (_, id) => {
            queryClient.invalidateQueries({ queryKey: ['leave-requests', id] });
            queryClient.invalidateQueries({ queryKey: ['leave-requests'] });
            queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        },
    });
}

export function useRejectLeaveRequest() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, reason }: { id: string; reason: string }) =>
            leaveService.reject(id, reason),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({ queryKey: ['leave-requests', variables.id] });
            queryClient.invalidateQueries({ queryKey: ['leave-requests'] });
            queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        },
    });
}

export function useDeleteLeaveRequest() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: string) => leaveService.cancel(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['leave-requests'] });
            queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        },
    });
}

// Leave Balances
export function useLeaveBalance(employeeId: string, year?: number) {
    return useQuery({
        queryKey: ['leave-balances', employeeId, year],
        queryFn: () => leaveService.getBalance(employeeId, year),
        staleTime: 5 * 60 * 1000, // 5 minutes
        enabled: !!employeeId,
    });
}

export function useAllLeaveBalances(year?: number) {
    return useQuery({
        queryKey: ['leave-balances', 'all', year],
        queryFn: () => leaveService.getAllBalances(year),
        staleTime: 5 * 60 * 1000,
    });
}
