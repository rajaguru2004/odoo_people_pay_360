import { UserRole } from '@/types/auth';

// Role-based permission structure (scalable approach)
export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  ADMIN: [
    // Full access to everything
    // Document templates. PUBLISH is ADMIN-only even though HR can draft:
    // publishing changes what goes out to banks and embassies.
    'VIEW_DOCUMENT_TEMPLATES', 'MANAGE_DOCUMENT_TEMPLATES', 'PUBLISH_DOCUMENT_TEMPLATE',
    'VIEW_EMPLOYEES', 'CREATE_EMPLOYEE', 'EDIT_EMPLOYEE', 'DELETE_EMPLOYEE',
    'VIEW_DEPARTMENTS', 'MANAGE_DEPARTMENTS',
    'VIEW_ALL_ATTENDANCE', 'VIEW_OWN_ATTENDANCE', 'APPROVE_ATTENDANCE_CORRECTION',
    'VIEW_ALL_LEAVES', 'VIEW_OWN_LEAVES', 'CREATE_LEAVE', 'APPROVE_LEAVE',
    'VIEW_ALL_OVERTIME', 'VIEW_OWN_OVERTIME', 'CREATE_OVERTIME', 'APPROVE_OVERTIME',
    'VIEW_ALL_PAYROLL', 'VIEW_OWN_PAYSLIP', 'MANAGE_PAYROLL',
    'VIEW_CONTRACTS', 'MANAGE_CONTRACTS',
    'VIEW_VISAS', 'MANAGE_VISAS',
    'VIEW_REWARDS_DISCIPLINES', 'VIEW_OWN_REWARDS_DISCIPLINES', 'MANAGE_REWARDS_DISCIPLINES',
    'MANAGE_SALARY_COMPONENTS',
    'VIEW_HOLIDAYS', 'MANAGE_HOLIDAYS',
    'VIEW_ALL_SCHEDULES', 'VIEW_OWN_SCHEDULE', 'CREATE_SCHEDULE', 'EDIT_SCHEDULE',
    'DELETE_SCHEDULE', 'BULK_CREATE_SCHEDULES', 'MANAGE_SCHEDULES',
    'VIEW_REPORTS', 'EXPORT_DATA',
    'CREATE_USER', 'MANAGE_USERS',
    'VIEW_DASHBOARD', 'VIEW_ADMIN_DASHBOARD',
    'VIEW_SYSTEM_SETTINGS', 'EDIT_SYSTEM_SETTINGS',
    'VIEW_OWN_PROFILE', 'EDIT_OWN_PROFILE',
    // Tasks & Timesheets
    'VIEW_TASKS', 'CREATE_TASK', 'MANAGE_TASKS',
    'VIEW_PROJECTS', 'CREATE_PROJECT', 'MANAGE_PROJECTS',
    'VIEW_TIMESHEETS', 'CREATE_TIMESHEET', 'APPROVE_TIMESHEET',
  ],

  HR_MANAGER: [
    // HR operations
    // Read and draft, but never publish — see the ADMIN block.
    'VIEW_DOCUMENT_TEMPLATES', 'MANAGE_DOCUMENT_TEMPLATES',
    'VIEW_EMPLOYEES', 'CREATE_EMPLOYEE', 'EDIT_EMPLOYEE', 'DELETE_EMPLOYEE',
    'VIEW_DEPARTMENTS', 'MANAGE_DEPARTMENTS',
    'VIEW_ALL_ATTENDANCE', 'VIEW_OWN_ATTENDANCE', 'APPROVE_ATTENDANCE_CORRECTION',
    'VIEW_ALL_LEAVES', 'VIEW_OWN_LEAVES', 'CREATE_LEAVE', 'APPROVE_LEAVE',
    'VIEW_ALL_OVERTIME', 'VIEW_OWN_OVERTIME', 'CREATE_OVERTIME', 'APPROVE_OVERTIME',
    'VIEW_ALL_PAYROLL', 'VIEW_OWN_PAYSLIP', 'MANAGE_PAYROLL',
    'VIEW_CONTRACTS', 'MANAGE_CONTRACTS',
    'VIEW_VISAS', 'MANAGE_VISAS',
    'VIEW_REWARDS_DISCIPLINES', 'VIEW_OWN_REWARDS_DISCIPLINES', 'MANAGE_REWARDS_DISCIPLINES',
    'MANAGE_SALARY_COMPONENTS',
    'VIEW_HOLIDAYS', 'MANAGE_HOLIDAYS',
    'VIEW_ALL_SCHEDULES', 'VIEW_OWN_SCHEDULE', 'CREATE_SCHEDULE', 'EDIT_SCHEDULE',
    'DELETE_SCHEDULE', 'BULK_CREATE_SCHEDULES', 'MANAGE_SCHEDULES',
    'VIEW_REPORTS', 'EXPORT_DATA',
    'CREATE_USER',
    'VIEW_DASHBOARD', 'VIEW_ADMIN_DASHBOARD',
    'VIEW_SYSTEM_SETTINGS', 'EDIT_SYSTEM_SETTINGS',
    'VIEW_OWN_PROFILE', 'EDIT_OWN_PROFILE',
    // Tasks & Timesheets
    'VIEW_TASKS', 'CREATE_TASK', 'MANAGE_TASKS',
    'VIEW_PROJECTS', 'CREATE_PROJECT', 'MANAGE_PROJECTS',
    'VIEW_TIMESHEETS', 'CREATE_TIMESHEET', 'APPROVE_TIMESHEET',
  ],

  MANAGER: [
    // Department management
    'VIEW_EMPLOYEES', 'VIEW_DEPARTMENTS',
    'VIEW_ALL_ATTENDANCE', 'VIEW_OWN_ATTENDANCE',
    'VIEW_ALL_LEAVES', 'VIEW_OWN_LEAVES', 'CREATE_LEAVE',
    'VIEW_ALL_OVERTIME', 'VIEW_OWN_OVERTIME', 'CREATE_OVERTIME',
    'VIEW_OWN_PAYSLIP',
    'VIEW_VISAS',
    'VIEW_REWARDS_DISCIPLINES', 'VIEW_OWN_REWARDS_DISCIPLINES',
    'VIEW_HOLIDAYS',
    'VIEW_OWN_SCHEDULE',
    'VIEW_REPORTS',
    'VIEW_DASHBOARD',
    'VIEW_OWN_PROFILE', 'EDIT_OWN_PROFILE',
    // Tasks & Timesheets
    'VIEW_TASKS', 'CREATE_TASK', 'MANAGE_TASKS',
    'VIEW_PROJECTS', 'CREATE_PROJECT', 'MANAGE_PROJECTS',
    'VIEW_TIMESHEETS', 'CREATE_TIMESHEET', 'APPROVE_TIMESHEET',
  ],

  EMPLOYEE: [
    // Basic employee access
    'VIEW_OWN_ATTENDANCE',
    'VIEW_OWN_LEAVES', 'CREATE_LEAVE',
    'VIEW_OWN_OVERTIME', 'CREATE_OVERTIME',
    'VIEW_OWN_PAYSLIP',
    'VIEW_OWN_REWARDS_DISCIPLINES',
    'VIEW_HOLIDAYS',
    'VIEW_OWN_SCHEDULE',
    'VIEW_DASHBOARD',
    'VIEW_OWN_PROFILE', 'EDIT_OWN_PROFILE',
    // Tasks & Timesheets
    'VIEW_TASKS', 'CREATE_TIMESHEET',
    'VIEW_PROJECTS',
    'VIEW_TIMESHEETS',
  ],
};

