import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import {
  LetterDecisionResult,
  LetterRequest,
  LetterTemplate,
  RequestLetterData,
} from '@/types/letter';

class LetterService {
  async listTemplates(activeOnly = true): Promise<ApiResponse<LetterTemplate[]>> {
    return axiosInstance.get('/letters/templates', { params: { activeOnly } });
  }

  async getMyRequests(): Promise<ApiResponse<LetterRequest[]>> {
    return axiosInstance.get('/letters/my-requests');
  }

  async getAll(status?: string): Promise<ApiResponse<LetterRequest[]>> {
    return axiosInstance.get('/letters', { params: status ? { status } : {} });
  }

  /** Templates flagged requiresApproval:false come back already ISSUED. */
  async request(data: RequestLetterData): Promise<ApiResponse<LetterRequest>> {
    return axiosInstance.post('/letters', data);
  }

  /**
   * Resolves with the WHOLE envelope, `warning` included.
   *
   * `lib/axios.ts` returns `response.data` from its success interceptor, so a
   * top-level `warning` survives the unwrap untouched — there is nothing to
   * lift and nothing to reshape here. It is typed rather than left implicit
   * because the only mistake available is reading it off `.data`, where it has
   * never been (R66).
   */
  async issue(id: string): Promise<LetterDecisionResult> {
    return axiosInstance.post(`/letters/${id}/issue`, {});
  }

  async reject(id: string, reason: string): Promise<LetterDecisionResult> {
    return axiosInstance.post(`/letters/${id}/reject`, { reason });
  }
}

export default new LetterService();
