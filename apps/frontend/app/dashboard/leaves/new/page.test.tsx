import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { routerMock } from '@/test/router-mock';
import { useAuthStore } from '@/store/authStore';
import type { UserRole } from '@/types/auth';
import NewLeavePage from './page';

/**
 * Applying for leave — the one form in this app every employee eventually meets.
 *
 * The rules worth defending are the ones a refactor can loosen without anything
 * looking broken: a reason too short to review, a submission with no dates, a
 * gender-restricted type offered to somebody who can only be refused it, and an
 * HR user filing their own leave on a screen that exists for self-service.
 *
 * The submit path is also a two-step, non-transactional sequence — create, then
 * upload each attachment in turn — so a partial failure has to be visible.
 */

vi.mock('@/services/leaveService', () => ({
  default: {
    create: vi.fn(),
    balance: vi.fn(),
    leaveTypes: vi.fn(),
    uploadAttachment: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import leaveService from '@/services/leaveService';
import { toast } from 'sonner';

const create = vi.mocked(leaveService.create);
const balance = vi.mocked(leaveService.balance);
const leaveTypes = vi.mocked(leaveService.leaveTypes);
const uploadAttachment = vi.mocked(leaveService.uploadAttachment);
const toastError = vi.mocked(toast.error);
const toastSuccess = vi.mocked(toast.success);

const LEAVE_TYPES = [
  { id: 'lt1', label: 'Annual Leave', genderRestriction: null },
  { id: 'lt2', label: 'Sick Leave', genderRestriction: null },
  { id: 'lt3', label: 'Maternity Leave', genderRestriction: 'FEMALE' },
];

/**
 * The balance payload, which names the employee's gender.
 *
 * That field is what decides which restricted types the picker offers. Null
 * stands for a record that does not say, which the form treats permissively.
 */
function balanceFor(gender: string | null) {
  return {
    success: true,
    data: {
      id: 'lb-1',
      employeeId: 'e-1',
      year: 2026,
      annualLeave: 30,
      usedAnnual: 4,
      sickLeave: 15,
      usedSick: 0,
      carriedOver: 2,
      gender,
      leaveTypeBalances: [],
    },
  };
}

function signIn(role: UserRole = 'EMPLOYEE') {
  useAuthStore.setState({
    user: { id: 'u-1', email: 'aisha@example.com', role, isActive: true, employeeId: 'e-1' },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });
}

/** Renders as an employee — the only role this screen serves. */
async function renderForm(gender: string | null = null) {
  signIn('EMPLOYEE');
  balance.mockResolvedValue(balanceFor(gender) as never);
  const result = renderWithProviders(<NewLeavePage />);
  // The type list loads in a query and seeds the picker's default.
  await waitFor(() => expect(leaveTypes).toHaveBeenCalled());
  await waitFor(() => expect(reasonBox()).toBeInTheDocument());
  return { ...result, user: userEvent.setup() };
}

/**
 * Dates derived from the clock, never written down.
 *
 * Both pickers carry `min={today}`, so a hardcoded date is only valid until the
 * clock passes it: `userEvent` will not type a value the control reports as out
 * of range, and the form would be left with an empty start date while the
 * assertions downstream waited for an error that never came. UTC to match the
 * form, which builds its floor from `toISOString()`.
 */
const isoDaysFromToday = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split('T')[0];
};

/** Tomorrow — comfortably inside `min`, whatever the clock says. */
const START = isoDaysFromToday(1);
/** Two days after START, so the inclusive preview reads "3 days". */
const END = isoDaysFromToday(3);
/** Far enough out to be unambiguous when asserting the end picker's floor. */
const LATER = isoDaysFromToday(10);

const reasonBox = () => document.querySelector('textarea')!;
const dateInputs = () =>
  Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
const submitButton = () => screen.getByTestId('leave-submit') as HTMLButtonElement;

beforeEach(() => {
  create.mockReset();
  balance.mockReset();
  leaveTypes.mockReset();
  uploadAttachment.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  leaveTypes.mockResolvedValue({ success: true, data: LEAVE_TYPES } as never);
  balance.mockResolvedValue(balanceFor(null) as never);
});

describe('who the screen is for', () => {
  it.each(['ADMIN', 'HR_MANAGER'] as const)(
    'refuses %s, who decide rather than apply',
    async (role) => {
      // Admin and HR act on other people's requests; a request they filed here
      // would be one they are also an approver for.
      signIn(role);
      renderWithProviders(<NewLeavePage />);

      expect(document.querySelector('textarea')).not.toBeInTheDocument();
    },
  );

  it('shows the form to an employee', async () => {
    await renderForm();
    expect(reasonBox()).toBeInTheDocument();
  });

  it('shows the form to a manager, who may also take leave', async () => {
    signIn('MANAGER');
    renderWithProviders(<NewLeavePage />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
  });
});

describe('leave types', () => {
  it('lists the types the library returns', async () => {
    await renderForm();
    expect(await screen.findByRole('option', { name: 'Annual Leave' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Sick Leave' })).toBeInTheDocument();
  });

  it('hides a restricted type from an employee it does not apply to', async () => {
    // Offering maternity leave to somebody the server will refuse it to
    // produces a request that can only ever be rejected.
    await renderForm('MALE');
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Annual Leave' })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: 'Maternity Leave' })).not.toBeInTheDocument(),
    );
  });

  it('shows a restricted type to the employee it applies to', async () => {
    await renderForm('FEMALE');
    expect(await screen.findByRole('option', { name: 'Maternity Leave' })).toBeInTheDocument();
  });

  it('matches the recorded gender whatever case it is written in', async () => {
    await renderForm('Female');
    expect(await screen.findByRole('option', { name: 'Maternity Leave' })).toBeInTheDocument();
  });

  it('shows every type when the record does not say', async () => {
    // Deliberately permissive: hiding an entitlement because a field is blank
    // is a silent denial, and the server still refuses what it should.
    await renderForm(null);
    expect(await screen.findByRole('option', { name: 'Maternity Leave' })).toBeInTheDocument();
  });

  it('survives a failed type load without taking the form down', async () => {
    leaveTypes.mockRejectedValue(new Error('network'));
    signIn('EMPLOYEE');
    renderWithProviders(<NewLeavePage />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
  });
});

describe('validation', () => {
  it('rejects a submission with no dates and no reason', async () => {
    const { user } = await renderForm();

    await user.click(submitButton());

    expect(await screen.findByText(/Start date is required/i)).toBeInTheDocument();
    expect(screen.getByText(/End date is required/i)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a reason shorter than ten characters', async () => {
    // The rule that makes a request reviewable. "sick" tells an approver
    // nothing, and loosening it is the kind of change that passes review
    // unnoticed.
    const { user } = await renderForm();
    const [start, end] = dateInputs();

    await user.type(start, START);
    await user.type(end, END);
    await user.type(reasonBox(), 'sick');
    await user.click(submitButton());

    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts a reason of exactly ten characters', async () => {
    // Boundary: the rule is `min(10)`, so ten passes.
    create.mockResolvedValue({ success: true, data: { id: 'lr-1' } } as never);
    const { user } = await renderForm();
    const [start, end] = dateInputs();

    await user.type(start, START);
    await user.type(end, END);
    await user.type(reasonBox(), '1234567890');
    await user.click(submitButton());

    await waitFor(() => expect(create).toHaveBeenCalled());
  });

  it('will not let the end date precede the start date in the picker', async () => {
    const { user } = await renderForm();
    const [start, end] = dateInputs();

    await user.type(start, LATER);

    await waitFor(() => expect(end).toHaveAttribute('min', LATER));
  });
});

describe('the estimated-days preview', () => {
  /**
   * Scoped to the preview line on purpose: a bare text match for a digit also
   * hits the date inputs, which would make the assertion pass for the wrong
   * reason.
   */
  const previewText = () => screen.getByText('Estimated Days:').closest('p')!.textContent ?? '';

  it('counts both endpoints, so a single day reads as one', async () => {
    // Inclusive by design: taking Monday off is one day, not zero.
    const { user } = await renderForm();
    const [start, end] = dateInputs();

    await user.type(start, START);
    await user.type(end, START);

    await waitFor(() => expect(previewText()).toContain('1 days'));
  });

  it('counts a three-day range as three', async () => {
    const { user } = await renderForm();
    const [start, end] = dateInputs();

    await user.type(start, START);
    await user.type(end, END);

    await waitFor(() => expect(previewText()).toContain('3 days'));
  });

  it('stays hidden until both dates are set', async () => {
    const { user } = await renderForm();
    const [start] = dateInputs();

    await user.type(start, START);

    expect(screen.queryByText('Estimated Days:')).not.toBeInTheDocument();
  });
});

describe('submitting', () => {
  async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
    const [start, end] = dateInputs();
    await user.type(start, START);
    await user.type(end, END);
    await user.type(reasonBox(), 'Family commitment abroad');
  }

  it('sends the entered values', async () => {
    create.mockResolvedValue({ success: true, data: { id: 'lr-1' } } as never);
    const { user } = await renderForm();

    await fillValidForm(user);
    await user.click(submitButton());

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: START,
          endDate: END,
          reason: 'Family commitment abroad',
          leaveType: 'Annual Leave',
        }),
      ),
    );
  });

  it('sends the employee back to their own list on success', async () => {
    create.mockResolvedValue({ success: true, data: { id: 'lr-1' } } as never);
    const { user } = await renderForm();

    await fillValidForm(user);
    await user.click(submitButton());

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith('/dashboard/my-leaves'));
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('uploads nothing when no file was attached', async () => {
    create.mockResolvedValue({ success: true, data: { id: 'lr-1' } } as never);
    const { user } = await renderForm();

    await fillValidForm(user);
    await user.click(submitButton());

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it('reports a failed create and stays on the form', async () => {
    // The interceptor rejects with a FLAT object, so the precise backend message
    // is on `.message` — a fallback string here would hide it.
    create.mockRejectedValue({ message: 'Insufficient leave balance' });
    const { user } = await renderForm();

    await fillValidForm(user);
    await user.click(submitButton());

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Insufficient leave balance'));
    expect(routerMock.push).not.toHaveBeenCalledWith('/dashboard/my-leaves');
  });

  it('re-enables the form after a failure, so the request can be retried', async () => {
    create.mockRejectedValue({ message: 'Server error' });
    const { user } = await renderForm();

    await fillValidForm(user);
    await user.click(submitButton());

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    await waitFor(() => expect(submitButton()).not.toBeDisabled());
  });
});

describe('the balance panel', () => {
  it('loads the balance for the signed-in employee', async () => {
    await renderForm();
    await waitFor(() => expect(balance).toHaveBeenCalledWith('e-1', undefined));
  });

  it('renders even when the balance request fails', async () => {
    // A missing balance must not block the request; the approver has the
    // authoritative figure anyway.
    signIn('EMPLOYEE');
    balance.mockRejectedValue(new Error('boom'));
    renderWithProviders(<NewLeavePage />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
  });
});
