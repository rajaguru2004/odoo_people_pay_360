import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import ScheduleModal from './ScheduleModal';

/**
 * The create/edit form for a single shift.
 *
 * The browser suite already drives this form end to end, so the value here is
 * not "does it submit" — it is the handful of rules the form enforces BEFORE it
 * talks to anyone, which a browser case can only reach one at a time and at the
 * cost of a round trip:
 *
 *  - the field swap: a FLEXIBLE shift has no window, a fixed one has no target
 *    hours, and the form must show exactly one of those pairs;
 *  - the preset windows, and the rule that only CUSTOM may move them — a
 *    disabled input is invisible to a test that only checks its value;
 *  - client validation, which must refuse without sending anything;
 *  - the two-stage contract dialog, which is a real gate rather than a notice;
 *  - the server's refusal reaching the form (T19) — the whole finding was that
 *    every refusal used to read as one generic sentence, so the assertion that
 *    matters is that a DIFFERENT reason produces DIFFERENT text.
 *
 * `authService.getUser` is stubbed rather than left to the auth store because
 * the component reads it directly for identity (not for authorization — that
 * goes through `usePermission`, which reads the store the render helper seeds).
 */

vi.mock('@/services/calendarService', () => ({
  default: {
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    getSchedule: vi.fn(),
  },
}));

vi.mock('@/services/employeeService', () => ({
  default: { getAll: vi.fn() },
}));

vi.mock('@/services/authService', () => ({
  default: { getUser: vi.fn() },
}));

import calendarService from '@/services/calendarService';
import employeeService from '@/services/employeeService';
import authService from '@/services/authService';

const WITH_CONTRACT = {
  id: 'emp-1',
  employeeCode: 'E-001',
  fullName: 'Rosa Rostered',
  status: 'ACTIVE',
  contracts: [{ id: 'c-1', startDate: '2026-01-01', endDate: '2026-12-31' }],
};

const WITHOUT_CONTRACT = {
  id: 'emp-2',
  employeeCode: 'E-002',
  fullName: 'Fiona Flexible',
  status: 'ACTIVE',
  contracts: [],
};

const noop = () => {};

/** Render the modal open, as a role that may schedule other people. */
function openModal(
  props: Partial<React.ComponentProps<typeof ScheduleModal>> = {},
) {
  return renderWithProviders(
    <ScheduleModal
      isOpen
      onClose={props.onClose ?? noop}
      onSuccess={props.onSuccess ?? noop}
      {...props}
    />,
    { role: 'ADMIN' },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  (employeeService.getAll as any).mockResolvedValue({
    success: true,
    data: [WITH_CONTRACT, WITHOUT_CONTRACT],
  });
  (authService.getUser as any).mockReturnValue({
    id: 'u-admin',
    role: 'ADMIN',
    employeeId: 'emp-1',
  });
  (calendarService.createSchedule as any).mockResolvedValue({
    success: true,
    data: { id: 'sch-1' },
  });
});


/**
 * Pick an employee, once the directory has actually loaded.
 *
 * `employeeService.getAll` is awaited inside an effect, and the `<select>` is
 * rendered disabled and empty until it resolves. Selecting straight after the
 * form appears therefore races the fetch and fails with "Value not found in
 * options" — which reads like the fixture is wrong rather than early.
 */
async function chooseEmployee(user: any, id: string) {
  const select = screen.getByTestId('sched-form-employee') as HTMLSelectElement;
  await waitFor(() => {
    expect(select.disabled).toBe(false);
    expect(
      Array.from(select.options).some((o) => o.value === id),
    ).toBe(true);
  });
  await user.selectOptions(select, id);
}

