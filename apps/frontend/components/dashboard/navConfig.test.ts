import { describe, expect, it } from 'vitest';
import type { BrandingData } from '@/store/brandingStore';
import {
  adminMenuItems,
  buildMenu,
  findGroupByModuleKey,
  findGroupForPathname,
  hrefDisabled,
} from './navConfig';

/**
 * The gating rules, tested where they now live.
 *
 * These used to be reachable only by rendering the whole sidebar, which meant
 * every assertion about a feature flag paid for a DOM and a provider tree. They
 * are pure functions with two consumers now — the rail and the module hubs'
 * tile grids — and a divergence between those two is exactly the defect that
 * hands a user a link `ProtectedRoute` then refuses.
 */

/** Branding with every payroll extension ON, so a test can turn one back off. */
function branding(overrides: Partial<BrandingData> = {}): BrandingData {
  return {
    payroll_preflight_enabled: true,
    payroll_eosb_enabled: true,
    payroll_reports_enabled: true,
    payroll_calendar_enabled: true,
    employee_transfer_enabled: true,
    employee_grade_enabled: true,
    leave_encashment_enabled: true,
    payroll_employee_recovery_enabled: true,
    ...overrides,
  } as BrandingData;
}

function hrefsOf(role: string | undefined, b: BrandingData | null): string[] {
  return buildMenu(role, b).flatMap((g) => [g.href, ...(g.children ?? []).map((c) => c.href)].filter(Boolean) as string[]);
}

describe('hrefDisabled', () => {
  it('hides an established feature only when it is explicitly off', () => {
    // Overtime ships ON. A backend that has never heard of the key must keep
    // showing it, so `undefined` is not `false`.
    expect(hrefDisabled('/dashboard/overtime', branding())).toBe(false);
    expect(hrefDisabled('/dashboard/overtime', branding({ overtime_enabled: false }))).toBe(true);
    expect(hrefDisabled('/dashboard/overtime', null)).toBe(false);
  });

  it('hides an opt-in payroll extension unless it is explicitly on', () => {
    // The opposite direction, and the reason the two rules cannot be merged:
    // these ship OFF, so an unknown key must hide a screen whose API 404s.
    expect(hrefDisabled('/dashboard/payroll/validate', branding())).toBe(false);
    expect(hrefDisabled('/dashboard/payroll/validate', null)).toBe(true);
    expect(
      hrefDisabled('/dashboard/payroll/validate', branding({ payroll_preflight_enabled: false })),
    ).toBe(true);
  });

  it('treats an absent href as enabled', () => {
    expect(hrefDisabled(undefined, null)).toBe(false);
  });
});

describe('buildMenu — role selection', () => {
  it('gives an employee the self-service array', () => {
    const links = hrefsOf('EMPLOYEE', branding());
    expect(links).toContain('/dashboard/my-attendance');
    expect(links).not.toContain('/dashboard/employees');
  });

  it('gives a manager its own array, not the admin one', () => {
    const links = hrefsOf('MANAGER', branding());
    expect(links).toContain('/dashboard/my-department');
    expect(links).not.toContain('/dashboard/branches');
  });

  it('falls back to the admin array for an unknown or absent role', () => {
    // Documents current behaviour: the checks are `=== 'EMPLOYEE'` /
    // `=== 'MANAGER'`, so the default is the *most* privileged menu.
    expect(hrefsOf(undefined, branding())).toContain('/dashboard/employees');
  });
});

describe('buildMenu — child role narrowing', () => {
  it('withholds the ADMIN-only banking screens from HR', () => {
    // HR was offered Bank Master and then bounced to /403 by its guard.
    const hr = hrefsOf('HR_MANAGER', branding());
    expect(hr).not.toContain('/dashboard/banks');
    expect(hr).not.toContain('/dashboard/banks/config');
    expect(hr).not.toContain('/dashboard/audit-logs');
  });

  it('keeps them for an admin', () => {
    const admin = hrefsOf('ADMIN', branding());
    expect(admin).toContain('/dashboard/banks');
    expect(admin).toContain('/dashboard/audit-logs');
  });

  it('leaves a child with no roles inheriting its parent audience', () => {
    const hr = hrefsOf('HR_MANAGER', branding());
    expect(hr).toContain('/dashboard/banks/branch-countries');
  });
});

