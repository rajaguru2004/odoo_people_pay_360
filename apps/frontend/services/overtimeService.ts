import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import {
  Overtime,
  CreateOvertimeData,
  RejectOvertimeData,
  OvertimeReport,
  ApproveOvertimeData,
  OvertimeServerPreview,
} from '@/types/overtime';

interface QueryOvertimeParams {
  status?: string;
  employeeId?: string;
  month?: number;
  year?: number;
  page?: number;
  limit?: number;
  search?: string;
  startDate?: string;
  endDate?: string;
  otType?: string;
}

class OvertimeService {
  async getAll(params?: QueryOvertimeParams): Promise<ApiResponse<Overtime[]>> {
    return axiosInstance.get('/overtime', { params });
  }

  async getById(id: string): Promise<ApiResponse<Overtime>> {
    return axiosInstance.get(`/overtime/${id}`);
  }

  async getMyRequests(params?: QueryOvertimeParams): Promise<ApiResponse<Overtime[]>> {
    return axiosInstance.get('/overtime/my-requests', { params });
  }

  async getPending(): Promise<ApiResponse<Overtime[]>> {
    return axiosInstance.get('/overtime/pending');
  }

  async getByEmployee(employeeId: string): Promise<ApiResponse<Overtime[]>> {
    return axiosInstance.get(`/overtime/employee/${employeeId}`);
  }

  async create(data: CreateOvertimeData): Promise<ApiResponse<Overtime>> {
    return axiosInstance.post('/overtime', data);
  }

  async createForEmployee(employeeId: string, data: CreateOvertimeData): Promise<ApiResponse<Overtime>> {
    return axiosInstance.post(`/overtime/employee/${employeeId}`, data);
  }

  /**
   * `data` carries an approver's corrections. Omitted entirely, this is the
   * plain "approve as filed" the inbox's fast path sends.
   */
  async approve(
    id: string,
    data?: ApproveOvertimeData,
  ): Promise<ApiResponse<Overtime>> {
    return axiosInstance.post(`/overtime/${id}/approve`, data);
  }

  /**
   * Dry run: what those corrections WOULD produce. Writes nothing.
   *
   * Server-side rather than a local recompute because the browser can only see
   * the global settings — not the employee's Overtime Policy, and not the
   * branch-aware rest-day/holiday classification. Reproducing the split here
   * would show an approver a figure the payslip then disagrees with.
   */
  async editPreview(
    id: string,
    data: ApproveOvertimeData,
  ): Promise<ApiResponse<OvertimeServerPreview>> {
    return axiosInstance.post(`/overtime/${id}/edit-preview`, data);
  }

  async reject(id: string, data: RejectOvertimeData): Promise<ApiResponse<Overtime>> {
    return axiosInstance.post(`/overtime/${id}/reject`, data);
  }

  async cancel(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/overtime/${id}`);
  }

  async getApprovedHours(employeeId: string, month: number, year: number): Promise<ApiResponse<{ totalHours: number }>> {
    return axiosInstance.get(`/overtime/employee/${employeeId}/hours/${month}/${year}`);
  }

  async getMonthlyReport(month: number, year: number): Promise<ApiResponse<OvertimeReport>> {
    return axiosInstance.get(`/overtime/report/${month}/${year}`);
  }
}

export default new OvertimeService();
