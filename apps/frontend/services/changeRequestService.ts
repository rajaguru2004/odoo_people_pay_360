import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type { ReviewPayload } from '@/types/common';
import type {
  CreateChangeRequestPayload,
  DepartmentChangeRequest,
} from '@/types/department';

export interface ChangeRequestListQuery {
  page?: number;
  limit?: number;
  status?: DepartmentChangeRequest['status'];
  departmentId?: string;
}

class ChangeRequestService {
  list(
    query: ChangeRequestListQuery = {},
  ): Promise<ApiResponse<DepartmentChangeRequest[]>> {
    return axiosInstance.get('/departments/change-requests', { params: query });
  }

  get(id: string): Promise<ApiResponse<DepartmentChangeRequest>> {
    return axiosInstance.get(`/departments/change-requests/${id}`);
  }

  create(
    payload: CreateChangeRequestPayload,
  ): Promise<ApiResponse<DepartmentChangeRequest>> {
    return axiosInstance.post('/departments/change-requests', payload);
  }

  /** APPROVE applies the change to the department; REJECT only stamps the request. */
  review(
    id: string,
    payload: ReviewPayload,
  ): Promise<ApiResponse<DepartmentChangeRequest>> {
    return axiosInstance.patch(
      `/departments/change-requests/${id}/review`,
      payload,
    );
  }

  cancel(id: string): Promise<ApiResponse<DepartmentChangeRequest>> {
    return axiosInstance.patch(`/departments/change-requests/${id}/cancel`);
  }
}

export default new ChangeRequestService();
