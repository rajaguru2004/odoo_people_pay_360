import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { navigationState } from '@/test/router-mock';
import Sidebar from './Sidebar';

/**
 * Navigation, which is where role separation is actually enforced in the UI.
 *
 * `getDefaultRouteForRole` sends every role to `/dashboard`, so the landing
 * page is shared and the sidebar is the only thing that differs. That makes
 * this component the cheapest and most direct RBAC assertion available: three
 * hardcoded menu arrays, selected by role, filtered by feature flags, with two
 * data-driven overlays on top.
 *
 * Assertions key on `href`, never on visible text. Labels come from next-intl
 * and exist in English and Arabic; a link's destination is the thing that
 * matters and the thing that stays stable.
 */

vi.mock('@/services/supervisorService', () => ({
  default: { getMyTeam: vi.fn() },
}));

vi.mock('@/services/approvalWorkflowService', () => ({
  default: { canApprove: vi.fn() },
}));

import supervisorService from '@/services/supervisorService';
import approvalWorkflowService from '@/services/approvalWorkflowService';

const getMyTeam = vi.mocked(supervisorService.getMyTeam);
const canApprove = vi.mocked(approvalWorkflowService.canApprove);

/** Every href the sidebar is currently offering. */
function hrefs(): string[] {
  return Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')!);
}

async function renderSidebar(options: Parameters<typeof renderWithProviders>[1] = {}) {
  const result = renderWithProviders(<Sidebar isOpen onToggle={() => {}} />, options);
  // Both overlays resolve in effects; wait so assertions see the settled menu.
  await waitFor(() => expect(canApprove).toHaveBeenCalled());
  return result;
}

beforeEach(() => {
  getMyTeam.mockReset();
  canApprove.mockReset();
  getMyTeam.mockResolvedValue({ data: [] } as never);
  canApprove.mockResolvedValue({ data: { isApprover: false } } as never);
  navigationState.pathname = '/dashboard';
});

describe('the admin menu', () => {
  it('offers the administrative screens', async () => {
    await renderSidebar({ role: 'ADMIN' });
    const links = hrefs();

    expect(links).toContain('/dashboard/employees');
    expect(links).toContain('/dashboard/branches');
    expect(links).toContain('/dashboard/departments');
    expect(links).toContain('/dashboard/attendance');
  });

  it('gives HR_MANAGER the same array as ADMIN', async () => {
    // One array serves both; the labels that used to say ADMIN-only were
    // decorative and never enforced. Pinned so a future split is deliberate.
    const admin = await renderSidebar({ role: 'ADMIN' });
    const adminLinks = new Set(hrefs());
    admin.unmount();

    await renderSidebar({ role: 'HR_MANAGER' });
    const hrLinks = new Set(hrefs());

    // Approvals is the one deliberate difference (HR sits in chains, admins
    // override from the domain screens), and it is gated on isApprover anyway.
    expect([...hrLinks].filter((l) => l !== '/dashboard/approvals' && !adminLinks.has(l))).toEqual([]);
  });
});

describe('the employee menu', () => {
  it('offers the self-service screens', async () => {
    await renderSidebar({ role: 'EMPLOYEE' });
    const links = hrefs();

    expect(links).toContain('/dashboard/my-attendance');
    expect(links).toContain('/dashboard/my-leaves');
  });

  it('withholds every administrative screen', async () => {
    // The leak this guards: an employee shown a payroll or employee-directory
    // link gets a 403 at best, and at worst discovers a screen that renders.
    await renderSidebar({ role: 'EMPLOYEE' });
    const links = hrefs();

    expect(links).not.toContain('/dashboard/employees');
    expect(links).not.toContain('/dashboard/payroll/manage');
    expect(links).not.toContain('/dashboard/branches');
    expect(links).not.toContain('/dashboard/departments');
    expect(links).not.toContain('/dashboard/audit-logs');
    expect(links).not.toContain('/dashboard/settings/system');
  });

  it('offers no link into another employee’s record', async () => {
    await renderSidebar({ role: 'EMPLOYEE' });
    expect(hrefs().some((h) => h.startsWith('/dashboard/employees'))).toBe(false);
  });
});

describe('the manager menu', () => {
  it('is its own array, not the admin one', async () => {
    await renderSidebar({ role: 'MANAGER' });
    const links = hrefs();

    expect(links).not.toContain('/dashboard/branches');
    expect(links).not.toContain('/dashboard/audit-logs');
  });

  it('offers the department views', async () => {
    await renderSidebar({ role: 'MANAGER' });
    expect(hrefs().some((h) => h.startsWith('/dashboard/my-department'))).toBe(true);
  });
});

