import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';

export interface DashboardOverview {
  totalEmployees: number;
  activeEmployees: number;
  onLeaveEmployees: number;
  newEmployeesThisMonth: number;
  attendanceRate: number;
  pendingLeaveRequests: number;
  pendingOvertimeRequests: number;
  expiringContracts: number;
}

export interface DashboardAlert {
  id: string;
  type: 'CONTRACT_EXPIRING' | 'LEAVE_PENDING' | 'OVERTIME_PENDING' | 'LATE_ATTENDANCE';
  title: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  link?: string;
  createdAt: string;
}

export interface AlertsData {
  expiringContracts: any[];
  pendingLeaveRequests: any[];
  frequentLateEmployees: any[];
}

export interface RecentActivity {
  id: string;
  type: string;
  description: string;
  user: string;
  timestamp: string;
}

export type AlertSeverity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface ContractAlert {
  contractId: string;
  employeeName: string;
  employeeCode: string;
  contractNumber: string | null;
  contractType: string;
  expirationDate: string;
  daysRemaining: number;
  severity: AlertSeverity;
}

export interface ContractAlertsResponse {
  total: number;
  bySeverity: Record<AlertSeverity, number>;
  alerts: ContractAlert[];
}

class DashboardService {
  async getOverview(date?: string): Promise<ApiResponse<any>> {
    return axiosInstance.get('/dashboard/overview', { params: { date } });
  }

  async getAlerts(): Promise<ApiResponse<AlertsData>> {
    return axiosInstance.get('/dashboard/alerts');
  }

  async getContractAlerts(days: number = 60): Promise<ApiResponse<ContractAlertsResponse>> {
    return axiosInstance.get('/dashboard/contract-alerts', { params: { days } });
  }

  async getExpiringContracts(days: number = 60): Promise<ApiResponse<ContractAlert[]>> {
    return axiosInstance.get('/dashboard/contract-alerts/expiring', { params: { days } });
  }

  async getRecentActivities(limit: number = 10): Promise<ApiResponse<RecentActivity[]>> {
    return axiosInstance.get('/dashboard/activities', { params: { limit } });
  }

  async getAttendanceSummary(month?: number, year?: number): Promise<ApiResponse<any>> {
    return axiosInstance.get('/dashboard/attendance-summary', { params: { month, year } });
  }

  async getEmployeeStats(): Promise<ApiResponse<any>> {
    return axiosInstance.get('/dashboard/employee-stats');
  }

  async getPayrollSummary(year?: number): Promise<ApiResponse<any>> {
    return axiosInstance.get('/dashboard/payroll-summary', { params: { year } });
  }

  async getTurnoverStats(months: number = 6): Promise<ApiResponse<any>> {
    return axiosInstance.get('/dashboard/turnover-stats', { params: { months } });
  }
}

export default new DashboardService();
