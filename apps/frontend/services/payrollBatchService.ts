import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { PayrollBatch, CreateBatchData, UpdateBatchData } from '@/types/payrollBatch';

class PayrollBatchService {
  async getAll(): Promise<ApiResponse<PayrollBatch[]>> {
    return axiosInstance.get('/payroll-batches');
  }

  async getById(id: string): Promise<ApiResponse<PayrollBatch>> {
    return axiosInstance.get(`/payroll-batches/${id}`);
  }

  async create(data: CreateBatchData): Promise<ApiResponse<PayrollBatch>> {
    return axiosInstance.post('/payroll-batches', data);
  }

  async update(id: string, data: UpdateBatchData): Promise<ApiResponse<PayrollBatch>> {
    return axiosInstance.patch(`/payroll-batches/${id}`, data);
  }

  async delete(id: string): Promise<ApiResponse<any>> {
    return axiosInstance.delete(`/payroll-batches/${id}`);
  }

  async addMembers(id: string, employeeIds: string[]): Promise<ApiResponse<PayrollBatch>> {
    return axiosInstance.post(`/payroll-batches/${id}/members`, { employeeIds });
  }

  async removeMember(id: string, employeeId: string): Promise<ApiResponse<PayrollBatch>> {
    return axiosInstance.delete(`/payroll-batches/${id}/members/${employeeId}`);
  }
}

export default new PayrollBatchService();
