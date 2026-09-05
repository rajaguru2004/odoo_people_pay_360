import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  CreateDepartmentPayload,
  Department,
  DepartmentNode,
  DepartmentStatistics,
  UpdateDepartmentPayload,
} from '@/types/department';

class DepartmentService {
  list(
    params: { branchId?: string; includeInactive?: boolean } = {},
  ): Promise<ApiResponse<Department[]>> {
    return axiosInstance.get('/departments', { params });
  }

  get(id: string): Promise<ApiResponse<Department>> {
    return axiosInstance.get(`/departments/${id}`);
  }

  /** The whole hierarchy, already linked — the org chart does no assembly. */
  tree(branchId?: string): Promise<ApiResponse<DepartmentNode[]>> {
    return axiosInstance.get('/departments/tree', {
      params: branchId ? { branchId } : undefined,
    });
  }

  statistics(): Promise<ApiResponse<DepartmentStatistics>> {
    return axiosInstance.get('/departments/statistics');
  }

  create(payload: CreateDepartmentPayload): Promise<ApiResponse<Department>> {
    return axiosInstance.post('/departments', payload);
  }

  update(
    id: string,
    payload: UpdateDepartmentPayload,
  ): Promise<ApiResponse<Department>> {
    return axiosInstance.patch(`/departments/${id}`, payload);
  }

  remove(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return axiosInstance.delete(`/departments/${id}`);
  }
}

export default new DepartmentService();
