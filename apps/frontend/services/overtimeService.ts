import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  ApproveOvertimeData,
  CreateOvertimeData,
  Overtime,
  OvertimeQuery,
  OvertimeReport,
  OvertimeServerPreview,
  RejectOvertimeData,
} from '@/types/overtime';

class OvertimeService {
  /**
   * The whole queue, for whoever is allowed to see past their own row.
   *
   * The server narrows the result from the principal — a manager sees their
   * department, HR and admin see everything — so widening `employeeId` here
   * grants nothing the caller did not already have.
   */
  getAll(params: OvertimeQuery = {}): Promise<ApiResponse<Overtime[]>> {
    return axiosInstance.get('/overtime', { params });
  }

  /** The detail payload, which additionally carries the live `preview` block. */
  getById(id: string): Promise<ApiResponse<Overtime>> {
    return axiosInstance.get(`/overtime/${id}`);
  }

  getMyRequests(params: OvertimeQuery = {}): Promise<ApiResponse<Overtime[]>> {
    return axiosInstance.get('/overtime/my-requests', { params });
  }

  /** Everything still awaiting a decision, for whoever may decide it. */
  getPending(): Promise<ApiResponse<Overtime[]>> {
    return axiosInstance.get('/overtime/pending');
  }

  getByEmployee(employeeId: string): Promise<ApiResponse<Overtime[]>> {
    return axiosInstance.get(`/overtime/employee/${employeeId}`);
  }

  create(data: CreateOvertimeData): Promise<ApiResponse<Overtime>> {
    return axiosInstance.post('/overtime', data);
  }

  /** HR filing on somebody else's behalf — the paper form arriving late. */
  createForEmployee(
    employeeId: string,
    data: CreateOvertimeData,
  ): Promise<ApiResponse<Overtime>> {
    return axiosInstance.post(`/overtime/employee/${employeeId}`, data);
  }

  /**
   * `data` carries an approver's corrections. Omitted entirely — which is what
   * both approval screens send — this is a plain "approve as filed".
   */
  approve(id: string, data?: ApproveOvertimeData): Promise<ApiResponse<Overtime>> {
    return axiosInstance.post(`/overtime/${id}/approve`, data);
  }

  /**
   * A dry run of an approver's corrections: what they WOULD produce. Writes
   * nothing.
   *
   * Answered by the server rather than recomputed here because the browser can
   * see neither the employee's overtime policy nor the branch-aware rest-day
   * classification. Reproducing the split locally would show an approver a
   * figure the payslip then disagrees with.
   */
  editPreview(
    id: string,
    data: ApproveOvertimeData,
  ): Promise<ApiResponse<OvertimeServerPreview>> {
    return axiosInstance.post(`/overtime/${id}/edit-preview`, data);
  }

  reject(id: string, data: RejectOvertimeData): Promise<ApiResponse<Overtime>> {
    return axiosInstance.post(`/overtime/${id}/reject`, data);
  }

  /** Withdrawal by the person who filed it. Only a PENDING row can go. */
  cancel(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/overtime/${id}`);
  }

  /** Approved hours only — a pending claim is a request, not an entitlement. */
  getApprovedHours(
    employeeId: string,
    month: number,
    year: number,
  ): Promise<ApiResponse<{ totalHours: number }>> {
    return axiosInstance.get(`/overtime/employee/${employeeId}/hours/${month}/${year}`);
  }

  getMonthlyReport(month: number, year: number): Promise<ApiResponse<OvertimeReport>> {
    return axiosInstance.get(`/overtime/report/${month}/${year}`);
  }
}

export default new OvertimeService();
