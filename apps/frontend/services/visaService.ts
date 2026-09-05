import api from '@/lib/axios';
import {
  VisaRecord,
  VisaSummary,
  CreateVisaPayload,
  UpdateVisaPayload,
  RenewVisaPayload,
} from '@/types/visa';

export interface VisaListParams {
  employeeId?: string;
  status?: string;
  country?: string;
  documentType?: string;
  expiringInDays?: number;
  isCurrent?: boolean;
  search?: string;
  page?: number;
  limit?: number;
}

// NOTE: axios interceptor unwraps to the backend envelope { success, data, meta }.
const visaService = {
  async getAll(params: VisaListParams = {}): Promise<{
    success: boolean;
    data: VisaRecord[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    return api.get('/legal-documents', { params });
  },

  async getExpiring(days = 30): Promise<{
    success: boolean;
    data: VisaRecord[];
    meta: { total: number; days: number };
  }> {
    return api.get('/legal-documents/expiring', { params: { days } });
  },

  async getSummary(): Promise<{ success: boolean; data: VisaSummary }> {
    return api.get('/legal-documents/summary');
  },

  async getByEmployee(
    employeeId: string,
  ): Promise<{ success: boolean; data: VisaRecord[] }> {
    return api.get(`/legal-documents/employee/${employeeId}`);
  },

  async getOne(id: string): Promise<{ success: boolean; data: VisaRecord }> {
    return api.get(`/legal-documents/${id}`);
  },

  async create(
    payload: CreateVisaPayload,
  ): Promise<{ success: boolean; data: VisaRecord; message: string }> {
    return api.post('/legal-documents', payload);
  },

  async update(
    id: string,
    payload: UpdateVisaPayload,
  ): Promise<{ success: boolean; data: VisaRecord; message: string }> {
    return api.patch(`/legal-documents/${id}`, payload);
  },

  async renew(
    id: string,
    payload: RenewVisaPayload,
  ): Promise<{ success: boolean; data: VisaRecord; message: string }> {
    return api.post(`/legal-documents/${id}/renew`, payload);
  },

  async cancel(
    id: string,
    reason?: string,
  ): Promise<{ success: boolean; data: VisaRecord; message: string }> {
    return api.post(`/legal-documents/${id}/cancel`, { reason });
  },

  async remove(id: string): Promise<{ success: boolean; message: string }> {
    return api.delete(`/legal-documents/${id}`);
  },

  async uploadAttachment(id: string, file: File) {
    const formData = new FormData();
    formData.append('file', file);
    return api.post(`/legal-documents/${id}/attachments`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  async deleteAttachment(id: string, attachmentId: string) {
    return api.delete(`/legal-documents/${id}/attachments/${attachmentId}`);
  },
};

export default visaService;
