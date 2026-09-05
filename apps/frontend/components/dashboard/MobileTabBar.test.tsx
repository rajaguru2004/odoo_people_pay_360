import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { routerMock, navigationState } from '@/test/router-mock';
import MobileTabBar from './MobileTabBar';

/**
 * The ESS phone tab bar.
 *
 * The one thing worth pinning beyond "it renders five tabs" is the active
 * match: Home is EXACT and the other three are prefixes. Without that, Home
 * stays lit on every screen under `/dashboard/…`, which is every screen there
 * is — the bar would never show where the reader actually is.
 */

describe('MobileTabBar', () => {
  it('carries five labelled destinations', () => {
    renderWithProviders(<MobileTabBar onMoreClick={vi.fn()} />, { role: 'EMPLOYEE' });

    for (const label of ['Home', 'Attendance', 'Leave', 'Payslip', 'More']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('lights Home only on the dashboard itself', () => {
    navigationState.pathname = '/dashboard';
    const { unmount } = renderWithProviders(<MobileTabBar onMoreClick={vi.fn()} />, { role: 'EMPLOYEE' });
    expect(screen.getByTestId('mobile-tab-navHome')).toHaveAttribute('aria-current', 'page');
    unmount();

    navigationState.pathname = '/dashboard/my-leaves';
    renderWithProviders(<MobileTabBar onMoreClick={vi.fn()} />, { role: 'EMPLOYEE' });
    expect(screen.getByTestId('mobile-tab-navHome')).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('mobile-tab-navLeave')).toHaveAttribute('aria-current', 'page');
  });

  it('stays lit on a child route of its section', () => {
    navigationState.pathname = '/dashboard/attendance/corrections';
    renderWithProviders(<MobileTabBar onMoreClick={vi.fn()} />, { role: 'EMPLOYEE' });
    expect(screen.getByTestId('mobile-tab-navAttendance')).toHaveAttribute('aria-current', 'page');
  });

  /**
   * A tab's destination and its lit-up routes are deliberately different
   * segments: leave is filed from `/dashboard/my-leaves` and read under
   * `/dashboard/leaves`. Conflating the two is what made an earlier version
   * navigate to a segment that had no page.
   */
  it('sends the leave tab to the self-service list, not to the segment it also lights on', async () => {
    const { user } = renderWithProviders(<MobileTabBar onMoreClick={vi.fn()} />, { role: 'EMPLOYEE' });
    await user.click(screen.getByTestId('mobile-tab-navLeave'));
    expect(routerMock.push).toHaveBeenCalledWith('/dashboard/my-leaves');
  });

  it.each([
    ['/dashboard/payroll', 'mobile-tab-navPayslip'],
    ['/dashboard/payroll/abc-123', 'mobile-tab-navPayslip'],
    ['/dashboard/leaves/new', 'mobile-tab-navLeave'],
    ['/dashboard/leaves/abc-123', 'mobile-tab-navLeave'],
    ['/dashboard/attendance/corrections', 'mobile-tab-navAttendance'],
  ])('lights the right tab on %s', (pathname, testId) => {
    navigationState.pathname = pathname;
    renderWithProviders(<MobileTabBar onMoreClick={vi.fn()} />, { role: 'EMPLOYEE' });
    expect(screen.getByTestId(testId)).toHaveAttribute('aria-current', 'page');
  });

  it('does not light a tab on a sibling segment that merely shares its prefix', () => {
    // `/dashboard/payroll-something` is not under `/dashboard/payroll`, and a
    // bare startsWith() would have said it was.
    navigationState.pathname = '/dashboard/payroll-reports';
    renderWithProviders(<MobileTabBar onMoreClick={vi.fn()} />, { role: 'EMPLOYEE' });
    expect(screen.getByTestId('mobile-tab-navPayslip')).not.toHaveAttribute('aria-current');
  });

  it('navigates on tap', async () => {
    const { user } = renderWithProviders(<MobileTabBar onMoreClick={vi.fn()} />, { role: 'EMPLOYEE' });
    await user.click(screen.getByTestId('mobile-tab-navAttendance'));
    expect(routerMock.push).toHaveBeenCalledWith('/dashboard/my-attendance');
  });

  it('opens the drawer from More rather than routing', async () => {
    const onMoreClick = vi.fn();
    const { user } = renderWithProviders(<MobileTabBar onMoreClick={onMoreClick} />, { role: 'EMPLOYEE' });

    await user.click(screen.getByTestId('mobile-tab-navMore'));
    expect(onMoreClick).toHaveBeenCalledTimes(1);
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});
