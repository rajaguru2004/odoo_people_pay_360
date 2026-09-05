import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, waitFor } from '@/test/render';
import ApprovalsPage from './page';

/**
 * The supervisor inbox.
 *
 * The card used to offer only Approve / Reject against a one-line summary, so a
 * supervisor decided on `date · Nh` with no sight of the window worked or the
 * allowances at stake. These pin the two things that fixed:
 *
 *   1. Overtime cards open a full review; other kinds keep the one-click
 *      actions they have always had, because nothing else has a review screen.
 *   2. The decision still runs through the kind registry, so the card's fast
 *      path and the modal cannot drift into two different approve calls.
 */

vi.mock('@/services/approvalWorkflowService', () => ({
  default: { inbox: vi.fn(), history: vi.fn(), trail: vi.fn() },
}));

vi.mock('@/services/overtimeService', () => ({
  default: { approve: vi.fn(), reject: vi.fn(), editPreview: vi.fn() },
}));

vi.mock('@/services/leaveService', () => ({
  default: { approve: vi.fn(), reject: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import approvalWorkflowService from '@/services/approvalWorkflowService';
import overtimeService from '@/services/overtimeService';

const BRANDING = {
  overtime_approver_edit_enabled: true,
  overtime_site_allowance_enabled: true,
  overtime_site_allowance_max: '0',
} as never;

const OT_ITEM = {
  requestType: 'OVERTIME',
  requestId: 'ot-1',
  stepOrder: 1,
  approverType: 'SUPERVISOR',
  request: {
    id: 'ot-1',
    date: '2026-08-20T00:00:00.000Z',
    startTime: '2026-08-20T18:00:00.000Z',
    endTime: '2026-08-20T20:00:00.000Z',
    hours: 2,
    foodAllowance: 0,
    siteAllowance: 0,
    otType: 'REGULAR',
    reason: 'Client cutover',
    status: 'PENDING',
    updatedAt: '2026-08-20T11:00:00.000Z',
    employee: {
      id: 'emp-1',
      employeeCode: 'TRS-POD-002',
      fullName: 'JAMEENRAJ MATHIYAZHAGAN',
      department: { id: 'd1', name: 'Projects Operation Department' },
    },
  },
};

const LEAVE_ITEM = {
  requestType: 'LEAVE',
  requestId: 'lv-1',
  stepOrder: 1,
  approverType: 'SUPERVISOR',
  request: {
    id: 'lv-1',
    leaveType: 'Annual Leave',
    startDate: '2026-09-01T00:00:00.000Z',
    endDate: '2026-09-03T00:00:00.000Z',
    totalDays: 3,
    employee: { id: 'emp-2', employeeCode: 'E-2', fullName: 'Priya R' },
  },
};

const el = (testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
const all = (testId: string) =>
  Array.from(document.querySelectorAll(`[data-testid="${testId}"]`));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(approvalWorkflowService.trail).mockResolvedValue({
    success: true,
    data: { engaged: false, canAct: false, activeStep: null, steps: [] },
  } as never);
  vi.mocked(overtimeService.approve).mockResolvedValue({ success: true } as never);
  vi.mocked(overtimeService.editPreview).mockResolvedValue({
    success: true,
    data: null,
  } as never);
});

const renderInbox = (items: unknown[], decided: unknown[] = []) => {
  vi.mocked(approvalWorkflowService.inbox).mockResolvedValue({
    success: true,
    data: items,
  } as never);
  vi.mocked(approvalWorkflowService.history).mockResolvedValue({
    success: true,
    data: decided,
  } as never);
  return renderWithProviders(<ApprovalsPage />, {
    role: 'EMPLOYEE',
    branding: BRANDING,
  });
};

/** A row this user has already settled. */
const DECIDED_ITEM = {
  ...OT_ITEM,
  requestId: 'ot-9',
  decision: 'APPROVED',
  decidedAt: '2026-08-20T12:00:00.000Z',
  comment: null,
  request: { ...OT_ITEM.request, id: 'ot-9', status: 'APPROVED', siteAllowance: '25' },
};

describe('the inbox card', () => {
  it('shows the worked window and an allowance chip on an overtime card', async () => {
    renderInbox([{ ...OT_ITEM, request: { ...OT_ITEM.request, foodAllowance: 150 } }]);

    await waitFor(() => expect(el('approval-row')).toBeInTheDocument());
    const row = el('approval-row');
    expect(row.textContent).toContain('18:00');
    expect(row.textContent).toContain('20:00');
    expect(row.textContent).toContain('allowance');
  });

  it('offers a review only for kinds that have one', async () => {
    renderInbox([OT_ITEM, LEAVE_ITEM]);

    await waitFor(() => expect(all('approval-row')).toHaveLength(2));
    // Overtime is reviewable; leave is not, and must keep its one-click card.
    expect(all('approval-details')).toHaveLength(1);
    expect(all('approval-approve')).toHaveLength(2);
  });
});

describe('the review modal', () => {
  it('opens on View details and carries the request into it', async () => {
    const { user } = renderInbox([OT_ITEM]);
    await waitFor(() => expect(el('approval-details')).toBeInTheDocument());

    await user.click(el('approval-details'));

    await waitFor(() => expect(el('ot-review-modal')).toBeInTheDocument());
    expect(el('ot-review-modal').getAttribute('data-request-id')).toBe('ot-1');
    expect((el('ot-review-start') as HTMLInputElement).value).toBe('18:00');
  });

  it('approves through the kind registry, with the corrections attached', async () => {
    const { user } = renderInbox([OT_ITEM]);
    await waitFor(() => expect(el('approval-details')).toBeInTheDocument());

    await user.click(el('approval-details'));
    await waitFor(() => expect(el('ot-review-site-toggle')).toBeInTheDocument());
    await user.click(el('ot-review-site-toggle'));
    await user.type(el('ot-review-site-amount'), '25');
    await user.click(el('ot-review-approve'));

    await waitFor(() =>
      expect(overtimeService.approve).toHaveBeenCalledWith('ot-1', {
        siteAllowance: 25,
        expectedUpdatedAt: '2026-08-20T11:00:00.000Z',
      }),
    );
    // Closed and reloaded on success.
    await waitFor(() => expect(el('ot-review-modal')).toBeNull());
    expect(approvalWorkflowService.inbox).toHaveBeenCalledTimes(2);
  });

  it('leaves the card’s fast path bodyless', async () => {
    const { user } = renderInbox([OT_ITEM]);
    await waitFor(() => expect(el('approval-approve')).toBeInTheDocument());

    await user.click(el('approval-approve'));

    await waitFor(() =>
      expect(overtimeService.approve).toHaveBeenCalledWith('ot-1', undefined),
    );
  });

  it('stays open when the server refuses the decision', async () => {
    vi.mocked(overtimeService.approve).mockRejectedValue({
      response: { data: { message: 'Site allowance is disabled' } },
    } as never);
    const { user } = renderInbox([OT_ITEM]);
    await waitFor(() => expect(el('approval-details')).toBeInTheDocument());

    await user.click(el('approval-details'));
    await waitFor(() => expect(el('ot-review-approve')).toBeInTheDocument());
    await user.click(el('ot-review-approve'));

    await waitFor(() => expect(el('ot-review-error')).toBeInTheDocument());
    expect(el('ot-review-modal')).toBeInTheDocument();
  });
});

describe('the record of what this user decided', () => {
  it('keeps a decided request visible instead of letting it vanish', async () => {
    // The defect: approving removed the card outright, so an approver could not
    // see what they had decided, nor the correction they made on the way.
    const { user } = renderInbox([], [DECIDED_ITEM]);
    await waitFor(() => expect(el('approval-empty')).toBeInTheDocument());

    await user.click(el('approval-tab-decided'));

    await waitFor(() => expect(el('approval-row')).toBeInTheDocument());
    expect(el('approval-decision').getAttribute('data-decision')).toBe('APPROVED');
    expect(el('approval-decision').textContent).toContain('You approved');
    expect(el('approval-decided-at').textContent).toContain('Decided');
  });

  it('offers no decision controls on a settled row', async () => {
    const { user } = renderInbox([], [DECIDED_ITEM]);
    await waitFor(() => expect(el('approval-tab-decided')).toBeInTheDocument());
    await user.click(el('approval-tab-decided'));
    await waitFor(() => expect(el('approval-row')).toBeInTheDocument());

    // The server refuses a decision on a settled request; a dead button is
    // worse than no button.
    expect(el('approval-approve')).toBeNull();
    expect(el('approval-reject-open')).toBeNull();
    // The full request is still reachable — it holds the corrections made.
    expect(el('approval-details')).toBeInTheDocument();
  });

  it('reads an empty record differently from an empty queue', async () => {
    const { user } = renderInbox([], []);
    await waitFor(() => expect(el('approval-empty')).toBeInTheDocument());
    expect(el('approval-empty').textContent).toContain('No pending approvals');

    await user.click(el('approval-tab-decided'));

    await waitFor(() => expect(el('approval-decided-empty')).toBeInTheDocument());
    expect(el('approval-decided-empty').textContent).toContain('Nothing decided yet');
  });

  it('asks the history endpoint, not the inbox, on the record tab', async () => {
    const { user } = renderInbox([OT_ITEM], [DECIDED_ITEM]);
    await waitFor(() => expect(el('approval-row')).toBeInTheDocument());

    await user.click(el('approval-tab-decided'));

    await waitFor(() =>
      expect(approvalWorkflowService.history).toHaveBeenCalled(),
    );
  });
});
