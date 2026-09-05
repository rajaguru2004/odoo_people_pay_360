import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, waitFor } from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import ApprovalsPage from './page';

/**
 * The approver's inbox.
 *
 * Two things it has to keep straight. Each card must go to the module that owns
 * the request — an overtime decision prices a claim and a leave decision moves
 * a balance, and a card wired to the wrong one settles neither. And a row must
 * not simply vanish when it is acted on: the queue drops it the instant a
 * decision lands, so without the record tab an approver has no way to see what
 * they decided.
 */

vi.mock('@/services/approvalWorkflowService', () => ({
  default: { inbox: vi.fn(), history: vi.fn(), trail: vi.fn(), kinds: vi.fn() },
}));

vi.mock('@/services/overtimeService', () => ({
  default: { approve: vi.fn(), reject: vi.fn() },
}));

vi.mock('@/services/leaveService', () => ({
  default: { approve: vi.fn(), reject: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import approvalWorkflowService from '@/services/approvalWorkflowService';
import overtimeService from '@/services/overtimeService';
import leaveService from '@/services/leaveService';

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
    reason: 'Client cutover',
    employee: {
      id: 'emp-1',
      employeeCode: 'E-002',
      fullName: 'Jameen Raj',
      department: { id: 'd1', name: 'Projects Operations' },
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
    employee: { id: 'emp-2', employeeCode: 'E-003', fullName: 'Priya R' },
  },
};

/** A row this user has already settled. */
const DECIDED_ITEM = {
  ...OT_ITEM,
  requestId: 'ot-9',
  decision: 'APPROVED',
  decidedAt: '2026-08-20T12:00:00.000Z',
  comment: null,
  request: { ...OT_ITEM.request, id: 'ot-9', siteAllowance: '25' },
};

const el = (testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
const all = (testId: string) =>
  Array.from(document.querySelectorAll(`[data-testid="${testId}"]`));

function renderInbox(pending: unknown[], decided: unknown[] = []) {
  vi.mocked(approvalWorkflowService.inbox).mockResolvedValue({
    success: true,
    data: pending,
  } as never);
  vi.mocked(approvalWorkflowService.history).mockResolvedValue({
    success: true,
    data: decided,
  } as never);
  return {
    user: userEvent.setup(),
    ...renderWithProviders(<ApprovalsPage />),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(overtimeService.approve).mockResolvedValue({ success: true } as never);
  vi.mocked(overtimeService.reject).mockResolvedValue({ success: true } as never);
  vi.mocked(leaveService.approve).mockResolvedValue({ success: true } as never);

  // A supervisor holds the EMPLOYEE role — the chain, not the role, is what
  // put these rows in front of them.
  useAuthStore.setState({
    user: {
      id: 'u-1',
      email: 'lead@example.com',
      role: 'EMPLOYEE',
      isActive: true,
      employeeId: 'emp-7',
    },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });
});

describe('the inbox card', () => {
  it('shows the worked window and an allowance chip on an overtime card', async () => {
    renderInbox([
      { ...OT_ITEM, request: { ...OT_ITEM.request, foodAllowance: 150 } },
    ]);

    await waitFor(() => expect(el('approval-row')).toBeInTheDocument());
    const row = el('approval-row')!;
    // Read in UTC: these instants are wall-clock tagged Z, and a local-zone
    // parse would show a different pair of hours to different viewers.
    expect(row.textContent).toContain('18:00');
    expect(row.textContent).toContain('20:00');
    expect(row.textContent).toContain('allowance');
  });

  it('links to the record only for a kind that has a screen here', async () => {
    renderInbox([OT_ITEM, LEAVE_ITEM]);

    await waitFor(() => expect(all('approval-row')).toHaveLength(2));
    expect(all('approval-details')).toHaveLength(1);
    expect(all('approval-details')[0].getAttribute('href')).toBe('/dashboard/overtime/ot-1');
    // Both are still decidable from the card itself.
    expect(all('approval-approve')).toHaveLength(2);
  });
});

describe('where a decision goes', () => {
  it('approves an overtime request through the overtime module', async () => {
    const { user } = renderInbox([OT_ITEM]);
    await waitFor(() => expect(el('approval-approve')).toBeInTheDocument());

    await user.click(el('approval-approve')!);

    await waitFor(() => expect(overtimeService.approve).toHaveBeenCalledWith('ot-1'));
    expect(leaveService.approve).not.toHaveBeenCalled();
  });

  it('approves a leave request through the leave module', async () => {
    const { user } = renderInbox([LEAVE_ITEM]);
    await waitFor(() => expect(el('approval-approve')).toBeInTheDocument());

    await user.click(el('approval-approve')!);

    await waitFor(() => expect(leaveService.approve).toHaveBeenCalledWith('lv-1'));
    expect(overtimeService.approve).not.toHaveBeenCalled();
  });

  it('will not send a rejection without a reason', async () => {
    const { user } = renderInbox([OT_ITEM]);
    await waitFor(() => expect(el('approval-reject-open')).toBeInTheDocument());

    await user.click(el('approval-reject-open')!);
    await waitFor(() => expect(el('approval-reject-reason')).toBeInTheDocument());
    await user.click(el('approval-reject-confirm')!);

    expect(overtimeService.reject).not.toHaveBeenCalled();
  });

  it('carries the typed reason into the rejection', async () => {
    const { user } = renderInbox([OT_ITEM]);
    await waitFor(() => expect(el('approval-reject-open')).toBeInTheDocument());

    await user.click(el('approval-reject-open')!);
    await user.type(el('approval-reject-reason')!, 'Already covered by the roster');
    await user.click(el('approval-reject-confirm')!);

    await waitFor(() =>
      expect(overtimeService.reject).toHaveBeenCalledWith('ot-1', {
        rejectedReason: 'Already covered by the roster',
      }),
    );
  });
});

describe('the record of what this user decided', () => {
  it('keeps a decided request visible instead of letting it vanish', async () => {
    const { user } = renderInbox([], [DECIDED_ITEM]);
    await waitFor(() => expect(el('approval-empty')).toBeInTheDocument());

    await user.click(el('approval-tab-decided')!);

    await waitFor(() => expect(el('approval-row')).toBeInTheDocument());
    expect(el('approval-decision')?.getAttribute('data-decision')).toBe('APPROVED');
    expect(el('approval-decision')?.textContent).toContain('You approved');
    expect(el('approval-decided-at')?.textContent).toContain('Decided');
  });

  it('offers no decision controls on a settled row', async () => {
    const { user } = renderInbox([], [DECIDED_ITEM]);
    await waitFor(() => expect(el('approval-tab-decided')).toBeInTheDocument());
    await user.click(el('approval-tab-decided')!);
    await waitFor(() => expect(el('approval-row')).toBeInTheDocument());

    // The server refuses a second decision; a dead button is worse than none.
    expect(el('approval-approve')).toBeNull();
    expect(el('approval-reject-open')).toBeNull();
    // The record itself stays reachable.
    expect(el('approval-details')).toBeInTheDocument();
  });

  it('reads an empty record differently from an empty queue', async () => {
    const { user } = renderInbox([], []);
    await waitFor(() => expect(el('approval-empty')).toBeInTheDocument());
    expect(el('approval-empty')?.textContent).toContain('No pending approvals');

    await user.click(el('approval-tab-decided')!);

    await waitFor(() => expect(el('approval-decided-empty')).toBeInTheDocument());
    expect(el('approval-decided-empty')?.textContent).toContain('Nothing decided yet');
  });

  it('asks the history endpoint, not the inbox, on the record tab', async () => {
    const { user } = renderInbox([OT_ITEM], [DECIDED_ITEM]);
    await waitFor(() => expect(el('approval-row')).toBeInTheDocument());

    await user.click(el('approval-tab-decided')!);

    await waitFor(() => expect(approvalWorkflowService.history).toHaveBeenCalled());
  });
});
