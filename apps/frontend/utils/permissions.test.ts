import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLE_HIERARCHY,
  ROLE_PERMISSIONS,
  canApproveRequest,
  canEditEmployee,
  canViewEmployee,
  getAccessibleRoutes,
  getDefaultRouteForRole,
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  hasRoleLevel,
  isAdmin,
  isEmployee,
  isHRManager,
  isManager,
} from './permissions';
import type { UserRole } from '@/types/auth';

/**
 * The client-side authorisation matrix.
 *
 * Nothing here grants access — the server does that — but everything here
 * decides what a user is *shown*. A wrong entry either hides a screen someone
 * needs or advertises an action that will 403, and neither failure is loud.
 *
 * The file carries two maps that must agree (see the drift block at the bottom),
 * which is the specific reason this test exists.
 */

const ROLES: UserRole[] = ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'];

describe('hasPermission', () => {
  it('grants the full administrative set to ADMIN', () => {
    expect(hasPermission('ADMIN', 'MANAGE_USERS')).toBe(true);
    expect(hasPermission('ADMIN', 'MANAGE_PAYROLL')).toBe(true);
    expect(hasPermission('ADMIN', 'EDIT_SYSTEM_SETTINGS')).toBe(true);
    expect(hasPermission('ADMIN', 'DELETE_EMPLOYEE')).toBe(true);
  });

  it('withholds MANAGE_USERS from HR_MANAGER — the one thing ADMIN keeps alone', () => {
    expect(hasPermission('HR_MANAGER', 'MANAGE_USERS')).toBe(false);
    // …while HR keeps the rest of the HR surface.
    expect(hasPermission('HR_MANAGER', 'CREATE_USER')).toBe(true);
    expect(hasPermission('HR_MANAGER', 'MANAGE_PAYROLL')).toBe(true);
  });

  it('gives MANAGER read-across but no approval or payroll authority', () => {
    expect(hasPermission('MANAGER', 'VIEW_EMPLOYEES')).toBe(true);
    expect(hasPermission('MANAGER', 'VIEW_ALL_LEAVES')).toBe(true);
    expect(hasPermission('MANAGER', 'VIEW_REPORTS')).toBe(true);

    expect(hasPermission('MANAGER', 'APPROVE_LEAVE')).toBe(false);
    expect(hasPermission('MANAGER', 'APPROVE_OVERTIME')).toBe(false);
    expect(hasPermission('MANAGER', 'MANAGE_PAYROLL')).toBe(false);
    expect(hasPermission('MANAGER', 'VIEW_ALL_PAYROLL')).toBe(false);
    expect(hasPermission('MANAGER', 'EDIT_EMPLOYEE')).toBe(false);
  });

  it('confines EMPLOYEE to own-record permissions', () => {
    expect(hasPermission('EMPLOYEE', 'VIEW_OWN_LEAVES')).toBe(true);
    expect(hasPermission('EMPLOYEE', 'VIEW_OWN_PAYSLIP')).toBe(true);
    expect(hasPermission('EMPLOYEE', 'CREATE_LEAVE')).toBe(true);

    expect(hasPermission('EMPLOYEE', 'VIEW_EMPLOYEES')).toBe(false);
    expect(hasPermission('EMPLOYEE', 'VIEW_ALL_LEAVES')).toBe(false);
    expect(hasPermission('EMPLOYEE', 'VIEW_ALL_ATTENDANCE')).toBe(false);
    expect(hasPermission('EMPLOYEE', 'VIEW_SYSTEM_SETTINGS')).toBe(false);
  });

  it('denies rather than throws for an unknown role', () => {
    // Shapes arriving from a stale token or a hand-edited localStorage blob.
    expect(hasPermission('SUPERUSER' as UserRole, 'VIEW_DASHBOARD')).toBe(false);
    expect(hasPermission(undefined as unknown as UserRole, 'VIEW_DASHBOARD')).toBe(false);
  });

  it('denies an unknown permission name', () => {
    expect(hasPermission('ADMIN', 'NOT_A_PERMISSION' as keyof typeof PERMISSIONS)).toBe(false);
  });
});

describe('the own-vs-all permission pairs', () => {
  // Each pair is the line between "my record" and "everyone's". Collapsing one
  // leaks other employees' data into a self-service screen.
  const PAIRS: Array<[keyof typeof PERMISSIONS, keyof typeof PERMISSIONS]> = [
    ['VIEW_ALL_ATTENDANCE', 'VIEW_OWN_ATTENDANCE'],
    ['VIEW_ALL_LEAVES', 'VIEW_OWN_LEAVES'],
    ['VIEW_ALL_OVERTIME', 'VIEW_OWN_OVERTIME'],
    ['VIEW_ALL_SCHEDULES', 'VIEW_OWN_SCHEDULE'],
    ['VIEW_REWARDS_DISCIPLINES', 'VIEW_OWN_REWARDS_DISCIPLINES'],
  ];

  it.each(PAIRS)('EMPLOYEE has %s = false but %s = true', (all, own) => {
    expect(hasPermission('EMPLOYEE', all)).toBe(false);
    expect(hasPermission('EMPLOYEE', own)).toBe(true);
  });

  it.each(PAIRS)('ADMIN has both %s and %s', (all, own) => {
    expect(hasPermission('ADMIN', all)).toBe(true);
    expect(hasPermission('ADMIN', own)).toBe(true);
  });
});

