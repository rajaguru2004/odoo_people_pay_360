import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  AssignOvertimePolicyPayload,
  CreateOvertimePolicyPayload,
  OvertimePolicy,
  OvertimePolicyResolution,
  UpdateOvertimePolicyPayload,
} from '@/types/overtime';

class OvertimePolicyService {
  /** Every configured policy. ADMIN and HR only. */
  list(): Promise<ApiResponse<OvertimePolicy[]>> {
    return axiosInstance.get('/overtime-policies');
  }

  get(id: string): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.get(`/overtime-policies/${id}`);
  }

  create(payload: CreateOvertimePolicyPayload): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.post('/overtime-policies', payload);
  }

  update(
    id: string,
    payload: UpdateOvertimePolicyPayload,
  ): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.patch(`/overtime-policies/${id}`, payload);
  }

  /** Makes this the company fallback, which demotes whichever policy held it. */
  setDefault(id: string): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.patch(`/overtime-policies/${id}/default`, {});
  }

  setActive(id: string, isActive: boolean): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.patch(`/overtime-policies/${id}/active`, { isActive });
  }

  remove(id: string): Promise<ApiResponse<null>> {
    return axiosInstance.delete(`/overtime-policies/${id}`);
  }

  /** Which policy governs one employee, and through which tier it was reached. */
  resolve(employeeId: string): Promise<ApiResponse<OvertimePolicyResolution>> {
    return axiosInstance.get(`/overtime-policies/resolve/${employeeId}`);
  }

  /** Pins an employment type and/or a policy override onto one employee. */
  assign(payload: AssignOvertimePolicyPayload): Promise<ApiResponse<OvertimePolicy | null>> {
    return axiosInstance.patch('/overtime-policies/assign', payload);
  }
}

export default new OvertimePolicyService();
