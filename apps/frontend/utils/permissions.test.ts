import { describe, expect, it } from 'vitest';
import { getDefaultRouteForRole, hasAnyPermission, hasPermission } from './permissions';

describe('hasPermission', () => {
  it('grants an admin the settings permission', () => {
    expect(hasPermission('ADMIN', 'EDIT_SYSTEM_SETTINGS')).toBe(true);
  });

  it('denies an employee the settings permission', () => {
    expect(hasPermission('EMPLOYEE', 'EDIT_SYSTEM_SETTINGS')).toBe(false);
  });

  it('lets a payroll officer RUN payroll but not APPROVE it (separation of duties)', () => {
    expect(hasPermission('PAYROLL_OFFICER', 'MANAGE_PAYROLL')).toBe(true);
    expect(hasPermission('PAYROLL_OFFICER', 'APPROVE_PAYROLL')).toBe(false);
  });

  it('denies everything for an absent role', () => {
    expect(hasPermission(null, 'VIEW_DASHBOARD')).toBe(false);
    expect(hasPermission(undefined, 'VIEW_DASHBOARD')).toBe(false);
  });

  it('denies a permission that does not exist', () => {
    expect(hasPermission('ADMIN', 'NOT_A_REAL_PERMISSION')).toBe(false);
  });
});

describe('hasAnyPermission', () => {
  it('is true when at least one is held', () => {
    expect(hasAnyPermission('EMPLOYEE', ['MANAGE_PAYROLL', 'VIEW_OWN_PAYSLIP'])).toBe(true);
  });

  it('is false when none are', () => {
    expect(hasAnyPermission('EMPLOYEE', ['MANAGE_PAYROLL', 'MANAGE_USERS'])).toBe(false);
  });
});

describe('getDefaultRouteForRole', () => {
  it('sends a signed-in role to the dashboard', () => {
    expect(getDefaultRouteForRole('ADMIN')).toBe('/dashboard');
    expect(getDefaultRouteForRole('EMPLOYEE')).toBe('/dashboard');
  });

  it('sends an unknown role back to login', () => {
    expect(getDefaultRouteForRole(null)).toBe('/login');
  });
});
