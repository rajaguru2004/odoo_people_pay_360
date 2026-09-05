import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import NewOvertimePage from './page';

/**
 * Filing overtime.
 *
 * The one thing this layer can see that a pure test cannot is whether the form
 * lets an impossible window through. An end at or before the start is a shift
 * crossing midnight and rolls forward a day — which means identical times would
 * file a 24-hour claim for a shift nobody worked, so the form has to refuse
 * them without also refusing genuine night work.
 */

vi.mock('@/services/overtimeService', () => ({
  default: { create: vi.fn() },
}));

vi.mock('@/services/holidayService', () => ({
  default: { list: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import overtimeService from '@/services/overtimeService';
import holidayService from '@/services/holidayService';

const create = vi.mocked(overtimeService.create);

const fields = () => ({
  day: screen.getByLabelText('Day worked'),
  start: screen.getByLabelText('Started at'),
  end: screen.getByLabelText('Finished at'),
  reason: screen.getByLabelText('What the hours were for'),
  submit: screen.getByRole('button', { name: 'File it' }),
});

async function fillIn(
  user: ReturnType<typeof userEvent.setup>,
  values: { day: string; start: string; end: string; reason: string },
) {
  const form = fields();
  await user.type(form.day, values.day);
  await user.type(form.start, values.start);
  await user.type(form.end, values.end);
  await user.type(form.reason, values.reason);
  await user.click(fields().submit);
}

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({ success: true, data: { id: 'ot-1' } } as never);
  vi.mocked(holidayService.list).mockResolvedValue({ success: true, data: [] } as never);

  useAuthStore.setState({
    user: {
      id: 'u-1',
      email: 'aisha@example.com',
      role: 'EMPLOYEE',
      isActive: true,
      employeeId: 'emp-1',
    },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });
});

describe('the same-start-and-end guard', () => {
  it('refuses a window whose start and end are identical', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewOvertimePage />);
    await waitFor(() => expect(fields().day).toBeInTheDocument());

    await fillIn(user, {
      day: '2026-09-01',
      start: '09:00',
      end: '09:00',
      reason: 'Covering the evening shift',
    });

    await waitFor(() =>
      expect(screen.getByText('Start and end time cannot be the same')).toBeInTheDocument(),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('still accepts a genuine overnight window, where the end precedes the start', async () => {
    // 22:00 → 02:00 is four hours of night work. The guard must not reject it.
    const user = userEvent.setup();
    renderWithProviders(<NewOvertimePage />);
    await waitFor(() => expect(fields().day).toBeInTheDocument());

    await fillIn(user, {
      day: '2026-09-01',
      start: '22:00',
      end: '02:00',
      reason: 'Covering the night shift',
    });

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      date: '2026-09-01',
      // The end rolled forward a day, and the instants carry the clock times
      // that were typed rather than a zone-converted pair.
      startTime: '2026-09-01T22:00:00Z',
      endTime: '2026-09-02T02:00:00Z',
      hours: 4,
      reason: 'Covering the night shift',
    });
  });

  it('accepts an ordinary same-day window', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewOvertimePage />);
    await waitFor(() => expect(fields().day).toBeInTheDocument());

    await fillIn(user, {
      day: '2026-09-01',
      start: '18:00',
      end: '21:00',
      reason: 'Month-end close',
    });

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].hours).toBe(3);
  });
});

describe('what the form tells the employee before they file', () => {
  it('measures the window as it is typed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewOvertimePage />);
    await waitFor(() => expect(fields().day).toBeInTheDocument());

    await user.type(fields().day, '2026-09-01');
    await user.type(fields().start, '18:00');
    await user.type(fields().end, '21:30');

    await waitFor(() =>
      expect(document.querySelector('[data-testid="ot-estimate"]')).toBeInTheDocument(),
    );
    expect(
      document.querySelector('[data-testid="ot-estimate"]')?.getAttribute('data-hours'),
    ).toBe('3.5');
  });
});