// Legacy permission structure (for backward compatibility)
export const PERMISSIONS = {
  // Document templates. The read/write split matches the backend exactly:
  // ADMIN + HR may look and draft, only ADMIN may publish — because publishing
  // changes what goes out to banks and embassies. Hiding a control here is
  // convenience; the server gate is the security boundary.
  VIEW_DOCUMENT_TEMPLATES: ['ADMIN', 'HR_MANAGER'],
  MANAGE_DOCUMENT_TEMPLATES: ['ADMIN', 'HR_MANAGER'],
  PUBLISH_DOCUMENT_TEMPLATE: ['ADMIN'],

  // Employee management
  VIEW_EMPLOYEES: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
  CREATE_EMPLOYEE: ['ADMIN', 'HR_MANAGER'],
  EDIT_EMPLOYEE: ['ADMIN', 'HR_MANAGER'],
  DELETE_EMPLOYEE: ['ADMIN', 'HR_MANAGER'],

  // Department management
  VIEW_DEPARTMENTS: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
  MANAGE_DEPARTMENTS: ['ADMIN', 'HR_MANAGER'],

  // Attendance
  VIEW_ALL_ATTENDANCE: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
  VIEW_OWN_ATTENDANCE: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  APPROVE_ATTENDANCE_CORRECTION: ['ADMIN', 'HR_MANAGER'],

  // Leave requests
  VIEW_ALL_LEAVES: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
  VIEW_OWN_LEAVES: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  CREATE_LEAVE: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  APPROVE_LEAVE: ['ADMIN', 'HR_MANAGER'],

  // Overtime
  VIEW_ALL_OVERTIME: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
  VIEW_OWN_OVERTIME: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  CREATE_OVERTIME: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  APPROVE_OVERTIME: ['ADMIN', 'HR_MANAGER'],

  // Payroll
  VIEW_ALL_PAYROLL: ['ADMIN', 'HR_MANAGER'],
  VIEW_OWN_PAYSLIP: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  MANAGE_PAYROLL: ['ADMIN', 'HR_MANAGER'],

  // Contracts
  VIEW_CONTRACTS: ['ADMIN', 'HR_MANAGER'],
  MANAGE_CONTRACTS: ['ADMIN', 'HR_MANAGER'],

  // Visas (legal documents)
  VIEW_VISAS: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
  MANAGE_VISAS: ['ADMIN', 'HR_MANAGER'],

  // Rewards & Disciplines
  VIEW_REWARDS_DISCIPLINES: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
  VIEW_OWN_REWARDS_DISCIPLINES: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  MANAGE_REWARDS_DISCIPLINES: ['ADMIN', 'HR_MANAGER'],

  // Salary components
  MANAGE_SALARY_COMPONENTS: ['ADMIN', 'HR_MANAGER'],

  // Holidays
  VIEW_HOLIDAYS: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  MANAGE_HOLIDAYS: ['ADMIN', 'HR_MANAGER'],

  // Work Schedule
  VIEW_ALL_SCHEDULES: ['ADMIN', 'HR_MANAGER'],
  VIEW_OWN_SCHEDULE: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  CREATE_SCHEDULE: ['ADMIN', 'HR_MANAGER'],
  EDIT_SCHEDULE: ['ADMIN', 'HR_MANAGER'],
  DELETE_SCHEDULE: ['ADMIN', 'HR_MANAGER'],
  BULK_CREATE_SCHEDULES: ['ADMIN', 'HR_MANAGER'],
  MANAGE_SCHEDULES: ['ADMIN', 'HR_MANAGER'],

  // Reports & Export
  VIEW_REPORTS: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
  EXPORT_DATA: ['ADMIN', 'HR_MANAGER'],

  // User management
  CREATE_USER: ['ADMIN', 'HR_MANAGER'],
  MANAGE_USERS: ['ADMIN'],

  // Dashboard
  VIEW_DASHBOARD: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  VIEW_ADMIN_DASHBOARD: ['ADMIN', 'HR_MANAGER'],

  // Settings
  VIEW_SYSTEM_SETTINGS: ['ADMIN', 'HR_MANAGER'],
  EDIT_SYSTEM_SETTINGS: ['ADMIN', 'HR_MANAGER'],
  VIEW_OWN_PROFILE: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  EDIT_OWN_PROFILE: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  // Tasks
  VIEW_TASKS: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  CREATE_TASK: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
  MANAGE_TASKS: ['ADMIN', 'HR_MANAGER', 'MANAGER'],

  // Projects
  VIEW_PROJECTS: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  CREATE_PROJECT: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
  MANAGE_PROJECTS: ['ADMIN', 'HR_MANAGER', 'MANAGER'],

  // Timesheets
  VIEW_TIMESHEETS: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  CREATE_TIMESHEET: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  APPROVE_TIMESHEET: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
} as const;

