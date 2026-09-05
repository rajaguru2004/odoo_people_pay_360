import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { routerMock } from '@/test/router-mock';
import EmployeeForm from './EmployeeForm';
import type { TemplateField, TemplateSection } from '@/types/profile-template';

/**
 * The employee create/edit form.
 *
 * Almost nothing here is rendered by this file any more — the fields, labels and
 * requiredness come from the active Employee Profile Template. What stays is the
 * behaviour a generic renderer cannot know, and every one of those rules exists
 * because getting it wrong is expensive rather than ugly:
 *
 *   - **Pay basis is DERIVED from the employment type.** `baseSalary` on a DAILY
 *     employee is a PER-DAY rate. Reading that number as a monthly salary — or
 *     rewriting a live employee's basis merely because someone opened their
 *     record — is a payroll incident, not a display bug.
 *   - **The form model spans two tables.** Employee columns go to
 *     `POST/PATCH /employees`, EmployeeProfile columns go to
 *     `PATCH /employees/:id/profile`, and both endpoints run under
 *     `forbidNonWhitelisted` — so a field routed to the wrong call does not
 *     half-save, it 400s the whole thing.
 *   - **Employee code is server-generated.** It is regenerated from the
 *     department and must never be sent back.
 *   - **A 400 carries per-field reasons.** They belong on the inputs; collapsing
 *     them into one toast is how a user ends up re-submitting the same mistake.
 *
 * Worth stating because it cost two wrong attempts elsewhere in this suite: a
 * field reaches the PROFILE payload only when `storage: 'COLUMN'` AND its
 * `boundColumn` starts with `employeeProfile.`. A `JSONB` field ALWAYS lands in
 * `customFields` on the EMPLOYEE payload, whatever its boundColumn says. A
 * fixture that gets either wrong yields a test that passes while never calling
 * the endpoint it mocks.
 */

vi.mock('@/hooks/useProfileTemplate', () => ({
  useProfileTemplate: vi.fn(),
}));

vi.mock('@/services/employeeService', () => ({
  default: {
    create: vi.fn(),
    update: vi.fn(),
    getById: vi.fn(),
    getAll: vi.fn(),
    generateCode: vi.fn(),
  },
}));
vi.mock('@/services/employeeProfileService', () => ({
  employeeProfileService: { updateProfile: vi.fn(), getProfile: vi.fn() },
}));
vi.mock('@/services/departmentService', () => ({ default: { getAll: vi.fn() } }));
vi.mock('@/services/branchService', () => ({ default: { getAll: vi.fn() } }));
vi.mock('@/services/libraryService', () => ({ default: { getAll: vi.fn() } }));
vi.mock('@/services/contractService', () => ({ default: { create: vi.fn() } }));
vi.mock('@/services/overtimePolicyService', () => ({ default: { list: vi.fn() } }));
vi.mock('@/services/systemSettingsService', () => ({
  default: { getAll: vi.fn(), getPublic: vi.fn() },
}));
vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { useProfileTemplate } from '@/hooks/useProfileTemplate';
import employeeService from '@/services/employeeService';
import { employeeProfileService } from '@/services/employeeProfileService';
import departmentService from '@/services/departmentService';
import branchService from '@/services/branchService';
import libraryService from '@/services/libraryService';
import contractService from '@/services/contractService';
import overtimePolicyService from '@/services/overtimePolicyService';
import systemSettingsService from '@/services/systemSettingsService';
import { toast } from '@/lib/toast';

const createEmployee = vi.mocked(employeeService.create);
const updateEmployee = vi.mocked(employeeService.update);
const getEmployee = vi.mocked(employeeService.getById);
const generateCode = vi.mocked(employeeService.generateCode);
const updateProfile = vi.mocked(employeeProfileService.updateProfile);
const createContract = vi.mocked(contractService.create);
const toastError = vi.mocked(toast.error);

const ok = (data: unknown) => ({ success: true, data }) as never;

/** The payload actually handed to a service mock, without the `never` casts. */
const bodyOf = (call: unknown[] | undefined, index = 0) =>
  (call?.[index] ?? {}) as Record<string, unknown>;

// ── Template fixture ────────────────────────────────────────────────────────

