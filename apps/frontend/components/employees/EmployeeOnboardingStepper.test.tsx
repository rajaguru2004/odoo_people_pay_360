import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { routerMock } from '@/test/router-mock';
import EmployeeOnboardingStepper from './EmployeeOnboardingStepper';

/**
 * The onboarding wizard's submit, which is four calls pretending to be one.
 *
 *   1. employeeService.create          — the record itself
 *   2. employeeProfileService.updateProfile — template-driven fields
 *   3. salaryComponentService.create   — one per salary row
 *   4. salaryComponentService.create   — PAYROLL_CONFIG, overrides as JSON
 *
 * There is no transaction, and each of steps 2-4 is GUARDED — it runs only if
 * the user configured that part. A minimal onboarding is therefore a single
 * write, which is what these tests pin. The partial-failure path that follows
 * from having configured more is documented at the foot of this file and is
 * not covered here.
 *
 * The template is mocked down to ONE optional JSONB field. The wizard's fields
 * come from the configurable Employee Profile Template, so filling a realistic
 * set would assert one tenant's configuration rather than the submit sequence
 * under test — `Field` and `TemplateFormRenderer` cover rendering separately.
 *
 * One field rather than none, though, and the distinction matters: step 2 is
 * skipped entirely when `profileValues` is empty
 * (`if (newId && Object.keys(profileValues).length)`). A wholly empty template
 * therefore never calls `updateProfile` at all, and a test that mocked it to
 * fail would pass while proving nothing. Filling one JSONB field is what makes
 * the failure path real.
 */

vi.mock('@/hooks/useProfileTemplate', () => ({
  useProfileTemplate: vi.fn(),
}));

vi.mock('@/services/employeeService', () => ({
  default: { create: vi.fn() },
}));
vi.mock('@/services/employeeProfileService', () => ({
  employeeProfileService: { updateProfile: vi.fn(), getProfile: vi.fn() },
}));
vi.mock('@/services/contractService', () => ({
  default: { create: vi.fn() },
}));
vi.mock('@/services/salaryComponentService', () => ({
  default: { create: vi.fn(), getByEmployee: vi.fn() },
}));
vi.mock('@/services/departmentService', () => ({
  default: { getAll: vi.fn() },
}));
vi.mock('@/services/branchService', () => ({
  default: { getAll: vi.fn() },
}));
vi.mock('@/services/libraryService', () => ({
  default: { getAll: vi.fn() },
}));
vi.mock('@/services/overtimePolicyService', () => ({
  default: { list: vi.fn() },
}));
vi.mock('@/services/systemSettingsService', () => ({
  default: { getAll: vi.fn(), getPublic: vi.fn() },
}));
vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { useProfileTemplate } from '@/hooks/useProfileTemplate';
import employeeService from '@/services/employeeService';
import { employeeProfileService } from '@/services/employeeProfileService';
import salaryComponentService from '@/services/salaryComponentService';
import departmentService from '@/services/departmentService';
import branchService from '@/services/branchService';
import libraryService from '@/services/libraryService';
import overtimePolicyService from '@/services/overtimePolicyService';
import systemSettingsService from '@/services/systemSettingsService';
import { toast } from '@/lib/toast';

const createEmployee = vi.mocked(employeeService.create);
const updateProfile = vi.mocked(employeeProfileService.updateProfile);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);

const ok = (data: unknown) => ({ success: true, data }) as never;

/**
 * One optional JSONB text field on step 1.
 *
 * JSONB rather than COLUMN so its value lands in `customFields` and therefore
 * in the profile payload — which is what makes step 2 of the submit actually
 * run. Optional so the step still advances if the test leaves it blank.
 */
