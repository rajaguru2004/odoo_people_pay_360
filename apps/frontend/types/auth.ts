export type UserRole = 'ADMIN' | 'HR_MANAGER' | 'PAYROLL_OFFICER' | 'MANAGER' | 'EMPLOYEE';

export interface User {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  employeeId?: string | null;
  lastLoginAt?: string | null;
  employee?: {
    id: string;
    employeeCode: string;
    firstName: string;
    lastName: string;
    position?: string | null;
    avatarUrl?: string | null;
    /** Personal IANA zone. null = use the company zone. */
    timezone?: string | null;
    departmentId?: string | null;
    branchId?: string | null;
    department?: { id: string; name: string } | null;
    branch?: { id: string; code: string; name: string } | null;
  } | null;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  user: User;
}

export interface RegisterData {
  email: string;
  password: string;
  role: UserRole;
  employeeId?: string;
}

export interface ChangePasswordData {
  oldPassword: string;
  newPassword: string;
}

/** Adds the confirm field the form validates on; never sent to the API. */
export interface ChangePasswordFormData extends ChangePasswordData {
  confirmPassword: string;
}