/** Minimal valid field; each entry below overrides only what it is about. */
function makeField(overrides: Partial<TemplateField> = {}): TemplateField {
  return {
    id: null,
    sectionKey: 'personal',
    fieldKey: 'fullName',
    label: 'Full Name',
    fieldType: 'TEXT',
    storage: 'COLUMN',
    boundColumn: 'employee.fullName',
    validationType: 'NONE',
    regex: null,
    options: null,
    optionSource: null,
    required: false,
    displayOrder: 1,
    placeholder: null,
    helpText: null,
    defaultValue: null,
    colSpan: 1,
    isSensitive: false,
    minValue: null,
    maxValue: null,
    minLength: null,
    maxLength: null,
    visibleToRoles: [],
    editableByRoles: [],
    selfVisible: true,
    selfEditable: true,
    includeInCompletion: true,
    isActive: true,
    systemDeprecated: false,
    origin: 'SYSTEM',
    locked: false,
    systemRequired: false,
    lockReason: null,
    ...overrides,
  };
}

/**
 * Three fields whose only job is to prove the payload split, one per
 * destination. Everything else in the fixture exists for a named rule.
 */
const PERSONAL_FIELDS: TemplateField[] = [
  makeField({ fieldKey: 'fullName', label: 'Full Name', required: true, displayOrder: 1 }),
  // COLUMN + `employeeProfile.` prefix: the ONLY combination that reaches the
  // separate profile endpoint.
  makeField({
    fieldKey: 'placeOfBirth',
    label: 'Place of Birth',
    boundColumn: 'employeeProfile.placeOfBirth',
    displayOrder: 2,
  }),
  // JSONB: rides on the EMPLOYEE payload under `customFields`, despite naming a
  // profile column — storage decides, boundColumn does not.
  makeField({
    fieldKey: 'bloodGroup',
    label: 'Blood Group',
    storage: 'JSONB',
    boundColumn: 'employeeProfile.bloodGroup',
    origin: 'CUSTOM',
    displayOrder: 3,
  }),
];

const EMPLOYMENT_FIELDS: TemplateField[] = [
  makeField({
    sectionKey: 'employment',
    fieldKey: 'departmentId',
    label: 'Department',
    fieldType: 'DEPARTMENT_SELECT',
    boundColumn: 'employee.departmentId',
    displayOrder: 1,
  }),
  makeField({
    sectionKey: 'employment',
    fieldKey: 'branchId',
    label: 'Branch',
    fieldType: 'BRANCH_SELECT',
    boundColumn: 'employee.branchId',
    displayOrder: 2,
  }),
  // Required on purpose. The system fills it, so requiredness has to be dropped
  // client-side or the form demands a value the user cannot supply.
  makeField({
    sectionKey: 'employment',
    fieldKey: 'employeeCode',
    label: 'Employee Code',
    boundColumn: 'employee.employeeCode',
    required: true,
    displayOrder: 3,
  }),
  makeField({
    sectionKey: 'employment',
    fieldKey: 'idCard',
    label: 'ID Card',
    boundColumn: 'employee.idCard',
    displayOrder: 4,
  }),
  makeField({
    sectionKey: 'employment',
    fieldKey: 'startDate',
    label: 'Start Date',
    fieldType: 'DATE',
    boundColumn: 'employee.startDate',
    displayOrder: 5,
  }),
  makeField({
    sectionKey: 'employment',
    fieldKey: 'employmentType',
    label: 'Employment Type',
    fieldType: 'LIBRARY_SELECT',
    optionSource: 'EMPLOYMENT_TYPE',
    boundColumn: 'employee.employmentType',
    displayOrder: 6,
  }),
  makeField({
    sectionKey: 'employment',
    fieldKey: 'salaryType',
    label: 'Pay Basis',
    fieldType: 'SELECT',
    boundColumn: 'employee.salaryType',
    options: [
      { value: 'MONTHLY', label: 'Monthly salary' },
      { value: 'DAILY', label: 'Daily wage' },
    ],
    displayOrder: 7,
  }),
  makeField({
    sectionKey: 'employment',
    fieldKey: 'baseSalary',
    label: 'Base Salary',
    fieldType: 'CURRENCY',
    boundColumn: 'employee.baseSalary',
    displayOrder: 8,
  }),
];

