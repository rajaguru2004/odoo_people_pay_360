import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import OvertimeReviewModal, {
  toTimeInput,
  fromTimeInput,
} from './OvertimeReviewModal';

/**
 * The approver's review screen.
 *
 * Three things it must get right, all of which were the reasons it exists:
 *
 *   1. It shows the WINDOW and the ALLOWANCES, not just an hours total — the
 *      approvals card showed `date · Nh` and nothing else.
 *   2. The figures it shows come from the SERVER on every correction. A local
 *      recompute reads the global settings and so cannot see the employee's
 *      Overtime Policy — the exact defect the detail page's `preview` fixed.
 *   3. It sends only what the approver actually changed, and `0` is a real
 *      food-allowance instruction rather than "unset".
 */

vi.mock('@/services/overtimeService', () => ({
  default: { editPreview: vi.fn(), approve: vi.fn(), reject: vi.fn() },
}));

vi.mock('@/services/approvalWorkflowService', () => ({
  default: { trail: vi.fn() },
}));

import overtimeService from '@/services/overtimeService';
import approvalWorkflowService from '@/services/approvalWorkflowService';

const BRANDING = {
  overtime_approver_edit_enabled: true,
  overtime_site_allowance_enabled: true,
  overtime_site_allowance_max: '100',
  overtime_food_allowance_enabled: true,
} as never;

const REQUEST = {
  id: 'ot-1',
  employeeId: 'emp-1',
  date: '2026-08-20T00:00:00.000Z',
  // Wall-clock tagged Z: an entered 18:00 is stored as ...T18:00:00Z.
  startTime: '2026-08-20T18:00:00.000Z',
  endTime: '2026-08-20T20:00:00.000Z',
  hours: 2,
  regularHours: 2,
  lateHours: 0,
  doubleHours: 0,
  foodAllowance: 0,
  siteAllowance: 0,
  otType: 'REGULAR',
  reason: 'Client cutover',
  status: 'PENDING',
  createdAt: '2026-08-20T11:00:00.000Z',
  updatedAt: '2026-08-20T11:00:00.000Z',
  employee: {
    id: 'emp-1',
    employeeCode: 'TRS-POD-002',
    fullName: 'JAMEENRAJ MATHIYAZHAGAN',
    email: 'j@example.com',
    department: { id: 'd1', name: 'Projects Operation Department' },
  },
  preview: {
    hours: 2,
    regularHours: 2,
    lateHours: 0,
    doubleHours: 0,
    doubleLateHours: 0,
    dayType: 'WEEKDAY',
    foodAllowance: 0,
    otType: 'REGULAR',
    isDoubleOtDay: false,
    regularRate: 1.5,
    lateRate: 1.5,
    doubleRate: 2,
    doubleLateRate: 2,
    policyId: 'pol-1',
    policyName: 'Projects Ops',
  },
} as never;

/** What the server answers once the window is stretched past 22:00. */
const CORRECTED_PREVIEW = {
  hours: 5,
  regularHours: 4,
  lateHours: 1,
  doubleHours: 0,
  doubleLateHours: 0,
  dayType: 'WEEKDAY',
  foodAllowance: 150,
  otType: 'LATE',
  isDoubleOtDay: false,
  regularRate: 1.5,
  lateRate: 1.5,
  doubleRate: 2,
  doubleLateRate: 2,
  policyId: 'pol-1',
  policyName: 'Projects Ops',
};

const onApprove = vi.fn();
const onReject = vi.fn();
const onClose = vi.fn();

const renderModal = (overrides: Record<string, unknown> = {}, branding = BRANDING) =>
  renderWithProviders(
    <OvertimeReviewModal
      request={{ ...(REQUEST as object), ...overrides } as never}
      onClose={onClose}
      onApprove={onApprove}
      onReject={onReject}
    />,
    { role: 'EMPLOYEE', branding },
  );

const el = (testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  onApprove.mockResolvedValue(undefined);
  onReject.mockResolvedValue(undefined);
  vi.mocked(approvalWorkflowService.trail).mockResolvedValue({
    success: true,
    data: { engaged: true, canAct: true, activeStep: 1, steps: [
      { stepOrder: 1, approverType: 'SUPERVISOR', status: 'ACTIVE' },
      { stepOrder: 2, approverType: 'HR_MANAGER', status: 'PENDING' },
    ] },
  } as never);
  vi.mocked(overtimeService.editPreview).mockResolvedValue({
    success: true,
    data: CORRECTED_PREVIEW,
  } as never);
});

