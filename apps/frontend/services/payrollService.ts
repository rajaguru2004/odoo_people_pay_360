import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { Payroll, CreatePayrollData, UpdatePayrollItemData, Payslip } from '@/types/payroll';

interface QueryPayrollParams {
  year?: number;
  status?: string;
}

class PayrollService {
  async getAll(params?: QueryPayrollParams): Promise<ApiResponse<Payroll[]>> {
    return axiosInstance.get('/payrolls', { params });
  }

  async getById(id: string): Promise<ApiResponse<Payroll>> {
    return axiosInstance.get(`/payrolls/${id}`);
  }

  async create(data: CreatePayrollData): Promise<ApiResponse<Payroll>> {
    return axiosInstance.post('/payrolls', data, {
      timeout: 180000 // 3 minutes for payroll creation
    });
  }

  async updateItem(payrollId: string, itemId: string, data: UpdatePayrollItemData): Promise<ApiResponse<any>> {
    return axiosInstance.patch(`/payrolls/${payrollId}/items/${itemId}`, data);
  }

  /**
   * @deprecated Use `submit` -> (approve) -> `lock`. The backend now routes
   * `/finalize` to the same code path as `/lock`, so it requires an APPROVED
   * payroll and no longer locks a DRAFT one. Kept only so an older client build
   * does not 404.
   */
  async finalize(id: string): Promise<ApiResponse<Payroll>> {
    return axiosInstance.post(`/payrolls/${id}/finalize`);
  }

  async getPayslip(employeeId: string, month: number, year: number): Promise<ApiResponse<Payslip>> {
    return axiosInstance.get(`/payrolls/payslip/${employeeId}/${month}/${year}`);
  }

  // Employee Payslip Methods
  async getMyPayslips(): Promise<ApiResponse<any[]>> {
    return axiosInstance.get('/payrolls/my-payslips/list');
  }

  async getMyPayslipDetail(itemId: string): Promise<ApiResponse<any>> {
    return axiosInstance.get(`/payrolls/my-payslips/${itemId}`);
  }

  async getYTDSummary(year?: number): Promise<ApiResponse<any>> {
    return axiosInstance.get('/payrolls/my-ytd-summary', {
      params: year ? { year } : {}
    });
  }

  // Workflow methods
  async submit(id: string): Promise<ApiResponse<Payroll>> {
    return axiosInstance.post(`/payrolls/${id}/submit`);
  }

  async approve(id: string, data: { notes?: string }): Promise<ApiResponse<Payroll>> {
    return axiosInstance.post(`/payrolls/${id}/approve`, data);
  }

  async reject(id: string, data: { reason: string }): Promise<ApiResponse<Payroll>> {
    return axiosInstance.post(`/payrolls/${id}/reject`, data);
  }

  async lock(id: string): Promise<ApiResponse<Payroll>> {
    return axiosInstance.post(`/payrolls/${id}/lock`);
  }

  /**
   * New version of a LOCKED payroll: a fresh DRAFT at version+1 that copies the
   * item amounts but no ledger rows, so it can never double-pay.
   *
   * This is the ONLY way forward for a run that reached LOCKED without approval —
   * submit, approve and lock all reject a LOCKED payroll, so such a run is
   * otherwise stuck and can never be paid out.
   */
  async createRevision(id: string, reason: string): Promise<ApiResponse<Payroll>> {
    return axiosInstance.post(`/payrolls/${id}/create-revision`, { reason });
  }

  async getHistory(id: string): Promise<ApiResponse<any>> {
    return axiosInstance.get(`/payrolls/${id}/history`);
  }

  async delete(id: string): Promise<ApiResponse<any>> {
    return axiosInstance.delete(`/payrolls/${id}`);
  }
}

export default new PayrollService();
