export type UserRole = 'ADMIN' | 'HR_MANAGER' | 'MANAGER' | 'EMPLOYEE';

export interface User {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  employeeId?: string;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    position: string;
    gender?: string | null;
    avatarUrl?: string;
    timezone?: string | null; // Employee's personal IANA TZ (null = use company TZ)
    dateFormat?: string | null; // Personal date-format pref (null = app default)
    department: {
      id: string;
      name: string;
    };


  };
  /** Employee's personal IANA TZ forwarded to top-level for convenience */
  timezone?: string | null;
  /** Employee's personal date-format preference forwarded to top-level */
  dateFormat?: string | null;

  // Multi-branch access
  /** True = may see all branches (incl. future ones). */
  isGlobalBranchAccess?: boolean;
  /** The user's own (home) branch id, if any. */
  homeBranchId?: string | null;
  /** Concrete branches this user is granted (∪ home). Global users use the full branch list instead. */
  accessibleBranches?: Array<{ id: string; code: string; name: string }>;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
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

// Form data for change password (includes confirmPassword for frontend validation)
export interface ChangePasswordFormData extends ChangePasswordData {
  confirmPassword: string;
}
