import { useQuery } from '@tanstack/react-query';
import dashboardService from '@/services/dashboardService';

export function useDashboardOverview() {
    return useQuery({
        queryKey: ['dashboard', 'overview'],
        queryFn: () => dashboardService.getOverview(),
        staleTime: 60 * 1000, // 1 minute
        gcTime: 5 * 60 * 1000, // 5 minutes
    });
}

export function useDashboardAlerts() {
    return useQuery({
        queryKey: ['dashboard', 'alerts'],
        queryFn: () => dashboardService.getAlerts(),
        staleTime: 30 * 1000, // 30 seconds
    });
}

export function useContractAlerts(days: number = 60) {
    return useQuery({
        queryKey: ['dashboard', 'contract-alerts', days],
        queryFn: () => dashboardService.getContractAlerts(days),
        staleTime: 60 * 60 * 1000, // 1 hour
    });
}

export function useRecentActivities(limit: number = 10) {
    return useQuery({
        queryKey: ['dashboard', 'recent-activities', limit],
        queryFn: () => dashboardService.getRecentActivities(limit),
        staleTime: 30 * 1000,
    });
}

export function useAttendanceSummary(month?: number, year?: number) {
    return useQuery({
        queryKey: ['dashboard', 'attendance-summary', month, year],
        queryFn: () => dashboardService.getAttendanceSummary(month, year),
        staleTime: 60 * 1000,
    });
}

export function useEmployeeStats() {
    return useQuery({
        queryKey: ['dashboard', 'employee-stats'],
        queryFn: () => dashboardService.getEmployeeStats(),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

export function usePayrollSummary(year?: number) {
    return useQuery({
        queryKey: ['dashboard', 'payroll-summary', year],
        queryFn: () => dashboardService.getPayrollSummary(year),
        staleTime: 60 * 60 * 1000, // 1 hour
    });
}
