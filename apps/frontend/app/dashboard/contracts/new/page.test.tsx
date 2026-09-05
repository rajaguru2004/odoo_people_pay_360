import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import NewContractPage from './page';

/**
 * Creating a contract.
 *
 * A contract is the document that sets someone's pay, and this form is where
 * two rules that only exist in the shape of the payload get decided:
 *
 *  - `endDate` is sent only when the type is not INDEFINITE. Sending one anyway
 *    would make a permanent contract expire; omitting it on a fixed term is a
 *    400 the user could not have predicted.
 *  - the employee is posted as the id that was SELECTED, never the text that
 *    was typed — the picker is an autocomplete, so those two can differ.
 *
 * The list it offers is `/employees/without-active-contract`, not every
 * employee: "one active contract at a time" is a server rule, and a form that
 * offers someone who already has one is offering a guaranteed 409.
 */

vi.mock('@/services/contractService', () => ({
  default: { create: vi.fn() },
}));

vi.mock('@/services/employeeService', () => ({
  default: { getWithoutActiveContract: vi.fn(), getAll: vi.fn() },
}));

vi.mock('@/services/libraryService', () => ({
  default: { getAll: vi.fn() },
}));

vi.mock('@/services/salaryComponentService', () => ({
  default: { create: vi.fn(), getByEmployee: vi.fn() },
}));

