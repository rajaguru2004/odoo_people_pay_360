import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type { ReviewPayload } from '@/types/common';
import type {
  Contract,
  ContractListQuery,
  CreateContractPayload,
  CreateTerminationPayload,
  TerminationRequest,
  UpdateContractPayload,
} from '@/types/contract';
import type { RequestStatus } from '@/types/common';

class ContractService {
  list(query: ContractListQuery = {}): Promise<ApiResponse<Contract[]>> {
    return axiosInstance.get('/contracts', { params: query });
  }

  /** Rows carry a computed `daysUntilExpiry`, negative once the term has lapsed. */
  expiring(days = 30): Promise<ApiResponse<Contract[]>> {
    return axiosInstance.get('/contracts/expiring', { params: { days } });
  }

  get(id: string): Promise<ApiResponse<Contract>> {
    return axiosInstance.get(`/contracts/${id}`);
  }

  create(payload: CreateContractPayload): Promise<ApiResponse<Contract>> {
    return axiosInstance.post('/contracts', payload);
  }

  update(
    id: string,
    payload: UpdateContractPayload,
  ): Promise<ApiResponse<Contract>> {
    return axiosInstance.patch(`/contracts/${id}`, payload);
  }

  /** Marks the current contract RENEWED and creates its successor, atomically. */
  renew(
    id: string,
    payload: CreateContractPayload,
  ): Promise<ApiResponse<Contract>> {
    return axiosInstance.post(`/contracts/${id}/renew`, payload);
  }

  // ── Terminations ──────────────────────────────────────────────────────────

  listTerminations(
    query: { page?: number; limit?: number; status?: RequestStatus } = {},
  ): Promise<ApiResponse<TerminationRequest[]>> {
    return axiosInstance.get('/contracts/terminations', { params: query });
  }

  createTermination(
    payload: CreateTerminationPayload,
  ): Promise<ApiResponse<TerminationRequest>> {
    return axiosInstance.post('/contracts/terminations', payload);
  }

  /**
   * Approving is the only place employment actually ends: the contract and the
   * employee record change together, and neither moves while the request is
   * merely pending.
   */
  reviewTermination(
    id: string,
    payload: ReviewPayload,
  ): Promise<ApiResponse<TerminationRequest>> {
    return axiosInstance.patch(`/contracts/terminations/${id}/review`, payload);
  }
}

export default new ContractService();
