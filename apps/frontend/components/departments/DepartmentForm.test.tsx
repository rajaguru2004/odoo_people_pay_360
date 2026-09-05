import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import DepartmentForm from './DepartmentForm';

/**
 * Creating and editing a department.
 *
 * The interesting rule is not the two required fields, it is which departments
 * may be offered as a PARENT. The backend caps the hierarchy at two levels, so
 * the option list has to exclude anything that already has a parent — and, in
 * edit mode, the department being edited, or it could be made its own parent
 * and the tree would contain a cycle.
 *
 * Two smaller rules ride along, both of which look like details until they bite:
 * the currently assigned parent is always kept in the list (otherwise opening
 * the form silently resets a department to top level on the next save), and a
 * department's own children need no special handling because the top-level rule
 * already excludes them.
 */

vi.mock('@/services/departmentService', () => ({
  default: {
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('@/services/employeeService', () => ({
  default: { getAll: vi.fn(), getDirectory: vi.fn() },
}));

vi.mock('@/services/departmentChangeRequestService', () => ({
  default: { createChangeRequest: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import departmentService from '@/services/departmentService';
import employeeService from '@/services/employeeService';
import departmentChangeRequestService from '@/services/departmentChangeRequestService';

const getAll = vi.mocked(departmentService.getAll);
const getById = vi.mocked(departmentService.getById);
const create = vi.mocked(departmentService.create);
const update = vi.mocked(departmentService.update);
const createChangeRequest = vi.mocked(departmentChangeRequestService.createChangeRequest);

const EMPLOYEES = [
  { id: 'e-old', fullName: 'Olivia Outgoing', position: 'Lead', departmentId: 'd-top' },
  { id: 'e-new', fullName: 'Ivan Incoming', position: 'Senior', departmentId: 'd-top' },
];

const managerSelect = () =>
  document.querySelector('select[name="managerId"]') as HTMLSelectElement;

const DEPARTMENTS = [
  { id: 'd-top', code: 'HRD', name: 'Human Resources', parentId: null },
  { id: 'd-other-top', code: 'FIN', name: 'Finance', parentId: null },
  { id: 'd-child', code: 'PAY', name: 'Payroll', parentId: 'd-other-top' },
];

const codeInput = () => document.querySelector('input[name="code"]') as HTMLInputElement;
const nameInput = () => document.querySelector('input[name="name"]') as HTMLInputElement;
const parentSelect = () => document.querySelector('select[name="parentId"]') as HTMLSelectElement;
const submitButton = () =>
  Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('type') === 'submit')!;

/** The department names currently offered as a parent. */
const parentOptions = () =>
  Array.from(parentSelect()?.options ?? []).map((o) => o.textContent?.trim() ?? '');

beforeEach(() => {
  getAll.mockReset();
  getById.mockReset();
  create.mockReset();
  update.mockReset();
  createChangeRequest.mockReset();
  getAll.mockResolvedValue({ success: true, data: DEPARTMENTS } as never);
  vi.mocked(employeeService.getAll).mockResolvedValue({ success: true, data: [] } as never);
  vi.mocked(employeeService.getDirectory)?.mockResolvedValue?.({ success: true, data: [] } as never);

  // jsdom implements neither, and this form uses both on every save path.
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

describe('required fields', () => {
  it('refuses a department with no code or name', async () => {
    const { user } = renderWithProviders(<DepartmentForm mode="create" />, { role: 'ADMIN' });
    await waitFor(() => expect(codeInput()).toBeInTheDocument());

    await user.click(submitButton());

    await waitFor(() => expect(create).not.toHaveBeenCalled());
  });

  it('creates with code and name alone', async () => {
    // Parent and manager are optional: a department can exist before anyone is
    // appointed to run it.
    create.mockResolvedValue({ success: true, data: { id: 'd-new' } } as never);
    const { user } = renderWithProviders(<DepartmentForm mode="create" />, { role: 'ADMIN' });
    await waitFor(() => expect(codeInput()).toBeInTheDocument());

    await user.type(codeInput(), 'ENG');
    await user.type(nameInput(), 'Engineering');
    await user.click(submitButton());

    await waitFor(() => expect(create).toHaveBeenCalled());
  });
});

describe('which departments may be a parent', () => {
  it('offers only top-level departments', async () => {
    // The hierarchy is capped at two levels, so a department that already has a
    // parent cannot take children of its own.
    renderWithProviders(<DepartmentForm mode="create" />, { role: 'ADMIN' });
    await waitFor(() => expect(parentSelect()).toBeInTheDocument());

    await waitFor(() => expect(parentOptions().join('|')).toContain('Human Resources'));
    expect(parentOptions().join('|')).toContain('Finance');
    expect(parentOptions().join('|')).not.toContain('Payroll');
  });

  it('excludes the department being edited, so it cannot parent itself', async () => {
    // A self-parent is a cycle: the tree screen would recurse and the backend
    // would have to reject a save the form allowed.
    getById.mockResolvedValue({
      success: true,
      data: { id: 'd-top', code: 'HRD', name: 'Human Resources', parentId: null },
    } as never);

    renderWithProviders(<DepartmentForm mode="edit" departmentId="d-top" />, { role: 'ADMIN' });

    await waitFor(() => expect(parentSelect()).toBeInTheDocument());
    await waitFor(() => expect(parentOptions().join('|')).toContain('Finance'));
    expect(parentOptions().join('|')).not.toContain('Human Resources');
  });

  it('keeps the currently assigned parent in the list even if it is not top level', async () => {
    // Otherwise opening the form would show "None (top level)" for a department
    // that has a parent, and the next save would silently promote it.
    getById.mockResolvedValue({
      success: true,
      data: { id: 'd-x', code: 'SUB', name: 'Sub Team', parentId: 'd-child' },
    } as never);

    renderWithProviders(<DepartmentForm mode="edit" departmentId="d-x" />, { role: 'ADMIN' });

    await waitFor(() => expect(parentSelect()).toBeInTheDocument());
    await waitFor(() => expect(parentOptions().join('|')).toContain('Payroll'));
  });
});

describe('edit mode', () => {
  it('loads the department and updates rather than creates', async () => {
    getById.mockResolvedValue({
      success: true,
      data: { id: 'd-top', code: 'HRD', name: 'Human Resources', parentId: null },
    } as never);
    update.mockResolvedValue({ success: true, data: {} } as never);

    const { user } = renderWithProviders(<DepartmentForm mode="edit" departmentId="d-top" />, {
      role: 'ADMIN',
    });

    await waitFor(() => expect(codeInput()).toHaveValue('HRD'));
    expect(nameInput()).toHaveValue('Human Resources');

    await user.click(submitButton());

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(create).not.toHaveBeenCalled();
  });
});

describe('failure handling', () => {
  it('stays on the form when the save is rejected', async () => {
    // A department code collides often; the user has to be able to correct it
    // rather than be navigated away from their input.
    create.mockRejectedValue({ message: 'Department code already exists' });
    const { user } = renderWithProviders(<DepartmentForm mode="create" />, { role: 'ADMIN' });
    await waitFor(() => expect(codeInput()).toBeInTheDocument());

    await user.type(codeInput(), 'HRD');
    await user.type(nameInput(), 'Duplicate');
    await user.click(submitButton());

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(codeInput()).toHaveValue('HRD');
  });
});

/**
 * Changing the head is not a save.
 *
 * On the edit form, picking a different head raises a CHANGE REQUEST and leaves
 * the department's head exactly as it was until someone approves it. Everything
 * else on the form is written immediately, in a SECOND call. Two calls, one
 * button, no transaction — which is where the interesting failures live.
 */
describe('changing the head raises a request', () => {
  const editing = (over: Record<string, unknown> = {}) => {
    getById.mockResolvedValue({
      success: true,
      data: {
        id: 'd-top',
        code: 'HRD',
        name: 'Human Resources',
        parentId: null,
        managerId: 'e-old',
        manager: { id: 'e-old', fullName: 'Olivia Outgoing', employeeCode: 'E1' },
        _count: { employees: 4 },
        ...over,
      },
    } as never);
    vi.mocked(employeeService.getAll).mockResolvedValue({
      success: true,
      data: EMPLOYEES,
    } as never);
  };

  it('asks first, then raises a request instead of writing the new head', async () => {
    editing();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    createChangeRequest.mockResolvedValue({ success: true, data: { id: 'cr-1' } } as never);
    update.mockResolvedValue({ success: true, data: {} } as never);

    const { user } = renderWithProviders(<DepartmentForm mode="edit" departmentId="d-top" />, {
      role: 'ADMIN',
    });
    await waitFor(() => expect(managerSelect()).toBeInTheDocument());
    await waitFor(() => expect(managerSelect().options.length).toBeGreaterThan(1));

    await user.selectOptions(managerSelect(), 'e-new');
    await user.click(submitButton());

    await waitFor(() => expect(createChangeRequest).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalled();

    const [departmentId, payload] = createChangeRequest.mock.calls[0];
    expect(departmentId).toBe('d-top');
    expect(payload.requestType).toBe('CHANGE_MANAGER');
    expect(payload.newManagerId).toBe('e-new');
    // The backend refuses a reason under ten characters, so a generated one that
    // is too short would make the whole flow unusable.
    expect(payload.reason.length).toBeGreaterThanOrEqual(10);

    // The department is still updated — but WITHOUT the head, which is the
    // request's to change.
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1]).not.toHaveProperty('managerId');

    // And the plain fields are written FIRST: see the failure case below for
    // what that ordering is protecting against.
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      createChangeRequest.mock.invocationCallOrder[0],
    );
  });

  it('does nothing at all when the confirmation is dismissed', async () => {
    editing();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    const { user } = renderWithProviders(<DepartmentForm mode="edit" departmentId="d-top" />, {
      role: 'ADMIN',
    });
    await waitFor(() => expect(managerSelect()).toBeInTheDocument());
    await waitFor(() => expect(managerSelect().options.length).toBeGreaterThan(1));

    await user.selectOptions(managerSelect(), 'e-new');
    await user.click(submitButton());

    // Not "the request was cancelled" — nothing was written either, so the
    // dismissal has to abandon the whole save.
    await waitFor(() => expect(createChangeRequest).not.toHaveBeenCalled());
    expect(update).not.toHaveBeenCalled();
  });

  it('leaves no request behind when the save is refused', async () => {
    // The trap this ordering exists to prevent: the request used to be created
    // FIRST and the department update second. When the update was refused — a
    // duplicate code, an illegal parent — the user was told the save had failed
    // while a PENDING request they were never told about had already been
    // opened, and their retry then hit "there is already a pending change
    // request for this department" with no way out of it from the form.
    editing();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    createChangeRequest.mockResolvedValue({ success: true, data: { id: 'cr-1' } } as never);
    update.mockRejectedValue({ message: 'Department code already exists' });

    const { user } = renderWithProviders(<DepartmentForm mode="edit" departmentId="d-top" />, {
      role: 'ADMIN',
    });
    await waitFor(() => expect(managerSelect()).toBeInTheDocument());
    await waitFor(() => expect(managerSelect().options.length).toBeGreaterThan(1));

    await user.selectOptions(managerSelect(), 'e-new');
    await user.click(submitButton());

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(createChangeRequest).not.toHaveBeenCalled();

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('Department code already exists');
  });

  it('saves normally when the head is left alone', async () => {
    editing();
    update.mockResolvedValue({ success: true, data: {} } as never);

    const { user } = renderWithProviders(<DepartmentForm mode="edit" departmentId="d-top" />, {
      role: 'ADMIN',
    });
    await waitFor(() => expect(nameInput()).toHaveValue('Human Resources'));

    await user.clear(nameInput());
    await user.type(nameInput(), 'People Team');
    await user.click(submitButton());

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(createChangeRequest).not.toHaveBeenCalled();
  });
});

describe('the warnings this form owes the user', () => {
  it('warns before a parent change that the server will refuse', async () => {
    // The backend refuses to re-parent a department that still has employees.
    // Saying so up front is the difference between a form and a trap.
    getById.mockResolvedValue({
      success: true,
      data: {
        id: 'd-x',
        code: 'SUB',
        name: 'Sub Team',
        parentId: null,
        _count: { employees: 3 },
      },
    } as never);

    const { user } = renderWithProviders(<DepartmentForm mode="edit" departmentId="d-x" />, {
      role: 'ADMIN',
    });
    await waitFor(() => expect(parentSelect()).toBeInTheDocument());
    await waitFor(() => expect(parentSelect().options.length).toBeGreaterThan(1));

    expect(document.querySelector('[data-testid="dept-parent-warning"]')).toBeNull();

    await user.selectOptions(parentSelect(), 'd-top');

    await waitFor(() =>
      expect(document.querySelector('[data-testid="dept-parent-warning"]')).not.toBeNull(),
    );
  });

  it('stays quiet about a parent change on an empty department', async () => {
    getById.mockResolvedValue({
      success: true,
      data: {
        id: 'd-x',
        code: 'SUB',
        name: 'Sub Team',
        parentId: null,
        _count: { employees: 0 },
      },
    } as never);

    const { user } = renderWithProviders(<DepartmentForm mode="edit" departmentId="d-x" />, {
      role: 'ADMIN',
    });
    await waitFor(() => expect(parentSelect()).toBeInTheDocument());
    await waitFor(() => expect(parentSelect().options.length).toBeGreaterThan(1));

    await user.selectOptions(parentSelect(), 'd-top');

    expect(document.querySelector('[data-testid="dept-parent-warning"]')).toBeNull();
  });

  it('sends null, not undefined, when the parent is cleared', async () => {
    // `undefined` is dropped from the JSON body, so the department would keep
    // its parent and the user's detach would silently do nothing.
    getById.mockResolvedValue({
      success: true,
      data: {
        id: 'd-x',
        code: 'SUB',
        name: 'Sub Team',
        parentId: 'd-top',
        _count: { employees: 0 },
      },
    } as never);
    update.mockResolvedValue({ success: true, data: {} } as never);

    const { user } = renderWithProviders(<DepartmentForm mode="edit" departmentId="d-x" />, {
      role: 'ADMIN',
    });
    await waitFor(() => expect(parentSelect()).toBeInTheDocument());
    await waitFor(() => expect(parentSelect().value).toBe('d-top'));

    await user.selectOptions(parentSelect(), '');
    await user.click(submitButton());

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1]).toHaveProperty('parentId', null);
  });
});
