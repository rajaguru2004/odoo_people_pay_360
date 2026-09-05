import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { routerMock } from '@/test/router-mock';
import EmployeeDashboardMobile, {
  type EmployeeDashboardMobileProps,
} from './EmployeeDashboardMobile';

/**
 * The phone home screen.
 *
 * The cases that matter are the STATE ones — the shift card is the only part
 * of the ESS portal that changes what it says four times a day, and the first
 * pass of this component got the last of those four wrong: after a check-out
 * with multiple sessions allowed it read "Not clocked in" beside two stamped
 * times, because the chip was deciding on the day rather than on the session.
 * Each of the four is pinned below.
 *
 * Layout is not asserted here. jsdom has no layout engine, so tap-target sizes
 * and the absence of horizontal overflow are the browser spec's job
 * (`e2e/specs/lifecycle/ess-mobile-dashboard.employee.spec.ts`).
 */

const CHECK_IN_AT = '2026-09-01T08:04:00.000Z';
const CHECK_OUT_AT = '2026-09-01T17:10:00.000Z';

function makeProps(overrides: Partial<EmployeeDashboardMobileProps> = {}): EmployeeDashboardMobileProps {
  return {
    fullName: 'John Employee',
    position: 'Software Developer',
    department: 'Human Resources',
    avatarUrl: null,
    attendance: { allowMultiple: false },
    checkInAt: null,
    checkOutAt: null,
    leaves: [],
    overtime: [],
    balances: [],
    profileCompletion: null,
    missingDocs: false,
    overtimeEnabled: true,
    checkingIn: false,
    checkingOut: false,
    onCheckIn: vi.fn(),
    onCheckOut: vi.fn(),
    onRefresh: vi.fn(),
    formatTime: (v) => (v ? '08:04 am' : '--:--'),
    statusBadge: (status) => <span data-testid="status-badge">{status}</span>,
    ...overrides,
  };
}

const render = (overrides?: Partial<EmployeeDashboardMobileProps>) =>
  renderWithProviders(<EmployeeDashboardMobile {...makeProps(overrides)} />, { role: 'EMPLOYEE' });

beforeEach(() => {
  // The elapsed counter and the greeting both read the wall clock.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-09-01T10:04:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the shift card', () => {
  it('offers check-in and says so when the day has not started', async () => {
    const onCheckIn = vi.fn();
    const { user } = render({ onCheckIn });

    expect(screen.getByText('Not clocked in')).toBeInTheDocument();
    expect(screen.queryByTestId('ess-mobile-elapsed')).not.toBeInTheDocument();

    const primary = screen.getByTestId('ess-mobile-primary-action');
    expect(primary).toHaveTextContent('Check-in');
    await user.click(primary);
    expect(onCheckIn).toHaveBeenCalledTimes(1);
  });

  it('runs a live counter and offers check-out while the session is open', async () => {
    const onCheckOut = vi.fn();
    const { user } = render({ checkInAt: CHECK_IN_AT, onCheckOut });

    expect(screen.getByText('On duty')).toBeInTheDocument();
    // Two hours after the 08:04 check-in, to the second.
    expect(screen.getByTestId('ess-mobile-elapsed')).toHaveTextContent('02:00:00');

    const primary = screen.getByTestId('ess-mobile-primary-action');
    expect(primary).toHaveTextContent('Check-out');
    await user.click(primary);
    expect(onCheckOut).toHaveBeenCalledTimes(1);
  });

  it('reads Completed and drops the counter once the session is closed', () => {
    // `allowMultiple` on: the day is still open for another session, which is
    // exactly the case that used to report "Not clocked in".
    render({ checkInAt: CHECK_IN_AT, checkOutAt: CHECK_OUT_AT, attendance: { allowMultiple: true } });

    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.queryByText('Not clocked in')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ess-mobile-elapsed')).not.toBeInTheDocument();
    // …and another check-in is still on offer, because sessions may repeat.
    expect(screen.getByTestId('ess-mobile-primary-action')).toHaveTextContent('Check-in');
  });

  it('sends face-only employees to the attendance screen instead of clocking them in', async () => {
    const onCheckIn = vi.fn();
    const { user } = render({ attendance: { attendanceFaceOnly: true }, onCheckIn });

    await user.click(screen.getByTestId('ess-mobile-primary-action'));
    expect(onCheckIn).not.toHaveBeenCalled();
    expect(routerMock.push).toHaveBeenCalledWith('/dashboard/my-attendance');
  });

  it('disables the primary action while a check-in is in flight', () => {
    render({ checkingIn: true });
    expect(screen.getByTestId('ess-mobile-primary-action')).toBeDisabled();
  });
});

