import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  CreateSalaryStructurePayload,
  SalaryStructure,
  SalaryStructureListQuery,
  UpdateSalaryStructurePayload,
} from '@/types/salaryStructure';

class SalaryStructureService {
  list(
    query: SalaryStructureListQuery = {},
  ): Promise<ApiResponse<SalaryStructure[]>> {
    return axiosInstance.get('/salary-structures', { params: query });
  }

  /**
   * One employee's structure, by EMPLOYEE id.
   *
   * A literal segment, declared before `:id` server-side. 404 here is the
   * ordinary answer for somebody who has never been assigned one — which is
   * exactly what pre-flight reports as a blocker.
   */
  getByEmployee(employeeId: string): Promise<ApiResponse<SalaryStructure>> {
    return axiosInstance.get(`/salary-structures/employee/${employeeId}`);
  }

  get(id: string): Promise<ApiResponse<SalaryStructure>> {
    return axiosInstance.get(`/salary-structures/${id}`);
  }

  create(
    payload: CreateSalaryStructurePayload,
  ): Promise<ApiResponse<SalaryStructure>> {
    return axiosInstance.post('/salary-structures', payload);
  }

  /** Sending `lines` REPLACES them all; the server never merges line by line. */
  update(
    id: string,
    payload: UpdateSalaryStructurePayload,
  ): Promise<ApiResponse<SalaryStructure>> {
    return axiosInstance.patch(`/salary-structures/${id}`, payload);
  }

  /** Refused once the employee has a payslip — the run that read it must stay
   *  explicable. */
  remove(id: string): Promise<ApiResponse<{ id: string }>> {
    return axiosInstance.delete(`/salary-structures/${id}`);
  }
}

export default new SalaryStructureService();