describe('feature kill switches', () => {
  it('hides overtime from an admin when the feature is off', async () => {
    // Checked against the href rather than the item, so grouping a route under
    // a parent does not quietly stop its kill switch working.
    await renderSidebar({ role: 'ADMIN', branding: { overtime_enabled: false } });
    expect(hrefs()).not.toContain('/dashboard/overtime');
  });

  it('hides my-overtime from an employee when the feature is off', async () => {
    await renderSidebar({ role: 'EMPLOYEE', branding: { overtime_enabled: false } });
    expect(hrefs()).not.toContain('/dashboard/my-overtime');
  });

  it('shows overtime when the feature is on', async () => {
    await renderSidebar({ role: 'EMPLOYEE', branding: { overtime_enabled: true } });
    expect(hrefs()).toContain('/dashboard/my-overtime');
  });

  it('leaves unrelated links alone when a switch is off', async () => {
    await renderSidebar({ role: 'ADMIN', branding: { overtime_enabled: false } });
    expect(hrefs()).toContain('/dashboard/employees');
  });
});

describe('the data-driven overlays', () => {
  it('hides Approvals from someone who is in no approval chain', async () => {
    // Not role-derived: HR, admins and department heads all sit in configured
    // chains, so the backend is the authority on who may act.
    canApprove.mockResolvedValue({ data: { isApprover: false } } as never);
    await renderSidebar({ role: 'HR_MANAGER' });
    expect(hrefs()).not.toContain('/dashboard/approvals');
  });

  it('shows Approvals once the backend says the user is an approver', async () => {
    canApprove.mockResolvedValue({ data: { isApprover: true } } as never);
    await renderSidebar({ role: 'HR_MANAGER' });
    await waitFor(() => expect(hrefs()).toContain('/dashboard/approvals'));
  });

  it('hides My Team from an employee with no supervisees', async () => {
    getMyTeam.mockResolvedValue({ data: [] } as never);
    await renderSidebar({ role: 'EMPLOYEE' });
    expect(hrefs()).not.toContain('/dashboard/my-team');
  });

  it('shows My Team once the employee has supervisees', async () => {
    // A data-driven role, not an RBAC one: being a supervisor is an assignment.
    getMyTeam.mockResolvedValue({ data: [{ id: 'e-2' }] } as never);
    await renderSidebar({ role: 'EMPLOYEE' });
    await waitFor(() => expect(hrefs()).toContain('/dashboard/my-team'));
  });

  it('treats a failed overlay probe as "not a supervisor" rather than crashing', async () => {
    // Failing open here would show a team screen to someone with no team.
    getMyTeam.mockRejectedValue(new Error('network'));
    canApprove.mockRejectedValue(new Error('network'));
    await renderSidebar({ role: 'EMPLOYEE' });

    expect(hrefs()).not.toContain('/dashboard/my-team');
    expect(hrefs()).not.toContain('/dashboard/approvals');
  });

  it('does not probe for supervisees when the user has no employee record', async () => {
    await renderSidebar({ role: 'ADMIN', user: { employeeId: undefined } });
    expect(getMyTeam).not.toHaveBeenCalled();
  });
});

describe('logged out', () => {
  it('falls back to the admin array rather than crashing with no user', async () => {
    // Documents current behaviour: the role check is `=== 'EMPLOYEE'` /
    // `=== 'MANAGER'`, so an absent user lands on the admin menu. The dashboard
    // layout redirects an unauthenticated visitor before this matters, but the
    // default being the *most* privileged menu is worth knowing about.
    renderWithProviders(<Sidebar isOpen onToggle={() => {}} />, { role: null });
    expect(hrefs()).toContain('/dashboard/employees');
  });
});

describe('active-route marking', () => {
  it('marks the current route', async () => {
    navigationState.pathname = '/dashboard/employees';
    await renderSidebar({ role: 'ADMIN' });

    const link = document.querySelector('a[href="/dashboard/employees"]')!;
    // The styling token differs by theme; what matters is that exactly one
    // branch of the active/inactive conditional applied.
    expect(link.className).not.toBe('');
  });

  it('marks a group as active when its own hub is the current route', async () => {
    navigationState.pathname = '/dashboard/talent';
    await renderSidebar({ role: 'ADMIN' });

    const row = document.querySelector('a[href="/dashboard/talent"]')!.parentElement!;
    expect(row.className).toContain('bg-sidebar-active-bg');
  });
});

