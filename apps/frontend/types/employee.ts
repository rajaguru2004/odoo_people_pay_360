import { EmployeeDocument, EmployeeProfile } from './employee-profile';

export type EmployeeStatus = 'ACTIVE' | 'INACTIVE' | 'ON_LEAVE' | 'TERMINATED';
export type Gender = 'MALE' | 'FEMALE' | 'OTHER';
/** Pay basis — MONTHLY (fixed salary, absence deducted as LOP) or DAILY (daily wage). */
export type SalaryType = 'MONTHLY' | 'DAILY';

export interface Employee {
  id: string;
  employeeCode: string;
  fullName: string;
  dateOfBirth: string;
  gender?: Gender;
  idCard: string;
  address?: string;
  phone?: string;
  /**
   * ISO-3166 alpha-2 the phone belongs to. Only consulted when `phone` was typed
   * without a country prefix. Empty/absent means "not stated" — the server falls
   * back to the branch country, then the global WhatsApp default region.
   */
  phoneCountryCode?: string;
  email: string;
  avatarUrl?: string;
  departmentId: string;
  position: string;
  startDate: string;
  endDate?: string;
  status: EmployeeStatus;
  /** Monthly amount when salaryType is MONTHLY; a PER-DAY rate when it is DAILY. */
  baseSalary: number;
  /** Pay basis. DAILY = daily wage, paid strictly for days actually worked. */
  salaryType?: SalaryType;
  /**
   * EMPLOYMENT_TYPE library label. Drives the overtime policy, and when that
   * library item carries a pay basis it also FIXES salaryType — the Pay Basis
   * field is locked on the form in that case.
   */
  employmentType?: string | null;
  /** Pins this employee to one overtime policy, bypassing type/default resolution. */
  overtimePolicyId?: string | null;
  branchId?: string | null;
  timezone?: string | null;
  dateFormat?: string | null;
  createdAt: string;
  updatedAt: string;
  department: {
    id: string;
    code: string;
    name: string;
  };
  /** Departments this employee heads. A manager may head more than one. */
  managedDepartments?: {
    id: string;
    code: string;
    name: string;
  }[];
  user?: {
    id: string;
    email: string;
    role: string;
    isActive: boolean;
  };
  _count?: {
    contracts: number;
    attendances: number;
    leaveRequests: number;
    rewards: number;
    disciplines: number;
  };
  documents?: EmployeeDocument[];
  profile?: EmployeeProfile;
  profileCompletionPercentage?: number;
}

export interface CreateEmployeeData {
  fullName: string;
  dateOfBirth: string;
  gender?: Gender;
  idCard: string;
  address?: string;
  phone?: string;
  phoneCountryCode?: string;
  email: string;
  departmentId: string;
  position: string;
  startDate: string;
  baseSalary: number;
  salaryType?: SalaryType;
  employmentType?: string | null;
  overtimePolicyId?: string | null;
  branchId?: string;
  timezone?: string | null;
  dateFormat?: string | null;
  /** idCard was auto-filled from the generated employee code, not typed by the user —
   *  lets the backend silently regenerate it on a collision instead of rejecting. */
  autoGenerateIdCard?: boolean;
}

export interface UpdateEmployeeData extends Partial<CreateEmployeeData> {
  status?: EmployeeStatus;
  endDate?: string;
  /** Explicit null clears the per-employee override and restores inheritance. */
  overtimePolicyId?: string | null;
}

export interface EmployeeStatistics {
  total: number;
  byStatus: Array<{ status: EmployeeStatus; count: number }>;
  byDepartment: Array<{ department: any; count: number }>;
  byGender: Array<{ gender: Gender; count: number }>;
  averageSalary: number;
}

export interface QueryEmployeesParams {
  page?: number;
  limit?: number;
  search?: string;
  departmentId?: string;
  position?: string;
  status?: EmployeeStatus | string;
  gender?: Gender | string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}
