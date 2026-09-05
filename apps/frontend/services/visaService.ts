import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  CreateLegalDocumentPayload,
  LegalDocument,
  LegalDocumentListQuery,
  LegalDocumentSummary,
  RenewLegalDocumentPayload,
  UpdateLegalDocumentPayload,
} from '@/types/legalDocument';

/**
 * Work permits and government identifiers.
 *
 * Named for the screen rather than the table: the Visa Reports page is the only
 * consumer, and every default here is `category: VISA`. The endpoint underneath
 * is generic because a labour card and a passport expire the same way.
 */
class VisaService {
  list(
    query: LegalDocumentListQuery = {},
  ): Promise<ApiResponse<LegalDocument[]>> {
    return axiosInstance.get('/legal-documents', {
      params: { category: 'VISA', ...query },
    });
  }

  summary(): Promise<ApiResponse<LegalDocumentSummary>> {
    return axiosInstance.get('/legal-documents/summary');
  }

  expiring(days = 30): Promise<ApiResponse<LegalDocument[]>> {
    return axiosInstance.get('/legal-documents/expiring', { params: { days } });
  }

  get(id: string): Promise<ApiResponse<LegalDocument>> {
    return axiosInstance.get(`/legal-documents/${id}`);
  }

  create(
    payload: CreateLegalDocumentPayload,
  ): Promise<ApiResponse<LegalDocument>> {
    return axiosInstance.post('/legal-documents', payload);
  }

  update(
    id: string,
    payload: UpdateLegalDocumentPayload,
  ): Promise<ApiResponse<LegalDocument>> {
    return axiosInstance.patch(`/legal-documents/${id}`, payload);
  }

  /** Creates a successor pointing back at this one; history is never overwritten. */
  renew(
    id: string,
    payload: RenewLegalDocumentPayload,
  ): Promise<ApiResponse<LegalDocument>> {
    return axiosInstance.post(`/legal-documents/${id}/renew`, payload);
  }

  cancel(id: string): Promise<ApiResponse<LegalDocument>> {
    return axiosInstance.patch(`/legal-documents/${id}/cancel`);
  }
}

export default new VisaService();