describe('hasAnyPermission / hasAllPermissions', () => {
  it('any: one match is enough', () => {
    expect(hasAnyPermission('EMPLOYEE', ['MANAGE_PAYROLL', 'VIEW_OWN_PAYSLIP'])).toBe(true);
  });

  it('any: no match is false', () => {
    expect(hasAnyPermission('EMPLOYEE', ['MANAGE_PAYROLL', 'MANAGE_USERS'])).toBe(false);
  });

  it('all: every entry must match', () => {
    expect(hasAllPermissions('ADMIN', ['MANAGE_PAYROLL', 'MANAGE_USERS'])).toBe(true);
    expect(hasAllPermissions('HR_MANAGER', ['MANAGE_PAYROLL', 'MANAGE_USERS'])).toBe(false);
  });

  it('treats the empty list as vacuously true for all, false for any', () => {
    // Guards a real call shape: `canAll([])` on a screen with no declared
    // requirement must not lock the screen.
    expect(hasAllPermissions('EMPLOYEE', [])).toBe(true);
    expect(hasAnyPermission('EMPLOYEE', [])).toBe(false);
  });

  it('denies both for an unknown role instead of throwing', () => {
    expect(hasAnyPermission('NOPE' as UserRole, ['VIEW_DASHBOARD'])).toBe(false);
    expect(hasAllPermissions('NOPE' as UserRole, ['VIEW_DASHBOARD'])).toBe(false);
  });
});

describe('role identity and hierarchy', () => {
  it('ranks ADMIN > HR_MANAGER > MANAGER > EMPLOYEE', () => {
    expect(ROLE_HIERARCHY.ADMIN).toBeGreaterThan(ROLE_HIERARCHY.HR_MANAGER);
    expect(ROLE_HIERARCHY.HR_MANAGER).toBeGreaterThan(ROLE_HIERARCHY.MANAGER);
    expect(ROLE_HIERARCHY.MANAGER).toBeGreaterThan(ROLE_HIERARCHY.EMPLOYEE);
  });

  it('hasRoleLevel is inclusive of the required level', () => {
    expect(hasRoleLevel('ADMIN', 'EMPLOYEE')).toBe(true);
    expect(hasRoleLevel('MANAGER', 'MANAGER')).toBe(true);
    expect(hasRoleLevel('EMPLOYEE', 'MANAGER')).toBe(false);
  });

  it('exposes exactly one true identity predicate per role', () => {
    const predicates = { ADMIN: isAdmin, HR_MANAGER: isHRManager, MANAGER: isManager, EMPLOYEE: isEmployee };
    for (const role of ROLES) {
      const trueOnes = ROLES.filter((r) => predicates[r](role));
      expect(trueOnes).toEqual([role]);
    }
  });
});

describe('canViewEmployee', () => {
  it('lets any role holding VIEW_EMPLOYEES see anyone', () => {
    expect(canViewEmployee('ADMIN', 'e-999')).toBe(true);
    expect(canViewEmployee('HR_MANAGER', 'e-999')).toBe(true);
    expect(canViewEmployee('MANAGER', 'e-999')).toBe(true);
  });

  it('lets an EMPLOYEE see only their own record', () => {
    expect(canViewEmployee('EMPLOYEE', 'e-1', 'e-1')).toBe(true);
    expect(canViewEmployee('EMPLOYEE', 'e-2', 'e-1')).toBe(false);
  });

  it('denies an EMPLOYEE with no known employee id', () => {
    // A user row with no linked employee must not fall through to "allowed".
    expect(canViewEmployee('EMPLOYEE', 'e-1')).toBe(false);
    expect(canViewEmployee('EMPLOYEE', 'e-1', undefined)).toBe(false);
  });
});

describe('canEditEmployee / canApproveRequest', () => {
  it('restricts editing to ADMIN and HR_MANAGER', () => {
    expect(canEditEmployee('ADMIN')).toBe(true);
    expect(canEditEmployee('HR_MANAGER')).toBe(true);
    expect(canEditEmployee('MANAGER')).toBe(false);
    expect(canEditEmployee('EMPLOYEE')).toBe(false);
  });

  it('restricts approval to ADMIN and HR_MANAGER', () => {
    // MANAGER approval, where it exists, comes from the configured approval
    // chain or department headship — not from this static matrix.
    expect(canApproveRequest('ADMIN')).toBe(true);
    expect(canApproveRequest('HR_MANAGER')).toBe(true);
    expect(canApproveRequest('MANAGER')).toBe(false);
    expect(canApproveRequest('EMPLOYEE')).toBe(false);
  });
});