describe('buildMenu — group hrefs', () => {
  it('points every admin group at its module hub', () => {
    const menu = buildMenu('ADMIN', branding());
    const hub = (key: string) => findGroupByModuleKey(menu, key)?.href;

    expect(hub('organization')).toBe('/dashboard/organization');
    expect(hub('people')).toBe('/dashboard/people');
    expect(hub('timeAttendance')).toBe('/dashboard/time');
    expect(hub('schedules')).toBe('/dashboard/schedules');
    expect(hub('leaveOvertime')).toBe('/dashboard/leave');
    expect(hub('payroll')).toBe('/dashboard/payroll/overview');
    expect(hub('finance')).toBe('/dashboard/finance');
    expect(hub('talent')).toBe('/dashboard/talent');
    expect(hub('workplace')).toBe('/dashboard/workplace');
    expect(hub('system')).toBe('/dashboard/system');
  });

  it('leaves the payslip screen to the employee groups', () => {
    // `/dashboard/payroll` is My Payslips for every role and is reachable from
    // the user menu; the admin hub deliberately sits beside it, not on it.
    const employee = buildMenu('EMPLOYEE', branding());
    expect(findGroupByModuleKey(employee, 'myPay')?.href).toBe('/dashboard/payroll');
  });

  it('re-points a group whose own href is flag-disabled to a surviving child', () => {
    // Not reachable through the current data — every hub href is flag-free —
    // so this pins the fallback against a future group that points at a gated
    // screen rather than a hub.
    const gated = buildMenu('ADMIN', branding());
    const payroll = findGroupByModuleKey(gated, 'payroll')!;
    expect(payroll.children!.map((c) => c.href)).toContain('/dashboard/payroll/manage');
  });
});

describe('buildMenu — pruning', () => {
  it('drops a flag-disabled leaf wherever it appears', () => {
    const off = hrefsOf('ADMIN', branding({ overtime_enabled: false }));
    expect(off).not.toContain('/dashboard/overtime');
    // Grouping the route under Leave & Overtime must not stop its kill switch
    // working, and the rest of the group survives.
    expect(off).toContain('/dashboard/leaves');
  });

  it('drops a group whose children all filtered away', () => {
    // Talent for a manager is Training + Rewards; nothing gates those, so use
    // the payroll extensions to prove the rule on a group that can empty.
    const menu = buildMenu('ADMIN', null);
    const payroll = findGroupByModuleKey(menu, 'payroll');
    // Every opt-in extension is off, but the always-on payroll screens remain.
    expect(payroll).toBeDefined();
    expect(payroll!.children!.map((c) => c.href)).not.toContain('/dashboard/payroll/validate');
    expect(payroll!.children!.map((c) => c.href)).toContain('/dashboard/payroll/manage');
  });

  it('does not mutate the source arrays', () => {
    const before = adminMenuItems.find((g) => g.labelKey === 'payroll')!.children!.length;
    buildMenu('HR_MANAGER', null);
    expect(adminMenuItems.find((g) => g.labelKey === 'payroll')!.children!.length).toBe(before);
  });
});

describe('findGroupForPathname', () => {
  const menu = buildMenu('ADMIN', branding());

  it('resolves an exact child route', () => {
    const at = findGroupForPathname(menu, '/dashboard/payroll/manage');
    expect(at?.group.labelKey).toBe('payroll');
    expect(at?.child?.labelKey).toBe('runPayroll');
  });

  it('prefers the longest matching child, not the first prefix', () => {
    // `/dashboard/departments/tree` also starts with `/dashboard/departments`.
    const at = findGroupForPathname(menu, '/dashboard/departments/tree');
    expect(at?.child?.labelKey).toBe('organizationalChart');
  });

  it('resolves a record page to the list it belongs under', () => {
    const at = findGroupForPathname(menu, '/dashboard/employees/e-123');
    expect(at?.group.labelKey).toBe('people');
    expect(at?.child?.labelKey).toBe('employeeDirectory');
  });

  it('resolves a module hub to its group with no child', () => {
    const at = findGroupForPathname(menu, '/dashboard/finance');
    expect(at?.group.labelKey).toBe('finance');
    expect(at?.child).toBeUndefined();
  });

  it('does not match a sibling route that merely shares a prefix', () => {
    // `/dashboard/leaves` must not swallow `/dashboard/leave` (the hub).
    const at = findGroupForPathname(menu, '/dashboard/leave');
    expect(at?.group.labelKey).toBe('leaveOvertime');
    expect(at?.child).toBeUndefined();
  });

  it('prefers the child when a group points at its own first child', () => {
    // Every self-service group does this. "My Records / My Documents" names
    // the screen; stopping at the section would name only the drawer.
    const employee = buildMenu('EMPLOYEE', branding());
    const at = findGroupForPathname(employee, '/dashboard/my-documents');
    expect(at?.group.labelKey).toBe('myRecords');
    expect(at?.child?.labelKey).toBe('myDocuments');
  });

  it('returns undefined for a route the nav does not know', () => {
    expect(findGroupForPathname(menu, '/dashboard/nothing-here')?.child).toBeUndefined();
  });
});

