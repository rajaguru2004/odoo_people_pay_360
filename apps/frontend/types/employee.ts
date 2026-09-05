export type EmployeeStatus = 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED' | 'TERMINATED';

export interface Employee {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  workEmail?: string | null;
  phone?: string | null;
  position?: string | null;
  status: EmployeeStatus;
  hireDate?: string | null;
  exitDate?: string | null;
  timezone?: string | null;
  avatarUrl?: string | null;
  department?: { id: string; code: string; name: string } | null;
  branch?: { id: string; code: string; name: string } | null;
  manager?: { id: string; employeeCode: string; firstName: string; lastName: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeListQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: EmployeeStatus;
  departmentId?: string;
  branchId?: string;
}

export interface CreateEmployeePayload {
  employeeCode: string;
  firstName: string;
  lastName: string;
  workEmail?: string;
  phone?: string;
  position?: string;
  status?: EmployeeStatus;
  hireDate?: string;
  branchId?: string;
  departmentId?: string;
  managerId?: string;
  timezone?: string;
}
