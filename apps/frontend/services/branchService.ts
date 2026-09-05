import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  Branch,
  CreateBranchPayload,
  UpdateBranchPayload,
} from '@/types/branch';

class BranchService {
  list(includeInactive = false): Promise<ApiResponse<Branch[]>> {
    return axiosInstance.get('/branches', {
      params: includeInactive ? { includeInactive: true } : undefined,
    });
  }

  get(id: string): Promise<ApiResponse<Branch>> {
    return axiosInstance.get(`/branches/${id}`);
  }

  create(payload: CreateBranchPayload): Promise<ApiResponse<Branch>> {
    return axiosInstance.post('/branches', payload);
  }

  update(id: string, payload: UpdateBranchPayload): Promise<ApiResponse<Branch>> {
    return axiosInstance.patch(`/branches/${id}`, payload);
  }

  /** Deactivates instead when attendance history still references the branch. */
  remove(
    id: string,
  ): Promise<ApiResponse<{ deleted: boolean; deactivated: boolean }>> {
    return axiosInstance.delete(`/branches/${id}`);
  }
}

export default new BranchService();