vi.mock('@/services/systemSettingsService', () => ({
  // `getPublic` is reached indirectly through `useStartDateBounds`, which the
  // date inputs use to clamp their `min`/`max`. Omitting it fails every case
  // with "getPublic is not a function" long before any assertion runs.
  default: { getAll: vi.fn(), getPublic: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import contractService from '@/services/contractService';
import employeeService from '@/services/employeeService';
import libraryService from '@/services/libraryService';
import systemSettingsService from '@/services/systemSettingsService';
import { toast } from '@/lib/toast';

const create = vi.mocked(contractService.create);

const EMPLOYEES = [
  {
    id: 'emp-1',
    employeeCode: 'E2E-NOCON',
    fullName: 'Uncontracted Staff',
    position: 'Analyst',
    email: 'nocon@company.com',
    department: { name: 'Operations' },
  },
];

const LIBRARY: Record<string, { label: string }[]> = {
  SALARY_COMPONENT_TYPE: [{ label: 'HRA' }],
  CONTRACT_TYPE: [
    { label: 'Indefinite' },
    { label: 'Fixed Term' },
    { label: 'Probation' },
  ],
  WORK_MODE: [{ label: 'Full Time' }, { label: 'Part Time' }],
};

const renderPage = () =>
  renderWithProviders(<NewContractPage />, { role: 'HR_MANAGER' });

async function selectEmployee(
  user: ReturnType<typeof renderWithProviders>['user'],
) {
  // The option list is rendered only while the dropdown is open, which happens
  // on focus. Clicking the option straight away finds nothing.
  await user.click(screen.getByTestId('con-form-employee-search'));
  await waitFor(() =>
    expect(
      screen.getByTestId('con-form-employee-option-E2E-NOCON'),
    ).toBeInTheDocument(),
  );
  await user.click(screen.getByTestId('con-form-employee-option-E2E-NOCON'));
}

describe('New contract page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(employeeService.getWithoutActiveContract).mockResolvedValue({
      success: true,
      data: EMPLOYEES,
    } as never);
    vi.mocked(libraryService.getAll).mockImplementation(((type?: string) =>
      Promise.resolve({ success: true, data: LIBRARY[type ?? ''] ?? [] })) as never);
    vi.mocked(systemSettingsService.getAll).mockResolvedValue({
      success: true,
      data: {},
    } as never);
    vi.mocked(systemSettingsService.getPublic).mockResolvedValue({
      success: true,
      data: {},
    } as never);
    create.mockResolvedValue({
      success: true,
      data: { id: 'contract-1' },
    } as never);
  });

  describe('who it offers', () => {
    it('asks for the employees who have no active contract, not for everyone', async () => {
      renderPage();
      await waitFor(() =>
        expect(employeeService.getWithoutActiveContract).toHaveBeenCalled(),
      );
      // Offering someone who already holds a contract would be offering a 409.
      expect(employeeService.getAll).not.toHaveBeenCalled();
    });
  });

  describe('the end date', () => {
    it('is not offered for an INDEFINITE contract', async () => {
      const { user } = renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('con-form-type')).toBeInTheDocument(),
      );
      await user.selectOptions(screen.getByTestId('con-form-type'), 'Indefinite');
      // Rendered but disabled, rather than removed — so the assertion is that
      // it cannot be filled, not that it is absent.
      expect(screen.getByTestId('con-form-end')).toBeDisabled();
    });

    it('appears as soon as the type is anything else', async () => {
      const { user } = renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('con-form-type')).toBeInTheDocument(),
      );
      // The type list arrives from the CONTRACT_TYPE library AFTER the first
      // paint — the select renders its hardcoded fallback first, and "Fixed
      // Term" only exists in the library set. Selecting before it lands picks
      // from the wrong list.
      await waitFor(() =>
        expect(
          screen.getByRole('option', { name: 'Fixed Term' }),
        ).toBeInTheDocument(),
      );
      await user.selectOptions(screen.getByTestId('con-form-type'), 'Fixed Term');
      await waitFor(() =>
        expect(screen.getByTestId('con-form-end')).toBeEnabled(),
      );
    });
  });

  describe('what it sends', () => {
    it('posts the selected employee id and omits endDate on an INDEFINITE contract', async () => {
      const { user } = renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('con-form-employee-search')).toBeInTheDocument(),
      );
      await selectEmployee(user);
      await user.selectOptions(screen.getByTestId('con-form-type'), 'Indefinite');
      await user.type(screen.getByTestId('con-form-start'), '2026-01-01');
      await user.type(screen.getByTestId('con-form-salary'), '55000');
      await user.click(screen.getByTestId('con-form-submit'));

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const payload = create.mock.calls[0][0] as unknown as Record<string, unknown>;
      expect(payload.employeeId).toBe('emp-1');
      expect(payload.contractType).toBe('INDEFINITE');
      expect(payload.salary).toBe(55000);
      // Explicitly undefined, not merely falsy: sending a date here would make
      // a permanent contract expire.
      expect(payload.endDate).toBeUndefined();
    });

    it('sends the end date once the contract is a fixed term', async () => {
      const { user } = renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('con-form-employee-search')).toBeInTheDocument(),
      );
      await selectEmployee(user);
      await user.selectOptions(screen.getByTestId('con-form-type'), 'Fixed Term');
      await user.type(screen.getByTestId('con-form-start'), '2026-01-01');
      await waitFor(() =>
        expect(screen.getByTestId('con-form-end')).toBeEnabled(),
      );
      await user.type(screen.getByTestId('con-form-end'), '2026-12-31');
      await user.type(screen.getByTestId('con-form-salary'), '42000');
      await user.click(screen.getByTestId('con-form-submit'));

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const payload = create.mock.calls[0][0] as unknown as Record<string, unknown>;
      expect(payload.contractType).toBe('FIXED_TERM');
      expect(payload.endDate).toBe('2026-12-31');
    });

    it('maps the library label to the enum the backend actually accepts', async () => {
      // The type dropdown is filled from a LIBRARY of human labels
      // ("Fixed Term"), while the DTO is an enum ("FIXED_TERM"). The mapping is
      // the only thing between a readable dropdown and a 400.
      const { user } = renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('con-form-employee-search')).toBeInTheDocument(),
      );
      await selectEmployee(user);
      await user.selectOptions(screen.getByTestId('con-form-type'), 'Probation');
      await user.type(screen.getByTestId('con-form-start'), '2026-01-01');
      await waitFor(() =>
        expect(screen.getByTestId('con-form-end')).toBeEnabled(),
      );
      await user.type(screen.getByTestId('con-form-end'), '2026-06-30');
      await user.type(screen.getByTestId('con-form-salary'), '30000');
      await user.click(screen.getByTestId('con-form-submit'));

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(
        (create.mock.calls[0][0] as unknown as Record<string, unknown>).contractType,
      ).toBe('PROBATION');
    });
  });

  describe('what it refuses to send', () => {
    it('sends nothing when the required fields are empty', async () => {
      const { user } = renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('con-form-submit')).toBeInTheDocument(),
      );
      await user.click(screen.getByTestId('con-form-submit'));

      // The handler's own `toast.error(t('fillRequiredInfo'))` guard is not
      // what stops this: the employee search, start date and salary all carry
      // `required`, so the browser refuses the submit first and the guard is a
      // second line of defence that users do not normally reach. The rule that
      // matters either way is that nothing is sent.
      await waitFor(() => expect(create).not.toHaveBeenCalled());
      expect(screen.getByTestId('con-form-employee-search')).toBeRequired();
      expect(screen.getByTestId('con-form-start')).toBeRequired();
      expect(screen.getByTestId('con-form-salary')).toBeRequired();
    });
  });
});