/**
 * `sectionKey` is deliberately NOT 'compensation'. That key makes the form
 * mount the SalaryStructure block in the section footer, which is a separate
 * entity with its own fetches and its own tests — pulling it in here would
 * couple these assertions to a component none of them are about.
 */
const SECTIONS: TemplateSection[] = [
  {
    id: null,
    sectionKey: 'personal',
    label: 'Personal',
    icon: null,
    wizardStep: 1,
    columns: 2,
    displayOrder: 1,
    fields: PERSONAL_FIELDS,
  },
  {
    id: null,
    sectionKey: 'employment',
    label: 'Employment',
    icon: null,
    wizardStep: 2,
    columns: 2,
    displayOrder: 2,
    fields: EMPLOYMENT_FIELDS,
  },
];

const ALL_FIELDS = [...PERSONAL_FIELDS, ...EMPLOYMENT_FIELDS];

/**
 * Three employment types covering the whole of the pay-basis rule: one that
 * forces DAILY, one that forces MONTHLY, and one that forces nothing and so
 * leaves the choice with HR.
 */
const EMPLOYMENT_TYPES = [
  { id: 'lt-1', label: 'Daily Wage', payBasis: 'DAILY' },
  { id: 'lt-2', label: 'Permanent', payBasis: 'MONTHLY' },
  { id: 'lt-3', label: 'Consultant', payBasis: null },
];

/** The record edit mode loads. Profile columns arrive nested under `profile`. */
const EXISTING_EMPLOYEE = {
  id: 'emp-1',
  fullName: 'Fatma Al Balushi',
  employeeCode: 'HR-0007',
  idCard: 'HR-0007',
  departmentId: 'dept-hr',
  branchId: 'br-ho',
  startDate: '2024-01-15T00:00:00.000Z',
  employmentType: 'Permanent',
  salaryType: 'MONTHLY',
  baseSalary: '850',
  customFields: { bloodGroup: 'O+' },
  profile: { placeOfBirth: 'Muscat' },
};

// ── DOM helpers ─────────────────────────────────────────────────────────────

const control = (name: string) =>
  document.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement;

const submitButton = () =>
  Array.from(document.querySelectorAll('button')).find(
    (b) => b.getAttribute('type') === 'submit',
  )!;

type User = ReturnType<typeof renderWithProviders>['user'];

/** Clicks Save only. Use when the expectation is that validation blocks it. */
async function attemptSubmit(user: User) {
  await user.click(submitButton());
}

/** Clicks Save and confirms the dialog that guards every write. */
async function confirmSubmit(user: User) {
  await user.click(submitButton());
  await user.click(await screen.findByTestId('confirm-modal-confirm'));
}

function renderCreate() {
  return renderWithProviders(<EmployeeForm mode="create" />, { role: 'ADMIN' });
}

/** Edit mode renders a skeleton until the record has loaded. */
async function renderEdit() {
  const result = renderWithProviders(<EmployeeForm mode="edit" employeeId="emp-1" />, {
    role: 'ADMIN',
  });
  await waitFor(() => expect(control('fullName')).toBeInTheDocument());
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(useProfileTemplate).mockReturnValue({
    data: {
      templateId: 't-1',
      source: 'COMPANY',
      scope: 'COMPANY',
      branchId: null,
      country: null,
      name: 'Default',
      enabled: true,
      sections: SECTIONS,
      fields: ALL_FIELDS,
    },
    isLoading: false,
  } as never);

  vi.mocked(departmentService.getAll).mockResolvedValue(
    ok([
      { id: 'dept-hr', name: 'Human Resources', code: 'HR' },
      { id: 'dept-ops', name: 'Operations', code: 'OPS' },
    ]),
  );
  vi.mocked(branchService.getAll).mockResolvedValue(
    ok([{ id: 'br-ho', name: 'Head Office', code: 'HO' }]),
  );
  vi.mocked(libraryService.getAll).mockImplementation(async (type) =>
    type === 'EMPLOYMENT_TYPE' ? ok(EMPLOYMENT_TYPES) : ok([]),
  );
  vi.mocked(overtimePolicyService.list).mockResolvedValue(ok([]));
  vi.mocked(systemSettingsService.getPublic).mockResolvedValue(ok({}));
  vi.mocked(employeeService.getAll).mockResolvedValue(ok([]));

  generateCode.mockResolvedValue(ok({ employeeCode: 'HR-0042' }));
  getEmployee.mockResolvedValue(ok(EXISTING_EMPLOYEE));
  createEmployee.mockResolvedValue(ok({ id: 'emp-new', employeeCode: 'HR-0042' }));
  updateEmployee.mockResolvedValue(ok({ id: 'emp-1' }));
  updateProfile.mockResolvedValue(ok({}));
  createContract.mockResolvedValue(ok({ id: 'c-1' }));
});