// Fast permission check using role-based lookup
export const hasPermission = (userRole: UserRole, permission: keyof typeof PERMISSIONS): boolean => {
  return ROLE_PERMISSIONS[userRole]?.includes(permission) ?? false;
};

// Check if user has any of the permissions
export const hasAnyPermission = (userRole: UserRole, permissions: Array<keyof typeof PERMISSIONS>): boolean => {
  const userPermissions = ROLE_PERMISSIONS[userRole] ?? [];
  return permissions.some(permission => userPermissions.includes(permission));
};

// Check if user has all permissions
export const hasAllPermissions = (userRole: UserRole, permissions: Array<keyof typeof PERMISSIONS>): boolean => {
  const userPermissions = ROLE_PERMISSIONS[userRole] ?? [];
  return permissions.every(permission => userPermissions.includes(permission));
};

// Role hierarchy
export const ROLE_HIERARCHY: Record<UserRole, number> = {
  ADMIN: 4,
  HR_MANAGER: 3,
  MANAGER: 2,
  EMPLOYEE: 1,
};

// Check if user role is higher than or equal to required role
export const hasRoleLevel = (userRole: UserRole, requiredRole: UserRole): boolean => {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
};

// Check if user is admin
export const isAdmin = (userRole: UserRole): boolean => {
  return userRole === 'ADMIN';
};

