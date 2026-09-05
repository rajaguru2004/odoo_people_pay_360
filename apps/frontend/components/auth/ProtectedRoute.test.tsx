import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import { routerMock } from '@/test/router-mock';
import { useAuthStore } from '@/store/authStore';
import type { User } from '@/types/auth';
import ProtectedRoute from './ProtectedRoute';

const employee: User = {
  id: 'u1',
  email: 'aisha@example.com',
  role: 'EMPLOYEE',
  isActive: true,
  employeeId: 'emp-1',
  employee: {
    id: 'emp-1',
    employeeCode: 'E-001',
    firstName: 'Aisha',
    lastName: 'Al Balushi',
  },
};

/** A settled session for `user`, or a settled signed-out one for null. */
function session(user: User | null) {
  useAuthStore.setState({
    user,
    isAuthenticated: user !== null,
    isLoading: false,
    hasHydrated: true,
  });
}

beforeEach(() => {
  useAuthStore.setState({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    hasHydrated: false,
  });
});

describe('ProtectedRoute', () => {
  it('renders nothing and navigates nowhere while the store is unread', () => {
    // `hasHydrated: false` is not "signed out" — it is "nobody has answered
    // yet". Acting on it bounces every reload to /login and back.
    const { container } = renderWithProviders(
      <ProtectedRoute>
        <p>Payroll run</p>
      </ProtectedRoute>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('holds while a session flag has no user behind it', () => {
    // Mid-restore: the flag rehydrated ahead of the record. Rendering here would
    // show a protected page to a caller the guard has not checked.
    useAuthStore.setState({
      user: null,
      isAuthenticated: true,
      isLoading: true,
      hasHydrated: true,
    });

    const { container } = renderWithProviders(
      <ProtectedRoute requiredRoles={['ADMIN']}>
        <p>Payroll run</p>
      </ProtectedRoute>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to the login screen', () => {
    session(null);

    renderWithProviders(
      <ProtectedRoute>
        <p>Payroll run</p>
      </ProtectedRoute>,
    );

    expect(routerMock.replace).toHaveBeenCalledWith('/login');
  });

  it('sends the wrong role to /403 and paints nothing on the way', () => {
    session(employee);

    const { container } = renderWithProviders(
      <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
        <p>Payroll run</p>
      </ProtectedRoute>,
    );

    expect(routerMock.replace).toHaveBeenCalledWith('/403');
    expect(container).toBeEmptyDOMElement();
  });

  it('renders for a role the route names', () => {
    session({ ...employee, role: 'HR_MANAGER' });

    renderWithProviders(
      <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
        <p>Payroll run</p>
      </ProtectedRoute>,
    );

    expect(screen.getByText('Payroll run')).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('lets an employee onto their own record despite the role check', () => {
    // The server admits an employee to their own record, so a guard that
    // refused them here would deny a request that would have succeeded.
    session(employee);

    renderWithProviders(
      <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']} selfEmployeeId="emp-1">
        <p>Employee record</p>
      </ProtectedRoute>,
    );

    expect(screen.getByText('Employee record')).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('reads the employee id from a session that only carries the column', () => {
    // A restored store has `employeeId` and no joined `employee`; reading only
    // the join would deny a user the server admits.
    session({ ...employee, employee: null });

    renderWithProviders(
      <ProtectedRoute requiredRoles={['ADMIN']} selfEmployeeId="emp-1">
        <p>Employee record</p>
      </ProtectedRoute>,
    );

    expect(screen.getByText('Employee record')).toBeInTheDocument();
  });

  it('refuses someone else’s record to the same employee', () => {
    session(employee);

    const { container } = renderWithProviders(
      <ProtectedRoute requiredRoles={['ADMIN']} selfEmployeeId="emp-2">
        <p>Employee record</p>
      </ProtectedRoute>,
    );

    expect(routerMock.replace).toHaveBeenCalledWith('/403');
    expect(container).toBeEmptyDOMElement();
  });

  it('refuses a permission the role does not carry', () => {
    session(employee);

    renderWithProviders(
      <ProtectedRoute requiredPermission="MANAGE_PAYROLL">
        <p>Payroll run</p>
      </ProtectedRoute>,
    );

    expect(routerMock.replace).toHaveBeenCalledWith('/403');
  });
});
