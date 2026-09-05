import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '@/test/render';
import ManualAttendanceEntry from './ManualAttendanceEntry';
import attendanceService from '@/services/attendanceService';
import employeeService from '@/services/employeeService';

/**
 * HR booking attendance by hand — the widget that writes a payroll input
 * directly, with no request and no approval behind it.
 *
 * Everything asserted here is client-side validation that the browser suite
 * tests ONCE and this file tests exhaustively, plus the error-surfacing gap.
 * The split is deliberate: reaching the onboarding-date boundary through a
 * browser would mean seeding an employee per case, where here it is a prop.
 *
 * The two rules worth stating up front:
 *
 *   - the **onboarding-date guard is client-side too**, and it must agree with
 *     the server's (`ATA-API-22` asserts the same rule over HTTP). A date
 *     EQUAL to the start date is legal; one day earlier is not. That boundary
 *     is the case most likely to be got wrong in either place.
 *   - **finding F2**: `lib/axios.ts` rejects with a FLAT object, so this
 *     component's `error.response?.data?.message` is always `undefined` and the
 *     generic fallback always wins. Pinned below with a failing twin.
 *
 * jsdom's constraint validation is not a browser's (it blocks an empty required
 * `<select>` but not an empty required `<textarea>`), so nothing here leans on
 * native form validation — every case drives the component's own guards.
 */

vi.mock('@/services/attendanceService', () => ({
  default: { createManualAttendance: vi.fn() },
}));

vi.mock('@/services/employeeService', () => ({
  default: { getAll: vi.fn() },
}));

const mockAttendance = vi.mocked(attendanceService);
const mockEmployees = vi.mocked(employeeService);

const EMP = {
  id: 'emp-1',
  employeeCode: 'ATT001',
  fullName: 'Ada Lovelace',
  startDate: '2024-03-15T00:00:00.000Z',
  department: { id: 'd1', name: 'Ops' },
};

/** Exactly what the axios interceptor rejects with — no `.response` anywhere. */
const flatApiError = (statusCode: number, message: string) => ({
  success: false,
  statusCode,
  message,
  timestamp: new Date().toISOString(),
  path: '/attendances/manual',
  errors: null,
  details: { message },
});

/** Picks the seeded employee out of the autocomplete. */
const pickEmployee = async (user: any) => {
  await user.click(await screen.findByTestId('manual-employee-search'));
  await user.type(
    screen.getByTestId('manual-employee-search'),
    'Ada',
  );
  await user.click(await screen.findByTestId(`manual-employee-option-${EMP.id}`));
};

/**
 * `user.type` does not drive an `<input type="date">` in jsdom — the value
 * simply never changes, and a case that relies on it passes for the wrong
 * reason (the form submits with TODAY's date and the assertion still holds).
 * Found the hard way: the "exactly on the onboarding date" case below was green
 * before this helper existed and was proving nothing. `fireEvent.change` sets
 * the value directly, which is what a real date picker does.
 */
const setDate = (value: string) => {
  const input = screen.getByTestId('manual-date') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  expect(input.value).toBe(value);
};

