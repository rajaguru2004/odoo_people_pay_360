import { UserRole } from '@/types/auth';

/**
 * Role → permission map.
 *
 * This is a UI-AFFORDANCE layer, not a security boundary. It decides what to
 * render; the backend's RolesGuard decides what is allowed. Every permission
 * here has a server-side counterpart, and a screen that hides a button must
 * never be the only thing stopping the action.
 */
export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  ADMIN: [
    'VIEW_DASHBOARD',
    'VIEW_EMPLOYEES', 'CREATE_EMPLOYEE', 'EDIT_EMPLOYEE', 'TERMINATE_EMPLOYEE',
    'VIEW_DEPARTMENTS', 'MANAGE_DEPARTMENTS',
    // Reading the roster and writing it are separate: a department head reads
    // their team's, and every /work-schedules route is ADMIN + HR server-side.
    'VIEW_SCHEDULES', 'MANAGE_SCHEDULES',
    // Leave and overtime. Reading the workforce's requests, deciding them and
    // changing what the company grants are three separate things: a department
    // head decides without ever changing an entitlement.
    'VIEW_LEAVE', 'APPROVE_LEAVE', 'MANAGE_LEAVE_TYPES', 'MANAGE_LEAVE_BALANCES',
    'VIEW_OVERTIME', 'APPROVE_OVERTIME', 'MANAGE_OVERTIME_POLICIES',
    'VIEW_OWN_LEAVE', 'VIEW_OWN_OVERTIME',
    'VIEW_ALL_PAYROLL', 'MANAGE_PAYROLL', 'APPROVE_PAYROLL', 'VIEW_OWN_PAYSLIP',
    'MANAGE_SALARY_COMPONENTS',
    'VIEW_REPORTS', 'EXPORT_DATA',
    'MANAGE_USERS',
    'VIEW_SYSTEM_SETTINGS', 'EDIT_SYSTEM_SETTINGS',
    'MANAGE_INTEGRATIONS',
    'VIEW_OWN_PROFILE', 'EDIT_OWN_PROFILE',
  ],

  HR_MANAGER: [
    'VIEW_DASHBOARD',
    'VIEW_EMPLOYEES', 'CREATE_EMPLOYEE', 'EDIT_EMPLOYEE', 'TERMINATE_EMPLOYEE',
    'VIEW_DEPARTMENTS', 'MANAGE_DEPARTMENTS',
    'VIEW_SCHEDULES', 'MANAGE_SCHEDULES',
    'VIEW_LEAVE', 'APPROVE_LEAVE', 'MANAGE_LEAVE_TYPES', 'MANAGE_LEAVE_BALANCES',
    'VIEW_OVERTIME', 'APPROVE_OVERTIME', 'MANAGE_OVERTIME_POLICIES',
    'VIEW_OWN_LEAVE', 'VIEW_OWN_OVERTIME',
    'VIEW_ALL_PAYROLL', 'VIEW_OWN_PAYSLIP',
    'VIEW_REPORTS', 'EXPORT_DATA',
    'MANAGE_USERS',
    'VIEW_OWN_PROFILE', 'EDIT_OWN_PROFILE',
  ],

  PAYROLL_OFFICER: [
    'VIEW_DASHBOARD',
    'VIEW_EMPLOYEES',
    'VIEW_DEPARTMENTS',
    // Runs payroll but cannot APPROVE it. Separation of duties: the person who
    // calculates a run must not be the person who releases it for payment.
    // Overtime hours ARE a payroll fact and have to be reconciled; leave
    // reasons are not, which is why only one of the two appears here.
    'VIEW_OVERTIME',
    'VIEW_OWN_LEAVE', 'VIEW_OWN_OVERTIME',
    'VIEW_ALL_PAYROLL', 'MANAGE_PAYROLL', 'VIEW_OWN_PAYSLIP',
    'MANAGE_SALARY_COMPONENTS',
    'VIEW_REPORTS', 'EXPORT_DATA',
    'VIEW_OWN_PROFILE', 'EDIT_OWN_PROFILE',
  ],

  MANAGER: [
    'VIEW_DASHBOARD',
    'VIEW_EMPLOYEES',
    'VIEW_DEPARTMENTS',
    // Read only — no MANAGE_SCHEDULES. The server refuses every roster write
    // from this role, so drawing the buttons would be a lie the user finds.
    'VIEW_SCHEDULES',
    // Decides their team's requests, changes nobody's entitlement.
    'VIEW_LEAVE', 'APPROVE_LEAVE',
    'VIEW_OVERTIME', 'APPROVE_OVERTIME',
    'VIEW_OWN_LEAVE', 'VIEW_OWN_OVERTIME',
    'VIEW_OWN_PAYSLIP',
    'VIEW_REPORTS',
    'VIEW_OWN_PROFILE', 'EDIT_OWN_PROFILE',
  ],

  EMPLOYEE: [
    'VIEW_DASHBOARD',
    // Their own record only. The workforce lists answer by name and the server
    // refuses them, so drawing the entry would be a link to /403.
    'VIEW_OWN_LEAVE', 'VIEW_OWN_OVERTIME',
    'VIEW_OWN_PAYSLIP',
    'VIEW_OWN_PROFILE', 'EDIT_OWN_PROFILE',
  ],
};

export function hasPermission(role: UserRole | undefined | null, permission: string): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function hasAnyPermission(role: UserRole | undefined | null, permissions: string[]): boolean {
  return permissions.some((p) => hasPermission(role, p));
}

/** Where a role lands after signing in. */
export function getDefaultRouteForRole(role: UserRole | undefined | null): string {
  switch (role) {
    case 'ADMIN':
    case 'HR_MANAGER':
    case 'PAYROLL_OFFICER':
    case 'MANAGER':
      return '/dashboard';
    case 'EMPLOYEE':
      return '/dashboard';
    default:
      return '/login';
  }
}
