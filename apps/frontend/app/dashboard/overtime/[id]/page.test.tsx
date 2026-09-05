import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import {
  fireEvent,
  renderWithProviders,
  screen,
  waitFor,
  within,
} from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import overtimeService from '@/services/overtimeService';
import type { OvertimePreview, OvertimeRequest } from '@/types/overtime';
import OvertimeDetailPage from './page';

/**
 * The screen that decides the money.
 *
 * Everything asserted here defends one rule: the breakdown belongs to the
 * SERVER. It depends on the employee's overtime policy and on the branch-aware
 * day classification, neither of which the browser has, so a page that derived
 * the tiers from the window would show REGULAR where the server said LATE — and
 * the number an approver signs off would not be the number that gets paid. The
 * fixtures below therefore give the preview figures that DISAGREE with the naive
 * arithmetic, so a recompute would fail the test rather than coincide with it.
 *
 * The food allowance is the same argument in miniature. `foodAllowanceOverride`
 * is null when nobody touched it and 0 when an approver decided to pay none, and
 * those are different facts about the same request. A page that treats 0 as
 * absent hides a decision somebody made deliberately.
 *
 * `expectedUpdatedAt` on an approval with a correction is the concurrency guard:
 * two approvers holding the same pending request open must not both write, and
 * the second one is refused with a 409 only if the first sent the version it saw.
 *
 * And withdrawal: the owner of a pending request may take it back and may not
 * decide it. The server enforces that; the page must not offer buttons the
 * server will refuse.
 */