// Check if user is HR Manager
export const isHRManager = (userRole: UserRole): boolean => {
  return userRole === 'HR_MANAGER';
};

// Check if user is Manager
export const isManager = (userRole: UserRole): boolean => {
  return userRole === 'MANAGER';
};

// Check if user is Employee
export const isEmployee = (userRole: UserRole): boolean => {
  return userRole === 'EMPLOYEE';
};

// Check if user can view employee data
export const canViewEmployee = (userRole: UserRole, targetEmployeeId: string, currentEmployeeId?: string): boolean => {
  // Admin and HR can view all
  if (hasPermission(userRole, 'VIEW_EMPLOYEES')) {
    return true;
  }

  // Employee can only view their own data
  if (currentEmployeeId) {
    return targetEmployeeId === currentEmployeeId;
  }

  return false;
};

// Check if user can edit employee data
export const canEditEmployee = (userRole: UserRole): boolean => {
  return hasPermission(userRole, 'EDIT_EMPLOYEE');
};

// Check if user can approve requests
export const canApproveRequest = (userRole: UserRole): boolean => {
  return hasPermission(userRole, 'APPROVE_LEAVE') || hasPermission(userRole, 'APPROVE_OVERTIME');
};

// Get accessible routes based on role
export const getAccessibleRoutes = (userRole: UserRole): string[] => {
  const routes: string[] = ['/dashboard'];

  if (hasPermission(userRole, 'VIEW_EMPLOYEES')) {
    routes.push('/dashboard/employees');
  }

  if (hasPermission(userRole, 'VIEW_DEPARTMENTS')) {
    routes.push('/dashboard/departments');
  }

  if (hasPermission(userRole, 'VIEW_ALL_ATTENDANCE')) {
    routes.push('/dashboard/attendance');
  }

  if (hasPermission(userRole, 'VIEW_ALL_LEAVES')) {
    routes.push('/dashboard/leaves');
  }

  if (hasPermission(userRole, 'VIEW_ALL_OVERTIME')) {
    routes.push('/dashboard/overtime');
  }

  if (hasPermission(userRole, 'VIEW_ALL_PAYROLL')) {
    routes.push('/dashboard/payroll');
  }

  if (hasPermission(userRole, 'VIEW_CONTRACTS')) {
    routes.push('/dashboard/contracts');
  }

  if (hasPermission(userRole, 'VIEW_REPORTS')) {
    routes.push('/dashboard/reports');
  }

  routes.push('/dashboard/profile');

  return routes;
};

// Get default route after login based on role
export const getDefaultRouteForRole = (userRole: UserRole): string => {
  switch (userRole) {
    case 'ADMIN':
    case 'HR_MANAGER':
    case 'MANAGER':
    case 'EMPLOYEE':
    default:
      return '/dashboard';
  }
};