describe('rendering from the template', () => {
  it('renders the sections and fields the template declares, and nothing else', async () => {
    // The form no longer knows what an employee has. If it starts rendering
    // hand-written fields again the two halves can drift apart, which is the
    // exact defect the template rewrite removed.
    renderCreate();

    expect(screen.getByText('Personal')).toBeInTheDocument();
    expect(screen.getByText('Employment')).toBeInTheDocument();
    expect(control('fullName')).toBeInTheDocument();
    expect(control('customFields.bloodGroup')).toBeInTheDocument();
    // Not in the fixture. A field appearing here would mean the renderer is
    // adding controls of its own.
    expect(control('personalEmail')).toBeNull();
  });

  it('shows a skeleton instead of an empty form while the template loads', () => {
    // Rendering an empty form first means a required field can be submitted
    // blank in the window before the template arrives.
    vi.mocked(useProfileTemplate).mockReturnValue({ data: undefined, isLoading: true } as never);

    renderCreate();

    expect(control('fullName')).toBeNull();
    expect(screen.queryByRole('button', { name: /create/i })).not.toBeInTheDocument();
  });
});

describe('the department picker', () => {
  // The regression: the list was filtered to top-level departments, so a tenant
  // whose real departments hang under Human Resources saw five of eleven.
  // Sub-departments hold staff; the service gates only on `isActive`.
  const WITH_SUB_DEPTS = [
    { id: 'dept-hr', name: 'Human Resources', code: 'HR' },
    { id: 'dept-ops', name: 'Operations', code: 'OPS' },
    {
      id: 'dept-fsd',
      name: 'Full Stack Development',
      code: 'FSD',
      parentId: 'dept-hr',
      parent: { id: 'dept-hr', code: 'HR', name: 'Human Resources' },
    },
  ];

  const options = () =>
    Array.from((control('departmentId') as HTMLSelectElement).options);

  it('offers sub-departments alongside top-level ones', async () => {
    vi.mocked(departmentService.getAll).mockResolvedValue(ok(WITH_SUB_DEPTS));

    renderCreate();

    await waitFor(() => expect(options().map((o) => o.value)).toContain('dept-fsd'));
    expect(options().map((o) => o.value)).toEqual(
      expect.arrayContaining(['dept-hr', 'dept-ops', 'dept-fsd']),
    );
  });

  it('labels a sub-department with its own name only', async () => {
    vi.mocked(departmentService.getAll).mockResolvedValue(ok(WITH_SUB_DEPTS));

    renderCreate();

    await waitFor(() =>
      expect(options().find((o) => o.value === 'dept-fsd')?.textContent).toBe(
        'Full Stack Development',
      ),
    );
  });

  it('loads an employee already filed under a sub-department', async () => {
    vi.mocked(departmentService.getAll).mockResolvedValue(ok(WITH_SUB_DEPTS));
    getEmployee.mockResolvedValue(ok({ ...EXISTING_EMPLOYEE, departmentId: 'dept-fsd' }));

    await renderEdit();

    await waitFor(() =>
      expect((control('departmentId') as HTMLSelectElement).value).toBe('dept-fsd'),
    );
  });
});