describe('ManualAttendanceEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmployees.getAll.mockResolvedValue({ data: [EMP] } as any);
    mockAttendance.createManualAttendance.mockResolvedValue({
      message: 'Attendance recorded',
      data: { id: 'a-1' },
    } as any);
  });

  it('loads only ACTIVE employees into the picker', async () => {
    renderWithProviders(<ManualAttendanceEntry />, { role: 'HR_MANAGER' });
    await waitFor(() => expect(mockEmployees.getAll).toHaveBeenCalled());
    const params = mockEmployees.getAll.mock.calls[0][0] as any;
    expect(params?.status).toBe('ACTIVE');
  });

  /**
   * The employee guard is enforced by DISABLING submit
   * (`disabled={submitting || !selectedEmployee}`), not by the error branch
   * inside `handleSubmit`. That in-handler `selectEmployeeError` message is
   * therefore unreachable from the UI — dead, but harmless, and asserted here as
   * the disabled button so a future refactor that enables the button has to
   * come back and decide which guard it wants.
   */
  it('cannot be submitted at all until an employee is chosen', async () => {
    renderWithProviders(<ManualAttendanceEntry />, { role: 'HR_MANAGER' });
    await waitFor(() => expect(mockEmployees.getAll).toHaveBeenCalled());

    const submit = screen.getByTestId('manual-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(mockAttendance.createManualAttendance).not.toHaveBeenCalled();
  });

  it('becomes submittable once an employee is chosen', async () => {
    const { user } = renderWithProviders(<ManualAttendanceEntry />, {
      role: 'HR_MANAGER',
    });
    await waitFor(() => expect(mockEmployees.getAll).toHaveBeenCalled());

    await pickEmployee(user);
    expect((screen.getByTestId('manual-submit') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('submits a complete PRESENT entry with both times', async () => {
    const { user } = renderWithProviders(<ManualAttendanceEntry />, {
      role: 'HR_MANAGER',
    });
    await waitFor(() => expect(mockEmployees.getAll).toHaveBeenCalled());

    await pickEmployee(user);
    setDate('2026-08-14');
    await user.click(screen.getByTestId('manual-submit'));

    await waitFor(() =>
      expect(mockAttendance.createManualAttendance).toHaveBeenCalledTimes(1),
    );
    const payload = mockAttendance.createManualAttendance.mock.calls[0][0] as any;
    expect(payload.employeeId).toBe(EMP.id);
    expect(payload.date).toBe('2026-08-14');
    expect(payload.status).toBe('PRESENT');
    expect(payload.checkIn).toBeTruthy();
    expect(payload.checkOut).toBeTruthy();
  });

  /**
   * The boundary. `date < onboardDate` is the guard, so the start date ITSELF
   * must be accepted — an off-by-one here would silently refuse every new
   * hire's first day, which is exactly the day HR is most likely to book by
   * hand.
   */
  it('accepts an entry dated exactly on the onboarding date', async () => {
    const { user } = renderWithProviders(<ManualAttendanceEntry />, {
      role: 'HR_MANAGER',
    });
    await waitFor(() => expect(mockEmployees.getAll).toHaveBeenCalled());

    await pickEmployee(user);
    setDate('2024-03-15');
    await user.click(screen.getByTestId('manual-submit'));

    await waitFor(() =>
      expect(mockAttendance.createManualAttendance).toHaveBeenCalledTimes(1),
    );
  });

  /**
   * The day before the onboarding date is refused — but by the INPUT, not by
   * the handler. Once an employee is picked, the date field gains
   * `min={selectedEmployee.startDate.slice(0,10)}`, so constraint validation
   * blocks the submit event and `handleSubmit` never runs.
   *
   * That makes the in-handler onboarding check belt-and-braces: correct to
   * keep (it is the only thing standing if the attribute is ever dropped, and
   * it mirrors the server's rule asserted at `ATA-API-22`), but not the
   * mechanism a user meets. Asserting the attribute is therefore the honest
   * test; asserting the message would be testing a branch the UI cannot reach.
   */
  it('constrains the date field to the onboarding date, so an earlier day cannot be submitted', async () => {
    const { user } = renderWithProviders(<ManualAttendanceEntry />, {
      role: 'HR_MANAGER',
    });
    await waitFor(() => expect(mockEmployees.getAll).toHaveBeenCalled());

    await pickEmployee(user);

    const input = screen.getByTestId('manual-date') as HTMLInputElement;
    expect(input.getAttribute('min')).toBe('2024-03-15');

    setDate('2024-03-14');
    await user.click(screen.getByTestId('manual-submit'));

    // Nothing reaches the server, and nothing is claimed to have been saved.
    expect(mockAttendance.createManualAttendance).not.toHaveBeenCalled();
    expect(screen.queryByTestId('manual-success')).toBeNull();
  });

  /**
   * The other half of the same attribute: no future-dating attendance.
   *
   * Compared as CALENDAR STRINGS, not as instants. The first cut of this case
   * did `new Date(max).getTime() <= Date.now()`, which parses 'YYYY-MM-DD' as
   * UTC midnight — so at any positive UTC offset, between local midnight and
   * the offset, "today" as a UTC instant is still in the future and the case
   * failed for no product reason. That is the same mechanism as finding F19,
   * reproduced in the test that was meant to guard it.
   */
  it('caps the date field at today', async () => {
    const { user } = renderWithProviders(<ManualAttendanceEntry />, {
      role: 'HR_MANAGER',
    });
    await waitFor(() => expect(mockEmployees.getAll).toHaveBeenCalled());

    await pickEmployee(user);
    const input = screen.getByTestId('manual-date') as HTMLInputElement;
    const max = input.getAttribute('max')!;

    const now = new Date();
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(max).toBe(localToday);
  });

  it('refuses a check-out at or before the check-in', async () => {
    const { user } = renderWithProviders(<ManualAttendanceEntry />, {
      role: 'HR_MANAGER',
    });
    await waitFor(() => expect(mockEmployees.getAll).toHaveBeenCalled());

    await pickEmployee(user);
    setDate('2026-08-14');

    const checkIn = screen.getByTestId('manual-in') as HTMLInputElement;
    const checkOut = screen.getByTestId('manual-out') as HTMLInputElement;
    await user.clear(checkIn);
    await user.type(checkIn, '17:00');
    await user.clear(checkOut);
    await user.type(checkOut, '17:00');

    await user.click(screen.getByTestId('manual-submit'));

    expect(await screen.findByTestId('manual-error')).toBeTruthy();
    expect(mockAttendance.createManualAttendance).not.toHaveBeenCalled();
  });

  /**
   * The times belong to a PRESENT day. For any other status they are disabled
   * and must not be sent — an ABSENT row carrying a check-in would be counted
   * as worked by every downstream reader.
   */
  it('omits the times entirely for a non-PRESENT status', async () => {
    const { user } = renderWithProviders(<ManualAttendanceEntry />, {
      role: 'HR_MANAGER',
    });
    await waitFor(() => expect(mockEmployees.getAll).toHaveBeenCalled());

    await pickEmployee(user);
    setDate('2026-08-14');
    await user.selectOptions(screen.getByTestId('manual-status'), 'ABSENT');
    await user.click(screen.getByTestId('manual-submit'));

    await waitFor(() =>
      expect(mockAttendance.createManualAttendance).toHaveBeenCalledTimes(1),
    );
    const payload = mockAttendance.createManualAttendance.mock.calls[0][0] as any;
    expect(payload.status).toBe('ABSENT');
    expect(payload.checkIn).toBeUndefined();
    expect(payload.checkOut).toBeUndefined();
  });

  it('sends blank notes as undefined rather than an empty string', async () => {
    const { user } = renderWithProviders(<ManualAttendanceEntry />, {
      role: 'HR_MANAGER',
    });
    await waitFor(() => expect(mockEmployees.getAll).toHaveBeenCalled());

    await pickEmployee(user);
    setDate('2026-08-14');
    await user.type(screen.getByTestId('manual-notes'), '   ');
    await user.click(screen.getByTestId('manual-submit'));

    await waitFor(() =>
      expect(mockAttendance.createManualAttendance).toHaveBeenCalledTimes(1),
    );
    const payload = mockAttendance.createManualAttendance.mock.calls[0][0] as any;
    expect(payload.notes).toBeUndefined();
  });

  it('clears the selected employee after a success, so the next entry is deliberate', async () => {
    const { user } = renderWithProviders(<ManualAttendanceEntry />, {
      role: 'HR_MANAGER',
    });
    await waitFor(() => expect(mockEmployees.getAll).toHaveBeenCalled());

    await pickEmployee(user);
    setDate('2026-08-14');
    await user.click(screen.getByTestId('manual-submit'));

    expect(await screen.findByTestId('manual-success')).toBeTruthy();
    // Submitting again without re-picking must not silently re-book the same
    // person — the guard that stops a double entry.
    await user.click(screen.getByTestId('manual-submit'));
    await waitFor(() =>
      expect(mockAttendance.createManualAttendance).toHaveBeenCalledTimes(1),
    );
  });

  /**
   * F2, FIXED. The server's refusal is precise and useful; the component used
   * to show a generic sentence instead, because it read a `.response` path this
   * app's interceptor never produces.
   */
  it('the server’s refusal reaches the user', async () => {
    mockAttendance.createManualAttendance.mockRejectedValue(
      flatApiError(
        400,
        "Cannot record attendance before the employee's onboarding date (2024-03-15)",
      ),
    );

    const { user } = renderWithProviders(<ManualAttendanceEntry />, {
      role: 'HR_MANAGER',
    });
    await waitFor(() => expect(mockEmployees.getAll).toHaveBeenCalled());

    await pickEmployee(user);
    setDate('2026-08-14');
    await user.click(screen.getByTestId('manual-submit'));

    const err = await screen.findByTestId('manual-error');
    expect(err.textContent).toContain('onboarding date');
  });

  it('field-level validation errors are folded into the message', async () => {
    mockAttendance.createManualAttendance.mockRejectedValue({
      success: false,
      statusCode: 400,
      message: 'Validation failed',
      details: { message: 'Validation failed', errors: { status: 'status must be one of PRESENT, ABSENT, LEAVE, HOLIDAY' } },
    });

    const { user } = renderWithProviders(<ManualAttendanceEntry />, {
      role: 'HR_MANAGER',
    });
    await waitFor(() => expect(mockEmployees.getAll).toHaveBeenCalled());

    await pickEmployee(user);
    setDate('2026-08-14');
    await user.click(screen.getByTestId('manual-submit'));

    const err = await screen.findByTestId('manual-error');
    expect(err.textContent).toContain('PRESENT');
  });
});
