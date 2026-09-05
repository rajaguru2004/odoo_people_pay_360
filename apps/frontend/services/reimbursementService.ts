import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import {
  Reimbursement,
  ReimbursementAttachment,
  CreateReimbursementData,
} from '@/types/reimbursement';

interface QueryReimbursementParams {
  status?: string;
  employeeId?: string;
}

class ReimbursementService {
  async getAll(
    params?: QueryReimbursementParams,
  ): Promise<ApiResponse<Reimbursement[]>> {
    return axiosInstance.get('/reimbursements', { params });
  }

  async getPending(): Promise<ApiResponse<Reimbursement[]>> {
    return axiosInstance.get('/reimbursements/pending');
  }

  async getMyRequests(): Promise<ApiResponse<Reimbursement[]>> {
    return axiosInstance.get('/reimbursements/my-requests');
  }

  async getById(id: string): Promise<ApiResponse<Reimbursement>> {
    return axiosInstance.get(`/reimbursements/${id}`);
  }

  async create(
    data: CreateReimbursementData,
  ): Promise<ApiResponse<Reimbursement>> {
    return axiosInstance.post('/reimbursements', data);
  }

  async approve(
    id: string,
    remarks?: string,
  ): Promise<ApiResponse<Reimbursement>> {
    return axiosInstance.post(`/reimbursements/${id}/approve`, { remarks });
  }

  async reject(
    id: string,
    remarks: string,
  ): Promise<ApiResponse<Reimbursement>> {
    return axiosInstance.post(`/reimbursements/${id}/reject`, { remarks });
  }

  async cancel(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/reimbursements/${id}`);
  }

  async getAttachments(
    id: string,
  ): Promise<ApiResponse<ReimbursementAttachment[]>> {
    return axiosInstance.get(`/reimbursements/${id}/attachments`);
  }

  async uploadAttachment(
    id: string,
    file: File,
  ): Promise<ApiResponse<ReimbursementAttachment>> {
    const formData = new FormData();
    formData.append('file', file);
    return axiosInstance.post(`/reimbursements/${id}/attachments`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  }

  async deleteAttachment(
    id: string,
    attachmentId: string,
  ): Promise<ApiResponse<void>> {
    return axiosInstance.delete(
      `/reimbursements/${id}/attachments/${attachmentId}`,
    );
  }
}

export default new ReimbursementService();