describe('required fields', () => {
  it('refuses to create an employee with no name', async () => {
    const { user } = renderCreate();

    await attemptSubmit(user);

    await waitFor(() => expect(screen.getByText('Full Name is required')).toBeInTheDocument());
    expect(createEmployee).not.toHaveBeenCalled();
  });

  it('creates once the one required field is filled', async () => {
    // The counterweight to the test above: without it, a form that rejected
    // everything would look equally green.
    const { user } = renderCreate();

    await user.type(control('fullName'), 'Salim Al Hinai');
    await confirmSubmit(user);

    await waitFor(() => expect(createEmployee).toHaveBeenCalledTimes(1));
    expect(bodyOf(createEmployee.mock.calls[0]).fullName).toBe('Salim Al Hinai');
  });

  it('does not let a required-but-generated field block the save', async () => {
    // `employeeCode` is required in the template AND filled by the server from
    // the department. Enforcing requiredness on the client makes the form
    // unsatisfiable — this is the bug that made the create wizard impossible to
    // complete, so it is pinned rather than assumed.
    const { user } = renderCreate();

    await user.type(control('fullName'), 'Salim Al Hinai');
    await confirmSubmit(user);

    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
    expect(screen.queryByText('Employee Code is required')).not.toBeInTheDocument();
  });
});

describe('server-generated identifiers', () => {
  it('renders employee code and ID card read-only', async () => {
    // Both are owned by the server. An editable box invites a value that is
    // silently discarded.
    renderCreate();

    expect(control('employeeCode')).toHaveAttribute('readonly');
    expect(control('idCard')).toHaveAttribute('readonly');
  });

  it('ignores anything typed into the employee code', async () => {
    const { user } = renderCreate();

    await user.type(control('employeeCode'), 'HACK-1');

    expect(control('employeeCode')).toHaveValue('');
  });

  it('regenerates the code and ID card when the department changes', async () => {
    // Employee codes are department-prefixed, so a moved employee must not keep
    // the old department's code.
    const { user } = renderCreate();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Human Resources' })).toBeInTheDocument(),
    );

    await user.selectOptions(control('departmentId'), 'dept-hr');

    await waitFor(() => expect(generateCode).toHaveBeenCalledWith('dept-hr'));
    await waitFor(() => expect(control('employeeCode')).toHaveValue('HR-0042'));
    expect(control('idCard')).toHaveValue('HR-0042');
  });

  it('never sends the previewed employee code back', async () => {
    // The server generates it — and regenerates it on a uniqueness collision.
    // A client-supplied code was a real defect.
    const { user } = renderCreate();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Human Resources' })).toBeInTheDocument(),
    );
    await user.selectOptions(control('departmentId'), 'dept-hr');
    await waitFor(() => expect(control('employeeCode')).toHaveValue('HR-0042'));

    await user.type(control('fullName'), 'Salim Al Hinai');
    await confirmSubmit(user);

    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
    const payload = bodyOf(createEmployee.mock.calls[0]);
    expect(payload).not.toHaveProperty('employeeCode');
    // `idCard` DOES go, and that is deliberate: the create DTO accepts it and
    // flags it as auto-filled so the server can regenerate the pair together.
    expect(payload.idCard).toBe('HR-0042');
  });
});

