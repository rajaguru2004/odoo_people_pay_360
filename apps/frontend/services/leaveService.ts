import axiosInstance from '@/lib/axios';
import type { ApiResponse } from '@/types/api';
import type {
  CompanyLeaveOverview,
  CreateLeavePayload,
  EmployeeLeaveBalanceRow,
  LeaveAccrualRecord,
  LeaveBalance,
  LeaveDecisionResult,
  LeaveListQuery,
  LeaveRequest,
  LeaveStats,
  LeaveType,
  TeamBalanceRow,
} from '@/types/leave';
import type { HubPeriod, LeaveHubSummary } from '@/types/leaveHub';

/**
 * Leave: the requests, the entitlements behind them, and the module hub.
 *
 * One class rather than three because the screens read across all of them — the
 * request form checks a balance, the balances screen counts pending requests —
 * and a caller should not have to know which controller owns which door.
 */
class LeaveService {
  // ── Requests ──────────────────────────────────────────────────────────────

  list(query: LeaveListQuery = {}): Promise<ApiResponse<LeaveRequest[]>> {
    return axiosInstance.get('/leave-requests', { params: query });
  }

  /**
   * The caller's own leave.
   *
   * A separate door from `list`, not a filtered one: the list answers BY NAME
   * and is refused to an employee, while their own history is a question every
   * employee is entitled to ask.
   */
  mine(query: LeaveListQuery = {}): Promise<ApiResponse<LeaveRequest[]>> {
    return axiosInstance.get('/leave-requests/my-requests', { params: query });
  }

  pending(query: LeaveListQuery = {}): Promise<ApiResponse<LeaveRequest[]>> {
    return axiosInstance.get('/leave-requests/pending', { params: query });
  }

  stats(): Promise<ApiResponse<LeaveStats>> {
    return axiosInstance.get('/leave-requests/stats');
  }

  get(id: string): Promise<ApiResponse<LeaveRequest>> {
    return axiosInstance.get(`/leave-requests/${id}`);
  }

  forEmployee(
    employeeId: string,
    query: LeaveListQuery = {},
  ): Promise<ApiResponse<LeaveRequest[]>> {
    return axiosInstance.get(`/leave-requests/employee/${employeeId}`, {
      params: query,
    });
  }

  create(payload: CreateLeavePayload): Promise<ApiResponse<LeaveRequest>> {
    return axiosInstance.post('/leave-requests', payload);
  }

  /**
   * Approving deducts the balance, marks it approved and writes an ON_LEAVE
   * attendance row for every working day, in one transaction. The response's
   * `meta` reports any day that already had attendance and was left alone.
   */
  approve(id: string, comment?: string): Promise<LeaveDecisionResult> {
    return axiosInstance.post(`/leave-requests/${id}/approve`, { comment });
  }

  reject(id: string, comment: string): Promise<LeaveDecisionResult> {
    return axiosInstance.post(`/leave-requests/${id}/reject`, { comment });
  }

  cancel(id: string): Promise<LeaveDecisionResult> {
    return axiosInstance.delete(`/leave-requests/${id}`);
  }

  teamBalances(): Promise<ApiResponse<TeamBalanceRow[]>> {
    return axiosInstance.get('/leave-requests/team-balances');
  }

  // ── The hub ───────────────────────────────────────────────────────────────

  hubSummary(
    period: HubPeriod,
    anchor?: string,
  ): Promise<ApiResponse<LeaveHubSummary>> {
    return axiosInstance.get('/leave-requests/hub-summary', {
      params: { period, ...(anchor ? { anchor } : {}) },
    });
  }

  // ── Balances ──────────────────────────────────────────────────────────────

  /** The types that may be filed, with their notice periods and restrictions. */
  leaveTypes(): Promise<ApiResponse<LeaveType[]>> {
    return axiosInstance.get('/leave-balances/leave-types');
  }

  allBalances(year?: number): Promise<ApiResponse<EmployeeLeaveBalanceRow[]>> {
    return axiosInstance.get('/leave-balances', { params: { year } });
  }

  /**
   * One employee's balance.
   *
   * This LOOKS like a read and is not: the server materialises the year's rows
   * if they do not exist yet, which is why it is guarded like a write.
   */
  balance(employeeId: string, year?: number): Promise<ApiResponse<LeaveBalance>> {
    return axiosInstance.get(`/leave-balances/employee/${employeeId}`, {
      params: { year },
    });
  }

  companyOverview(year?: number): Promise<ApiResponse<CompanyLeaveOverview>> {
    return axiosInstance.get('/leave-balances/company-overview', {
      params: { year },
    });
  }

  updateBalance(
    employeeId: string,
    year: number,
    payload: { annualLeave?: number; sickLeave?: number },
  ): Promise<ApiResponse<LeaveBalance>> {
    return axiosInstance.patch(
      `/leave-balances/employee/${employeeId}/year/${year}`,
      payload,
    );
  }

  updateTypeBalance(
    employeeId: string,
    year: number,
    leaveTypeKey: string,
    payload: { allocated: number; carriedOver?: number },
  ): Promise<ApiResponse<LeaveBalance>> {
    return axiosInstance.patch(
      // Encoded: a label is free text and "Annual Leave" carries a space.
      `/leave-balances/employee/${employeeId}/year/${year}/type/${encodeURIComponent(leaveTypeKey)}`,
      payload,
    );
  }

  initBalance(
    employeeId: string,
    year: number,
  ): Promise<ApiResponse<LeaveBalance>> {
    return axiosInstance.post(
      `/leave-balances/employee/${employeeId}/init/${year}`,
    );
  }

  setDefaultAllocations(year: number): Promise<ApiResponse<null>> {
    return axiosInstance.post('/leave-balances/set-default-allocation', { year });
  }

  runAccrual(): Promise<ApiResponse<{ credited: number; skipped: number }>> {
    return axiosInstance.post('/leave-balances/accrual/run');
  }

  accrueForEmployee(
    employeeId: string,
    payload: { daysToAdd: number; notes?: string },
  ): Promise<ApiResponse<unknown>> {
    return axiosInstance.post(
      `/leave-balances/accrual/employee/${employeeId}`,
      payload,
    );
  }

  accrualHistory(params: {
    employeeId?: string;
    year?: number;
    month?: number;
  } = {}): Promise<ApiResponse<LeaveAccrualRecord[]>> {
    return axiosInstance.get('/leave-balances/accrual/history', { params });
  }
}

export default new LeaveService();
