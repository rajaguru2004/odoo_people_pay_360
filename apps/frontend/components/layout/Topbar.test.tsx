import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import { navigationState } from '@/test/router-mock';
import { useAuthStore } from '@/store/authStore';
import { usePageHeaderStore } from '@/store/pageHeaderStore';
import Topbar from './Topbar';

beforeEach(() => {
  usePageHeaderStore.setState({ entry: null });
  useAuthStore.setState({
    user: { id: 'u1', email: 'hr@example.com', role: 'ADMIN', isActive: true },
    isAuthenticated: true,
    hasHydrated: true,
  });
});

describe('Topbar', () => {
  it('draws exactly one heading, from the page that declared it', () => {
    navigationState.pathname = '/dashboard/employees';
    usePageHeaderStore.setState({
      entry: { pathname: '/dashboard/employees', title: 'Employees', subtitle: '42 record(s)' },
    });

    renderWithProviders(<Topbar />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Employees');
    expect(screen.getByText('42 record(s)')).toBeInTheDocument();
  });

  it('ignores a heading left behind by the page just navigated away from', () => {
    // React runs the incoming page's effect before the outgoing page's cleanup,
    // so a stale entry outlives its route by a frame.
    navigationState.pathname = '/dashboard/departments';
    usePageHeaderStore.setState({
      entry: { pathname: '/dashboard/employees', title: 'Employees' },
    });

    renderWithProviders(<Topbar />);

    // Falls back to the nav entry that owns the route we are actually on.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('All departments');
  });

  it('names a page that declares nothing after its nav entry', () => {
    navigationState.pathname = '/dashboard/attendance/reports';
    renderWithProviders(<Topbar />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Attendance reports');
  });

  it('derives the trail from the module down', () => {
    navigationState.pathname = '/dashboard/departments/tree';
    renderWithProviders(<Topbar />);

    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(trail).toHaveTextContent('Organisation');
    expect(trail).toHaveTextContent('Organisational chart');
    expect(screen.getByRole('link', { name: 'Organisation' })).toHaveAttribute(
      'href',
      '/dashboard/organization',
    );
  });

  it('adds the page title as the last crumb on a record page the nav cannot name', () => {
    navigationState.pathname = '/dashboard/departments/abc-123';
    usePageHeaderStore.setState({
      entry: { pathname: '/dashboard/departments/abc-123', title: 'Finance' },
    });

    renderWithProviders(<Topbar />);

    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(trail).toHaveTextContent('All departments');
    expect(trail).toHaveTextContent('Finance');
  });

  it('draws no trail where there is nothing above the page', () => {
    // A trail of one crumb only repeats the heading beside it.
    navigationState.pathname = '/dashboard';
    renderWithProviders(<Topbar />);

    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Dashboard');
  });

  it('keeps the sign-out control', () => {
    navigationState.pathname = '/dashboard';
    renderWithProviders(<Topbar />);
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});
