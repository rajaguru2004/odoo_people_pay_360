import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { routerMock } from '@/test/router-mock';
import NewLeavePage from './page';

/**
 * Applying for leave.
 *
 * One of only seven forms in this app with declarative validation, and the one
 * an employee is most likely to meet. The rules worth defending are the ones a
 * refactor can loosen without anything looking wrong: a reason short enough to
 * be useless, a submission with no dates, or an HR user filing leave for
 * themselves on a screen that is meant to be self-service only.
 *
 * The submit path is also a two-step, non-transactional sequence — create, then
 * upload each attachment in turn — so a partial failure has to be visible.
 */

vi.mock('@/services/leaveService', () => ({
  default: {
    create: vi.fn(),
    getBalance: vi.fn(),
    uploadAttachment: vi.fn(),
  },
}));

vi.mock('@/services/libraryService', () => ({
  default: { getAll: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import leaveService from '@/services/leaveService';
import libraryService from '@/services/libraryService';
import { toast } from '@/lib/toast';

const create = vi.mocked(leaveService.create);
const getBalance = vi.mocked(leaveService.getBalance);
const uploadAttachment = vi.mocked(leaveService.uploadAttachment);
const getAll = vi.mocked(libraryService.getAll);
const toastError = vi.mocked(toast.error);
const toastSuccess = vi.mocked(toast.success);

const LEAVE_TYPES = [
  { id: 'lt1', label: 'Annual Leave', genderRestriction: null },
  { id: 'lt2', label: 'Sick Leave', genderRestriction: null },
  { id: 'lt3', label: 'Maternity Leave', genderRestriction: 'FEMALE' },
];

function mockLeaveTypes(types: unknown[] = LEAVE_TYPES) {
  getAll.mockResolvedValue({ success: true, data: types } as never);
}

/** Renders as an employee — the only role this screen serves. */
async function renderForm(overrides: Record<string, unknown> = {}) {
  const result = renderWithProviders(<NewLeavePage />, {
    role: 'EMPLOYEE',
    user: { employeeId: 'e-1', ...overrides },
  });
  // The leave-type list loads in an effect and seeds the select's default.
  await waitFor(() => expect(getAll).toHaveBeenCalled());
  return result;
}

/**
 * Dates derived from the clock, never written down.
 *
 * The form sets `min={new Date().toISOString().split('T')[0]}` on both date
 * inputs, so a hardcoded date is only valid until the clock passes it. These
 * cases were written with `2026-09-01`, and seven of them — plus the browser
 * case LVE-UI-04 — began failing on the day that became yesterday: `userEvent`
 * will not type a value the control reports as out of range, so the form was
 * left with an empty start date and the assertions downstream never saw the
 * error they were waiting for. A test that expires is worse than no test,
 * because it fails long after the change that would explain it.
 *
 * UTC to match the form: it builds its `min` from `toISOString()`, so a local
 * date would disagree with it either side of midnight.
 */
const isoDaysFromToday = (days: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
};

/** Tomorrow — comfortably inside `min`, whatever the clock says. */
const START = isoDaysFromToday(1);
/** Two days after START, so the inclusive preview reads "3 days". */
const END = isoDaysFromToday(3);
/** Far enough out to be unambiguous when asserting the end picker's `min`. */
const LATER = isoDaysFromToday(10);

const reasonBox = () => document.querySelector('textarea')!;
const dateInputs = () => Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
const submitButton = () =>
  Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('type') === 'submit')!;

beforeEach(() => {
  create.mockReset();
  getBalance.mockReset();
  uploadAttachment.mockReset();
  getAll.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  getBalance.mockResolvedValue({ data: { totalAnnual: 20, usedAnnual: 4 } } as never);
  mockLeaveTypes();
});

describe('who the screen is for', () => {
  it.each(['ADMIN', 'HR_MANAGER'])('refuses %s, who approve rather than apply', async (role) => {
    // Admin and HR act on other people's requests; letting them file their own
    // here would create a request they are also the approver for.
    renderWithProviders(<NewLeavePage />, { role: role as 'ADMIN', user: { employeeId: 'e-1' } });

    expect(document.querySelector('textarea')).not.toBeInTheDocument();
  });

  it('shows the form to an employee', async () => {
    await renderForm();
    expect(reasonBox()).toBeInTheDocument();
  });

  it('shows the form to a manager, who may also take leave', async () => {
    renderWithProviders(<NewLeavePage />, { role: 'MANAGER', user: { employeeId: 'e-9' } });
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
  });
});

describe('leave types', () => {
  it('lists the types the library returns', async () => {
    await renderForm();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Annual Leave' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Sick Leave' })).toBeInTheDocument();
  });

  it('requests only ACTIVE leave types', async () => {
    await renderForm();
    expect(getAll).toHaveBeenCalledWith('LEAVE_TYPE', true);
  });

  it('hides a gender-restricted type from an employee of another gender', async () => {
    // Offering Maternity Leave to a male employee produces a request that can
    // only be rejected.
    await renderForm({ employee: { gender: 'MALE' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Annual Leave' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: 'Maternity Leave' })).not.toBeInTheDocument();
  });

  it('shows a gender-restricted type to a matching employee', async () => {
    await renderForm({ employee: { gender: 'FEMALE' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Maternity Leave' })).toBeInTheDocument());
  });

  it('shows every type when the employee has no gender recorded', async () => {
    // Deliberately permissive: an unset gender must not silently remove
    // entitlements. The approver still sees the request.
    await renderForm({ employee: {} });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Maternity Leave' })).toBeInTheDocument());
  });

  it('survives a failed leave-type load without crashing the page', async () => {
    getAll.mockRejectedValue(new Error('network'));
    renderWithProviders(<NewLeavePage />, { role: 'EMPLOYEE', user: { employeeId: 'e-1' } });
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
  });
});

describe('validation', () => {
  it('rejects a submission with no dates and no reason', async () => {
    const { user } = await renderForm();

    await user.click(submitButton());

    await waitFor(() => expect(screen.getByText(/Start date is required/i)).toBeInTheDocument());
    expect(screen.getByText(/End date is required/i)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a reason shorter than ten characters', async () => {
    // The rule that makes a request reviewable. "sick" tells an approver
    // nothing, and loosening this is exactly the kind of change that passes
    // review unnoticed.
    const { user } = await renderForm();
    const [start, end] = dateInputs();

    await user.type(start, START);
    await user.type(end, END);
    await user.type(reasonBox(), 'sick');
    await user.click(submitButton());

    await waitFor(() =>
      expect(screen.getByText(/at least 10 characters/i)).toBeInTheDocument(),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts a reason of exactly ten characters', async () => {
    // Boundary: the rule is `min(10)`, so ten passes.
    create.mockResolvedValue({ data: { id: 'lr-1' } } as never);
    const { user } = await renderForm();
    const [start, end] = dateInputs();

    await user.type(start, START);
    await user.type(end, END);
    await user.type(reasonBox(), '1234567890');
    await user.click(submitButton());

    await waitFor(() => expect(create).toHaveBeenCalled());
  });

  it('does not let the end date precede the start date in the picker', async () => {
    const { user } = await renderForm();
    const [start, end] = dateInputs();

    await user.type(start, LATER);

    await waitFor(() => expect(end).toHaveAttribute('min', LATER));
  });
});

describe('the estimated-days preview', () => {
  /**
   * Scoped to the preview panel on purpose. A bare text match for a digit also
   * hits the date inputs, which would make the assertion pass
   * for the wrong reason.
   */
  const previewText = () =>
    screen.getByText('Estimated Days:').closest('p')!.textContent ?? '';

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
  async function fillValidForm(user: ReturnType<typeof renderWithProviders>['user']) {
    const [start, end] = dateInputs();
    await user.type(start, START);
    await user.type(end, END);
    await user.type(reasonBox(), 'Family commitment abroad');
  }

  it('sends the entered values', async () => {
    create.mockResolvedValue({ data: { id: 'lr-1' } } as never);
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

  it('redirects to the employee’s own list on success', async () => {
    create.mockResolvedValue({ data: { id: 'lr-1' } } as never);
    const { user } = await renderForm();

    await fillValidForm(user);
    await user.click(submitButton());

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith('/dashboard/my-leaves'));
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('does not upload anything when no file was attached', async () => {
    create.mockResolvedValue({ data: { id: 'lr-1' } } as never);
    const { user } = await renderForm();

    await fillValidForm(user);
    await user.click(submitButton());

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it('reports a failed create and stays on the form', async () => {
    create.mockRejectedValue({ message: 'Insufficient leave balance' });
    const { user } = await renderForm();

    await fillValidForm(user);
    await user.click(submitButton());

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Insufficient leave balance'));
    expect(routerMock.push).not.toHaveBeenCalledWith('/dashboard/my-leaves');
  });

  it('re-enables the form after a failure, so the user can retry', async () => {
    create.mockRejectedValue({ message: 'Server error' });
    const { user } = await renderForm();

    await fillValidForm(user);
    await user.click(submitButton());

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(submitButton()).not.toBeDisabled();
  });
});

describe('the leave balance panel', () => {
  it('loads the balance for the signed-in employee', async () => {
    await renderForm();
    await waitFor(() => expect(getBalance).toHaveBeenCalledWith('e-1'));
  });

  it('renders even when the balance request fails', async () => {
    // A missing balance must not block the request; the approver has the
    // authoritative figure anyway.
    getBalance.mockRejectedValue(new Error('boom'));
    await renderForm();
    expect(reasonBox()).toBeInTheDocument();
  });
});
