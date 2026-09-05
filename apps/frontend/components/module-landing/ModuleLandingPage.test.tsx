import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '@/test/utils';
import { navigationState } from '@/test/router-mock';
import { useAuthStore } from '@/store/authStore';
import { usePageHeaderStore } from '@/store/pageHeaderStore';
import ModuleLandingPage from './ModuleLandingPage';

beforeEach(() => {
  navigationState.pathname = '/dashboard/organization';
  usePageHeaderStore.setState({ entry: null });
  useAuthStore.setState({
    user: { id: 'u1', email: 'hr@example.com', role: 'ADMIN', isActive: true },
    isAuthenticated: true,
    hasHydrated: true,
  });
});

describe('the module landing shell', () => {
  it('declares its heading to the shell rather than painting one', () => {
    renderWithProviders(
      <ModuleLandingPage
        moduleKey="organization"
        title="Organisation"
        subtitle="Branches and departments."
      />,
    );

    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(usePageHeaderStore.getState().entry).toMatchObject({
      pathname: '/dashboard/organization',
      title: 'Organisation',
      subtitle: 'Branches and departments.',
    });
  });

  it('draws no period filter unless the page asks for one', () => {
    // A control wired to nothing is worse than no control: the reader clicks
    // Week, the figures do not move, and they conclude the data did not change.
    renderWithProviders(<ModuleLandingPage moduleKey="organization" title="Organisation" />);

    expect(screen.queryByRole('button', { name: 'Week' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Month' })).toBeNull();
  });

  it('draws it when the page opts in, controlled by that page', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <ModuleLandingPage
        moduleKey="timeAttendance"
        title="Time & attendance"
        showControls
        timeFilterOptions={['Today', 'Week', 'Month', 'Year']}
        timeFilter="Today"
        onTimeFilterChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Week' }));
    expect(onChange).toHaveBeenCalledWith('Week');
  });

  it('hides the action buttons that have no handler', () => {
    renderWithProviders(
      <ModuleLandingPage moduleKey="organization" title="Organisation" showControls />,
    );

    expect(screen.queryByRole('button', { name: /add new/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
  });

  it('renders the module tiles under the explore heading', () => {
    renderWithProviders(<ModuleLandingPage moduleKey="organization" title="Organisation" />);

    expect(screen.getByRole('heading', { name: 'Explore' })).toBeInTheDocument();
    expect(screen.getAllByTestId('module-tile')).toHaveLength(4);
  });
});