// ── The field swap ──────────────────────────────────────────────────────────
describe('the shape of a shift', () => {
  it('offers a time window for a fixed shift and target hours for a flexible one', async () => {
    const { user } = openModal();
    await screen.findByTestId('sched-form');

    await user.click(screen.getByTestId('sched-form-type-FULL_DAY'));
    expect(screen.getByTestId('sched-form-start')).toBeInTheDocument();
    expect(screen.queryByTestId('sched-form-hours')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('sched-form-type-FLEXIBLE'));
    expect(screen.getByTestId('sched-form-hours')).toBeInTheDocument();
    // Not merely hidden — a flexible shift has no window at all, and the server
    // writes null into both columns.
    expect(screen.queryByTestId('sched-form-start')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sched-form-end')).not.toBeInTheDocument();
  });

  it('switches back, so the choice is not one-way', async () => {
    const { user } = openModal();
    await screen.findByTestId('sched-form');

    await user.click(screen.getByTestId('sched-form-type-FLEXIBLE'));
    await user.click(screen.getByTestId('sched-form-type-CUSTOM'));

    expect(screen.getByTestId('sched-form-start')).toBeInTheDocument();
    expect(screen.queryByTestId('sched-form-hours')).not.toBeInTheDocument();
  });

  it.each([
    ['MORNING', true],
    ['AFTERNOON', true],
    ['FULL_DAY', true],
    ['NIGHT', true],
    ['CUSTOM', false],
  ])('locks the window for %s and leaves CUSTOM editable', async (type, locked) => {
    // The rule that makes the presets meaningful: every named shift IS its
    // window, and only CUSTOM means "I will say". Asserted on `disabled`
    // because a test that only read the value would pass against a form that
    // let the user edit a preset and then silently overwrote them.
    const { user } = openModal();
    await screen.findByTestId('sched-form');

    await user.click(screen.getByTestId(`sched-form-type-${type}`));
    const start = screen.getByTestId('sched-form-start') as HTMLInputElement;
    const end = screen.getByTestId('sched-form-end') as HTMLInputElement;

    expect(start.disabled).toBe(locked);
    expect(end.disabled).toBe(locked);
  });

  it('gives each preset its own window rather than one shared default', async () => {
    const { user } = openModal();
    await screen.findByTestId('sched-form');

    await user.click(screen.getByTestId('sched-form-type-MORNING'));
    const morning = (screen.getByTestId('sched-form-start') as HTMLInputElement)
      .value;

    await user.click(screen.getByTestId('sched-form-type-NIGHT'));
    const night = (screen.getByTestId('sched-form-start') as HTMLInputElement)
      .value;

    expect(morning).toBeTruthy();
    expect(night).toBeTruthy();
    expect(morning).not.toBe(night);
  });
});

// ── Client validation ───────────────────────────────────────────────────────
describe('what the form refuses before sending anything', () => {
  it('refuses a missing date and never calls the service', async () => {
    const { user } = openModal();
    await screen.findByTestId('sched-form');

    await chooseEmployee(user, 'emp-1');
    await user.clear(screen.getByTestId('sched-form-date'));
    await user.click(screen.getByTestId('sched-form-submit'));

    expect(await screen.findByTestId('sched-form-error-date')).toBeVisible();
    expect(calendarService.createSchedule).not.toHaveBeenCalled();
  });

  it('refuses a missing employee', async () => {
    const { user } = openModal();
    await screen.findByTestId('sched-form');

    await user.type(screen.getByTestId('sched-form-date'), '2026-05-10');
    await user.click(screen.getByTestId('sched-form-submit'));

    expect(
      await screen.findByTestId('sched-form-error-employeeId'),
    ).toBeVisible();
    expect(calendarService.createSchedule).not.toHaveBeenCalled();
  });

  it('refuses an inverted window', async () => {
    const { user } = openModal();
    await screen.findByTestId('sched-form');

    await chooseEmployee(user, 'emp-1');
    await user.type(screen.getByTestId('sched-form-date'), '2026-05-10');
    await user.click(screen.getByTestId('sched-form-type-CUSTOM'));
    await user.clear(screen.getByTestId('sched-form-start'));
    await user.type(screen.getByTestId('sched-form-start'), '18:00');
    await user.clear(screen.getByTestId('sched-form-end'));
    await user.type(screen.getByTestId('sched-form-end'), '09:00');
    await user.click(screen.getByTestId('sched-form-submit'));

    expect(await screen.findByTestId('sched-form-error-endTime')).toBeVisible();
    expect(calendarService.createSchedule).not.toHaveBeenCalled();
  });

  it('bounds the flexible-hours field natively, and refuses an empty one', async () => {
    // Two different guards, and it is worth being precise about which is which.
    //
    // The UPPER bound is the input's own `max={24}` — a native constraint, so
    // the browser refuses to submit at all and the JS validator never runs.
    // That is a legitimate design, but it means there is no message to assert:
    // a test looking for one fails while the form is working correctly. The
    // bound itself is what can be asserted, and it is what a regression would
    // remove.
    //
    // The EMPTY case is the one the JS validator owns, because a cleared number
    // input reads as NaN rather than as out-of-range.
    const { user } = openModal();
    await screen.findByTestId('sched-form');
    await user.click(screen.getByTestId('sched-form-type-FLEXIBLE'));

    const hours = screen.getByTestId('sched-form-hours') as HTMLInputElement;
    expect(hours.type).toBe('number');
    expect(hours.max).toBe('24');
    expect(hours.min).toBe('0.5');

    await chooseEmployee(user, 'emp-1');
    await user.type(screen.getByTestId('sched-form-date'), '2026-05-10');
    await user.clear(hours);
    await user.click(screen.getByTestId('sched-form-submit'));

    expect(
      await screen.findByTestId('sched-form-error-requiredHours'),
    ).toBeVisible();
    expect(calendarService.createSchedule).not.toHaveBeenCalled();
  });
});

// ── The contract gate ───────────────────────────────────────────────────────
describe('the two-stage contract dialog', () => {
  /** Fill a valid FULL_DAY payload for `employee` and submit. */
  async function submitFor(user: any, employee: string) {
    await screen.findByTestId('sched-form');
    await chooseEmployee(user, employee);
    await user.type(screen.getByTestId('sched-form-date'), '2026-05-10');
    await user.click(screen.getByTestId('sched-form-type-FULL_DAY'));
    await user.click(screen.getByTestId('sched-form-submit'));
  }

  it('raises the warning for an employee with no active contract', async () => {
    const { user } = openModal();
    await submitFor(user, 'emp-2');

    // `waitFor`, not a bare assertion on the found node: the dialog mounts at
    // its framer-motion `initial` (`opacity: 0`) and reaches `animate` a frame
    // later, so `findBy*` resolves while it is still transparent — and
    // `toBeVisible()` reads opacity 0 as invisible.
    await waitFor(() =>
      expect(screen.getByTestId('sched-contract-warning')).toBeVisible(),
    );
    // Nothing sent yet — the dialog is a gate, not a notice shown afterwards.
    expect(calendarService.createSchedule).not.toHaveBeenCalled();
  });

  it('does NOT raise it for an employee who has one', async () => {
    // The complement. Without it the case above would pass against a form that
    // showed the dialog to everybody.
    const { user } = openModal();
    await submitFor(user, 'emp-1');

    await waitFor(() =>
      expect(calendarService.createSchedule).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.queryByTestId('sched-contract-warning'),
    ).not.toBeInTheDocument();
  });

  it('cancelling sends nothing and returns to the form', async () => {
    const { user } = openModal();
    await submitFor(user, 'emp-2');

    await user.click(await screen.findByTestId('sched-contract-cancel'));

    expect(calendarService.createSchedule).not.toHaveBeenCalled();
    // `waitFor`, not a bare assertion: the dialog is a framer-motion child with
    // an exit transition, so for a few frames after the click it is still in the
    // document at a fractional opacity. Asserting removal immediately fails on
    // the animation rather than on the behaviour.
    await waitFor(() =>
      expect(
        screen.queryByTestId('sched-contract-warning'),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('sched-form')).toBeInTheDocument();
  });

  it('confirming sends the schedule it was holding', async () => {
    const onSuccess = vi.fn();
    const { user } = openModal({ onSuccess });
    await submitFor(user, 'emp-2');

    await user.click(await screen.findByTestId('sched-contract-confirm'));

    await waitFor(() =>
      expect(calendarService.createSchedule).toHaveBeenCalledTimes(1),
    );
    expect(
      (calendarService.createSchedule as any).mock.calls[0][0],
    ).toMatchObject({ employeeId: 'emp-2', shiftType: 'FULL_DAY' });
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });
});

// ── T19: the server's reason reaches the user ───────────────────────────────
describe('a refused save (T19)', () => {
  /**
   * The finding was not "errors are not shown" — it was that they were all
   * shown as the SAME sentence, because the modal read
   * `error.response?.data?.message`, a path this app's axios interceptor never
   * fills. So the assertion that matters is that two different refusals produce
   * two different messages.
   */
  const refuseWith = (message: string) =>
    (calendarService.createSchedule as any).mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        response: { status: 400, data: { success: false, message } },
        message,
      }),
    );

  async function submitValid(user: any) {
    await screen.findByTestId('sched-form');
    await chooseEmployee(user, 'emp-1');
    await user.type(screen.getByTestId('sched-form-date'), '2026-05-10');
    await user.click(screen.getByTestId('sched-form-type-FULL_DAY'));
    await user.click(screen.getByTestId('sched-form-submit'));
  }

  it('shows the overlap reason for a duplicate shift', async () => {
    refuseWith('Work schedule overlaps with an existing one');
    const { user } = openModal();
    await submitValid(user);

    const banner = await screen.findByTestId('sched-form-error');
    expect(banner).toHaveTextContent(/overlaps/i);
  });

  it('shows the leave reason for a leave-day clash — a DIFFERENT message', async () => {
    refuseWith('Cannot create work schedule on leave day (ANNUAL)');
    const { user } = openModal();
    await submitValid(user);

    const banner = await screen.findByTestId('sched-form-error');
    expect(banner).toHaveTextContent(/leave day/i);
    expect(banner).toHaveTextContent(/ANNUAL/);
    // The regression this guards: both of these used to read "An error occurred
    // while saving the work schedule".
    expect(banner).not.toHaveTextContent(/An error occurred/i);
  });

  it('keeps the form open so the user can correct and retry', async () => {
    refuseWith('Work date must be after the contract start date');
    const onSuccess = vi.fn();
    const { user } = openModal({ onSuccess });
    await submitValid(user);

    await screen.findByTestId('sched-form-error');
    expect(screen.getByTestId('sched-form')).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('falls back to a readable sentence when the server says nothing useful', async () => {
    // `apiErrorMessage` has to cope with a refusal that carries no message at
    // all — a 502 from a proxy, say. "undefined" on screen is the failure mode.
    (calendarService.createSchedule as any).mockRejectedValue(new Error(''));
    const { user } = openModal();
    await submitValid(user);

    const banner = await screen.findByTestId('sched-form-error');
    expect(banner.textContent?.trim()).toBeTruthy();
    expect(banner).not.toHaveTextContent(/undefined|\[object Object\]/);
  });
});

// ── Editing ─────────────────────────────────────────────────────────────────
describe('editing an existing shift', () => {
  it('loads the shift and locks the employee', async () => {
    // The employee of an existing shift is not editable: moving a roster row to
    // somebody else is a different act from changing its hours, and the server
    // ignores `employeeId` on update.
    (calendarService.getSchedule as any).mockResolvedValue({
      success: true,
      data: {
        id: 'sch-9',
        employeeId: 'emp-1',
        date: '2026-05-10T00:00:00.000Z',
        shiftType: 'CUSTOM',
        startTime: '2026-05-10T09:00:00.000Z',
        endTime: '2026-05-10T17:00:00.000Z',
        requiredHours: null,
        isWorkDay: true,
        notes: 'existing',
      },
    });

    openModal({ scheduleId: 'sch-9' });

    const select = (await screen.findByTestId(
      'sched-form-employee',
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('emp-1'));
    expect(select.disabled).toBe(true);
    expect((screen.getByTestId('sched-form-date') as HTMLInputElement).value).toBe(
      '2026-05-10',
    );
  });

  it('surfaces a failed load rather than showing an empty form', async () => {
    // An empty form and a form that could not load look identical, and the
    // second one silently creates a second shift when the user saves it.
    (calendarService.getSchedule as any).mockRejectedValue(
      Object.assign(new Error('nope'), {
        response: { status: 404, data: { message: 'Work schedule not found' } },
      }),
    );

    openModal({ scheduleId: 'missing' });

    // Same reason as the contract dialog: the banner appears on the modal's
    // first paint, while the modal itself is still at `opacity: 0`.
    await waitFor(() =>
      expect(screen.getByTestId('sched-form-error')).toBeVisible(),
    );
  });
});
