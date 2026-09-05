import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import NewOvertimePage from './page';

/**
 * Filing overtime.
 *
 * Pay-affecting, and the arithmetic behind the preview is already covered by
 * `utils/overtimeCalc.test.ts`. What is left for this layer is the part the
 * pure functions cannot see: whether the form lets an impossible window through.
 *
 * It did. `end <= start` is treated as an overnight shift and rolled forward a
 * day, and the comparison is inclusive — so identical start and end times were
 * submitted as a 24-hour claim. Nothing rejected it, on either side.
 */

vi.mock('@/services/overtimeService', () => ({
  default: { create: vi.fn(), getMyOvertimes: vi.fn() },
}));

vi.mock('@/services/holidayService', () => ({
  default: { getAll: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import overtimeService from '@/services/overtimeService';
import holidayService from '@/services/holidayService';

const create = vi.mocked(overtimeService.create);

const dateInput = () => document.querySelector('input[type="date"]') as HTMLInputElement;
const timeInputs = () => Array.from(document.querySelectorAll('input[type="time"]')) as HTMLInputElement[];
const reasonBox = () => document.querySelector('textarea') as HTMLTextAreaElement | null;
const submitButton = () =>
  Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('type') === 'submit')!;

function renderForm() {
  return renderWithProviders(<NewOvertimePage />, {
    role: 'EMPLOYEE',
    user: { employeeId: 'e-1' },
    branding: { overtime_enabled: true, overtime_require_reason: true } as never,
  });
}

beforeEach(() => {
  create.mockReset();
  vi.mocked(holidayService.getAll).mockResolvedValue({ success: true, data: [] } as never);
});

describe('the same-start-and-end guard', () => {
  it('refuses a window whose start and end are identical', async () => {
    // The defect: `buildOvertimeWindow` rolls the end forward a full day when
    // `end <= start`, so 09:00–09:00 became a 24-hour claim — about 19 payable
    // hours after the day-boundary clamp, plus a food allowance, for a shift
    // nobody worked.
    const { user } = renderForm();
    await waitFor(() => expect(dateInput()).toBeInTheDocument());
    const [start, end] = timeInputs();

    await user.type(dateInput(), '2026-09-01');
    await user.type(start, '09:00');
    await user.type(end, '09:00');
    if (reasonBox()) await user.type(reasonBox()!, 'Covering the evening shift');
    await user.click(submitButton());

    await waitFor(() =>
      expect(screen.getByText('Start and end time cannot be the same')).toBeInTheDocument(),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('still accepts a genuine overnight window, where the end precedes the start', async () => {
    // 22:00 → 02:00 is four hours of night work. The fix must not reject it.
    create.mockResolvedValue({ data: { id: 'ot-1' } } as never);
    const { user } = renderForm();
    await waitFor(() => expect(dateInput()).toBeInTheDocument());
    const [start, end] = timeInputs();

    await user.type(dateInput(), '2026-09-01');
    await user.type(start, '22:00');
    await user.type(end, '02:00');
    if (reasonBox()) await user.type(reasonBox()!, 'Covering the night shift');
    await user.click(submitButton());

    await waitFor(() => expect(create).toHaveBeenCalled());
  });

  it('accepts an ordinary same-day window', async () => {
    create.mockResolvedValue({ data: { id: 'ot-2' } } as never);
    const { user } = renderForm();
    await waitFor(() => expect(dateInput()).toBeInTheDocument());
    const [start, end] = timeInputs();

    await user.type(dateInput(), '2026-09-01');
    await user.type(start, '18:00');
    await user.type(end, '21:00');
    if (reasonBox()) await user.type(reasonBox()!, 'Month-end close');
    await user.click(submitButton());

    await waitFor(() => expect(create).toHaveBeenCalled());
  });
});
