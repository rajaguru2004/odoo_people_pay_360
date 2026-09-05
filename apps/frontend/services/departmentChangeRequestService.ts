import axios from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { 
  DepartmentChangeRequest, 
  CreateChangeRequestDto, 
  ReviewChangeRequestDto,
  ChangeRequestStatus 
} from '@/types/department-change-request';

class DepartmentChangeRequestService {
  private baseUrl = '/departments';

  /**
   * Create a change request for a department
   */
  async createChangeRequest(departmentId: string, data: CreateChangeRequestDto): Promise<ApiResponse<DepartmentChangeRequest>> {
    return axios.post(
      `${this.baseUrl}/${departmentId}/change-requests`,
      data
    );
  }

  /**
   * Get all change requests with optional filters
   */
  async getChangeRequests(filters?: { 
    status?: ChangeRequestStatus; 
    departmentId?: string;
  }): Promise<ApiResponse<DepartmentChangeRequest[]>> {
    const params = new URLSearchParams();
    if (filters?.status) params.append('status', filters.status);
    if (filters?.departmentId) params.append('departmentId', filters.departmentId);
    
    return axios.get(
      `${this.baseUrl}/change-requests?${params.toString()}`
    );
  }

  /**
   * Get a specific change request by ID
   */
  async getChangeRequest(requestId: string): Promise<ApiResponse<DepartmentChangeRequest>> {
    return axios.get(
      `${this.baseUrl}/change-requests/${requestId}`
    );
  }

  /**
   * Review (approve/reject) a change request
   */
  async reviewChangeRequest(requestId: string, data: ReviewChangeRequestDto): Promise<ApiResponse<DepartmentChangeRequest>> {
    return axios.patch(
      `${this.baseUrl}/change-requests/${requestId}/review`,
      data
    );
  }

  /**
   * Cancel a pending change request
   */
  async cancelChangeRequest(requestId: string): Promise<ApiResponse<DepartmentChangeRequest>> {
    return axios.patch(
      `${this.baseUrl}/change-requests/${requestId}/cancel`,
      {}
    );
  }
}

export default new DepartmentChangeRequestService();

