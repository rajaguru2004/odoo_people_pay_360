import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  LetterRequest,
  LetterTemplate,
  RequestLetterData,
} from '@/types/letter';

/**
 * `warning` is a SIBLING of `data`, not a field in it.
 *
 * Issuing a letter for somebody who has left is allowed and is stated rather
 * than refused, and the interceptor passes a handler-built envelope through
 * untouched — so the warning survives the unwrap exactly where the server put
 * it. Typed here because the only mistake available is reading it off `.data`.
 */
export interface LetterDecisionResult extends ApiResponse<LetterRequest> {
  warning?: string;
}

class LetterService {
  listTemplates(activeOnly = true): Promise<ApiResponse<LetterTemplate[]>> {
    return axiosInstance.get('/letters/templates', { params: { activeOnly } });
  }

  myRequests(): Promise<ApiResponse<LetterRequest[]>> {
    return axiosInstance.get('/letters/my-requests');
  }

  list(status?: string): Promise<ApiResponse<LetterRequest[]>> {
    return axiosInstance.get('/letters', { params: status ? { status } : {} });
  }

  /** A template flagged `requiresApproval: false` comes back already ISSUED. */
  request(payload: RequestLetterData): Promise<ApiResponse<LetterRequest>> {
    return axiosInstance.post('/letters', payload);
  }

  issue(id: string): Promise<LetterDecisionResult> {
    return axiosInstance.post(`/letters/${id}/issue`, {});
  }

  reject(id: string, reason: string): Promise<LetterDecisionResult> {
    return axiosInstance.post(`/letters/${id}/reject`, { reason });
  }
}

export default new LetterService();
