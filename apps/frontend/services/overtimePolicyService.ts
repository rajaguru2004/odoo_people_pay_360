import axiosInstance from '@/lib/axios';
import type { ApiResponse } from '@/types/api';
import type {
  OvertimePolicy,
  OvertimePolicyRules,
  ResolvedPolicy,
} from '@/types/overtime';

export interface SavePolicyPayload {
  name: string;
  description?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
  /** An EMPLOYMENT_TYPE library label. Omit for an unscoped policy. */
  employmentType?: string | null;
  /** Partial: the server composes it over the current global defaults. */
  rules?: Partial<OvertimePolicyRules>;
}

class OvertimePolicyService {
  list(): Promise<ApiResponse<OvertimePolicy[]>> {
    return axiosInstance.get('/overtime-policies');
  }

  get(id: string): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.get(`/overtime-policies/${id}`);
  }

  create(payload: SavePolicyPayload): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.post('/overtime-policies', payload);
  }

  update(
    id: string,
    payload: Partial<SavePolicyPayload>,
  ): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.patch(`/overtime-policies/${id}`, payload);
  }

  setDefault(id: string): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.patch(`/overtime-policies/${id}/default`);
  }

  setActive(
    id: string,
    isActive: boolean,
  ): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.patch(`/overtime-policies/${id}/active`, { isActive });
  }

  remove(id: string): Promise<ApiResponse<null>> {
    return axiosInstance.delete(`/overtime-policies/${id}`);
  }

  /**
   * Assign an employment type and/or a direct override.
   *
   * `overtimePolicyId: null` CLEARS the override, dropping the employee back
   * through the chain — which is why null has to be sent explicitly rather than
   * omitted.
   */
  assign(payload: {
    employeeId: string;
    employmentType?: string;
    overtimePolicyId?: string | null;
  }): Promise<ApiResponse<unknown>> {
    return axiosInstance.patch('/overtime-policies/assign', payload);
  }

  /** Which policy governs one employee, and which tier of the chain produced it. */
  resolve(employeeId: string): Promise<ApiResponse<ResolvedPolicy>> {
    return axiosInstance.get(`/overtime-policies/resolve/${employeeId}`);
  }
}

export default new OvertimePolicyService();
