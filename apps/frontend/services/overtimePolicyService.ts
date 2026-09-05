import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';

// Employment type is a Contract Type library label (free string).
export type EmploymentType = string;
export type HolidayBehavior = 'STANDARD' | 'IGNORE';

export interface RateTier {
  regularRate: number;
  lateRate: number;
  lateThreshold: string;
}

export interface OvertimePolicyRules {
  eligible: boolean;
  holidayBehavior: HolidayBehavior;
  lateThreshold: string;
  regularRate: number;
  lateRate: number;
  doubleOtEnabled: boolean;
  doubleRate: number;
  doubleOtAllowAnytime: boolean;
  sunday: RateTier;
  holiday: RateTier;
  shiftEndTime: string;
  dayEndBoundary: string | null;
  foodAllowanceEnabled: boolean;
  foodAllowanceAmount: number;
  foodAllowanceThreshold: string;
  doubleFoodAllowanceAnyTime: boolean;
  maxHoursPerDay: number;
  maxHoursPerDoubleDay: number;
  maxHoursPerMonth: number;
  maxHoursPerYear: number;
}

export interface OvertimePolicy {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isDefault: boolean;
  employmentType: EmploymentType | null;
  schemaVersion: number;
  rules: OvertimePolicyRules;
  createdAt: string;
  updatedAt: string;
  _count?: { employees: number };
}

export interface CreateOvertimePolicyDto {
  name: string;
  description?: string;
  isActive?: boolean;
  isDefault?: boolean;
  employmentType?: EmploymentType | null;
  rules?: Partial<OvertimePolicyRules>;
}

export type UpdateOvertimePolicyDto = Partial<CreateOvertimePolicyDto>;

export interface AssignOvertimePolicyDto {
  employeeId: string;
  employmentType?: EmploymentType;
  overtimePolicyId?: string | null;
}

export interface PolicyResolution {
  employeeId: string;
  employeeName: string;
  employmentType: EmploymentType | null;
  overtimePolicyId: string | null;
  source:
    | 'EMPLOYEE_OVERRIDE'
    | 'EMPLOYMENT_TYPE'
    | 'COMPANY_DEFAULT'
    | 'LEGACY_GLOBAL'
    | 'LEGACY_GLOBAL_DISABLED';
  effectivePolicyId: string | null;
  effectivePolicyName: string | null;
  description?: string | null;
  eligible: boolean;
  holidayBehavior: HolidayBehavior;
  rules?: Partial<OvertimePolicyRules>;
}

class OvertimePolicyService {
  /** List policies (ADMIN/HR). */
  async list(): Promise<ApiResponse<OvertimePolicy[]>> {
    return axiosInstance.get('/overtime-policies');
  }

  async get(id: string): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.get(`/overtime-policies/${id}`);
  }

  async create(
    dto: CreateOvertimePolicyDto,
  ): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.post('/overtime-policies', dto);
  }

  async update(
    id: string,
    dto: UpdateOvertimePolicyDto,
  ): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.patch(`/overtime-policies/${id}`, dto);
  }

  async setDefault(id: string): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.patch(`/overtime-policies/${id}/default`, {});
  }

  async setActive(
    id: string,
    isActive: boolean,
  ): Promise<ApiResponse<OvertimePolicy>> {
    return axiosInstance.patch(`/overtime-policies/${id}/active`, { isActive });
  }

  async remove(id: string): Promise<ApiResponse<null>> {
    return axiosInstance.delete(`/overtime-policies/${id}`);
  }

  /** Debug: which policy governs an employee and via which tier. */
  async resolve(employeeId: string): Promise<ApiResponse<PolicyResolution>> {
    return axiosInstance.get(`/overtime-policies/resolve/${employeeId}`);
  }

  /** Assign an employment type and/or policy override to an employee. */
  async assign(dto: AssignOvertimePolicyDto): Promise<ApiResponse<any>> {
    return axiosInstance.patch('/overtime-policies/assign', dto);
  }
}

export default new OvertimePolicyService();
