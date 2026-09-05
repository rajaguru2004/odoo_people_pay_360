import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, renderWithProviders, screen, waitFor } from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import leaveService from '@/services/leaveService';
import { toast } from 'sonner';
import NewLeaveRequestPage from './page';

/**
 * Filing leave: who may file for whom, what the reader is told before they
 * commit, and what actually goes up the wire.
 *
 * Three things here are worth a test rather than a type.
 *
 * The Employee picker is the difference between filing your own leave and
 * spending somebody else's balance. It is an HR affordance and the server agrees
 * with a RolesGuard — but a picker rendered to an employee is a form that fails
 * on submit with a 403 after the person has typed a reason, which is the worst
 * of both.
 *
 * The rules line and the balance card are the only facts on this screen that
 * decide whether the request is worth filing at all. "Needs 7 days notice" read
 * after a rejection is not the same information.
 *
 * And the failure path: the axios interceptor rejects with a FLAT object with no
 * `.response` on it. A catch reaching for `err.response.data.message` falls
 * through to the generic fallback, and the precise reason the server gave — the
 * notice period, the exhausted entitlement — is thrown away.
 */
vi.mock('@/services/leaveService', () => ({
  default: {
    leaveTypes: vi.fn(),
    balance: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('@/services/employeeService', () => ({
  default: { list: vi.fn(() => Promise.resolve({ success: true, data: [] })) },
}));

// Mocked so the surfaced message can be read. The toast is the only place a
// refused submit is reported, so asserting on it is asserting on the screen.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const leaveTypes = vi.mocked(leaveService.leaveTypes);
const balance = vi.mocked(leaveService.balance);
const createRequest = vi.mocked(leaveService.create);

const LEAVE_TYPES = [
  {
    id: 'lt-1',
    libraryType: 'LEAVE_TYPE' as const,
    label: 'Annual Leave',
    isActive: true,
    sortOrder: 1,
    defaultDays: 30,
    isPaid: true,
    requiresNoticeDays: 7,
    affectsBalance: true,
    genderRestriction: null,
  },
  {
    id: 'lt-2',
    libraryType: 'LEAVE_TYPE' as const,
    label: 'Unpaid Leave',
    isActive: true,
    sortOrder: 2,
    defaultDays: null,
    isPaid: false,
    requiresNoticeDays: 0,
    affectsBalance: false,
    genderRestriction: null,
  },
];

/** Signs a role in with an employee record behind it, as a real session has. */
function signIn(role: 'ADMIN' | 'EMPLOYEE') {
  useAuthStore.setState({
    user: {
      id: 'u1',
      email: role === 'ADMIN' ? 'hr@peoplepay360.com' : 'aisha@peoplepay360.com',
      role,
      isActive: true,
      employee: {
        id: 'emp-1',
        employeeCode: 'EMP-0001',
        firstName: 'Aisha',
        lastName: 'Al Balushi',
      },
    },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });
}

/**
 * Everything the resolver insists on, leaving the type to the caller.
 *
 * Date inputs are set directly: typing into one in jsdom depends on the
 * locale-dependent segment order the browser would have used.
 */
function fillBaseline() {
  fireEvent.change(screen.getByLabelText('First day off'), {
    target: { value: '2026-10-12' },
  });
  fireEvent.change(screen.getByLabelText('Last day off'), {
    target: { value: '2026-10-15' },
  });
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'Family visit to Salalah' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  signIn('EMPLOYEE');

  leaveTypes.mockResolvedValue({ success: true, data: LEAVE_TYPES });
  balance.mockResolvedValue({
    success: true,
    data: {
      id: 'bal-1',
      employeeId: 'emp-1',
      year: 2026,
      annualLeave: 30,
      sickLeave: 15,
      usedAnnual: 4,
      usedSick: 0,
      carriedOver: 2,
      remainingAnnual: 28,
      remainingSick: 15,
      leaveTypeBalances: [
        {
          id: 'ltb-1',
          employeeId: 'emp-1',
          year: 2026,
          leaveTypeKey: 'Annual Leave',
          allocated: 30,
          used: 4,
          carriedOver: 2,
          remaining: 28,
        },
      ],
      totals: { allocated: 30, used: 4, carriedOver: 2, remaining: 28 },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  });
  createRequest.mockResolvedValue({
    success: true,
    data: { id: 'lr-1' } as never,
  });
});

describe('File leave', () => {
  it('asks for the four things a request cannot be filed without', async () => {
    renderWithProviders(<NewLeaveRequestPage />);

    expect(await screen.findByLabelText('Leave type')).toBeInTheDocument();
    expect(screen.getByLabelText('First day off')).toBeInTheDocument();
    expect(screen.getByLabelText('Last day off')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'File the request' }),
    ).toBeInTheDocument();
  });

  it('does not offer an employee the picker that spends another balance', async () => {
    renderWithProviders(<NewLeaveRequestPage />);

    await screen.findByLabelText('Leave type');
    expect(screen.queryByLabelText('Employee')).not.toBeInTheDocument();
  });

  it('gives HR the picker, because filing for somebody else is their job', async () => {
    signIn('ADMIN');
    renderWithProviders(<NewLeaveRequestPage />);

    expect(await screen.findByLabelText('Employee')).toBeInTheDocument();
  });

  it('states the chosen type rules before the request is committed to', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewLeaveRequestPage />);

    await screen.findByRole('option', { name: 'Annual Leave' });
    await user.selectOptions(screen.getByLabelText('Leave type'), 'Annual Leave');

    // Both halves matter: what it costs, and how far ahead it has to be filed.
    expect(
      screen.getByText(
        /Counts against your Annual Leave balance\.\s*Needs 7 days notice\./,
      ),
    ).toBeInTheDocument();

    // "Approved but free" is a different fact from "you have none left", and the
    // form has to say which one this type is.
    await user.selectOptions(screen.getByLabelText('Leave type'), 'Unpaid Leave');
    expect(
      screen.getByText('Recorded and approved, but costs no entitlement.'),
    ).toBeInTheDocument();
  });

  it('shows the balance for the chosen type, the fact that decides the request', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewLeaveRequestPage />);

    await screen.findByRole('option', { name: 'Annual Leave' });
    await user.selectOptions(screen.getByLabelText('Leave type'), 'Annual Leave');

    expect(
      await screen.findByRole('heading', { name: 'Balance' }),
    ).toBeInTheDocument();
    expect(screen.getByText('30 days')).toBeInTheDocument();
    expect(screen.getByText('28 days')).toBeInTheDocument();
    // The employee never names themselves: their own id comes off the session.
    expect(balance).toHaveBeenCalledWith('emp-1', undefined);
  });

  it('posts the label, the two dates and the reason, and no employee', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewLeaveRequestPage />);

    await screen.findByRole('option', { name: 'Annual Leave' });
    await user.selectOptions(screen.getByLabelText('Leave type'), 'Annual Leave');
    fillBaseline();

    await user.click(screen.getByRole('button', { name: 'File the request' }));

    await waitFor(() => expect(createRequest).toHaveBeenCalledTimes(1));

    // `leaveType` is the LABEL, not the library id: the request row and the
    // balance row both key off this exact string.
    //
    // `employeeId` is undefined rather than '' — an empty string is a uuid the
    // server cannot resolve, and "file my own" is expressed by the field being
    // absent.
    expect(createRequest).toHaveBeenCalledWith({
      employeeId: undefined,
      leaveType: 'Annual Leave',
      startDate: '2026-10-12',
      endDate: '2026-10-15',
      reason: 'Family visit to Salalah',
    });
  });

  it('repeats the server refusal verbatim rather than a generic apology', async () => {
    // The shape the axios interceptor rejects with: FLAT, no `.response`.
    createRequest.mockRejectedValue({
      success: false,
      statusCode: 400,
      message: 'Annual Leave needs 7 days notice; the first day off is in 3',
      errors: null,
      timestamp: '2026-10-09T08:00:00.000Z',
      path: '/leave-requests',
    });

    const user = userEvent.setup();
    renderWithProviders(<NewLeaveRequestPage />);

    await screen.findByRole('option', { name: 'Annual Leave' });
    await user.selectOptions(screen.getByLabelText('Leave type'), 'Annual Leave');
    fillBaseline();
    await user.click(screen.getByRole('button', { name: 'File the request' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Annual Leave needs 7 days notice; the first day off is in 3',
      ),
    );
    // The fallback would be a silent regression: the form would still "work".
    expect(toast.error).not.toHaveBeenCalledWith(
      'The leave request could not be filed.',
    );
  });
});
