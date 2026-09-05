import type { EmployeeRef } from './common';

export type EmployeeStatus = 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED' | 'TERMINATED';

export interface Employee {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  workEmail?: string | null;
  personalEmail?: string | null;
  phone?: string | null;
  position?: string | null;
  status: EmployeeStatus;
  hireDate?: string | null;
  exitDate?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  /** ISO-3166 alpha-2. */
  nationality?: string | null;
  nationalId?: string | null;
  address?: string | null;
  timezone?: string | null;
  avatarUrl?: string | null;
  department?: { id: string; code: string; name: string } | null;
  branch?: { id: string; code: string; name: string } | null;
  manager?: EmployeeRef | null;
  /**
   * Who signs this person's leave and timesheet, which is NOT the same question
   * as where they sit in the structure. Usually the same person as `manager`
   * and deliberately sometimes not — a matrixed engineer reports to a
   * functional head and is supervised by a project lead.
   */
  supervisor?: EmployeeRef | null;
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
  supervisorId?: string;
  managerId?: string;
  sortBy?: 'employeeCode' | 'firstName' | 'hireDate' | 'status';
  sortOrder?: 'asc' | 'desc';
}

export interface CreateEmployeePayload {
  employeeCode: string;
  firstName: string;
  lastName: string;
  workEmail?: string;
  personalEmail?: string;
  phone?: string;
  position?: string;
  status?: EmployeeStatus;
  hireDate?: string;
  exitDate?: string;
  dateOfBirth?: string;
  gender?: string;
  nationality?: string;
  nationalId?: string;
  address?: string;
  branchId?: string;
  departmentId?: string;
  managerId?: string;
  supervisorId?: string;
  timezone?: string;
}