describe('the employee / profile payload split', () => {
  it('routes each field to the endpoint that owns its table', async () => {
    // Three destinations, one form. The employee endpoints run under
    // `forbidNonWhitelisted`, so a profile column sent to them 400s the entire
    // save rather than being ignored.
    const { user } = renderCreate();

    await user.type(control('fullName'), 'Salim Al Hinai');
    await user.type(control('placeOfBirth'), 'Nizwa');
    await user.type(control('customFields.bloodGroup'), 'O+');
    await confirmSubmit(user);

    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
    const employeeBody = bodyOf(createEmployee.mock.calls[0]);
    expect(employeeBody.fullName).toBe('Salim Al Hinai');
    // JSONB rides on the EMPLOYEE body even though its boundColumn names a
    // profile column: storage decides the destination.
    expect(employeeBody.customFields).toEqual({ bloodGroup: 'O+' });
    expect(employeeBody).not.toHaveProperty('placeOfBirth');

    // …and the profile column goes to the profile endpoint, keyed by the id the
    // create call just returned.
    await waitFor(() => expect(updateProfile).toHaveBeenCalled());
    expect(updateProfile).toHaveBeenCalledWith('emp-new', { placeOfBirth: 'Nizwa' });
  });

  it('skips the profile call entirely when no profile column was filled', async () => {
    // Guarded on `Object.keys(profileValues).length`. Worth pinning because it
    // is what makes the test above meaningful: with the field left blank the
    // endpoint is never called at all.
    const { user } = renderCreate();

    await user.type(control('fullName'), 'Salim Al Hinai');
    await confirmSubmit(user);

    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('omits untouched optional fields on create rather than sending empty strings', async () => {
    // `@IsOptional()` skips undefined and null but NOT ''. Sending '' made five
    // untouched fields fail their own validators at once.
    const { user } = renderCreate();

    await user.type(control('fullName'), 'Salim Al Hinai');
    await confirmSubmit(user);

    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
    const payload = bodyOf(createEmployee.mock.calls[0]);
    expect(payload).not.toHaveProperty('departmentId');
    expect(Object.values(payload)).not.toContain('');
  });

  it('reports a failed profile save without claiming the employee failed', async () => {
    // There is no transaction. The employee exists; only the second call fell
    // over, and staying silent about it leaves half a record nobody knows about.
    updateProfile.mockRejectedValue({ message: 'profile rejected' });

    const { user } = renderCreate();
    await user.type(control('fullName'), 'Salim Al Hinai');
    await user.type(control('placeOfBirth'), 'Nizwa');
    await confirmSubmit(user);

    await waitFor(() => expect(updateProfile).toHaveBeenCalled());
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(createEmployee).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith('/dashboard/employees');
  });
});

describe('pay basis derived from the employment type', () => {
  it('locks pay basis to DAILY when the employment type dictates it', async () => {
    // The reason this rule exists: on a DAILY employee `baseSalary` is a
    // per-day rate. Leaving the basis editable lets HR save a day rate flagged
    // MONTHLY, and payroll then pays ~26x too little for a month.
    const { user } = renderCreate();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Daily Wage' })).toBeInTheDocument(),
    );

    await user.selectOptions(control('employmentType'), 'Daily Wage');

    await waitFor(() => expect(control('salaryType')).toHaveValue('DAILY'));
    expect(control('salaryType')).toBeDisabled();
  });

  it('leaves pay basis editable when the employment type dictates none', async () => {
    // Not every employment type fixes a basis; an unflagged one has to leave
    // the choice with HR rather than defaulting silently.
    const { user } = renderCreate();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Consultant' })).toBeInTheDocument(),
    );

    await user.selectOptions(control('employmentType'), 'Consultant');

    expect(control('salaryType')).not.toBeDisabled();
  });

  it('omits the locked basis from the payload so the server derives it', async () => {
    // The server derives the same value from the employment type and REJECTS a
    // contradicting one. Sending the mirrored value would make the save fail
    // whenever the two disagree by a race.
    const { user } = renderCreate();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Daily Wage' })).toBeInTheDocument(),
    );
    await user.selectOptions(control('employmentType'), 'Daily Wage');
    await waitFor(() => expect(control('salaryType')).toHaveValue('DAILY'));

    await user.type(control('fullName'), 'Salim Al Hinai');
    await confirmSubmit(user);

    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
    const payload = bodyOf(createEmployee.mock.calls[0]);
    expect(payload).not.toHaveProperty('salaryType');
    // The employment type IS sent — it is what the server derives the basis
    // from, so dropping it would leave the basis unset rather than derived.
    expect(payload.employmentType).toBe('Daily Wage');
  });

  it('sends the chosen basis when no employment type locks it', async () => {
    // The complement of the test above. Without this, deleting the salaryType
    // key unconditionally would still look correct.
    const { user } = renderCreate();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Consultant' })).toBeInTheDocument(),
    );
    await user.selectOptions(control('employmentType'), 'Consultant');
    await user.selectOptions(control('salaryType'), 'DAILY');

    await user.type(control('fullName'), 'Salim Al Hinai');
    await confirmSubmit(user);

    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
    expect(bodyOf(createEmployee.mock.calls[0]).salaryType).toBe('DAILY');
  });

  it('does not rewrite a live employee’s basis just because the form opened', async () => {
    // The stored employee is MONTHLY while their employment type says DAILY.
    // Merely OPENING the record must not flip the basis: that re-reads their
    // base salary as a per-day rate on the next payroll run, with no one having
    // asked for it. A warning is shown instead, and the change only happens if
    // the user saves.
    getEmployee.mockResolvedValue(ok({ ...EXISTING_EMPLOYEE, employmentType: 'Daily Wage' }));

    await renderEdit();

    await waitFor(() => expect(control('salaryType')).toBeDisabled());
    expect(control('salaryType')).toHaveValue('MONTHLY');
    expect(screen.getByText(/will change this employee's pay basis/i)).toBeInTheDocument();
  });
});

