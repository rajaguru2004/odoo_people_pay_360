import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderWithProviders, screen, waitFor } from '@/test/utils';
import SalaryStructureForm from './SalaryStructureForm';

/**
 * The two rules the API refuses on, caught while the person who typed it can
 * still see which row they meant — and worded IDENTICALLY to the server, so
 * hitting the same rule from a different route reads as the same problem
 * rather than as a second one.
 *
 * The third claim is about the wire: every field in this form is a STRING,
 * including the amounts, and the conversion happens once, where the payload is
 * built. Bound to a number, a cleared amount becomes `NaN`, serialises to
 * `null`, and reaches the API as "no answer" instead of as the blank the user
 * is looking at.
 */
const NO_EARNING = 'A salary structure must have at least one earning line.';
const DUPLICATE_COMPONENT =
  'The same salary component appears twice in this structure. Each component may only be listed once — combine the two amounts into a single line.';

const { createStructure } = vi.hoisted(() => ({
  createStructure: vi.fn((_payload: unknown) =>
    Promise.resolve({ success: true, data: { id: 'str-1' } }),
  ),
}));

vi.mock('@/services/salaryStructureService', () => ({
  default: { create: createStructure, update: vi.fn() },
}));

vi.mock('@/services/salaryComponentService', () => ({
  default: {
    list: () =>
      Promise.resolve({
        success: true,
        data: [
          {
            id: 'cmp-basic',
            code: 'BASIC',
            name: 'Basic salary',
            type: 'EARNING',
            isGratuityBase: true,
            isTaxable: true,
            sequence: 1,
            isActive: true,
          },
          {
            id: 'cmp-hra',
            code: 'HRA',
            name: 'House rent allowance',
            type: 'EARNING',
            isGratuityBase: false,
            isTaxable: true,
            sequence: 2,
            isActive: true,
          },
          {
            id: 'cmp-ss-ee',
            code: 'SOCIAL_SEC_EE',
            name: 'Social security — employee',
            type: 'DEDUCTION',
            isGratuityBase: false,
            isTaxable: false,
            sequence: 10,
            isActive: true,
          },
          {
            id: 'cmp-ss-er',
            code: 'SOCIAL_SEC_ER',
            name: 'Social security — employer',
            type: 'EMPLOYER_CONTRIBUTION',
            isGratuityBase: false,
            isTaxable: false,
            sequence: 20,
            isActive: true,
          },
        ],
      }),
  },
}));

vi.mock('@/services/employeeService', () => ({
  default: {
    list: () =>
      Promise.resolve({
        success: true,
        data: [
          {
            id: 'emp-1',
            employeeCode: 'EMP-0001',
            firstName: 'Aisha',
            lastName: 'Al Balushi',
            status: 'ACTIVE',
            createdAt: '',
            updatedAt: '',
          },
        ],
      }),
  },
}));

/** Everything a valid submit needs except the lines, which each test owns. */
async function fillAssignment() {
  await screen.findByRole('option', { name: /Aisha Al Balushi/ });
  await userEvent.selectOptions(screen.getByLabelText('Employee'), 'emp-1');
  // Set directly: typing into a date input in jsdom depends on the segment
  // order the browser would have chosen from the locale.
  fireEvent.change(screen.getByLabelText('Effective from'), {
    target: { value: '2026-01-01' },
  });
}

/** Appends a line and fills it in. Rows are addressed by their aria-labels. */
async function addLine(componentId: string, amount: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /add line/i }));

  const components = screen.getAllByLabelText('Salary component');
  const amounts = screen.getAllByLabelText('Amount');
  const index = components.length - 1;

  await user.selectOptions(components[index], componentId);
  fireEvent.change(amounts[index], { target: { value: amount } });
}

const submit = async () => {
  await userEvent.setup().click(screen.getByRole('button', { name: /assign structure/i }));
};

beforeEach(() => {
  createStructure.mockClear();
});

