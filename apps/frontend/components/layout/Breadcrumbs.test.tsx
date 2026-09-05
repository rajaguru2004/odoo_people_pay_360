import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import { navigationState } from '@/test/router-mock';
import { useAuthStore } from '@/store/authStore';
import { usePageHeaderStore } from '@/store/pageHeaderStore';
import Breadcrumbs from './Breadcrumbs';

beforeEach(() => {
  usePageHeaderStore.setState({ entry: null });
  useAuthStore.setState({
    user: { id: 'u1', email: 'hr@example.com', role: 'ADMIN', isActive: true },
    isAuthenticated: true,
    hasHydrated: true,
  });
});

describe('Breadcrumbs', () => {
  it('derives the trail from the module down', () => {
    navigationState.pathname = '/dashboard/departments/tree';
    renderWithProviders(<Breadcrumbs />);

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

    renderWithProviders(<Breadcrumbs />);

    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(trail).toHaveTextContent('All departments');
    expect(trail).toHaveTextContent('Finance');
  });

  it('does not link the crumb the reader is standing on', () => {
    navigationState.pathname = '/dashboard/departments/tree';
    renderWithProviders(<Breadcrumbs />);

    // A link to the page you are already on is a link that does nothing.
    expect(screen.queryByRole('link', { name: 'Organisational chart' })).toBeNull();
    expect(screen.getByText('Organisational chart')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('renders nothing where there is nothing above the page', () => {
    // A trail of one crumb only repeats the heading in the bar above it.
    navigationState.pathname = '/dashboard';
    const { container } = renderWithProviders(<Breadcrumbs />);

    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('ignores a trail left behind by the page just navigated away from', () => {
    navigationState.pathname = '/dashboard/employees';
    usePageHeaderStore.setState({
      entry: {
        pathname: '/dashboard/contracts/xyz',
        title: 'Stale',
        breadcrumbs: [{ label: 'Stale crumb' }],
      },
    });

    renderWithProviders(<Breadcrumbs />);

    // React runs the incoming page's effect before the outgoing page's
    // cleanup, so the store legitimately still holds the old entry for a frame.
    expect(screen.queryByText('Stale crumb')).toBeNull();
  });
});