describe('edit mode', () => {
  it('loads the record and updates rather than creates', async () => {
    const { user } = await renderEdit();

    expect(getEmployee).toHaveBeenCalledWith('emp-1');
    expect(control('fullName')).toHaveValue('Fatma Al Balushi');

    await confirmSubmit(user);

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledWith('emp-1', expect.anything()));
    expect(createEmployee).not.toHaveBeenCalled();
  });

  it('splits the loaded record across both endpoints on save', async () => {
    // The edit path has its own splitting call, so it can regress independently
    // of create. Profile columns arrive nested under `profile` and must come
    // back out to the profile endpoint.
    const { user } = await renderEdit();
    expect(control('placeOfBirth')).toHaveValue('Muscat');

    await confirmSubmit(user);

    await waitFor(() => expect(updateEmployee).toHaveBeenCalled());
    const employeeBody = bodyOf(updateEmployee.mock.calls[0], 1);
    expect(employeeBody).not.toHaveProperty('placeOfBirth');
    expect(employeeBody.customFields).toEqual({ bloodGroup: 'O+' });
    expect(updateProfile).toHaveBeenCalledWith('emp-1', { placeOfBirth: 'Muscat' });
  });

  it('sends only template-governed keys, not the whole loaded record', async () => {
    // `reset()` fills the form model with the entire API response — `id`,
    // `profile`, and anything else the endpoint returned. `forbidNonWhitelisted`
    // rejects the lot, so an untouched edit would 400 listing every extra key.
    const { user } = await renderEdit();

    await confirmSubmit(user);

    await waitFor(() => expect(updateEmployee).toHaveBeenCalled());
    const employeeBody = bodyOf(updateEmployee.mock.calls[0], 1);
    expect(employeeBody).not.toHaveProperty('id');
    expect(employeeBody).not.toHaveProperty('profile');
  });

  it('strips start date and branch, which need their own reviewed flow', async () => {
    // A start-date change rewrites payroll history and a branch change crosses
    // the branch-isolation axis. Both are loaded into the form (asserted here,
    // so this cannot pass by the fields simply being absent) and neither is
    // accepted on PATCH.
    const { user } = await renderEdit();
    expect(control('startDate')).toHaveValue('2024-01-15');
    expect(control('branchId')).toHaveValue('br-ho');

    await confirmSubmit(user);

    await waitFor(() => expect(updateEmployee).toHaveBeenCalled());
    const employeeBody = bodyOf(updateEmployee.mock.calls[0], 1);
    expect(employeeBody).not.toHaveProperty('startDate');
    expect(employeeBody).not.toHaveProperty('branchId');
  });

  it('clears an emptied optional field with null rather than an empty string', async () => {
    // On EDIT, emptying a box IS the instruction to clear the column, and null
    // is what the DTOs accept for that — '' fails their validators. On create
    // the same blank means "not provided" and is omitted, which the create
    // tests above pin.
    const { user } = await renderEdit();

    await user.clear(control('placeOfBirth'));
    await confirmSubmit(user);

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith('emp-1', { placeOfBirth: null }));
  });

  it('returns to the list on a successful update', async () => {
    const { user } = await renderEdit();

    await confirmSubmit(user);

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith('/dashboard/employees'));
  });
});