describe('what the approver is shown', () => {
  it('shows the worked window, the hours and both allowances', async () => {
    renderModal();

    // The whole point: the card only ever said "date · Nh".
    expect(el('ot-review-window').textContent).toContain('18:00');
    expect(el('ot-review-window').textContent).toContain('20:00');
    expect(el('ot-review-hours').getAttribute('data-hours')).toBe('2');
    expect(el('ot-review-breakdown').getAttribute('data-food-allowance')).toBe('0');
    expect(el('ot-review-breakdown').getAttribute('data-site-allowance')).toBe('0');
    expect(el('ot-review-breakdown').getAttribute('data-ot-type')).toBe('REGULAR');
  });

  it('renders the window in UTC wall-clock, not the browser timezone', () => {
    renderModal();
    // A tz-shifted read would show 23:30 in IST — the classic "time drifts
    // after submit" bug these stamps are stored UTC-naive to avoid.
    expect((el('ot-review-start') as HTMLInputElement).value).toBe('18:00');
    expect((el('ot-review-end') as HTMLInputElement).value).toBe('20:00');
  });

  it('shows the approval trail', async () => {
    renderModal();
    await waitFor(() => expect(el('ot-review-trail')).toBeInTheDocument());
    expect(
      document.querySelectorAll('[data-testid="ot-review-trail-step"]'),
    ).toHaveLength(2);
  });

  it('names the employee’s original window once a correction has been made', () => {
    renderModal({
      originalStartTime: '2026-08-20T18:00:00.000Z',
      originalEndTime: '2026-08-20T20:00:00.000Z',
      endTime: '2026-08-20T23:00:00.000Z',
    });
    expect(el('ot-review-original').textContent).toContain('18:00');
    expect(el('ot-review-original').textContent).toContain('20:00');
  });
});

describe('correcting the window', () => {
  it('prices the correction on the server and shows the retiering', async () => {
    const { user } = renderModal();

    await user.clear(el('ot-review-end'));
    await user.type(el('ot-review-end'), '23:00');

    await waitFor(() =>
      expect(overtimeService.editPreview).toHaveBeenCalledWith('ot-1', {
        endTime: '2026-08-20T23:00:00.000Z',
      }),
    );
    await waitFor(() =>
      expect(el('ot-review-breakdown').getAttribute('data-ot-type')).toBe('LATE'),
    );
    // The food allowance the employee could not have earned at 20:00.
    expect(el('ot-review-breakdown').getAttribute('data-food-allowance')).toBe('150');
    expect(el('ot-review-hours').getAttribute('data-hours')).toBe('5');
  });

  it('anchors a corrected end time to the START date, so overnight still works', async () => {
    const { user } = renderModal();

    await user.clear(el('ot-review-end'));
    await user.type(el('ot-review-end'), '01:00');

    // 01:00 on the SAME calendar day. The server reads an end at or before the
    // start as crossing midnight; anchoring to the end's own day would run the
    // window backwards.
    await waitFor(() =>
      expect(overtimeService.editPreview).toHaveBeenCalledWith('ot-1', {
        endTime: '2026-08-20T01:00:00.000Z',
      }),
    );
  });

  it('surfaces a server refusal without losing the typed correction', async () => {
    vi.mocked(overtimeService.editPreview).mockRejectedValue({
      message: 'Daily overtime limit exceeded (4h). Corrected to: 6h',
    } as never);
    const { user } = renderModal();

    await user.clear(el('ot-review-end'));
    await user.type(el('ot-review-end'), '23:59');

    await waitFor(() => expect(el('ot-review-preview-error')).toBeInTheDocument());
    expect(el('ot-review-preview-error').textContent).toContain(
      'Daily overtime limit exceeded',
    );
    expect((el('ot-review-end') as HTMLInputElement).value).toBe('23:59');
  });
});

