import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { routerMock } from '@/test/router-mock';
import EmployeeForm from './EmployeeForm';

/**
 * Mocked at the SERVICE, so the assertion can be "the API was never called".
 *
 * That is the property worth protecting: an invalid submit that still fires the
 * request is how a half-filled record reaches the database and the validation
 * message arrives too late to mean anything.
 */
const { createEmployee, listEmployees } = vi.hoisted(() => ({
  createEmployee: vi.fn((_payload: unknown) =>
    Promise.resolve({ success: true, data: { id: 'new-1' } }),
  ),
  listEmployees: vi.fn(() => Promise.resolve({ success: true, data: [] })),
}));

vi.mock('@/services/employeeService', () => ({
  default: { list: listEmployees, create: createEmployee, update: vi.fn() },
}));

vi.mock('@/services/departmentService', () => ({
  default: { list: () => Promise.resolve({ success: true, data: [] }) },
}));

vi.mock('@/services/branchService', () => ({
  default: { list: () => Promise.resolve({ success: true, data: [] }) },
}));

beforeEach(() => {
  createEmployee.mockClear();
  listEmployees.mockClear();
});

describe('EmployeeForm', () => {
  it('names the fields the API insists on', () => {
    renderWithProviders(<EmployeeForm />);

    expect(screen.getByLabelText('Employee code')).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toBeInTheDocument();
    expect(screen.getByLabelText('Last name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create employee/i })).toBeEnabled();
  });

  it('blocks an empty submit, says what is missing and sends nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EmployeeForm />);

    await user.click(screen.getByRole('button', { name: /create employee/i }));

    expect(await screen.findByText(/employee code is required/i)).toBeInTheDocument();
    expect(screen.getByText(/first name is required/i)).toBeInTheDocument();
    expect(screen.getByText(/last name is required/i)).toBeInTheDocument();

    expect(createEmployee).not.toHaveBeenCalled();
    // Navigating away on an invalid submit loses what was typed and tells the
    // user nothing about why.
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('refuses a malformed email before the request is made', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EmployeeForm />);

    await user.type(screen.getByLabelText('Employee code'), 'EMP-0021');
    await user.type(screen.getByLabelText('First name'), 'Noor');
    await user.type(screen.getByLabelText('Last name'), 'Al Kindi');
    await user.type(screen.getByLabelText('Work email'), 'noor@@example');

    await user.click(screen.getByRole('button', { name: /create employee/i }));

    expect(await screen.findByText(/valid work email/i)).toBeInTheDocument();
    expect(createEmployee).not.toHaveBeenCalled();
  });

  it('sends only the fields that were filled in', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EmployeeForm />);

    await user.type(screen.getByLabelText('Employee code'), 'EMP-0021');
    await user.type(screen.getByLabelText('First name'), 'Noor');
    await user.type(screen.getByLabelText('Last name'), 'Al Kindi');

    await user.click(screen.getByRole('button', { name: /create employee/i }));

    await waitFor(() => expect(createEmployee).toHaveBeenCalledTimes(1));

    const payload = createEmployee.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      employeeCode: 'EMP-0021',
      firstName: 'Noor',
      lastName: 'Al Kindi',
      status: 'ACTIVE',
    });
    // An empty optional is omitted, not sent as '' — the API validates work
    // emails and relation ids, and both reject a blank string with a 400 the
    // user cannot read.
    expect(payload).not.toHaveProperty('workEmail');
    expect(payload).not.toHaveProperty('departmentId');
  });
});