describe('getAccessibleRoutes', () => {
  it('always includes the dashboard and the profile', () => {
    for (const role of ROLES) {
      const routes = getAccessibleRoutes(role);
      expect(routes).toContain('/dashboard');
      expect(routes).toContain('/dashboard/profile');
    }
  });

  it('gives an EMPLOYEE nothing but those two', () => {
    expect(getAccessibleRoutes('EMPLOYEE')).toEqual(['/dashboard', '/dashboard/profile']);
  });

  it('gives MANAGER the read-only screens but not payroll or contracts', () => {
    const routes = getAccessibleRoutes('MANAGER');
    expect(routes).toContain('/dashboard/employees');
    expect(routes).toContain('/dashboard/attendance');
    expect(routes).toContain('/dashboard/leaves');
    expect(routes).toContain('/dashboard/reports');

    expect(routes).not.toContain('/dashboard/payroll');
    expect(routes).not.toContain('/dashboard/contracts');
  });

  it('gives ADMIN a superset of every other role', () => {
    const admin = new Set(getAccessibleRoutes('ADMIN'));
    for (const role of ROLES) {
      for (const route of getAccessibleRoutes(role)) {
        expect(admin.has(route)).toBe(true);
      }
    }
  });
});

describe('getDefaultRouteForRole', () => {
  it('sends every role to /dashboard', () => {
    // Not an oversight: the landing page is shared and the *sidebar* is what
    // differs per role. Pinned here so a future per-role landing page is a
    // deliberate change with a failing test, not a silent one.
    for (const role of ROLES) {
      expect(getDefaultRouteForRole(role)).toBe('/dashboard');
    }
  });

  it('falls back to /dashboard for an unrecognised role', () => {
    expect(getDefaultRouteForRole('WHATEVER' as UserRole)).toBe('/dashboard');
  });
});

describe('the two permission maps agree', () => {
  /**
   * `ROLE_PERMISSIONS` (role → permissions) is what `hasPermission` reads.
   * `PERMISSIONS` (permission → roles) is the older map, kept for the key type
   * and still consulted by eye when someone adds a permission. Nothing keeps
   * them in step, so they can — and do — drift.
   *
   * The two are currently in step. `KNOWN_DRIFT` below is the escape hatch for
   * a disagreement that cannot be fixed immediately — it is empty, and adding
   * to it is a decision to ship a permission that silently answers false.
   */
  const KNOWN_DRIFT = new Set<string>([
    // Empty, and it should stay that way.
    //
    // It previously held five entries, all of them VIEW_VISAS / MANAGE_VISAS:
    // declared in the legacy map but granted to no role, so `hasPermission`
    // answered false for everyone. Harmless only because nothing called them —
    // wiring `can('VIEW_VISAS')` into the visa screens would have hidden them
    // from every user with no error to explain it. Both are now granted in
    // ROLE_PERMISSIONS to match the legacy map.
  ])

  it('has no drift beyond the documented list', () => {
    const drift: string[] = [];

    for (const [permission, legacyRoles] of Object.entries(PERMISSIONS)) {
      for (const role of ROLES) {
        const legacySays = (legacyRoles as readonly string[]).includes(role);
        const activeSays = ROLE_PERMISSIONS[role].includes(permission);
        if (legacySays !== activeSays) drift.push(`${permission}|${role}`);
      }
    }

    const unexpected = drift.filter((d) => !KNOWN_DRIFT.has(d));
    expect(unexpected, 'new drift between PERMISSIONS and ROLE_PERMISSIONS').toEqual([]);
  });

  it('still has every documented drift entry — shrink the list when one is fixed', () => {
    // Stops KNOWN_DRIFT from outliving the problem it describes.
    for (const entry of KNOWN_DRIFT) {
      const [permission, role] = entry.split('|') as [string, UserRole];
      const legacySays = (PERMISSIONS[permission as keyof typeof PERMISSIONS] as readonly string[]).includes(role);
      const activeSays = ROLE_PERMISSIONS[role].includes(permission);
      expect(legacySays === activeSays, `${entry} is fixed — remove it from KNOWN_DRIFT`).toBe(false);
    }
  });

  it('declares no permission in ROLE_PERMISSIONS that PERMISSIONS has never heard of', () => {
    // The reverse direction: a permission granted to a role but absent from the
    // key map is untypeable, so `can('X')` would not compile at the call site.
    const known = new Set(Object.keys(PERMISSIONS));
    const granted = new Set(ROLES.flatMap((r) => ROLE_PERMISSIONS[r]));
    expect([...granted].filter((p) => !known.has(p))).toEqual([]);
  });

  it('covers all four roles in both maps', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
    for (const roles of Object.values(PERMISSIONS)) {
      for (const role of roles as readonly string[]) {
        expect(ROLES).toContain(role as UserRole);
      }
    }
  });
});
