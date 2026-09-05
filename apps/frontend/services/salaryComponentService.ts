import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  CreateSalaryComponentPayload,
  SalaryComponent,
  SalaryComponentListQuery,
  UpdateSalaryComponentPayload,
} from '@/types/salaryStructure';

class SalaryComponentService {
  list(
    query: SalaryComponentListQuery = {},
  ): Promise<ApiResponse<SalaryComponent[]>> {
    return axiosInstance.get('/salary-components', { params: query });
  }

  get(id: string): Promise<ApiResponse<SalaryComponent>> {
    return axiosInstance.get(`/salary-components/${id}`);
  }

  create(
    payload: CreateSalaryComponentPayload,
  ): Promise<ApiResponse<SalaryComponent>> {
    return axiosInstance.post('/salary-components', payload);
  }

  /** `code` and `type` are not editable — payslip lines already join on them. */
  update(
    id: string,
    payload: UpdateSalaryComponentPayload,
  ): Promise<ApiResponse<SalaryComponent>> {
    return axiosInstance.patch(`/salary-components/${id}`, payload);
  }

  /**
   * Retirement, not deletion — there is no DELETE on this resource.
   *
   * A component behind a payslip line must keep resolving: the line carries the
   * code and label it printed, but a report that walks back to the catalogue
   * still has to find a row there.
   */
  deactivate(id: string): Promise<ApiResponse<SalaryComponent>> {
    return axiosInstance.post(`/salary-components/${id}/deactivate`);
  }

  /** Put a retired component back in the catalogue. */
  activate(id: string): Promise<ApiResponse<SalaryComponent>> {
    return axiosInstance.post(`/salary-components/${id}/activate`);
  }
}

export default new SalaryComponentService();
