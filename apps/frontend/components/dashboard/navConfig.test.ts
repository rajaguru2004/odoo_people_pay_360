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

/** Branding with every flagged route ON, so a test can turn one back off. */
function branding(overrides: Partial<BrandingData> = {}): BrandingData {
  return {
    document_engine_enabled: true,
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

  it('hides an opt-in route unless it is explicitly on', () => {
    // The opposite direction, and the reason the two rules cannot be merged:
    // these ship OFF, so an unknown key must hide a screen whose API 404s.
    expect(hrefDisabled('/dashboard/settings/documents', branding())).toBe(false);
    expect(hrefDisabled('/dashboard/settings/documents', null)).toBe(true);
    expect(
      hrefDisabled(
        '/dashboard/settings/documents',
        branding({ document_engine_enabled: false }),
      ),
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
  it('withholds an ADMIN-only child from HR', () => {
    // A role offered a screen its guard then refuses is the defect this closes.
    const hr = hrefsOf('HR_MANAGER', branding());
    expect(hr).not.toContain('/dashboard/audit-logs');
  });

  it('keeps it for an admin', () => {
    expect(hrefsOf('ADMIN', branding())).toContain('/dashboard/audit-logs');
  });

  it('leaves a child with no roles inheriting its parent audience', () => {
    const hr = hrefsOf('HR_MANAGER', branding());
    expect(hr).toContain('/dashboard/payroll/batches');
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
    expect(hub('payroll')).toBe('/dashboard/payroll/manage');
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
    // The document builder was the last flag-gated leaf in the rail and its
    // entry is gone, so the assertion this keeps is the one about the group:
    // pruning a child must never take the rest of System with it. The flag
    // itself is still exercised by the `hrefDisabled` cases above.
    const off = hrefsOf('ADMIN', branding({ document_engine_enabled: false }));
    expect(off).not.toContain('/dashboard/settings/documents');
    expect(off).toContain('/dashboard/settings');
  });

  it('leaves the ungated screens of a group alone', () => {
    const menu = buildMenu('ADMIN', null);
    const payroll = findGroupByModuleKey(menu, 'payroll');
    expect(payroll).toBeDefined();
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
    const at = findGroupForPathname(menu, '/dashboard/talent');
    expect(at?.group.labelKey).toBe('talent');
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
 * Payroll is the only one today: its header points at
 * `/dashboard/payroll/manage`, because `/dashboard/payroll` itself is the
 * payslip screen every role reaches from the user menu. Matching on `href`
 * alone therefore resolved none of the record routes under
 * `/dashboard/payroll/` to the payroll group, and those screens rendered NO
 * breadcrumb trail at all — the defect `basePath` exists to close. The cases
 * below are the exact routes that were blank.
 */
describe('findGroupForPathname — unlistedPaths', () => {
  const menu = buildMenu('ADMIN', branding());

  it('keeps a module claim on a route the rail no longer offers', () => {
    // Projects moved out of the rail and onto the Workplace hub's own cards.
    // The screens still exist, so they must still know which module they are
    // in — a route no group claims renders no breadcrumb trail at all.
    const at = findGroupForPathname(menu, '/dashboard/projects');
    expect(at?.group.labelKey).toBe('workplace');
    // No nav child owns it any more, so the page's own title names it.
    expect(at?.child).toBeUndefined();
  });

  it('claims the record pages under it too', () => {
    expect(findGroupForPathname(menu, '/dashboard/projects/p-1')?.group.labelKey).toBe(
      'workplace',
    );
  });

  it('does not put the entry back in the rail', () => {
    // The whole point of the field: ownership without a line in the menu.
    const workplace = findGroupByModuleKey(menu, 'workplace')!;
    expect(workplace.children!.map((c) => c.href)).not.toContain('/dashboard/projects');
  });

  it('does not let an owned prefix swallow a sibling', () => {
    // `/dashboard/projects` must not claim a `/dashboard/projections` that has
    // its own owner — prefix matching is on path segments, not on characters.
    const at = findGroupForPathname(menu, '/dashboard/projects-archive');
    expect(at?.group.labelKey).not.toBe('workplace');
  });

  it('still lets a longer child href win', () => {
    // Same ordering rule `basePath` relies on: the extra prefixes are scored by
    // length like every other, so nothing above loses its middle crumb.
    const at = findGroupForPathname(menu, '/dashboard/assets/a-1');
    expect(at?.group.labelKey).toBe('workplace');
    expect(at?.child?.labelKey).toBe('assets');
  });
});

describe('findGroupForPathname — basePath', () => {
  const menu = buildMenu('ADMIN', branding());

  it('claims a record route that sits beside the module hub', () => {
    const at = findGroupForPathname(menu, '/dashboard/payroll/run-123');
    expect(at?.group.labelKey).toBe('payroll');
    // No nav child owns a run, so the page's own title has to name it.
    expect(at?.child).toBeUndefined();
  });

  it('claims a route nested deeper than any nav entry', () => {
    const at = findGroupForPathname(menu, '/dashboard/payroll/run-123/items');
    expect(at?.group.labelKey).toBe('payroll');
  });

  it('claims the payslip screen the hub deliberately does not point at', () => {
    const at = findGroupForPathname(menu, '/dashboard/payroll');
    expect(at?.group.labelKey).toBe('payroll');
  });

  it('still lets a longer child href win over the basePath', () => {
    // `/dashboard/payroll/batches` (26) beats `/dashboard/payroll` (18), so a
    // batch keeps its middle crumb instead of collapsing to the module. This is
    // the ordering that makes `basePath` safe to add.
    const at = findGroupForPathname(menu, '/dashboard/payroll/batches/b-1');
    expect(at?.group.labelKey).toBe('payroll');
    expect(at?.child?.labelKey).toBe('payrollBatches');
  });

  it('leaves every group that declares no basePath unchanged', () => {
    // The fallback is `basePath ?? href`, so every other module must resolve
    // exactly as it did before. Guards the blast radius of the matcher change.
    expect(findGroupForPathname(menu, '/dashboard/employees/e-1')?.child?.labelKey).toBe(
      'employeeDirectory',
    );
    expect(findGroupForPathname(menu, '/dashboard/departments/tree')?.child?.labelKey).toBe(
      'organizationalChart',
    );
    expect(findGroupForPathname(menu, '/dashboard/talent')?.child).toBeUndefined();
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