describe('the rest of the screen', () => {
  it('shows a leave-balance rail with remaining over entitlement', () => {
    render({
      balances: [
        { id: 'b1', employeeId: 'e1', year: 2026, leaveTypeKey: 'ANNUAL', allocated: 10, used: 3, carriedOver: 2, remaining: 9 },
      ],
    });

    const card = screen.getByTestId('ess-mobile-balance-card');
    expect(within(card).getByText('ANNUAL')).toBeInTheDocument();
    expect(within(card).getByText('9')).toBeInTheDocument();
    // allocated + carriedOver, the same total the my-leaves screen shows.
    expect(within(card).getByText('/ 12')).toBeInTheDocument();
  });

  it('omits the balance rail entirely when the employee has no balance row', () => {
    render();
    expect(screen.queryByTestId('ess-mobile-balances')).not.toBeInTheDocument();
  });

  it('routes a stat tile to the screen it counts', async () => {
    const { user } = render({
      leaves: [{ id: 'l1', startDate: CHECK_IN_AT, endDate: CHECK_IN_AT, type: 'ANNUAL', status: 'PENDING', totalDays: 1 }],
    });

    const tiles = screen.getAllByTestId('ess-mobile-stat');
    await user.click(tiles[0]);
    expect(routerMock.push).toHaveBeenCalledWith('/dashboard/my-leaves');
  });

  it('drops every overtime affordance when the module is off', () => {
    render({
      overtimeEnabled: false,
      overtime: [{ id: 'o1', date: CHECK_IN_AT, startTime: CHECK_IN_AT, endTime: CHECK_OUT_AT, status: 'PENDING', hours: 2 }],
    });

    // Two stat tiles rather than four, no segmented control, no OT shortcut.
    expect(screen.getAllByTestId('ess-mobile-stat')).toHaveLength(2);
    expect(screen.queryByTestId('ess-mobile-activity-tab-overtime')).not.toBeInTheDocument();
    expect(screen.queryByText('Overtime request awaiting approval')).not.toBeInTheDocument();
    const actions = screen.getAllByTestId('ess-mobile-quick-action').map((n) => n.textContent);
    expect(actions).not.toContain('Overtime');
  });

  it('switches the activity list between leave and overtime', async () => {
    const { user } = render({
      leaves: [{ id: 'l1', startDate: CHECK_IN_AT, endDate: CHECK_IN_AT, type: 'ANNUAL', status: 'PENDING', totalDays: 1 }],
      overtime: [{ id: 'o1', date: CHECK_IN_AT, startTime: CHECK_IN_AT, endTime: CHECK_OUT_AT, status: 'APPROVED', hours: 2 }],
    });

    const activity = screen.getByTestId('ess-mobile-activity');
    expect(within(activity).getByText('ANNUAL')).toBeInTheDocument();

    await user.click(screen.getByTestId('ess-mobile-activity-tab-overtime'));
    expect(within(activity).queryByText('ANNUAL')).not.toBeInTheDocument();
    expect(within(activity).getByTestId('status-badge')).toHaveTextContent('APPROVED');
  });

  it('offers the profile card only while the profile is incomplete', () => {
    const { unmount } = render({ profileCompletion: 15, missingDocs: true });
    expect(screen.getByTestId('ess-mobile-profile-card')).toHaveTextContent('15%');
    unmount();

    render({ profileCompletion: 100 });
    expect(screen.queryByTestId('ess-mobile-profile-card')).not.toBeInTheDocument();
  });
});
