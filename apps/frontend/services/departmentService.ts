import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { Department, CreateDepartmentData, UpdateDepartmentData, DepartmentStatistics } from '@/types/department';

class DepartmentService {
  async getAll(): Promise<ApiResponse<Department[]>> {
    return axiosInstance.get('/departments');
  }

  async getById(id: string): Promise<ApiResponse<Department>> {
    return axiosInstance.get(`/departments/${id}`);
  }

  async getOrganizationTree(): Promise<ApiResponse<Department[]>> {
    return axiosInstance.get('/departments/tree');
  }

  async create(data: CreateDepartmentData): Promise<ApiResponse<Department>> {
    return axiosInstance.post('/departments', data);
  }

  async update(id: string, data: UpdateDepartmentData): Promise<ApiResponse<Department>> {
    return axiosInstance.patch(`/departments/${id}`, data);
  }

  async delete(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/departments/${id}`);
  }

  async assignManager(departmentId: string, managerId: string): Promise<ApiResponse<Department>> {
    return axiosInstance.patch(`/departments/${departmentId}/manager`, { managerId });
  }

  async getStatistics(): Promise<ApiResponse<DepartmentStatistics>> {
    return axiosInstance.get('/departments/statistics');
  }

  async getPerformance(id: string): Promise<ApiResponse<any>> {
    return axiosInstance.get(`/departments/${id}/performance`);
  }
}

export default new DepartmentService();
