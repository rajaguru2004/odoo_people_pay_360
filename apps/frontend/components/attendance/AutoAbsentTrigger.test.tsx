import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import AutoAbsentTrigger from './AutoAbsentTrigger';
import attendanceService from '@/services/attendanceService';

/**
 * The Auto-Absent trigger — the one control on the Attendance Manager screen
 * that mutates every employee at once.
 *
 * Three things are worth testing here and only one of them is the happy path:
 *
 * 1. **The confirmation gate actually gates.** Opening the dialog must not
 *    issue the request; only the confirm button may.
 * 2. **The result count comes from the response**, not from anything the
 *    component assumed.
 * 3. **Finding F2 — the flat error shape.** `lib/axios.ts` rejects with a FLAT
 *    object: `{ success, statusCode, message, errors, details }`. There is no
 *    `.response` on it. This component reads
 *    `error.response?.data?.message || t('failedToMark')`, so the first operand
 *    is ALWAYS `undefined` and the generic fallback always wins — the server's
 *    actual sentence never reaches the user. That is pinned below with a
 *    failing twin naming the intent.
 *
 * The error is also delivered through a native `alert()` rather than the app's
 * toast system (F12), which is why these cases spy on `window.alert`. Asserting
 * that here is far cheaper than driving a browser dialog listener in Playwright.
 */

vi.mock('@/services/attendanceService', () => ({
  default: { autoMarkAbsent: vi.fn() },
}));

const mockService = vi.mocked(attendanceService);

/** Exactly what the axios interceptor rejects with — no `.response` anywhere. */
const flatApiError = (statusCode: number, message: string) => ({
  success: false,
  statusCode,
  message,
  timestamp: new Date().toISOString(),
  path: '/attendances/auto-mark-absent',
  errors: null,
  details: { message },
});

const okResult = (over: Record<string, unknown> = {}) => ({
  data: {
    date: new Date('2026-08-15'),
    totalActive: 42,
    markedAbsent: 7,
    onLeave: 3,
    checkedIn: 32,
    absentEmployees: [],
    ...over,
  },
});

describe('AutoAbsentTrigger', () => {
  let alertSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('offers the trigger without issuing anything', async () => {
    renderWithProviders(<AutoAbsentTrigger />, { role: 'HR_MANAGER' });

    expect(await screen.findByTestId('absent-open')).toBeTruthy();
    expect(mockService.autoMarkAbsent).not.toHaveBeenCalled();
  });

  it('opening the confirmation does not call the server', async () => {
    const { user } = renderWithProviders(<AutoAbsentTrigger />, {
      role: 'HR_MANAGER',
    });

    await user.click(await screen.findByTestId('absent-open'));

    expect(await screen.findByTestId('absent-confirm')).toBeTruthy();
    // The whole point of the gate: the dialog is open and nothing has happened.
    expect(mockService.autoMarkAbsent).not.toHaveBeenCalled();
  });

  it('cancelling closes the dialog and still issues nothing', async () => {
    const { user } = renderWithProviders(<AutoAbsentTrigger />, {
      role: 'HR_MANAGER',
    });

    await user.click(await screen.findByTestId('absent-open'));
    await user.click(await screen.findByTestId('absent-cancel'));

    await waitFor(() =>
      expect(screen.queryByTestId('absent-confirm')).toBeNull(),
    );
    expect(mockService.autoMarkAbsent).not.toHaveBeenCalled();
  });

  it('confirming runs it once and reports the count the server returned', async () => {
    mockService.autoMarkAbsent.mockResolvedValue(okResult() as any);

    const { user } = renderWithProviders(<AutoAbsentTrigger />, {
      role: 'HR_MANAGER',
    });

    await user.click(await screen.findByTestId('absent-open'));
    await user.click(await screen.findByTestId('absent-confirm'));

    const result = await screen.findByTestId('absent-result');
    // Read the attribute, not the rendered text: the number is interpolated
    // into a translated sentence everywhere else on this card.
    expect(result.getAttribute('data-marked')).toBe('7');
    expect(mockService.autoMarkAbsent).toHaveBeenCalledTimes(1);
  });

  it('a run that marked nobody reports zero rather than hiding the panel', async () => {
    mockService.autoMarkAbsent.mockResolvedValue(
      okResult({ markedAbsent: 0 }) as any,
    );

    const { user } = renderWithProviders(<AutoAbsentTrigger />, {
      role: 'HR_MANAGER',
    });

    await user.click(await screen.findByTestId('absent-open'));
    await user.click(await screen.findByTestId('absent-confirm'));

    const result = await screen.findByTestId('absent-result');
    expect(result.getAttribute('data-marked')).toBe('0');
  });

  /**
   * F2, FIXED. `lib/axios.ts` rejects with a FLAT object — no `.response` on it
   * — so `error.response?.data?.message` always read `undefined` and the generic
   * fallback always won. The server's actual reason never reached the user.
   * `apiErrorMessage` handles both shapes.
   */
  it('the server’s reason reaches the user', async () => {
    mockService.autoMarkAbsent.mockRejectedValue(
      flatApiError(
        400,
        'Skipped (Day-end boundary for 2026-08-15 has not been reached yet)',
      ),
    );

    const { user } = renderWithProviders(<AutoAbsentTrigger />, {
      role: 'HR_MANAGER',
    });

    await user.click(await screen.findByTestId('absent-open'));
    await user.click(await screen.findByTestId('absent-confirm'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(String(alertSpy.mock.calls[0][0])).toContain('Day-end boundary');
  });

  it('falls back to the generic message when the server sent none', async () => {
    mockService.autoMarkAbsent.mockRejectedValue({ success: false });

    const { user } = renderWithProviders(<AutoAbsentTrigger />, {
      role: 'HR_MANAGER',
    });

    await user.click(await screen.findByTestId('absent-open'));
    await user.click(await screen.findByTestId('absent-confirm'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(String(alertSpy.mock.calls[0][0]).length).toBeGreaterThan(0);
  });

  it('a failure leaves the trigger usable rather than stuck', async () => {
    mockService.autoMarkAbsent.mockRejectedValue(flatApiError(500, 'boom'));

    const { user } = renderWithProviders(<AutoAbsentTrigger />, {
      role: 'HR_MANAGER',
    });

    await user.click(await screen.findByTestId('absent-open'));
    await user.click(await screen.findByTestId('absent-confirm'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    // `finally { setLoading(false) }` — the confirm button must come back, or a
    // transient 500 bricks the screen until a reload.
    await waitFor(() =>
      expect(
        (screen.getByTestId('absent-confirm') as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});
