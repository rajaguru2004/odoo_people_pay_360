import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, renderWithProviders, screen, waitFor } from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import overtimeService from '@/services/overtimeService';
import { toast } from 'sonner';
import LogOvertimePage from './page';

/**
 * Logging overtime, where the wire format is the whole risk.
 *
 * Overtime times are tz-naive wall clocks TAGGED UTC: an entered 17:30 has to
 * arrive as "…T17:30:00.000Z" whatever zone the browser is set to. Building the
 * instant with a local `new Date(y, m, d, h, m)` would post 13:30 from Muscat
 * and 22:30 from Los Angeles — and the server, which cross-checks the `hours`
 * field against the window it was given, refuses the request with a message
 * about a disagreement the employee cannot see. That is the assertion this file
 * exists for, and it is written as a literal string on purpose: a test that
 * derived the expected value the same way the page does would pass under the
 * bug.
 *
 * The other half is the midnight crossing. An end at or before the start is not
 * a typo, it is a night shift: 22:00–02:00 is four hours, and the naive
 * subtraction that makes it minus twenty is how a night worker is told their own
 * hours are nonsense. The page has to agree with the server's reading and say so
 * on screen.
 */
vi.mock('@/services/overtimeService', () => ({
  default: {
    create: vi.fn(),
    createForEmployee: vi.fn(),
  },
}));

vi.mock('@/services/employeeService', () => ({
  default: { list: vi.fn(() => Promise.resolve({ success: true, data: [] })) },
}));

// The toast is the only place a refused submit is reported.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const create = vi.mocked(overtimeService.create);
const createForEmployee = vi.mocked(overtimeService.createForEmployee);

beforeEach(() => {
  vi.clearAllMocks();

  useAuthStore.setState({
    user: {
      id: 'u1',
      email: 'hassan@peoplepay360.com',
      role: 'EMPLOYEE',
      isActive: true,
      employee: {
        id: 'emp-2',
        employeeCode: 'EMP-0012',
        firstName: 'Hassan',
        lastName: 'Al Hinai',
      },
    },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });

  create.mockResolvedValue({ success: true, data: { id: 'ot-1' } as never });
});

describe('Log overtime', () => {
  it('recomputes the window length as the clocks move', async () => {
    renderWithProviders(<LogOvertimePage />);

    // The defaults, 17:30 to 21:30.
    expect(await screen.findByText('4h')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Finished'), {
      target: { value: '23:00' },
    });
    expect(await screen.findByText('5.5h')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Started'), {
      target: { value: '18:00' },
    });
    expect(await screen.findByText('5h')).toBeInTheDocument();
  });

  it('reads an end before the start as a night shift, not as an error', async () => {
    renderWithProviders(<LogOvertimePage />);

    await screen.findByLabelText('Started');
    fireEvent.change(screen.getByLabelText('Started'), {
      target: { value: '22:00' },
    });
    fireEvent.change(screen.getByLabelText('Finished'), {
      target: { value: '02:00' },
    });

    // Four hours, not minus twenty, and not a validation message.
    expect(await screen.findByText('4h')).toBeInTheDocument();
    expect(
      screen.getByText(/This window crosses midnight and is read as finishing/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Log the overtime' }),
    ).toBeEnabled();
  });

  it('says nothing about midnight for a window that stays inside the day', async () => {
    renderWithProviders(<LogOvertimePage />);

    await screen.findByLabelText('Started');
    expect(
      screen.queryByText(/This window crosses midnight/),
    ).not.toBeInTheDocument();
  });

  it('posts the typed clocks as wall clocks tagged UTC', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LogOvertimePage />);

    // Date inputs are set directly: typing into one in jsdom depends on the
    // locale-dependent segment order the browser would have used.
    fireEvent.change(await screen.findByLabelText('Day worked'), {
      target: { value: '2026-10-05' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Line 3 changeover ran past the shift' },
    });

    await user.click(screen.getByRole('button', { name: 'Log the overtime' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    // Literal, not derived: 17:30 typed is 17:30 sent, in every zone. The hour
    // here is the bug a local Date constructor would introduce.
    expect(create).toHaveBeenCalledWith({
      date: '2026-10-05',
      startTime: '2026-10-05T17:30:00.000Z',
      endTime: '2026-10-05T21:30:00.000Z',
      hours: 4,
      reason: 'Line 3 changeover ran past the shift',
    });
    // Filing your own goes through the unnamed door; naming somebody else is an
    // HR privilege and a different endpoint.
    expect(createForEmployee).not.toHaveBeenCalled();
  });

  it('sends the crossing window on the day it started', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LogOvertimePage />);

    fireEvent.change(await screen.findByLabelText('Day worked'), {
      target: { value: '2026-10-05' },
    });
    fireEvent.change(screen.getByLabelText('Started'), {
      target: { value: '22:00' },
    });
    fireEvent.change(screen.getByLabelText('Finished'), {
      target: { value: '02:00' },
    });

    await user.click(screen.getByRole('button', { name: 'Log the overtime' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    // Both instants carry the day WORKED. The server owns the roll-over, and a
    // browser that helpfully advanced the end date would file a second day.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        date: '2026-10-05',
        startTime: '2026-10-05T22:00:00.000Z',
        endTime: '2026-10-05T02:00:00.000Z',
        hours: 4,
      }),
    );
  });

  it('repeats the server refusal verbatim rather than a generic apology', async () => {
    // The shape the axios interceptor rejects with: FLAT, no `.response`.
    create.mockRejectedValue({
      success: false,
      statusCode: 400,
      message: 'This would take Hassan past 40 overtime hours this month',
      errors: null,
      timestamp: '2026-10-05T18:00:00.000Z',
      path: '/overtime',
    });

    const user = userEvent.setup();
    renderWithProviders(<LogOvertimePage />);

    fireEvent.change(await screen.findByLabelText('Day worked'), {
      target: { value: '2026-10-05' },
    });
    await user.click(screen.getByRole('button', { name: 'Log the overtime' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'This would take Hassan past 40 overtime hours this month',
      ),
    );
    // A cap, a duplicate date and an overlap with the working day all reach the
    // user through this one line; the fallback tells them none of it.
    expect(toast.error).not.toHaveBeenCalledWith(
      'The overtime could not be logged.',
    );
  });
});
