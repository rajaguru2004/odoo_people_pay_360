import { describe, expect, it } from 'vitest';
import { Building2 } from 'lucide-react';
import {
  buildMenu,
  filterMenuForRole,
  findGroupByModuleKey,
  findGroupForPathname,
  type NavGroup,
} from './navConfig';

const adminMenu = buildMenu('ADMIN');

function labelKeys(menu: NavGroup[]): string[] {
  return menu.map((group) => group.labelKey);
}

function childKeys(menu: NavGroup[], moduleKey: string): string[] {
  return findGroupByModuleKey(menu, moduleKey)?.children?.map((c) => c.labelKey) ?? [];
}

describe('buildMenu', () => {
  it('gives admin and HR the three modules', () => {
    expect(labelKeys(adminMenu)).toEqual(
      expect.arrayContaining(['organization', 'people', 'timeAttendance']),
    );
    expect(labelKeys(buildMenu('HR_MANAGER'))).toEqual(
      expect.arrayContaining(['organization', 'people', 'timeAttendance']),
    );
  });

  it('narrows a child below its parent', () => {
    // A payroll officer reads the contract list because a run reads the salary
    // terms on it, but creating and ending contracts is HR's.
    expect(childKeys(buildMenu('PAYROLL_OFFICER'), 'people')).toContain('allContracts');
    expect(childKeys(buildMenu('PAYROLL_OFFICER'), 'people')).not.toContain('newContract');
    expect(childKeys(buildMenu('HR_MANAGER'), 'people')).toContain('newContract');
  });

  it('leaves a child with no roles of its own to inherit its parent', () => {
    for (const role of ['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER'] as const) {
      expect(childKeys(buildMenu(role), 'people')).toContain('employeeDirectory');
    }
  });

  it('gives a manager the modules but not what changes a record company-wide', () => {
    const menu = buildMenu('MANAGER');
    expect(labelKeys(menu)).toEqual(
      expect.arrayContaining(['organization', 'people', 'timeAttendance']),
    );
    expect(childKeys(menu, 'people')).not.toContain('addEmployee');
    expect(childKeys(menu, 'timeAttendance')).not.toContain('biometricEnrollment');
  });

  it('gives an employee only their own screens', () => {
    expect(labelKeys(buildMenu('EMPLOYEE'))).toEqual(['dashboard', 'payroll', 'settings']);
  });

  it('drops the system group for everyone but an admin', () => {
    expect(labelKeys(adminMenu)).toContain('system');
    expect(labelKeys(buildMenu('HR_MANAGER'))).not.toContain('system');
  });

  it('prunes a group whose children all filtered away', () => {
    // An accordion that opens onto nothing is worse than no entry at all, so the
    // group goes with its last child.
    const menu: NavGroup[] = [
      {
        icon: Building2,
        labelKey: 'organization',
        href: '/dashboard/organization',
        roles: ['ADMIN', 'HR_MANAGER'],
        children: [{ labelKey: 'branches', href: '/dashboard/branches', roles: ['ADMIN'] }],
      },
    ];

    expect(filterMenuForRole(menu, 'HR_MANAGER')).toHaveLength(0);
    expect(filterMenuForRole(menu, 'ADMIN')).toHaveLength(1);
  });

  it('never hands a consumer a group with an empty children array', () => {
    for (const role of ['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER', 'MANAGER', 'EMPLOYEE'] as const) {
      for (const group of buildMenu(role)) {
        expect(group.children?.length ?? 1).toBeGreaterThan(0);
      }
    }
  });

  it('builds no menu at all until the role is known', () => {
    // The session is still being restored; a rail built for "whoever this turns
    // out to be" shows the wrong person's routes for a frame.
    expect(buildMenu(undefined)).toEqual([]);
    expect(buildMenu(null)).toEqual([]);
  });
});

