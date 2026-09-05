import { describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import ModuleNavTiles from './ModuleNavTiles';

/**
 * The tiles are the module hub's navigation, and they are fed from the same
 * `buildMenu` output as the rail.
 *
 * That is the whole safety property worth testing here: if the two ever
 * diverge, a hub offers a screen the sidebar hides and `ProtectedRoute` then
 * bounces the user to /403 — a dead end reached from a link we drew ourselves.
 */

function hrefs(): string[] {
  return Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')!);
}

describe('ModuleNavTiles', () => {
  it('renders every child of the module as a link', () => {
    renderWithProviders(<ModuleNavTiles moduleKey="workplace" />, { role: 'ADMIN' });

    expect(hrefs()).toEqual(
      expect.arrayContaining(['/dashboard/assets', '/dashboard/letters']),
    );
  });

  it('mirrors a feature kill switch', () => {
    renderWithProviders(<ModuleNavTiles moduleKey="leaveOvertime" />, {
      role: 'ADMIN',
      branding: { overtime_enabled: false },
    });

    expect(hrefs()).toContain('/dashboard/leaves');
    expect(hrefs()).not.toContain('/dashboard/overtime');
  });

  it('mirrors a child role narrowing', () => {
    // Bank Master is ADMIN-only server-side; HR must not be offered the tile.
    renderWithProviders(<ModuleNavTiles moduleKey="payroll" />, { role: 'HR_MANAGER' });
    expect(hrefs()).not.toContain('/dashboard/banks');

    renderWithProviders(<ModuleNavTiles moduleKey="payroll" />, { role: 'ADMIN' });
    expect(hrefs()).toContain('/dashboard/banks');
  });

  it('renders nothing for a module the current role has no group for', () => {
    const { container } = renderWithProviders(<ModuleNavTiles moduleKey="payroll" />, {
      role: 'EMPLOYEE',
    });
    expect(container.querySelectorAll('a[href]').length).toBe(0);
  });

  it('shows a live badge only when the count is above zero', () => {
    renderWithProviders(
      <ModuleNavTiles
        moduleKey="leaveOvertime"
        badges={{ pendingLeaves: 7, leaveRequests: 0 }}
        badgeTones={{ pendingLeaves: 'warning' }}
      />,
      { role: 'ADMIN' },
    );

    // An empty queue is not news, so a zero draws no pill at all.
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('caps an unreadably large badge', () => {
    renderWithProviders(<ModuleNavTiles moduleKey="leaveOvertime" badges={{ pendingLeaves: 512 }} />, {
      role: 'ADMIN',
    });
    expect(screen.getByText('99+')).toBeTruthy();
  });
});