describe('SalaryStructureForm', () => {
  it('refuses a structure with no lines at all, in the server’s words', async () => {
    renderWithProviders(<SalaryStructureForm />);
    await fillAssignment();

    await submit();

    expect(await screen.findByText(NO_EARNING)).toBeInTheDocument();
    expect(createStructure).not.toHaveBeenCalled();
  });

  it('refuses a structure that only takes money off somebody', async () => {
    // Lines, but no EARNING among them: the run would produce a payslip paying
    // the employee nothing, which is a data-entry mistake and not a wage.
    renderWithProviders(<SalaryStructureForm />);
    await fillAssignment();
    await addLine('cmp-ss-ee', '87.500');

    await submit();

    expect(await screen.findByText(NO_EARNING)).toBeInTheDocument();
    expect(createStructure).not.toHaveBeenCalled();
  });

  it('refuses an earning of zero as an earning', async () => {
    renderWithProviders(<SalaryStructureForm />);
    await fillAssignment();
    await addLine('cmp-basic', '0');

    await submit();

    expect(await screen.findByText(NO_EARNING)).toBeInTheDocument();
    expect(createStructure).not.toHaveBeenCalled();
  });

  it('refuses the same component listed twice', async () => {
    renderWithProviders(<SalaryStructureForm />);
    await fillAssignment();
    await addLine('cmp-basic', '1000');
    await addLine('cmp-basic', '250.500');

    await submit();

    // Flagged on the SECOND occurrence, so the reader can see which row to
    // merge rather than being sent back to the top of the form.
    expect(await screen.findByText(DUPLICATE_COMPONENT)).toBeInTheDocument();
    expect(createStructure).not.toHaveBeenCalled();
  });

  it('accepts the same amount on two different components', async () => {
    renderWithProviders(<SalaryStructureForm />);
    await fillAssignment();
    await addLine('cmp-basic', '1000');
    await addLine('cmp-hra', '1000');

    await submit();

    await waitFor(() => expect(createStructure).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(DUPLICATE_COMPONENT)).not.toBeInTheDocument();
  });

  it('sends the amounts as numbers, never as the strings the form holds', async () => {
    renderWithProviders(<SalaryStructureForm />);
    await fillAssignment();
    await addLine('cmp-basic', '1250.500');
    await addLine('cmp-ss-ee', '87.535');
    await addLine('cmp-ss-er', '131.250');

    await submit();

    await waitFor(() => expect(createStructure).toHaveBeenCalledTimes(1));

    const payload = createStructure.mock.calls[0][0] as {
      employeeId: string;
      currency: string;
      effectiveFrom: string;
      lines: { componentId: string; amount: unknown }[];
    };

    expect(payload).toMatchObject({
      employeeId: 'emp-1',
      currency: 'OMR',
      // Date-only, handed over exactly as picked — no instant parse in between.
      effectiveFrom: '2026-01-01',
    });

    expect(payload.lines).toEqual([
      { componentId: 'cmp-basic', amount: 1250.5 },
      { componentId: 'cmp-ss-ee', amount: 87.535 },
      { componentId: 'cmp-ss-er', amount: 131.25 },
    ]);
    for (const line of payload.lines) {
      expect(typeof line.amount).toBe('number');
    }
  });

  it('keeps employer contributions out of gross, deductions and net as it is typed', async () => {
    renderWithProviders(<SalaryStructureForm />);
    await fillAssignment();
    await addLine('cmp-basic', '1000');
    await addLine('cmp-ss-ee', '70');
    await addLine('cmp-ss-er', '105');

    // OMR is thousandths, and the running totals take their decimals from the
    // currency field rather than from a default of two.
    await waitFor(() => expect(screen.getByText('OMR 1,000.000')).toBeInTheDocument());
    expect(screen.getByText('OMR 70.000')).toBeInTheDocument();
    expect(screen.getByText('OMR 930.000')).toBeInTheDocument();
    expect(screen.getByText('OMR 105.000')).toBeInTheDocument();
    // gross + employer = 1,105.000 and net − employer = 825.000: neither is a
    // figure this form may print.
    expect(screen.queryByText('OMR 1,105.000')).not.toBeInTheDocument();
    expect(screen.queryByText('OMR 825.000')).not.toBeInTheDocument();
  });

  it('re-decimalises the totals when the currency changes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SalaryStructureForm />);
    await fillAssignment();
    await addLine('cmp-basic', '1000');

    // Gross and net are both 1,000.000 with a single earning line, so the
    // figure legitimately appears more than once.
    await waitFor(() => expect(screen.getAllByText('OMR 1,000.000').length).toBeGreaterThan(0));

    await user.selectOptions(screen.getByLabelText('Currency'), 'AED');
    await waitFor(() => expect(screen.getAllByText('AED 1,000.00').length).toBeGreaterThan(0));
  });

  it('hands the saved structure back to the caller instead of navigating', async () => {
    const onSaved = vi.fn();
    renderWithProviders(<SalaryStructureForm onSaved={onSaved} />);
    await fillAssignment();
    await addLine('cmp-basic', '1000');

    await submit();

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 'str-1' }));
  });
});
