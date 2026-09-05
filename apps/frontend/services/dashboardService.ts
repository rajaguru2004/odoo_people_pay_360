import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
// Aliased: this module already exports its own `DashboardOverview` — the eight
// counters the legacy widgets read — and the analytics page's payload is a
// different contract that happens to share the noun.
import type {
  DashboardOverview as AnalyticsOverview,
  DashboardOverviewQuery,
} from '@/types/dashboardOverview';

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

  /**
   * The analytics dashboard's single aggregate.
   *
   * Deliberately NOT `/dashboard/overview`. That route already exists and
   * answers main's shape — the eight counters above, which the widgets on the
   * old dashboard read. The analytics page wants an entirely different payload
   * (`types/dashboardOverview.ts`), and pointing both at one URL would have the
   * server guess which caller it was talking to.
   *
   * One method, one request: the server decides per caller which blocks come
   * back, so the entitlement decision is taken ONCE for the whole page rather
   * than in five places, and the reader never gets panels that half-loaded and
   * half-403'd with nothing on screen saying which was which. The response's
   * `sections` array is the contract for what actually arrived; consumers read
   * that, never a truthy figure.
   *
   * NOTE: the backend route is not built yet — see docs/payroll-dashboard-walkthrough.md.
   * Until it is, this 404s and the page shows its error state, which is the
   * honest outcome: better an empty panel than main's payload rendered as if it
   * were this one.
   */
  async overview(
    query: DashboardOverviewQuery = {},
  ): Promise<ApiResponse<AnalyticsOverview>> {
    return axiosInstance.get('/dashboard/analytics-overview', { params: query });
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
