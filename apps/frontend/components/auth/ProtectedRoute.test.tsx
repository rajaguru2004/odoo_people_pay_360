import { beforeEach, describe, expect, it } from 'vitest';
import { act, buildUser, renderWithProviders, screen } from '@/test/render';
import ProtectedRoute from './ProtectedRoute';
import { routerMock } from '@/test/router-mock';
import { useAuthStore } from '@/store/authStore';

/**
 * The route guard, and the one question a permission name cannot answer.
 *
 * `requiredPermission` asks "may this ROLE see this KIND of thing", which is
 * right for a list and wrong for `/dashboard/employees/[id]`: an employee is
 * entitled to their own record and to nobody else's, and the server agrees.
 * Before `selfEmployeeId`, the guard redirected them to /403 before the request
 * was made — so the page's own self-service branch was unreachable code.
 *
 * The check has to be answerable BEFORE the record loads, which is why it takes
 * the id from the URL rather than from the fetched employee.
 */
describe('ProtectedRoute', () => {
  const Child = () => <div data-testid="guarded">visible</div>;

  // `renderWithProviders` seeds user/isAuthenticated/isLoading but not
  // `hasHydrated` — that flag belongs to the persist middleware, which flips it
  // once when the module is first evaluated. Pinning it here makes every test's
  // starting point explicit rather than inherited from whichever test ran last.
  beforeEach(() => {
    useAuthStore.setState({ hasHydrated: true });
  });

  it('lets a permitted role through', () => {
    renderWithProviders(
      <ProtectedRoute requiredPermission="VIEW_EMPLOYEES">
        <Child />
      </ProtectedRoute>,
      { role: 'ADMIN' },
    );
    expect(screen.getByTestId('guarded')).toBeInTheDocument();
  });

  it('redirects a role without the permission', () => {
    renderWithProviders(
      <ProtectedRoute requiredPermission="VIEW_EMPLOYEES">
        <Child />
      </ProtectedRoute>,
      { role: 'EMPLOYEE' },
    );
    expect(screen.queryByTestId('guarded')).toBeNull();
    expect(routerMock.replace).toHaveBeenCalledWith('/403');
  });

  it('lets an employee through to their OWN record', () => {
    const { queryClient: _ } = renderWithProviders(
      <ProtectedRoute
        requiredPermission="VIEW_EMPLOYEES"
        selfEmployeeId="emp-self"
      >
        <Child />
      </ProtectedRoute>,
      {
        role: 'EMPLOYEE',
        user: { employeeId: 'emp-self', employee: { id: 'emp-self' } } as never,
      },
    );
    expect(screen.getByTestId('guarded')).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalledWith('/403');
  });

  it('still refuses them someone else’s record', () => {
    renderWithProviders(
      <ProtectedRoute
        requiredPermission="VIEW_EMPLOYEES"
        selfEmployeeId="emp-other"
      >
        <Child />
      </ProtectedRoute>,
      {
        role: 'EMPLOYEE',
        user: { employeeId: 'emp-self', employee: { id: 'emp-self' } } as never,
      },
    );
    expect(screen.queryByTestId('guarded')).toBeNull();
    expect(routerMock.replace).toHaveBeenCalledWith('/403');
  });

  it('reads the id from either shape a session can carry', () => {
    // A login response carries `employee.id`; a restored store may carry only
    // `employeeId`. A guard that reads one of them silently denies the other.
    renderWithProviders(
      <ProtectedRoute
        requiredPermission="VIEW_EMPLOYEES"
        selfEmployeeId="emp-self"
      >
        <Child />
      </ProtectedRoute>,
      { role: 'EMPLOYEE', user: { employeeId: 'emp-self' } as never },
    );
    expect(screen.getByTestId('guarded')).toBeInTheDocument();
  });

  /**
   * The denial the app actually has to make.
   *
   * `/dashboard/banks` and `/dashboard/banks/config` are the only two routes
   * whose guard has to refuse an AUTHENTICATED non-admin — everywhere else the
   * denial branch is never taken — so they are the only place a bug in it shows.
   */
  it('sends an authenticated role that is not on the list to /403', () => {
    renderWithProviders(
      <ProtectedRoute requiredRoles={['ADMIN']}>
        <Child />
      </ProtectedRoute>,
      { role: 'HR_MANAGER' },
    );
    expect(screen.queryByTestId('guarded')).toBeNull();
    expect(routerMock.replace).toHaveBeenCalledWith('/403');
    expect(routerMock.replace).not.toHaveBeenCalledWith('/login');
  });

  /**
   * The race.
   *
   * `auth-storage` is a zustand `persist` store, and `useSyncExternalStore`
   * serves the PRE-rehydration state during React's hydration pass, so the guard
   * renders at least once against a store that does not know who the user is.
   * Reading that first render as an answer is what made the denial intermittent.
   *
   * The three cases below are the three shapes "not yet" arrives in.
   */
  describe('before the session is known', () => {
    it('does not decide anything until storage has been read', () => {
      // Nothing has been read yet, so `isAuthenticated: false` is not evidence
      // of a logged-out visitor — it is the absence of evidence.
      useAuthStore.setState({ hasHydrated: false });
      renderWithProviders(
        <ProtectedRoute requiredRoles={['ADMIN']}>
          <Child />
        </ProtectedRoute>,
        { role: null },
      );

      expect(screen.queryByTestId('guarded')).toBeNull();
      // Not /login either. A wrong-way navigation here is what raced the correct
      // one a render later; the guard must sit still, not guess.
      expect(routerMock.replace).not.toHaveBeenCalled();
      expect(routerMock.push).not.toHaveBeenCalled();

      // Storage lands, carrying an HR session, on an ADMIN-only route.
      act(() => {
        useAuthStore.setState({
          hasHydrated: true,
          isAuthenticated: true,
          user: buildUser('HR_MANAGER'),
        });
      });

      expect(screen.queryByTestId('guarded')).toBeNull();
      expect(routerMock.replace).toHaveBeenCalledWith('/403');
      expect(routerMock.replace).not.toHaveBeenCalledWith('/login');
    });

    it('does not render the page to a session whose identity has not arrived', () => {
      // The fail-open. `isAuthenticated` is true but `user` is still null, so
      // every check short-circuited to "not denied" and the guard rendered an
      // ADMIN-only page to an unidentified session and never redirected at all.
      renderWithProviders(
        <ProtectedRoute requiredRoles={['ADMIN']}>
          <Child />
        </ProtectedRoute>,
        { role: null },
      );
      routerMock.replace.mockClear();

      act(() => {
        useAuthStore.setState({ isAuthenticated: true, user: null });
      });

      expect(screen.queryByTestId('guarded')).toBeNull();
      expect(routerMock.replace).not.toHaveBeenCalled();

      // `loadUser()` finishes and the identity turns out to be HR.
      act(() => {
        useAuthStore.setState({ user: buildUser('HR_MANAGER') });
      });

      expect(screen.queryByTestId('guarded')).toBeNull();
      expect(routerMock.replace).toHaveBeenCalledWith('/403');
    });

    it('holds an allowed role too, then lets them through', () => {
      // `pending` is a hold, not a denial: the same unresolved state that must
      // not leak the page must also not bounce someone entitled to it.
      useAuthStore.setState({ hasHydrated: false });
      renderWithProviders(
        <ProtectedRoute requiredRoles={['ADMIN']}>
          <Child />
        </ProtectedRoute>,
        { role: null },
      );

      expect(screen.queryByTestId('guarded')).toBeNull();
      expect(routerMock.replace).not.toHaveBeenCalled();

      act(() => {
        useAuthStore.setState({
          hasHydrated: true,
          isAuthenticated: true,
          user: buildUser('ADMIN'),
        });
      });

      expect(screen.getByTestId('guarded')).toBeInTheDocument();
      expect(routerMock.replace).not.toHaveBeenCalled();
    });
  });

  it('still sends a settled logged-out visitor to /login', () => {
    // The other half of the same distinction: once storage HAS been read and
    // there is nobody in it, "no session" is a real answer and must be acted on.
    renderWithProviders(
      <ProtectedRoute requiredRoles={['ADMIN']}>
        <Child />
      </ProtectedRoute>,
      { role: null },
    );
    expect(screen.queryByTestId('guarded')).toBeNull();
    expect(routerMock.replace).toHaveBeenCalledWith('/login');
  });
});