const TEMPLATE_SECTION = {
  id: null,
  sectionKey: 'personal',
  label: 'Personal',
  icon: null,
  wizardStep: 1,
  columns: 1,
  displayOrder: 1,
  fields: [
    {
      id: null,
      sectionKey: 'personal',
      fieldKey: 'bloodGroup',
      label: 'Blood group',
      fieldType: 'TEXT',
      // BOTH of these matter, and neither alone is enough.
      //
      // `toEmployeePayloads` only considers a field for the profile payload
      // when `storage === 'COLUMN'`; JSONB fields always go to `customFields`
      // on the EMPLOYEE payload. Among COLUMN fields, the destination is then
      // decided by `boundColumn`'s table prefix. So a profile-bound field is
      // COLUMN + `employeeProfile.*`, and getting either wrong means the
      // profile call never happens — which is how a partial-failure test can
      // pass while never exercising the call it mocks.
      storage: 'COLUMN',
      boundColumn: 'employeeProfile.bloodGroup',
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
      origin: 'CUSTOM',
      locked: false,
      systemRequired: false,
      lockReason: null,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(useProfileTemplate).mockReturnValue({
    data: {
      enabled: true,
      source: 'COMPANY',
      sections: [TEMPLATE_SECTION],
      fields: TEMPLATE_SECTION.fields,
    },
    isLoading: false,
  } as never);

  vi.mocked(departmentService.getAll).mockResolvedValue(ok([{ id: 'd1', name: 'HR', code: 'HRD' }]));
  vi.mocked(branchService.getAll).mockResolvedValue(ok([{ id: 'b1', name: 'HO', code: 'HO' }]));
  vi.mocked(libraryService.getAll).mockResolvedValue(ok([]));
  vi.mocked(overtimePolicyService.list).mockResolvedValue(ok([]));
  vi.mocked(systemSettingsService.getAll)?.mockResolvedValue?.(ok([]));
  vi.mocked(systemSettingsService.getPublic)?.mockResolvedValue?.(ok({}));

  createEmployee.mockResolvedValue(ok({ id: 'emp-new', employeeCode: 'EMP999' }));
  updateProfile.mockResolvedValue(ok({}));
  vi.mocked(salaryComponentService.create).mockResolvedValue(ok({}));
});

/** Walks the wizard to the review step and submits, confirming the dialog. */
async function submitWizard(
  user: ReturnType<typeof renderWithProviders>['user'],
  opts: { fillTemplateField?: boolean } = {},
) {
  // Filling the template field is what makes the profile call happen at all —
  // it is left off by default so the "guarded, not unconditional" tests below
  // mean what they say.
  if (opts.fillTemplateField) {
    // A COLUMN field registers under its bare key, not under `customFields.`.
    const field = document.querySelector('input[name="bloodGroup"]') as HTMLInputElement | null;
    if (field) await user.type(field, 'O+');
  }

  // The template field is optional, the contract block is off by default and
  // there are no salary rows, so every step advances from here.
  for (let i = 0; i < 4; i += 1) {
    const next = screen.queryByTestId('onboard-next');
    if (!next) break;
    await user.click(next);
  }

  await waitFor(() => expect(screen.getByTestId('onboard-submit')).toBeInTheDocument());
  await user.click(screen.getByTestId('onboard-submit'));

  // The submit is guarded by the shared confirm dialog.
  await waitFor(() => expect(screen.getByTestId('confirm-modal-confirm')).toBeInTheDocument());
  await user.click(screen.getByTestId('confirm-modal-confirm'));
}

function renderWizard() {
  return renderWithProviders(<EmployeeOnboardingStepper />, { role: 'ADMIN' });
}

describe('reaching the review step', () => {
  it('advances through the wizard with an empty template', async () => {
    const { user } = renderWizard();
    await waitFor(() => expect(screen.getByTestId('onboard-next')).toBeInTheDocument());

    for (let i = 0; i < 4; i += 1) {
      const next = screen.queryByTestId('onboard-next');
      if (!next) break;
      await user.click(next);
    }

    await waitFor(() => expect(screen.getByTestId('onboard-submit')).toBeInTheDocument());
  });
});

describe('the department picker', () => {
  // The wizard is where the filter hurt most: six of eleven departments were
  // simply absent from the list, with nothing on screen to say why.
  const DEPARTMENT_FIELD = {
    ...TEMPLATE_SECTION.fields[0],
    fieldKey: 'departmentId',
    label: 'Department',
    fieldType: 'DEPARTMENT_SELECT',
    boundColumn: 'employee.departmentId',
    displayOrder: 2,
  };

  it('lists sub-departments under their own name', async () => {
    const section = {
      ...TEMPLATE_SECTION,
      fields: [...TEMPLATE_SECTION.fields, DEPARTMENT_FIELD],
    };
    vi.mocked(useProfileTemplate).mockReturnValue({
      data: { enabled: true, source: 'COMPANY', sections: [section], fields: section.fields },
      isLoading: false,
    } as never);
    vi.mocked(departmentService.getAll).mockResolvedValue(
      ok([
        { id: 'd1', name: 'HR', code: 'HRD' },
        {
          id: 'd2',
          name: 'Full Stack Development',
          code: 'FSD',
          parentId: 'd1',
          parent: { id: 'd1', code: 'HRD', name: 'HR' },
        },
      ]),
    );

    renderWizard();

    const select = () => document.querySelector('select[name="departmentId"]') as HTMLSelectElement;
    await waitFor(() => expect(select()).toBeInTheDocument());
    await waitFor(() =>
      expect(Array.from(select().options).map((o) => o.value)).toContain('d2'),
    );
    expect(
      Array.from(select().options).find((o) => o.value === 'd2')?.textContent,
    ).toBe('Full Stack Development');
  });
});

describe('the submit sequence', () => {
  it('creates the employee', async () => {
    const { user } = renderWizard();
    await waitFor(() => expect(screen.getByTestId('onboard-next')).toBeInTheDocument());

    await submitWizard(user);

    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
  });

  it('never sends a client-chosen employee code', async () => {
    // The server generates it. A client-supplied code was a real defect, and
    // the wizard deletes the field from the payload for that reason.
    const { user } = renderWizard();
    await waitFor(() => expect(screen.getByTestId('onboard-next')).toBeInTheDocument());

    await submitWizard(user);

    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
    expect(createEmployee.mock.calls[0][0]).not.toHaveProperty('employeeCode');
  });

  it('reports success and navigates when every call succeeds', async () => {
    const { user } = renderWizard();
    await waitFor(() => expect(screen.getByTestId('onboard-next')).toBeInTheDocument());

    await submitWizard(user);

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith('/dashboard/employees'));
    expect(toastSuccess).toHaveBeenCalled();
  });
});

