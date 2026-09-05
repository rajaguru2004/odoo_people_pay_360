import { beforeEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '@/test/utils';
import { navigationState } from '@/test/router-mock';
import { useAuthStore } from '@/store/authStore';
import type { UserRole } from '@/types/auth';
import Sidebar from './Sidebar';

function signIn(role: UserRole) {
  useAuthStore.setState({
    user: { id: 'u1', email: 'user@example.com', role, isActive: true },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });
}

beforeEach(() => {
  useAuthStore.setState({ user: null, isAuthenticated: false, hasHydrated: true });
});

describe('Sidebar', () => {
  it('renders the modules the role has and none it has not', () => {
    signIn('HR_MANAGER');
    renderWithProviders(<Sidebar />);

    expect(screen.getByRole('link', { name: 'People' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Time & attendance' })).toBeInTheDocument();
    // System settings are ADMIN-only, server-side and here.
    expect(screen.queryByRole('link', { name: 'System' })).toBeNull();
  });

  it('opens the section that owns the route and marks the page inside it', () => {
    // Longest match: /dashboard/departments/tree is the chart, not the shorter
    // All departments prefix it also starts with.
    navigationState.pathname = '/dashboard/departments/tree';
    signIn('ADMIN');
    renderWithProviders(<Sidebar />);

    expect(screen.getByRole('button', { name: 'Toggle Organisation' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Organisational chart' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'All departments' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('leaves the other sections shut', () => {
    navigationState.pathname = '/dashboard/departments';
    signIn('ADMIN');
    renderWithProviders(<Sidebar />);

    expect(screen.getByRole('button', { name: 'Toggle People' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('link', { name: 'Employee directory' })).toBeNull();
  });

  it('opens a section on the chevron without navigating', async () => {
    const user = userEvent.setup();
    navigationState.pathname = '/dashboard';
    signIn('ADMIN');
    renderWithProviders(<Sidebar />);

    await user.click(screen.getByRole('button', { name: 'Toggle People' }));

    expect(screen.getByRole('link', { name: 'Employee directory' })).toHaveAttribute(
      'href',
      '/dashboard/employees',
    );
  });

  it('marks a module hub as the current page, and only it', () => {
    navigationState.pathname = '/dashboard/organization';
    signIn('ADMIN');
    const { container } = renderWithProviders(<Sidebar />);

    expect(screen.getByRole('link', { name: 'Organisation' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it('gives a group and its identically-addressed child one mark between them', () => {
    // System and Settings point at the same screen; marking both would leave the
    // rail claiming two current pages.
    navigationState.pathname = '/dashboard/settings';
    signIn('ADMIN');
    const { container } = renderWithProviders(<Sidebar />);

    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  });

  it('does not light the dashboard entry on a route it does not own', () => {
    // `/dashboard` is a prefix of every route in the shell; treating that as
    // ownership would leave Dashboard highlighted everywhere.
    navigationState.pathname = '/dashboard/employees';
    signIn('ADMIN');
    renderWithProviders(<Sidebar />);

    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('renders nothing until the session says who is asking', () => {
    const { container } = renderWithProviders(<Sidebar />);
    expect(container.querySelectorAll('nav a')).toHaveLength(0);
  });
});
