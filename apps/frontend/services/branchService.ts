import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { Branch, CreateBranchData, UpdateBranchData } from '@/types/branch';

class BranchService {
  // `includeInactive` is the only way to reach a retired branch: it is filtered
  // out of this list and `getById` 404s on it, so without the flag a branch
  // deactivated by mistake cannot be found again. Server-side it is honoured
  // for ADMIN/HR_MANAGER only.
  async getAll(includeInactive = false): Promise<ApiResponse<Branch[]>> {
    return axiosInstance.get('/branches', {
      params: includeInactive ? { includeInactive: 'true' } : undefined,
    });
  }

  async getById(id: string): Promise<ApiResponse<Branch>> {
    return axiosInstance.get(`/branches/${id}`);
  }

  async create(data: CreateBranchData): Promise<ApiResponse<Branch>> {
    return axiosInstance.post('/branches', data);
  }

  async update(id: string, data: UpdateBranchData): Promise<ApiResponse<Branch>> {
    return axiosInstance.patch(`/branches/${id}`, data);
  }

  async delete(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/branches/${id}`);
  }
}

export default new BranchService();
