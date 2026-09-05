import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { CreateEmployeePayload, Employee, EmployeeListQuery } from '@/types/employee';

class EmployeeService {
  list(query: EmployeeListQuery = {}): Promise<ApiResponse<Employee[]>> {
    return axiosInstance.get('/employees', { params: query });
  }

  get(id: string): Promise<ApiResponse<Employee>> {
    return axiosInstance.get(`/employees/${id}`);
  }

  create(payload: CreateEmployeePayload): Promise<ApiResponse<Employee>> {
    return axiosInstance.post('/employees', payload);
  }

  update(id: string, payload: Partial<CreateEmployeePayload>): Promise<ApiResponse<Employee>> {
    return axiosInstance.patch(`/employees/${id}`, payload);
  }

  terminate(id: string, exitDate?: string): Promise<ApiResponse<Employee>> {
    return axiosInstance.patch(`/employees/${id}/terminate`, { exitDate });
  }
}

export default new EmployeeService();