vi.mock('@/services/overtimeService', () => ({
  default: {
    get: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
    previewEdit: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const getRequest = vi.mocked(overtimeService.get);
const approve = vi.mocked(overtimeService.approve);
const cancel = vi.mocked(overtimeService.cancel);
const previewEdit = vi.mocked(overtimeService.previewEdit);

/**
 * The server's breakdown for the filed window.
 *
 * 17:30 to 22:00 is four and a half hours of clock, and the payable total is
 * 3.5 — the last half hour falls past the attendance day boundary. The gap is
 * deliberate: it is what tells a recompute apart from a read.
 */
const PREVIEW: OvertimePreview = {
  hours: 3.5,
  regularHours: 2,
  lateHours: 1.5,
  doubleHours: 0,
  doubleLateHours: 0,
  dayType: 'WEEKDAY',
  otType: 'LATE',
  foodAllowance: 3,
  foodAllowanceOverride: null,
  siteAllowance: 0,
  isDoubleOtDay: false,
  regularRate: 1.25,
  lateRate: 1.5,
  doubleRate: 2,
  doubleLateRate: 2.5,
  policyId: 'pol-1',
  policyName: 'Plant crew',
};

const REQUEST: OvertimeRequest = {
  id: 'ot-1',
  employeeId: 'emp-1',
  date: '2026-10-05',
  // Wall clocks tagged UTC, exactly as the API stores them.
  startTime: '2026-10-05T17:30:00.000Z',
  endTime: '2026-10-05T22:00:00.000Z',
  hours: 3.5,
  regularHours: 2,
  lateHours: 1.5,
  doubleHours: 0,
  doubleLateHours: 0,
  dayType: 'WEEKDAY',
  otType: 'LATE',
  foodAllowance: 3,
  siteAllowance: 0,
  siteAllowanceNote: null,
  foodAllowanceOverride: null,
  approverNote: null,
  editedById: null,
  editedAt: null,
  originalStartTime: null,
  originalEndTime: null,
  overtimePolicyId: 'pol-1',
  reason: 'Line 3 changeover ran past the shift',
  status: 'PENDING',
  approverId: null,
  approvedAt: null,
  rejectedReason: null,
  createdAt: '2026-10-05T22:10:00.000Z',
  updatedAt: '2026-10-05T22:10:00.000Z',
  employee: {
    id: 'emp-1',
    employeeCode: 'EMP-0001',
    firstName: 'Aisha',
    lastName: 'Al Balushi',
  },
  overtimePolicy: { id: 'pol-1', name: 'Plant crew' },
  preview: PREVIEW,
};

/** Signs in an approver: HR, and not the person who filed the request. */
function signInApprover() {
  useAuthStore.setState({
    user: {
      id: 'u1',
      email: 'hr@peoplepay360.com',
      role: 'HR_MANAGER',
      isActive: true,
      employee: {
        id: 'emp-hr',
        employeeCode: 'EMP-0100',
        firstName: 'Noora',
        lastName: 'Al Rashdi',
      },
    },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });
}

/** Signs in the employee whose request this is. */
function signInOwner() {
  useAuthStore.setState({
    user: {
      id: 'u2',
      email: 'aisha@peoplepay360.com',
      role: 'EMPLOYEE',
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
 * The route takes `params` as a promise and unwraps it with `use()`.
 *
 * A plain `Promise.resolve` would SUSPEND the first render, and a suspension
 * inside Testing Library's synchronous `act` never recovers — the tree stays
 * empty and every assertion fails on an empty body rather than on the page.
 * Handing `use()` an already-settled thenable (React's own contract: `status`
 * plus `value`) makes the unwrap synchronous, which is what Next does in the
 * browser once the params have arrived anyway.
 */
function resolvedParams(id: string): Promise<{ id: string }> {
  const settled = Promise.resolve({ id });
  return Object.assign(settled, { status: 'fulfilled', value: { id } });
}

function renderDetail() {
  return renderWithProviders(
    <OvertimeDetailPage params={resolvedParams('ot-1')} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  signInApprover();
  getRequest.mockResolvedValue({ success: true, data: REQUEST });
  approve.mockResolvedValue({ success: true, data: REQUEST });
  cancel.mockResolvedValue({ success: true, data: REQUEST });
});

describe('Overtime request', () => {
  it('draws the tiers the server sent, with their hours and multipliers', async () => {
    renderDetail();

    const regular = within(await screen.findByRole('row', { name: /Regular/ }));
    expect(regular.getByText('2h')).toBeInTheDocument();
    expect(regular.getByText('1.25×')).toBeInTheDocument();

    const late = within(screen.getByRole('row', { name: /^Late/ }));
    expect(late.getByText('1.5h')).toBeInTheDocument();
    expect(late.getByText('1.5×')).toBeInTheDocument();

    // The zero tiers are not drawn: two permanent "0h" rows train the reader to
    // stop looking at the column that matters.
    expect(screen.queryByRole('row', { name: /Rest day/ })).not.toBeInTheDocument();
  });

  it('reports the payable total the server computed, not the length of the window', async () => {
    renderDetail();

    const total = within(await screen.findByRole('row', { name: /Total/ }));
    expect(total.getByText('3.5h')).toBeInTheDocument();

    // 17:30 to 22:00 is 4.5 hours of clock. That figure must appear NOWHERE:
    // the payable total is clamped at the attendance day boundary, and a page
    // that did the subtraction itself would print it.
    expect(screen.queryByText('4.5h')).not.toBeInTheDocument();
    // The window itself is still shown — as a window, not as a number of hours.
    expect(screen.getByText('17:30 – 22:00')).toBeInTheDocument();
  });

  it('shows a suppressed food allowance as 0, and says a person decided it', async () => {
    getRequest.mockResolvedValue({
      success: true,
      data: {
        ...REQUEST,
        foodAllowanceOverride: 0,
        preview: { ...PREVIEW, foodAllowance: 0, foodAllowanceOverride: 0 },
      },
    });

    renderDetail();

    const food = (await screen.findByText('Food allowance')).parentElement!;
    expect(within(food).getByText('0')).toBeInTheDocument();
    // 0 is a decision the approval has to honour; null is nobody having touched
    // it. Rendering the two the same way loses the one that was deliberate.
    expect(within(food).getByText('set by the approver')).toBeInTheDocument();
  });

  it('does not claim an approver set an allowance the policy granted', async () => {
    renderDetail();

    const food = (await screen.findByText('Food allowance')).parentElement!;
    expect(within(food).getByText('3')).toBeInTheDocument();
    expect(
      within(food).queryByText('set by the approver'),
    ).not.toBeInTheDocument();
  });

  it('replaces the figures with the dry run when the approver corrects the times', async () => {
    previewEdit.mockResolvedValue({
      success: true,
      data: {
        ...PREVIEW,
        hours: 5,
        regularHours: 2,
        lateHours: 3,
        startTime: '2026-10-05T17:30:00.000Z',
        endTime: '2026-10-05T23:00:00.000Z',
      },
    });

    const user = userEvent.setup();
    renderDetail();

    await user.click(
      await screen.findByRole('button', { name: 'Correct the times' }),
    );

    // Seeded in UTC. Read in the browser's zone these boxes would show an hour
    // the employee never typed.
    expect(screen.getByLabelText('Corrected start')).toHaveValue('17:30');
    expect(screen.getByLabelText('Corrected finish')).toHaveValue('22:00');

    fireEvent.change(screen.getByLabelText('Corrected finish'), {
      target: { value: '23:00' },
    });
    await user.click(screen.getByRole('button', { name: 'Check the figures' }));

    // The card renames itself so nobody signs the corrected figures believing
    // they are what the employee filed.
    expect(
      await screen.findByRole('heading', { name: 'With your correction' }),
    ).toBeInTheDocument();
    const total = within(screen.getByRole('row', { name: /Total/ }));
    expect(total.getByText('5h')).toBeInTheDocument();

    // The dry run is priced by the server too, on the corrected instants.
    expect(previewEdit).toHaveBeenCalledWith('ot-1', {
      startTime: '2026-10-05T17:30:00.000Z',
      endTime: '2026-10-05T23:00:00.000Z',
    });
  });

  it('sends the version it read when approving with a correction', async () => {
    previewEdit.mockResolvedValue({ success: true, data: { ...PREVIEW, hours: 5 } });

    const user = userEvent.setup();
    renderDetail();

    await user.click(
      await screen.findByRole('button', { name: 'Correct the times' }),
    );
    fireEvent.change(screen.getByLabelText('Corrected finish'), {
      target: { value: '23:00' },
    });
    fireEvent.change(screen.getByLabelText('Why the change'), {
      target: { value: 'The gate log shows 23:00.' },
    });

    await user.click(
      screen.getByRole('button', { name: 'Approve with the correction' }),
    );

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(approve).toHaveBeenCalledWith('ot-1', {
      startTime: '2026-10-05T17:30:00.000Z',
      endTime: '2026-10-05T23:00:00.000Z',
      approverNote: 'The gate log shows 23:00.',
      // Without this a second approver holding the request open overwrites the
      // first silently, instead of being refused with a 409.
      expectedUpdatedAt: '2026-10-05T22:10:00.000Z',
    });
  });

  it('approves as filed with no body at all when nothing was corrected', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    // A bodyless call means "exactly as filed"; any field present makes it an
    // edit, which is written before the decision.
    expect(approve).toHaveBeenCalledWith('ot-1', undefined);
  });

  it('lets the owner of a pending request withdraw it, and decide nothing', async () => {
    signInOwner();
    const user = userEvent.setup();
    renderDetail();

    const withdraw = await screen.findByRole('button', { name: 'Withdraw' });
    // Nobody approves their own overtime; the server refuses it, so the page
    // must not draw the button.
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Correct the times' }),
    ).not.toBeInTheDocument();

    await user.click(withdraw);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('ot-1'));
  });
});