describe('a rejected save', () => {
  it('puts the server’s per-field reasons on the fields themselves', async () => {
    // Without this the precise reason collapses into one generic toast and the
    // user has to guess which box the server objected to. Note the nested key:
    // a JSONB field's error path is `customFields.<key>`, and it has to land on
    // that control rather than nowhere.
    createEmployee.mockRejectedValue({
      message: 'Validation failed',
      errors: {
        fullName: 'An employee with this name already exists',
        'customFields.bloodGroup': 'Not a recognised blood group',
      },
    });

    const { user } = renderCreate();
    await user.type(control('fullName'), 'Salim Al Hinai');
    await user.type(control('customFields.bloodGroup'), 'ZZ');
    await confirmSubmit(user);

    await waitFor(() =>
      expect(screen.getByText('An employee with this name already exists')).toBeInTheDocument(),
    );
    expect(screen.getByText('Not a recognised blood group')).toBeInTheDocument();
    // The banner is suppressed when the fields carry the reasons.
    expect(toastError).not.toHaveBeenCalled();
  });

  it('keeps the user on the form so the input can be corrected', async () => {
    createEmployee.mockRejectedValue({
      message: 'Validation failed',
      errors: { fullName: 'An employee with this name already exists' },
    });

    const { user } = renderCreate();
    await user.type(control('fullName'), 'Salim Al Hinai');
    await confirmSubmit(user);

    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
    expect(routerMock.push).not.toHaveBeenCalledWith('/dashboard/employees');
  });

  it('falls back to a banner when the server sent no field map', async () => {
    // A NestJS ValidationPipe failure carries `message` as a string array and no
    // `errors` map, so there is nothing to attach — silence here would make the
    // save look like it worked.
    createEmployee.mockRejectedValue({ message: 'Database unavailable' });

    const { user } = renderCreate();
    await user.type(control('fullName'), 'Salim Al Hinai');
    await confirmSubmit(user);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it('surfaces field errors from a rejected update too', async () => {
    // Same mapping on the edit path, which calls a different endpoint.
    updateEmployee.mockRejectedValue({
      message: 'Validation failed',
      errors: { fullName: 'Name is not permitted' },
    });

    const { user } = await renderEdit();
    await confirmSubmit(user);

    await waitFor(() => expect(screen.getByText('Name is not permitted')).toBeInTheDocument());
  });
});

describe('the optional initial contract', () => {
  it('is offered on create', async () => {
    renderCreate();
    expect(screen.getByLabelText(/assign initial contract/i)).toBeInTheDocument();
  });

  it('is not offered on edit', async () => {
    // Editing an employee must not silently mint a second contract; contract
    // changes have their own screen. Separate test rather than a second render
    // in the one above — Testing Library only unmounts between tests, so both
    // forms would be in the document at once and the assertion would be a lie.
    await renderEdit();
    expect(screen.queryByLabelText(/assign initial contract/i)).not.toBeInTheDocument();
  });

  it('blocks the save when the block is on but incomplete', async () => {
    // Half a contract is worse than none — the employee would be created and
    // the contract silently skipped. The whole submit stops instead.
    const { user } = renderCreate();

    await user.type(control('fullName'), 'Salim Al Hinai');
    await user.click(screen.getByLabelText(/assign initial contract/i));
    await attemptSubmit(user);

    await waitFor(() => expect(createEmployee).not.toHaveBeenCalled());
  });

  it('creates the contract after the employee, with the id the create returned', async () => {
    // Ordering is the point: the contract needs an employee id that does not
    // exist until the first call resolves.
    const { user } = renderCreate();

    await user.type(control('fullName'), 'Salim Al Hinai');
    await user.type(control('baseSalary'), '850');
    await user.click(screen.getByLabelText(/assign initial contract/i));
    await user.selectOptions(control('initialContract.contractType'), 'PROBATION');
    await user.type(control('initialContract.startDate'), '2026-09-01');
    await user.type(control('initialContract.endDate'), '2026-12-01');
    await confirmSubmit(user);

    await waitFor(() => expect(createContract).toHaveBeenCalled());
    const contract = bodyOf(createContract.mock.calls[0]);
    expect(contract.employeeId).toBe('emp-new');
    expect(contract.contractType).toBe('PROBATION');
    // The contract's salary is copied from the employee's base salary; a 0 here
    // means an employee on a contract worth nothing.
    expect(contract.salary).toBe(850);
  });
});

/**
 * NOT COVERED, named rather than quietly omitted:
 *
 *   - **The SalaryStructure block** rendered in the `compensation` section
 *     footer on edit. It is a separate entity that saves itself, and it fetches
 *     its own components — the fixture deliberately avoids that section key so
 *     these tests are not coupled to it. It needs its own file.
 *   - **The grouped timezone picker**, which is a bespoke widget substituted via
 *     `renderField`, and the start-date min/max HINTS, which come from
 *     `useStartDateBounds`. Both are picker affordances the server re-checks;
 *     `TimezoneSelect` and `useStartDateBounds` are the right places to test
 *     them.
 *   - **The contract-failure branch** (employee created, contract rejected).
 *     Identical in shape to the profile-failure branch covered above.
 */
