import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';

export type ComponentType = string;

export interface SalaryComponent {
  id: string;
  employeeId: string;
  componentType: ComponentType;
  amount: number;
  effectiveDate: string;
  note?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  employee: {
    id: string;
    employeeCode: string;
    fullName: string;
    department?: {
      name: string;
    };
  };
}

export interface CreateSalaryComponentData {
  employeeId: string;
  componentType: ComponentType;
  amount: number;
  effectiveDate?: string;
  note?: string;
}

export interface UpdateSalaryComponentData {
  amount?: number;
  effectiveDate?: string;
  note?: string;
  isActive?: boolean;
}

class SalaryComponentService {
  async getAll(params?: {
    employeeId?: string;
    componentType?: string;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<SalaryComponent[]>> {
    return axiosInstance.get('/salary-components', { params });
  }

  async getById(id: string): Promise<ApiResponse<SalaryComponent>> {
    return axiosInstance.get(`/salary-components/${id}`);
  }

  async getByEmployee(employeeId: string): Promise<ApiResponse<{ employee: any; components: SalaryComponent[]; totalSalary: number }>> {
    return axiosInstance.get(`/salary-components/employee/${employeeId}`);
  }

  async create(data: CreateSalaryComponentData): Promise<ApiResponse<SalaryComponent>> {
    return axiosInstance.post('/salary-components', data);
  }

  async update(id: string, data: UpdateSalaryComponentData): Promise<ApiResponse<SalaryComponent>> {
    return axiosInstance.patch(`/salary-components/${id}`, data);
  }

  async deactivate(id: string): Promise<ApiResponse<SalaryComponent>> {
    return axiosInstance.patch(`/salary-components/${id}/deactivate`);
  }

  async delete(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/salary-components/${id}`);
  }
}

export default new SalaryComponentService();