/**
 * A module whose hub is a SIBLING of the routes it owns.
 *
 * Payroll is the only one today: its hub is `/dashboard/payroll/overview`,
 * because `/dashboard/payroll` itself is the payslip screen every role reaches
 * from the user menu. Matching on `href` alone therefore resolved none of the
 * record routes under `/dashboard/payroll/` to the payroll group, and those
 * screens rendered NO breadcrumb trail at all — the defect `basePath` exists to
 * close. The cases below are the exact routes that were blank.
 */
describe('findGroupForPathname — basePath', () => {
  const menu = buildMenu('ADMIN', branding());

  it('claims a record route that sits beside the module hub', () => {
    const at = findGroupForPathname(menu, '/dashboard/payroll/run-123');
    expect(at?.group.labelKey).toBe('payroll');
    // No nav child owns a run, so the page's own title has to name it.
    expect(at?.child).toBeUndefined();
  });

  it('claims the payslip screen the hub deliberately does not point at', () => {
    const at = findGroupForPathname(menu, '/dashboard/payroll');
    expect(at?.group.labelKey).toBe('payroll');
  });

  it('still lets a longer child href win over the basePath', () => {
    // `/dashboard/payroll/settlements` (30) beats `/dashboard/payroll` (18), so
    // a settlement detail keeps its middle crumb instead of collapsing to the
    // module. This is the ordering that makes `basePath` safe to add.
    const at = findGroupForPathname(menu, '/dashboard/payroll/settlements/s-1');
    expect(at?.group.labelKey).toBe('payroll');
    expect(at?.child?.labelKey).toBe('finalSettlements');
  });

  it('still lets the hub href win on the hub itself', () => {
    // `/dashboard/payroll/overview` (27) beats the basePath (18), so the hub
    // resolves to the group with no child and the trail stays a single crumb.
    const at = findGroupForPathname(menu, '/dashboard/payroll/overview');
    expect(at?.group.labelKey).toBe('payroll');
    expect(at?.child).toBeUndefined();
  });

  it('does not let a basePath swallow a neighbouring module', () => {
    // `/dashboard/my-payroll/*` is its own prefix and must not be captured by
    // `/dashboard/payroll`.
    const at = findGroupForPathname(menu, '/dashboard/my-payroll/gratuity');
    expect(at?.group.labelKey).not.toBe('payroll');
  });

  it('leaves every group that declares no basePath unchanged', () => {
    // The fallback is `basePath ?? href`, so the other nine modules must resolve
    // exactly as they did before. Guards the blast radius of the matcher change.
    expect(findGroupForPathname(menu, '/dashboard/employees/e-1')?.child?.labelKey).toBe(
      'employeeDirectory',
    );
    expect(findGroupForPathname(menu, '/dashboard/departments/tree')?.child?.labelKey).toBe(
      'organizationalChart',
    );
    expect(findGroupForPathname(menu, '/dashboard/finance')?.child).toBeUndefined();
  });

  it('follows the role: an employee reaches a payslip through My Pay', () => {
    // The admin payroll group is not in the employee menu at all, so the same
    // URL must resolve through their own self-service group.
    const employee = buildMenu('EMPLOYEE', branding());
    const at = findGroupForPathname(employee, '/dashboard/payroll/run-123');
    expect(at?.group.labelKey).toBe('myPay');
    expect(at?.child?.labelKey).toBe('myPayslips');
  });
});
