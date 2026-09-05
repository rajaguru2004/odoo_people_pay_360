import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { Employee, CreateEmployeeData, UpdateEmployeeData, EmployeeStatistics } from '@/types/employee';
import type { PeopleHubSummary } from '@/types/peopleHub';

interface QueryEmployeesParams {
  search?: string;
  departmentId?: string;
  position?: string;
  status?: string;
  gender?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

class EmployeeService {
  async getAll(params?: QueryEmployeesParams): Promise<ApiResponse<Employee[]>> {
    return axiosInstance.get('/employees', { params });
  }

  /** Lightweight active-employee directory for pickers (any authenticated user). */
  async getDirectory(search?: string): Promise<ApiResponse<Employee[]>> {
    return axiosInstance.get('/employees/directory', { params: search ? { search } : undefined });
  }

  async getById(id: string): Promise<ApiResponse<Employee>> {
    return axiosInstance.get(`/employees/${id}`);
  }

  async getProfile(id: string): Promise<ApiResponse<Employee>> {
    return axiosInstance.get(`/employees/${id}/profile`);
  }

  async create(data: CreateEmployeeData): Promise<ApiResponse<Employee>> {
    return axiosInstance.post('/employees', data);
  }

  async update(id: string, data: UpdateEmployeeData): Promise<ApiResponse<Employee>> {
    return axiosInstance.patch(`/employees/${id}`, data);
  }

  async delete(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/employees/${id}`);
  }

  async hardDelete(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/employees/${id}/hard`);
  }

  /**
   * The People hub in one payload — lifecycle, contracts, terminations, trend.
   *
   * Separate from `getStatistics()`, which is the by-department/by-gender
   * breakdown several older screens still read.
   */
  async getPeopleHubSummary(months: 6 | 12 = 6): Promise<ApiResponse<PeopleHubSummary>> {
    return axiosInstance.get('/employees/hub-summary', { params: { months } });
  }

  async getStatistics(): Promise<ApiResponse<EmployeeStatistics>> {
    return axiosInstance.get('/employees/statistics');
  }

  async getHistory(id: string): Promise<ApiResponse<any[]>> {
    return axiosInstance.get(`/employees/${id}/history`);
  }

  async generateCode(departmentId?: string): Promise<ApiResponse<{ employeeCode: string }>> {
    return axiosInstance.get('/employees/generate-code', {
      params: { departmentId }
    });
  }

  async getWithoutActiveContract(limit?: number): Promise<ApiResponse<Employee[]>> {
    return axiosInstance.get('/employees/without-active-contract', {
      params: { limit: limit || 100 }
    });
  }

  async resendWelcomeEmail(id: string): Promise<ApiResponse<any>> {
    return axiosInstance.post(`/employees/${id}/resend-welcome`);
  }

  async downloadImportTemplate(): Promise<Blob> {
    const response = await axiosInstance.get('/employees/import/template', {
      responseType: 'blob'
    });
    return response.data;
  }

  async previewImport(file: File): Promise<ApiResponse<{
    summary: { totalRows: number; validRows: number; invalidRows: number };
    rows: Array<{
      rowNumber: number;
      valid: boolean;
      errors: string[];
      data: any;
    }>;
  }>> {
    const formData = new FormData();
    formData.append('file', file);
    return axiosInstance.post('/employees/import/preview', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    });
  }

  async confirmImport(employees: any[]): Promise<ApiResponse<Array<{
    email: string;
    success: boolean;
    employeeCode?: string;
    error?: string;
  }>>> {
    return axiosInstance.post('/employees/import/confirm', employees);
  }
}

export default new EmployeeService();
