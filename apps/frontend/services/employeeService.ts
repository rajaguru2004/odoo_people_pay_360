import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  CreateEmployeePayload,
  Employee,
  EmployeeListQuery,
} from '@/types/employee';
import type { PeopleHubSummary } from '@/types/peopleHub';
import type { TrendMonths } from '@/types/organizationHub';

class EmployeeService {
  list(query: EmployeeListQuery = {}): Promise<ApiResponse<Employee[]>> {
    return axiosInstance.get('/employees', { params: query });
  }

  get(id: string): Promise<ApiResponse<Employee>> {
    return axiosInstance.get(`/employees/${id}`);
  }

  /** The people this employee supervises — not their department. */
  team(id: string): Promise<ApiResponse<Employee[]>> {
    return axiosInstance.get(`/employees/${id}/team`);
  }

  /** One aggregate behind the People hub's lifecycle cards and trend. */
  hubSummary(months: TrendMonths = 6): Promise<ApiResponse<PeopleHubSummary>> {
    return axiosInstance.get('/employees/hub-summary', { params: { months } });
  }

  create(payload: CreateEmployeePayload): Promise<ApiResponse<Employee>> {
    return axiosInstance.post('/employees', payload);
  }

  update(
    id: string,
    payload: Partial<CreateEmployeePayload>,
  ): Promise<ApiResponse<Employee>> {
    return axiosInstance.patch(`/employees/${id}`, payload);
  }

  /** A soft exit. The record stays: payslips reference it and must keep resolving. */
  terminate(id: string, exitDate?: string): Promise<ApiResponse<Employee>> {
    return axiosInstance.patch(`/employees/${id}/terminate`, { exitDate });
  }
}

export default new EmployeeService();
