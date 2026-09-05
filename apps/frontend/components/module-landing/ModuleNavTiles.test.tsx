import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import type { UserRole } from '@/types/auth';
import ModuleNavTiles from './ModuleNavTiles';

/**
 * The tiles are the hub's navigation, fed from the same `buildMenu` output as
 * the rail.
 *
 * That is the safety property worth testing: if the two ever diverge, a hub
 * offers a screen the sidebar hides and `ProtectedRoute` bounces the reader to
 * /403 — a dead end reached from a link we drew ourselves.
 */
function signIn(role: UserRole) {
  useAuthStore.setState({
    user: { id: 'u1', email: 'user@example.com', role, isActive: true },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });
}

function hrefs(container: HTMLElement): string[] {
  return [...container.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')!);
}

beforeEach(() => {
  useAuthStore.setState({ user: null, isAuthenticated: false, hasHydrated: true });
});

describe('ModuleNavTiles', () => {
  it('renders one tile per visible child of the module', () => {
    signIn('ADMIN');
    const { container } = renderWithProviders(<ModuleNavTiles moduleKey="organization" />);

    expect(hrefs(container)).toEqual([
      '/dashboard/branches',
      '/dashboard/departments',
      '/dashboard/departments/tree',
      '/dashboard/departments/change-requests',
    ]);
  });

  it('mirrors a child role narrowing', () => {
    // Creating an employee is HR's, and a payroll officer must not be offered
    // the tile the server would refuse.
    signIn('PAYROLL_OFFICER');
    const narrowed = renderWithProviders(<ModuleNavTiles moduleKey="people" />);
    expect(hrefs(narrowed.container)).not.toContain('/dashboard/employees/new');
    narrowed.unmount();

    signIn('HR_MANAGER');
    const full = renderWithProviders(<ModuleNavTiles moduleKey="people" />);
    expect(hrefs(full.container)).toContain('/dashboard/employees/new');
  });

  it('renders nothing for a module this role has no group for', () => {
    signIn('EMPLOYEE');
    const { container } = renderWithProviders(<ModuleNavTiles moduleKey="people" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before the session says who is asking', () => {
    const { container } = renderWithProviders(<ModuleNavTiles moduleKey="people" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a live badge only when the count is above zero', () => {
    signIn('ADMIN');
    renderWithProviders(
      <ModuleNavTiles
        moduleKey="timeAttendance"
        badges={{ attendanceRequests: 7, attendanceLogs: 0 }}
        badgeTones={{ attendanceRequests: 'warning' }}
      />,
    );

    // An empty queue is not news, so a zero draws no pill at all.
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('caps an unreadably large badge', () => {
    signIn('ADMIN');
    renderWithProviders(
      <ModuleNavTiles moduleKey="timeAttendance" badges={{ attendanceRequests: 512 }} />,
    );
    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('names each tile from the same messages the rail reads', () => {
    signIn('ADMIN');
    renderWithProviders(<ModuleNavTiles moduleKey="organization" />);
    expect(screen.getByText('Organisational chart')).toBeInTheDocument();
    expect(screen.getByText('The reporting structure, drawn as a tree.')).toBeInTheDocument();
  });
});