describe('group headers navigate', () => {
  it('links each group to its module hub instead of only expanding', async () => {
    // The whole point of the change: a group used to be a <button> that
    // toggled and nothing more, so the hub href in the data was unreachable.
    await renderSidebar({ role: 'ADMIN' });
    const links = hrefs();

    expect(links).toContain('/dashboard/payroll/manage');
    expect(links).toContain('/dashboard/people');
    expect(links).toContain('/dashboard/time');
    expect(links).toContain('/dashboard/organization');
  });

  it('keeps the chevron a separate control that does not navigate', async () => {
    // A <button> nested in an <a> is invalid markup and swallows one of the two
    // intents, so they are siblings: label navigates, chevron expands.
    const { user } = await renderSidebar({ role: 'ADMIN' });

    const toggle = screen.getByRole('button', { name: /Payroll submenu/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await user.click(toggle);

    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
    // Expanding is not navigating. Asserted on a child rather than the group's
    // own hub, which is already in the list before the chevron is touched.
    expect(navigationState.pathname).toBe('/dashboard');
    expect(hrefs()).toContain('/dashboard/payroll/batches');
  });

  it('collapses an expanded group on a second chevron click', async () => {
    const { user } = await renderSidebar({ role: 'ADMIN' });
    const toggle = screen.getByRole('button', { name: /Talent submenu/i });

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
  });

  it('auto-expands the group that owns the current route', async () => {
    // A child, not the group's own hub — landing on the hub deliberately leaves
    // the accordion shut, which the case below pins.
    navigationState.pathname = '/dashboard/payroll/batches';
    await renderSidebar({ role: 'ADMIN' });

    const toggle = screen.getByRole('button', { name: /Payroll submenu/i });
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
  });

  it('leaves the group shut when its own hub is the current route', async () => {
    // Following the group label is a navigation, not an expansion: the hub page
    // lists the same children as tiles, so springing the accordion open too
    // duplicates what the user is already looking at.
    navigationState.pathname = '/dashboard/talent';
    await renderSidebar({ role: 'ADMIN' });

    const toggle = screen.getByRole('button', { name: /Talent submenu/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('shuts an open group when the user then lands on another group hub', async () => {
    const { user, rerender } = await renderSidebar({ role: 'ADMIN' });
    const toggle = screen.getByRole('button', { name: /Talent submenu/i });

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));

    navigationState.pathname = '/dashboard/workplace';
    rerender(<Sidebar isOpen onToggle={() => {}} />);

    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
  });
});

describe('the collapsed rail', () => {
  async function renderCollapsed(onToggle = () => {}) {
    const result = renderWithProviders(<Sidebar isOpen={false} onToggle={onToggle} />, { role: 'ADMIN' });
    await waitFor(() => expect(canApprove).toHaveBeenCalled());
    return result;
  }

  it('links a group icon straight to its hub rather than prising the rail open', async () => {
    // The hub repeats the same children as tiles, so a user working from the
    // icon rail never has to expand it to get anywhere.
    await renderCollapsed();
    expect(hrefs()).toContain('/dashboard/payroll/manage');
  });

  it('offers no chevron to press, since there is nowhere to show a submenu', async () => {
    await renderCollapsed();
    expect(screen.queryByRole('button', { name: /Payroll submenu/i })).toBeNull();
  });

  it('leaves the rail collapsed when a group icon is clicked', async () => {
    const onToggle = vi.fn();
    const { user } = await renderCollapsed(onToggle);

    await user.click(document.querySelector('a[href="/dashboard/payroll/manage"]')!);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('names the icon on hover, since the rail shows no labels', async () => {
    // The label the expanded rail prints is the label the tooltip must repeat —
    // read it from the expanded render rather than hardcoding a translation.
    const expanded = await renderSidebar({ role: 'ADMIN' });
    const label = document.querySelector('a[href="/dashboard/talent"]')!.textContent!.trim();
    expanded.unmount();
    expect(label).not.toBe('');

    const { user } = await renderCollapsed();
    await user.hover(document.querySelector('a[href="/dashboard/talent"]')!);

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe(label);
  });

  it('drops the tooltip again when the pointer leaves', async () => {
    const { user } = await renderCollapsed();
    const link = document.querySelector('a[href="/dashboard/talent"]')!;

    await user.hover(link);
    await screen.findByRole('tooltip');

    await user.unhover(link);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('names a childless item too, not only the groups', async () => {
    const { user } = await renderCollapsed();
    await user.hover(document.querySelector('a[href="/dashboard/copilot"]')!);

    expect((await screen.findByRole('tooltip')).textContent).not.toBe('');
  });

  it('shows no tooltip once the rail is expanded', async () => {
    // A hover left open while the rail expands would strand a chip over the
    // label it is duplicating.
    const { user } = await renderSidebar({ role: 'ADMIN' });
    await user.hover(document.querySelector('a[href="/dashboard/talent"]')!);

    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
