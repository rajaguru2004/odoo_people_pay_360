import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import attendanceService from '@/services/attendanceService';

interface AttendanceQueryParams {
    employeeId?: string;
    month?: number;
    year?: number;
}

export function useMyAttendances(month?: number, year?: number) {
    return useQuery({
        queryKey: ['attendances', 'my', month, year],
        queryFn: () => attendanceService.getMyAttendances(month, year),
        staleTime: 30 * 1000, // 30 seconds
    });
}

export function useEmployeeAttendances(employeeId: string, month?: number, year?: number) {
    return useQuery({
        queryKey: ['attendances', 'employee', employeeId, month, year],
        queryFn: () => attendanceService.getEmployeeAttendances(employeeId, month, year),
        staleTime: 30 * 1000,
        enabled: !!employeeId,
    });
}

export function useTodayAttendance() {
    return useQuery({
        queryKey: ['attendances', 'today'],
        queryFn: () => attendanceService.getTodayAttendance(),
        staleTime: 10 * 1000, // 10 seconds - very fresh data
        refetchInterval: 30 * 1000, // Refetch every 30 seconds
    });
}

export function useTodayAllAttendances() {
    return useQuery({
        queryKey: ['attendances', 'today', 'all'],
        queryFn: () => attendanceService.getTodayAllAttendances(),
        staleTime: 30 * 1000,
        refetchInterval: 60 * 1000, // Refetch every minute
    });
}

export function useAttendanceStats(month?: number, year?: number) {
    return useQuery({
        queryKey: ['attendances', 'stats', month, year],
        queryFn: () => attendanceService.getStatistics(month, year),
        staleTime: 60 * 1000, // 1 minute
    });
}

export function useMonthlyReport(month: number, year: number) {
    return useQuery({
        queryKey: ['attendances', 'report', month, year],
        queryFn: () => attendanceService.getMonthlyReport(month, year),
        staleTime: 5 * 60 * 1000, // 5 minutes
        enabled: !!month && !!year,
    });
}

export function useCheckIn() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => attendanceService.checkIn(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['attendances'] });
            queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        },
    });
}

export function useCheckOut() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => attendanceService.checkOut(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['attendances'] });
            queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        },
    });
}

// Attendance Corrections
export function useAttendanceCorrections(params?: { status?: string; employeeId?: string }) {
    return useQuery({
        queryKey: ['attendance-corrections', params],
        queryFn: () => attendanceService.getCorrections(params),
        staleTime: 60 * 1000,
    });
}

export function usePendingCorrections() {
    return useQuery({
        queryKey: ['attendance-corrections', 'pending'],
        queryFn: () => attendanceService.getPendingCorrections(),
        staleTime: 30 * 1000,
    });
}

export function useMyCorrections() {
    return useQuery({
        queryKey: ['attendance-corrections', 'my'],
        queryFn: () => attendanceService.getMyCorrections(),
        staleTime: 60 * 1000,
    });
}

export function useCreateCorrection() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: any) => attendanceService.createCorrection(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['attendance-corrections'] });
            queryClient.invalidateQueries({ queryKey: ['attendances'] });
        },
    });
}

export function useApproveCorrection() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: string) => attendanceService.approveCorrection(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['attendance-corrections'] });
            queryClient.invalidateQueries({ queryKey: ['attendances'] });
        },
    });
}

export function useRejectCorrection() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, reason }: { id: string; reason: string }) =>
            attendanceService.rejectCorrection(id, reason),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['attendance-corrections'] });
        },
    });
}