describe('the downstream calls are guarded, not unconditional', () => {
  it('skips the profile update when the template contributed no values', async () => {
    // `if (newId && Object.keys(profileValues).length)`. Worth pinning because
    // it is the reason a naive test of the partial-failure path passes while
    // proving nothing: mock updateProfile to reject, leave the template fields
    // blank, and it is never called at all.
    const { user } = renderWizard();
    await waitFor(() => expect(screen.getByTestId('onboard-next')).toBeInTheDocument());

    await submitWizard(user);

    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('skips the payroll-config component when no override was set', async () => {
    // Guarded on `empPfEnabled !== null || empEsiEnabled !== null || empPtEnabled !== null`.
    // An employee who inherits every statutory default gets no PAYROLL_CONFIG
    // row, which is correct — the row exists to record a DIFFERENCE.
    const { user } = renderWizard();
    await waitFor(() => expect(screen.getByTestId('onboard-next')).toBeInTheDocument());

    await submitWizard(user);

    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
    expect(salaryComponentService.create).not.toHaveBeenCalled();
  });

  it('creates the employee with exactly one call when nothing else is configured', async () => {
    // The plain case: a minimal onboarding really is a single write, so there
    // is no partial state to be inconsistent about.
    const { user } = renderWizard();
    await waitFor(() => expect(screen.getByTestId('onboard-next')).toBeInTheDocument());

    await submitWizard(user);

    await waitFor(() => expect(createEmployee).toHaveBeenCalledTimes(1));
    expect(routerMock.push).toHaveBeenCalledWith('/dashboard/employees');
    expect(toastSuccess).toHaveBeenCalled();
  });
});

describe('when a later call fails, the employee is still created and kept', () => {
  it('calls the profile endpoint once the template contributes a value', async () => {
    // The precondition for everything below. Asserted on its own so that a
    // change which stops the call being made fails HERE, loudly, rather than
    // quietly hollowing out the tests that follow.
    const { user } = renderWizard();
    await waitFor(() => expect(screen.getByTestId('onboard-next')).toBeInTheDocument());

    await submitWizard(user, { fillTemplateField: true });

    await waitFor(() => expect(updateProfile).toHaveBeenCalled());
  });

  it('still reports success and navigates when the profile save fails', async () => {
    // DOCUMENTING CURRENT BEHAVIOUR, not endorsing it. The employee exists, its
    // template-driven fields did not save, and the user is returned to the list
    // having been told it worked.
    updateProfile.mockRejectedValue({ message: 'profile rejected' });

    const { user } = renderWizard();
    await waitFor(() => expect(screen.getByTestId('onboard-next')).toBeInTheDocument());

    await submitWizard(user, { fillTemplateField: true });

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith('/dashboard/employees'));
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('does say something, rather than failing silently', async () => {
    // The one thing that must not regress. If this toast disappears, a
    // half-created employee becomes invisible to the person who created it.
    updateProfile.mockRejectedValue({ message: 'profile rejected' });

    const { user } = renderWizard();
    await waitFor(() => expect(screen.getByTestId('onboard-next')).toBeInTheDocument());

    await submitWizard(user, { fillTemplateField: true });

    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it('does not roll back the employee it already created', async () => {
    // There is no transaction and no compensating delete, so the record stays.
    // Pinned so that adding a rollback is a deliberate change with a failing
    // test, rather than something nobody notices either way.
    updateProfile.mockRejectedValue({ message: 'profile rejected' });

    const { user } = renderWizard();
    await waitFor(() => expect(screen.getByTestId('onboard-next')).toBeInTheDocument());

    await submitWizard(user, { fillTemplateField: true });

    await waitFor(() => expect(createEmployee).toHaveBeenCalledTimes(1));
    expect(routerMock.push).toHaveBeenCalledWith('/dashboard/employees');
  });
});

/**
 * NOT COVERED, and named rather than quietly omitted: the CONTRACT and
 * SALARY-COMPONENT failure branches. Both are guarded on the user switching the
 * contract block on or adding salary rows, so reaching them means driving two
 * further steps of the form. The profile branch above has the same shape and is
 * covered, so the marginal value is low — but the behaviour is identical and
 * equally worth questioning.
 *
 * Worth recording, because it cost two wrong attempts: a field only reaches the
 * PROFILE payload when it is `storage: 'COLUMN'` AND its `boundColumn` starts
 * with `employeeProfile.`. A `JSONB` field always lands in `customFields` on the
 * employee payload instead, whatever its boundColumn says — so a fixture that
 * gets either wrong produces a test that passes without ever calling the
 * endpoint it mocks.
 */

describe('when the employee itself cannot be created', () => {
  it('stays on the wizard so the user can correct their input', async () => {
    // Step 1 failing is the case that IS handled properly — nothing downstream
    // ran, so there is nothing to be inconsistent about.
    createEmployee.mockRejectedValue({ message: 'Email already exists' });

    const { user } = renderWizard();
    await waitFor(() => expect(screen.getByTestId('onboard-next')).toBeInTheDocument());

    await submitWizard(user);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(routerMock.push).not.toHaveBeenCalledWith('/dashboard/employees');
  });

  it('does not attempt the downstream calls', async () => {
    createEmployee.mockRejectedValue({ message: 'Email already exists' });

    const { user } = renderWizard();
    await waitFor(() => expect(screen.getByTestId('onboard-next')).toBeInTheDocument());

    await submitWizard(user);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(updateProfile).not.toHaveBeenCalled();
    expect(salaryComponentService.create).not.toHaveBeenCalled();
  });
});
