import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import ModuleLandingPage from './ModuleLandingPage';

/**
 * The shared hub shell.
 *
 * `showControls` used to default to TRUE, which drew a period filter on all ten
 * hubs while only Time & Attendance passed `timeFilter`/`onTimeFilterChange`.
 * On the other nine the tabs moved and the page did not — and a reader who
 * clicks Week, sees the same numbers, and concludes nothing changed has been
 * told something false. The default is now false and the Time hub opts in.
 */
vi.mock('@/hooks/useModuleNav', () => ({
  useModuleNav: () => ({ group: null, children: [] }),
  useNavLocation: () => ({ group: null, child: null }),
}));

describe('the module landing shell', () => {
  it('draws no period filter unless a page asks for one', () => {
    renderWithProviders(
      <ModuleLandingPage moduleKey="organization" title="Organization" />,
      { role: 'ADMIN' },
    );

    expect(screen.queryByRole('button', { name: 'Week' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Month' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Years' })).toBeNull();
  });

  it('draws it when a page opts in, controlled by that page', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(
      <ModuleLandingPage
        moduleKey="timeAttendance"
        title="Time & Attendance"
        showControls
        timeFilterOptions={['Today', 'Week', 'Month', 'Year']}
        timeFilter="Today"
        onTimeFilterChange={onChange}
      />,
      { role: 'ADMIN' },
    );

    const week = screen.getByRole('button', { name: 'Week' });
    await user.click(week);
    expect(onChange).toHaveBeenCalledWith('Week');
  });

  it('hides the action buttons that have no handler', () => {
    // A button wired to nothing is a defect in this codebase, not a
    // placeholder: the reader clicks it, nothing happens, and they stop
    // trusting the rest of the row.
    renderWithProviders(
      <ModuleLandingPage moduleKey="organization" title="Organization" showControls />,
      { role: 'ADMIN' },
    );

    expect(screen.queryByRole('button', { name: /Add new/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Export/i })).toBeNull();
  });
});
