import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { LeaveRequest, CreateLeaveRequestData, LeaveBalance } from '@/types/leave';
import type { HubPeriod, LeaveHubSummary } from '@/types/leaveHub';

interface QueryLeaveParams {
  status?: string;
  employeeId?: string;
  leaveType?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

class LeaveService {
  // Leave Requests
  async getAll(params?: QueryLeaveParams): Promise<ApiResponse<LeaveRequest[]>> {
    return axiosInstance.get('/leave-requests', { params });
  }

  async getById(id: string): Promise<ApiResponse<LeaveRequest>> {
    return axiosInstance.get(`/leave-requests/${id}`);
  }

  async getMyRequests(params?: any): Promise<ApiResponse<LeaveRequest[]>> {
    return axiosInstance.get('/leave-requests/my-requests', { params });
  }

  async getPending(): Promise<ApiResponse<LeaveRequest[]>> {
    return axiosInstance.get('/leave-requests/pending');
  }

  async getTeamBalances(): Promise<ApiResponse<any[]>> {
    return axiosInstance.get('/leave-requests/team-balances');
  }

  async getByEmployee(employeeId: string): Promise<ApiResponse<LeaveRequest[]>> {
    return axiosInstance.get(`/leave-requests/employee/${employeeId}`);
  }

  async create(data: CreateLeaveRequestData): Promise<ApiResponse<LeaveRequest>> {
    return axiosInstance.post('/leave-requests', data);
  }

  async approve(id: string, comment?: string): Promise<ApiResponse<LeaveRequest>> {
    return axiosInstance.post(`/leave-requests/${id}/approve`, { comment });
  }

  async reject(id: string, rejectedReason: string): Promise<ApiResponse<LeaveRequest>> {
    return axiosInstance.post(`/leave-requests/${id}/reject`, { rejectedReason });
  }

  async cancel(id: string): Promise<ApiResponse<LeaveRequest>> {
    return axiosInstance.delete(`/leave-requests/${id}`);
  }

  // Leave Attachments
  async getAttachments(leaveRequestId: string): Promise<ApiResponse<any[]>> {
    return axiosInstance.get(`/leave-requests/${leaveRequestId}/attachments`);
  }

  async uploadAttachment(leaveRequestId: string, file: File): Promise<ApiResponse<any>> {
    const formData = new FormData();
    formData.append('file', file);
    return axiosInstance.post(`/leave-requests/${leaveRequestId}/attachments`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  }

  async deleteAttachment(leaveRequestId: string, attachmentId: string): Promise<ApiResponse<any>> {
    return axiosInstance.delete(`/leave-requests/${leaveRequestId}/attachments/${attachmentId}`);
  }

  // Leave Balances
  async getBalance(employeeId: string, year?: number): Promise<ApiResponse<LeaveBalance>> {
    return axiosInstance.get(`/leave-balances/employee/${employeeId}`, {
      params: { year }
    });
  }

  async getCompanyOverview(year?: number): Promise<ApiResponse<any>> {
    return axiosInstance.get('/leave-balances/company-overview', { params: { year } });
  }

  async getAllBalances(year?: number): Promise<ApiResponse<LeaveBalance[]>> {
    return axiosInstance.get('/leave-balances', {
      params: { year }
    });
  }

  async initBalance(employeeId: string, year: number): Promise<ApiResponse<LeaveBalance>> {
    return axiosInstance.post(`/leave-balances/employee/${employeeId}/init/${year}`);
  }

  async updateBalance(employeeId: string, year: number, annualLeave: number, sickLeave?: number): Promise<ApiResponse<LeaveBalance>> {
    return axiosInstance.patch(`/leave-balances/employee/${employeeId}/year/${year}`, {
      annualLeave,
      sickLeave
    });
  }

  async getLeaveTypes(): Promise<ApiResponse<any[]>> {
    return axiosInstance.get('/leave-balances/leave-types');
  }

  async setBulkDefaultBalances(year: number): Promise<ApiResponse<any>> {
    return axiosInstance.post('/leave-balances/set-default-allocation', { year });
  }

  async updateTypeBalance(employeeId: string, year: number, leaveTypeKey: string, allocated: number, carriedOver?: number): Promise<ApiResponse<any>> {
    return axiosInstance.patch(`/leave-balances/${employeeId}/${year}/${leaveTypeKey}`, {
      allocated,
      carriedOver
    });
  }

  // Leave Accrual
  async runAccrual(): Promise<ApiResponse<any>> {
    return axiosInstance.post('/leave-balances/accrual/run', {}, {
      timeout: 120000 // 2 minutes for long-running operation
    });
  }

  async accrueForEmployee(employeeId: string, daysToAdd: number, notes: string): Promise<ApiResponse<any>> {
    return axiosInstance.post(`/leave-balances/accrual/employee/${employeeId}`, {
      daysToAdd,
      notes
    });
  }

  async getAccrualHistory(employeeId?: string, year?: number, month?: number): Promise<ApiResponse<any[]>> {
    return axiosInstance.get('/leave-balances/accrual/history', {
      params: { employeeId, year, month }
    });
  }

  /**
   * Everything the Leave & Overtime module hub draws, in one request.
   *
   * Replaces the three the hub used to fan out to (`/dashboard/overview`,
   * `/leave-balances/company-overview`, `/overtime/report/:m/:y`), none of which
   * could be moved by a period selector: the first is unwindowed, the second is
   * year-only and the third month-only.
   *
   * `anchor` is any date inside the window being viewed; omit it for the
   * current one, and page with the `prevAnchor`/`nextAnchor` the response
   * returns rather than doing calendar arithmetic here.
   */
  async getHubSummary(
    period: HubPeriod,
    anchor?: string,
  ): Promise<ApiResponse<LeaveHubSummary>> {
    return axiosInstance.get('/leave-requests/hub-summary', {
      params: { period, anchor },
    });
  }
}

export default new LeaveService();
