import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  ApprovalTrail,
  CompanyLeaveOverview,
  CreateLeaveRequestData,
  LeaveAttachment,
  LeaveBalance,
  LeaveRequest,
  LeaveRequestListQuery,
  LeaveTypeBalance,
  LeaveTypeOption,
  MyLeaveRequestQuery,
  TeamLeaveBalance,
} from '@/types/leave';

class LeaveService {
  // ── Requests ───────────────────────────────────────────────────────────────

  /** The whole company's requests. ADMIN, HR and a manager over their department. */
  list(query: LeaveRequestListQuery = {}): Promise<ApiResponse<LeaveRequest[]>> {
    return axiosInstance.get('/leave-requests', { params: query });
  }

  pending(): Promise<ApiResponse<LeaveRequest[]>> {
    return axiosInstance.get('/leave-requests/pending');
  }

  /**
   * The caller's own requests. Narrowed from the principal rather than from a
   * query parameter, so there is no employee id to pass and none to forge.
   */
  myRequests(query: MyLeaveRequestQuery = {}): Promise<ApiResponse<LeaveRequest[]>> {
    return axiosInstance.get('/leave-requests/my-requests', { params: query });
  }

  byEmployee(employeeId: string): Promise<ApiResponse<LeaveRequest[]>> {
    return axiosInstance.get(`/leave-requests/employee/${employeeId}`);
  }

  get(id: string): Promise<ApiResponse<LeaveRequest>> {
    return axiosInstance.get(`/leave-requests/${id}`);
  }

  create(data: CreateLeaveRequestData): Promise<ApiResponse<LeaveRequest>> {
    return axiosInstance.post('/leave-requests', data);
  }

  /**
   * Accept this step.
   *
   * The response's `status` is what says whether the REQUEST is settled: under a
   * multi-step chain an accepted step leaves the request PENDING behind it, so a
   * caller that assumes APPROVED tells the approver something that is not true
   * yet.
   */
  approve(id: string, comment?: string): Promise<ApiResponse<LeaveRequest>> {
    return axiosInstance.post(`/leave-requests/${id}/approve`, { comment });
  }

  reject(id: string, rejectedReason?: string): Promise<ApiResponse<LeaveRequest>> {
    return axiosInstance.post(`/leave-requests/${id}/reject`, { rejectedReason });
  }

  /** Withdraw a request. Only the person who raised it, and only while PENDING. */
  cancel(id: string): Promise<ApiResponse<LeaveRequest>> {
    return axiosInstance.delete(`/leave-requests/${id}`);
  }

  /** Remaining days for everyone in the calling manager's department. */
  teamBalances(): Promise<ApiResponse<TeamLeaveBalance[]>> {
    return axiosInstance.get('/leave-requests/team-balances');
  }

  /**
   * The approval chain over one leave request, plus whether the caller may act
   * on the live step.
   *
   * Read for `canAct`: a configured step routes to a supervisor or a department
   * manager, so no role check on the client can stand in for it.
   */
  approvalTrail(id: string): Promise<ApiResponse<ApprovalTrail>> {
    return axiosInstance.get(`/approval-workflows/trail/LEAVE/${id}`);
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  attachments(leaveRequestId: string): Promise<ApiResponse<LeaveAttachment[]>> {
    return axiosInstance.get(`/leave-requests/${leaveRequestId}/attachments`);
  }

  /** PDF or JPG/PNG, 10MB a file — the server enforces both. */
  uploadAttachment(leaveRequestId: string, file: File): Promise<ApiResponse<LeaveAttachment>> {
    const formData = new FormData();
    formData.append('file', file);
    return axiosInstance.post(`/leave-requests/${leaveRequestId}/attachments`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  }

  deleteAttachment(
    leaveRequestId: string,
    attachmentId: string,
  ): Promise<ApiResponse<{ id: string }>> {
    return axiosInstance.delete(`/leave-requests/${leaveRequestId}/attachments/${attachmentId}`);
  }

  // ── Balances ───────────────────────────────────────────────────────────────

  balances(year?: number): Promise<ApiResponse<LeaveBalance[]>> {
    return axiosInstance.get('/leave-balances', { params: { year } });
  }

  balance(employeeId: string, year?: number): Promise<ApiResponse<LeaveBalance>> {
    return axiosInstance.get(`/leave-balances/employee/${employeeId}`, {
      params: { year },
    });
  }

  initBalance(employeeId: string, year: number): Promise<ApiResponse<LeaveBalance>> {
    return axiosInstance.post(`/leave-balances/employee/${employeeId}/init/${year}`);
  }

  /** The two statutory buckets. Per-type allocations go through `updateTypeBalance`. */
  updateBalance(
    employeeId: string,
    year: number,
    annualLeave: number,
    sickLeave?: number,
  ): Promise<ApiResponse<LeaveBalance>> {
    return axiosInstance.patch(`/leave-balances/employee/${employeeId}/year/${year}`, {
      annualLeave,
      sickLeave,
    });
  }

  companyOverview(year?: number): Promise<ApiResponse<CompanyLeaveOverview>> {
    return axiosInstance.get('/leave-balances/company-overview', { params: { year } });
  }

  /** The configured leave types, active ones only. */
  leaveTypes(): Promise<ApiResponse<LeaveTypeOption[]>> {
    return axiosInstance.get('/leave-balances/leave-types');
  }

  /** Rewrite every employee's allocations for a year from the library defaults. */
  setDefaultAllocation(year: number): Promise<ApiResponse<{ updated: number }>> {
    return axiosInstance.post('/leave-balances/set-default-allocation', { year });
  }

  updateTypeBalance(
    employeeId: string,
    year: number,
    leaveTypeKey: string,
    allocated: number,
    carriedOver?: number,
  ): Promise<ApiResponse<LeaveTypeBalance>> {
    return axiosInstance.patch(`/leave-balances/${employeeId}/${year}/${leaveTypeKey}`, {
      allocated,
      carriedOver,
    });
  }
}

export default new LeaveService();