describe('findGroupForPathname', () => {
  it('resolves the longest match, not the first prefix', () => {
    // `/dashboard/departments/tree` starts with `/dashboard/departments`, so a
    // first-match search names the wrong screen.
    const chart = findGroupForPathname(adminMenu, '/dashboard/departments/tree');
    expect(chart?.group.labelKey).toBe('organization');
    expect(chart?.child?.labelKey).toBe('organizationalChart');

    const list = findGroupForPathname(adminMenu, '/dashboard/departments');
    expect(list?.child?.labelKey).toBe('allDepartments');
  });

  it('keeps a record page on its list', () => {
    const detail = findGroupForPathname(adminMenu, '/dashboard/departments/abc-123');
    expect(detail?.child?.labelKey).toBe('allDepartments');
  });

  it('prefers the more specific child of two overlapping ones', () => {
    expect(findGroupForPathname(adminMenu, '/dashboard/employees')?.child?.labelKey).toBe(
      'employeeDirectory',
    );
    expect(findGroupForPathname(adminMenu, '/dashboard/employees/new')?.child?.labelKey).toBe(
      'addEmployee',
    );
  });

  it('gives an exact tie to the child rather than to its group', () => {
    // System and its only child both point at /dashboard/settings; the trail
    // should read "System › Settings" rather than stop at the section.
    const settings = findGroupForPathname(adminMenu, '/dashboard/settings');
    expect(settings?.group.labelKey).toBe('system');
    expect(settings?.child?.labelKey).toBe('settings');
  });

  it('matches a group on its basePath as well as its href', () => {
    // A hub that sits beside the routes it owns still claims them...
    const menu: NavGroup[] = [
      {
        icon: Building2,
        labelKey: 'organization',
        href: '/dashboard/organization/overview',
        basePath: '/dashboard/organization',
        roles: ['ADMIN'],
        children: [{ labelKey: 'branches', href: '/dashboard/branches' }],
      },
    ];

    expect(findGroupForPathname(menu, '/dashboard/organization/units')?.group.labelKey).toBe(
      'organization',
    );
    expect(findGroupForPathname(menu, '/dashboard/organization/units')?.child).toBeUndefined();

    // ...while a longer child href still wins over it.
    expect(findGroupForPathname(menu, '/dashboard/branches')?.child?.labelKey).toBe('branches');
  });

  it('resolves a module hub to its group with no child', () => {
    const hub = findGroupForPathname(adminMenu, '/dashboard/people');
    expect(hub?.group.labelKey).toBe('people');
    expect(hub?.child).toBeUndefined();
  });

  it('answers nothing for a route the menu does not list', () => {
    // `/dashboard` is a prefix of every route in the shell, so an unlisted
    // screen matches that entry and nothing else. Answering with it would light
    // Dashboard in the rail on a page it does not own.
    expect(findGroupForPathname(adminMenu, '/dashboard/nowhere')).toBeUndefined();
    // The dashboard itself still resolves.
    expect(findGroupForPathname(adminMenu, '/dashboard')?.group.labelKey).toBe('dashboard');
  });

  it('returns nothing at all for a route outside the shell', () => {
    expect(findGroupForPathname(adminMenu, '/login')).toBeUndefined();
  });

  it('never names a child the role cannot see', () => {
    // The rail and the tiles read the same answer, so a route hidden from a
    // manager must not surface as their crumb either. /employees/new falls back
    // to the directory they do have rather than naming the form they do not.
    const managerMenu = buildMenu('MANAGER');
    expect(findGroupForPathname(managerMenu, '/dashboard/employees/new')?.child?.labelKey).toBe(
      'employeeDirectory',
    );
  });
});

describe('findGroupByModuleKey', () => {
  it('finds a module by the key its hub passes', () => {
    expect(findGroupByModuleKey(adminMenu, 'timeAttendance')?.href).toBe('/dashboard/time');
  });

  it('returns nothing when the role has no such module', () => {
    expect(findGroupByModuleKey(buildMenu('EMPLOYEE'), 'people')).toBeUndefined();
  });
});
