import axiosInstance from '@/lib/axios';
import type { ApiResponse } from '@/types/api';
import type {
  ApprovedOvertimeHours,
  ApproveOvertimePayload,
  CreateOvertimePayload,
  OvertimeListQuery,
  OvertimeMonthlyReport,
  OvertimePreview,
  OvertimeRequest,
  OvertimeStats,
} from '@/types/overtime';

class OvertimeService {
  list(query: OvertimeListQuery = {}): Promise<ApiResponse<OvertimeRequest[]>> {
    return axiosInstance.get('/overtime', { params: query });
  }

  /**
   * The caller's own overtime.
   *
   * A separate door from `list`: the workforce list answers by name and by pay,
   * which is a management view, while an employee's own record is theirs.
   */
  mine(query: OvertimeListQuery = {}): Promise<ApiResponse<OvertimeRequest[]>> {
    return axiosInstance.get('/overtime/my-requests', { params: query });
  }

  pending(query: OvertimeListQuery = {}): Promise<ApiResponse<OvertimeRequest[]>> {
    return axiosInstance.get('/overtime/pending', { params: query });
  }

  stats(): Promise<ApiResponse<OvertimeStats>> {
    return axiosInstance.get('/overtime/stats');
  }

  /** Carries the server's live payable breakdown in `preview`. */
  get(id: string): Promise<ApiResponse<OvertimeRequest>> {
    return axiosInstance.get(`/overtime/${id}`);
  }

  forEmployee(
    employeeId: string,
    query: OvertimeListQuery = {},
  ): Promise<ApiResponse<OvertimeRequest[]>> {
    return axiosInstance.get(`/overtime/employee/${employeeId}`, {
      params: query,
    });
  }

  create(payload: CreateOvertimePayload): Promise<ApiResponse<OvertimeRequest>> {
    return axiosInstance.post('/overtime', payload);
  }

  /** Recording it for somebody else is an HR privilege: the hours become pay. */
  createForEmployee(
    employeeId: string,
    payload: CreateOvertimePayload,
  ): Promise<ApiResponse<OvertimeRequest>> {
    return axiosInstance.post(`/overtime/employee/${employeeId}`, payload);
  }

  /**
   * Approve, optionally with corrections.
   *
   * A bodyless call means "approve exactly as filed". Any field present makes it
   * an edit, which is written BEFORE the decision so the approval prices the
   * corrected window.
   */
  approve(
    id: string,
    payload?: ApproveOvertimePayload,
  ): Promise<ApiResponse<OvertimeRequest>> {
    return axiosInstance.post(`/overtime/${id}/approve`, payload ?? {});
  }

  /**
   * Dry-run a correction. Writes nothing.
   *
   * The browser cannot answer this itself: the figure depends on the employee's
   * policy and on the branch calendar. An approver about to change the money has
   * to see the real number before they commit to it.
   */
  previewEdit(
    id: string,
    payload: ApproveOvertimePayload,
  ): Promise<ApiResponse<OvertimePreview>> {
    return axiosInstance.post(`/overtime/${id}/edit-preview`, payload);
  }

  reject(
    id: string,
    rejectedReason: string,
  ): Promise<ApiResponse<OvertimeRequest>> {
    return axiosInstance.post(`/overtime/${id}/reject`, { rejectedReason });
  }

  cancel(id: string): Promise<ApiResponse<OvertimeRequest>> {
    return axiosInstance.delete(`/overtime/${id}`);
  }

  report(
    year: number,
    month: number,
  ): Promise<ApiResponse<OvertimeMonthlyReport>> {
    return axiosInstance.get(`/overtime/report/${year}/${month}`);
  }

  /** The four payable buckets for one employee-month — what payroll reads. */
  approvedHours(
    employeeId: string,
    year: number,
    month: number,
  ): Promise<ApiResponse<ApprovedOvertimeHours>> {
    return axiosInstance.get(
      `/overtime/employee/${employeeId}/hours/${year}/${month}`,
    );
  }
}

export default new OvertimeService();