describe('what gets sent on approve', () => {
  it('sends only the concurrency stamp when nothing was changed', async () => {
    const { user } = renderModal();
    await user.click(el('ot-review-approve'));

    expect(onApprove).toHaveBeenCalledWith({
      expectedUpdatedAt: '2026-08-20T11:00:00.000Z',
    });
  });

  it('sends the corrected window and the site allowance', async () => {
    const { user } = renderModal();

    await user.clear(el('ot-review-end'));
    await user.type(el('ot-review-end'), '23:00');
    await user.click(el('ot-review-site-toggle'));
    await user.type(el('ot-review-site-amount'), '25');
    await user.type(el('ot-review-site-note'), 'Offshore rig');
    await user.click(el('ot-review-approve'));

    expect(onApprove).toHaveBeenCalledWith({
      endTime: '2026-08-20T23:00:00.000Z',
      siteAllowance: 25,
      siteAllowanceNote: 'Offshore rig',
      expectedUpdatedAt: '2026-08-20T11:00:00.000Z',
    });
  });

  it('sends a food allowance of 0 as a real instruction, not as "unset"', async () => {
    const { user } = renderModal();

    await user.clear(el('ot-review-end'));
    await user.type(el('ot-review-end'), '23:00');
    await waitFor(() =>
      expect(el('ot-review-breakdown').getAttribute('data-food-allowance')).toBe('150'),
    );

    await user.click(el('ot-review-food-toggle'));
    await user.clear(el('ot-review-food'));
    await user.type(el('ot-review-food'), '0');
    await user.click(el('ot-review-approve'));

    const payload = onApprove.mock.calls.at(-1)![0];
    expect(payload.foodAllowance).toBe(0);
  });

  it('keeps the modal open and shows the refusal when approve fails', async () => {
    onApprove.mockRejectedValue({ message: 'You are not an eligible approver' } as never);
    const { user } = renderModal();

    await user.click(el('ot-review-approve'));

    await waitFor(() => expect(el('ot-review-error')).toBeInTheDocument());
    expect(el('ot-review-error').textContent).toContain('not an eligible approver');
    expect(el('ot-review-modal')).toBeInTheDocument();
  });
});

describe('the site allowance ceiling', () => {
  it('refuses an amount over the maximum before it reaches the server', async () => {
    const { user } = renderModal();

    await user.click(el('ot-review-site-toggle'));
    await user.type(el('ot-review-site-amount'), '250');

    await waitFor(() => expect(el('ot-review-site-error')).toBeInTheDocument());
    expect((el('ot-review-approve') as HTMLButtonElement).disabled).toBe(true);

    await user.click(el('ot-review-approve'));
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('treats a maximum of 0 as no ceiling', async () => {
    const { user } = renderModal({}, {
      ...(BRANDING as object),
      overtime_site_allowance_max: '0',
    } as never);

    await user.click(el('ot-review-site-toggle'));
    await user.type(el('ot-review-site-amount'), '5000');

    expect(el('ot-review-site-error')).toBeNull();
    expect((el('ot-review-approve') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('the kill switches', () => {
  it('hides every editor when approver edit is off', () => {
    renderModal({}, {
      ...(BRANDING as object),
      overtime_approver_edit_enabled: false,
    } as never);

    // Still a full review — just not an editable one.
    expect(el('ot-review-window')).toBeInTheDocument();
    expect(el('ot-review-breakdown')).toBeInTheDocument();
    expect(el('ot-review-start')).toBeNull();
    expect(el('ot-review-site-toggle')).toBeNull();
  });

  it('hides only the site allowance when that switch alone is off', () => {
    renderModal({}, {
      ...(BRANDING as object),
      overtime_site_allowance_enabled: false,
    } as never);

    expect(el('ot-review-start')).toBeInTheDocument();
    expect(el('ot-review-site-toggle')).toBeNull();
  });
});

describe('rejecting from the review screen', () => {
  it('requires a reason and then passes it through', async () => {
    const { user } = renderModal();

    await user.click(el('ot-review-reject-open'));
    await user.click(el('ot-review-reject-confirm'));
    expect(onReject).not.toHaveBeenCalled();

    await user.type(el('ot-review-reject-reason'), 'No PM request on file');
    await user.click(el('ot-review-reject-confirm'));
    expect(onReject).toHaveBeenCalledWith('No PM request on file');
  });
});

describe('the wall-clock helpers', () => {
  it('round-trips a time through the input and back', () => {
    const iso = '2026-08-20T18:30:00.000Z';
    expect(toTimeInput(iso)).toBe('18:30');
    expect(fromTimeInput(iso, '18:30')).toBe(iso);
  });

  it('anchors to the given date, never to the input', () => {
    expect(fromTimeInput('2026-08-20T18:00:00.000Z', '02:15')).toBe(
      '2026-08-20T02:15:00.000Z',
    );
  });

  it('returns empty for a missing or unparseable stamp', () => {
    expect(toTimeInput(undefined)).toBe('');
    expect(toTimeInput('not-a-date')).toBe('');
  });
});
