import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderWithProviders, screen, waitFor } from '@/test/utils';
import ContractForm from './ContractForm';

/**
 * The term rules are the point of these tests.
 *
 * A contract that ends before it starts, or a probation that finishes outside
 * the term, is a typo with a settlement attached — the notice period and the
 * final payslip are both calculated from these dates. Catching it server-side
 * only means the person who can still see which field they meant has already
 * navigated away.
 */
const { createContract } = vi.hoisted(() => ({
  createContract: vi.fn((_payload: unknown) =>
    Promise.resolve({ success: true, data: { id: 'ctr-1' } }),
  ),
}));

vi.mock('@/services/contractService', () => ({
  default: { create: createContract },
}));

vi.mock('@/services/employeeService', () => ({
  default: {
    list: () =>
      Promise.resolve({
        success: true,
        data: [
          {
            id: 'e-1',
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

/** Fills the fields every valid submit needs, leaving the term to the caller. */
async function fillBaseline() {
  await screen.findByRole('option', { name: /Aisha Al Balushi/ });
  await userEvent.selectOptions(screen.getByLabelText('Employee'), 'e-1');
  // Date inputs are set directly: typing into one in jsdom depends on the
  // locale-dependent segment order the browser would have used.
  fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-01-01' } });
  fireEvent.change(screen.getByLabelText('Salary'), { target: { value: '1200' } });
}

beforeEach(() => {
  createContract.mockClear();
});

describe('ContractForm', () => {
  it('names the fields the API insists on', async () => {
    renderWithProviders(<ContractForm />);

    expect(screen.getByLabelText('Employee')).toBeInTheDocument();
    expect(screen.getByLabelText('Contract type')).toBeInTheDocument();
    expect(screen.getByLabelText('Start date')).toBeInTheDocument();
  });

  it('refuses an end date that falls before the start date', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ContractForm />);

    await fillBaseline();
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2025-12-01' } });

    await user.click(screen.getByRole('button', { name: /create contract/i }));

    expect(await screen.findByText(/end date has to fall after the start date/i)).toBeInTheDocument();
    expect(createContract).not.toHaveBeenCalled();
  });

  it('refuses an end date equal to the start date', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ContractForm />);

    await fillBaseline();
    // A one-day term with the same start and end is a typo, not a contract.
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-01-01' } });

    await user.click(screen.getByRole('button', { name: /create contract/i }));

    expect(await screen.findByText(/end date has to fall after the start date/i)).toBeInTheDocument();
    expect(createContract).not.toHaveBeenCalled();
  });

  it('refuses a probation that ends outside the term', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ContractForm />);

    await fillBaseline();
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-06-30' } });
    fireEvent.change(screen.getByLabelText('Probation end date'), {
      target: { value: '2026-09-30' },
    });

    await user.click(screen.getByRole('button', { name: /create contract/i }));

    expect(
      await screen.findByText(/probation cannot end after the contract does/i),
    ).toBeInTheDocument();
    expect(createContract).not.toHaveBeenCalled();
  });

  it('refuses a probation that ends before the contract starts', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ContractForm />);

    await fillBaseline();
    fireEvent.change(screen.getByLabelText('Probation end date'), {
      target: { value: '2025-11-30' },
    });

    await user.click(screen.getByRole('button', { name: /create contract/i }));

    expect(
      await screen.findByText(/probation has to end after the contract starts/i),
    ).toBeInTheDocument();
    expect(createContract).not.toHaveBeenCalled();
  });

  it('sends a term that hangs together, with the salary as a number', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ContractForm />);

    await fillBaseline();
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-12-31' } });
    fireEvent.change(screen.getByLabelText('Probation end date'), {
      target: { value: '2026-04-01' },
    });

    await user.click(screen.getByRole('button', { name: /create contract/i }));

    await waitFor(() => expect(createContract).toHaveBeenCalledTimes(1));

    expect(createContract.mock.calls[0][0]).toMatchObject({
      employeeId: 'e-1',
      contractType: 'PERMANENT',
      startDate: '2026-01-01',
      endDate: '2027-12-31',
      probationEndDate: '2026-04-01',
      salary: 1200,
      currency: 'OMR',
    });
  });

  it('leaves the end date out entirely for a contract that does not expire', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ContractForm />);

    await fillBaseline();
    await user.click(screen.getByRole('button', { name: /create contract/i }));

    await waitFor(() => expect(createContract).toHaveBeenCalledTimes(1));
    // Sent as an empty string it would fail the API's date validation; omitted,
    // it means the permanent contract it is.
    expect(createContract.mock.calls[0][0]).not.toHaveProperty('endDate');
  });
});
