import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { Department } from '@/types/department';

class DepartmentService {
  list(branchId?: string): Promise<ApiResponse<Department[]>> {
    return axiosInstance.get('/departments', { params: branchId ? { branchId } : undefined });
  }

  get(id: string): Promise<ApiResponse<Department>> {
    return axiosInstance.get(`/departments/${id}`);
  }

  create(payload: { code: string; name: string; branchId?: string; managerId?: string }): Promise<ApiResponse<Department>> {
    return axiosInstance.post('/departments', payload);
  }

  update(id: string, payload: Partial<{ code: string; name: string; branchId: string; managerId: string }>): Promise<ApiResponse<Department>> {
    return axiosInstance.patch(`/departments/${id}`, payload);
  }

  remove(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return axiosInstance.delete(`/departments/${id}`);
  }
}

export default new DepartmentService();
