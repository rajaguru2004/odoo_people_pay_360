import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, waitFor } from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import OvertimeDetailPage from './page';

/**
 * The overtime detail screen, and the number it has to get right.
 *
 * The figures on this page are what an approver decides on, so they must be the
 * server's: it resolves the employee's overtime policy and the branch-aware
 * rest-day classification, and it is what approval persists. A breakdown worked
 * out in the browser from company-wide settings disagrees with the list and
 * with the payslip the moment a policy overrides anything — which is why the
 * page reads `preview` and never recomputes.
 */

vi.mock('@/services/overtimeService', () => ({
  default: { getById: vi.fn(), approve: vi.fn(), reject: vi.fn(), cancel: vi.fn() },
}));

vi.mock('@/services/approvalWorkflowService', () => ({
  default: { trail: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import overtimeService from '@/services/overtimeService';
import approvalWorkflowService from '@/services/approvalWorkflowService';

const REQUEST = {
  id: 'ot-1',
  employeeId: 'emp-1',
  date: '2026-08-18T00:00:00.000Z',
  startTime: '2026-08-18T17:30:00.000Z',
  endTime: '2026-08-18T22:00:00.000Z',
  hours: 4.5,
  regularHours: 3.5,
  lateHours: 1,
  doubleHours: 0,
  foodAllowance: 4,
  otType: 'LATE',
  reason: 'Line shutdown recovery',
  status: 'PENDING',
  createdAt: '2026-08-18T13:21:43.000Z',
  updatedAt: '2026-08-18T13:21:43.000Z',
  employee: {
    id: 'emp-1',
    employeeCode: 'E-002',
    fullName: 'Jameen Raj',
    email: 'jameen@example.com',
    baseSalary: 27,
    branchId: 'br-ho',
  },
};

/** What the server computed under this employee's policy. */
const SERVER_PREVIEW = {
  hours: 4.5,
  regularHours: 3.5,
  lateHours: 1,
  doubleHours: 0,
  doubleLateHours: 0,
  dayType: 'WEEKDAY',
  foodAllowance: 4,
  otType: 'LATE',
  isDoubleOtDay: false,
  regularRate: 1.5,
  lateRate: 1.5,
  doubleRate: 2,
  doubleLateRate: 2.5,
  policyId: 'pol-1',
  policyName: 'Projects Ops',
};

/**
 * `use(params)` suspends on a pending promise. A fulfilled thenable — the shape
 * React caches internally — lets the page render without a Suspense boundary it
 * does not have.
 */
const resolvedParams = (id: string) => {
  const thenable = Promise.resolve({ id }) as Promise<{ id: string }> & {
    status?: string;
    value?: { id: string };
  };
  thenable.status = 'fulfilled';
  thenable.value = { id };
  return thenable;
};

const breakdown = () =>
  document.querySelector('[data-testid="ot-breakdown"]') as HTMLElement | null;

const tiers = () =>
  Array.from(document.querySelectorAll('[data-testid="ot-breakdown-tier"]')).map((el) => [
    el.getAttribute('data-tier'),
    el.getAttribute('data-hours'),
  ]);

const renderDetail = () =>
  renderWithProviders(<OvertimeDetailPage params={resolvedParams('ot-1')} />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(approvalWorkflowService.trail).mockResolvedValue({
    success: true,
    data: { engaged: false, canAct: false, activeStep: null, steps: [] },
  } as never);

  useAuthStore.setState({
    user: {
      id: 'u-1',
      email: 'admin@example.com',
      role: 'ADMIN',
      isActive: true,
      employeeId: 'emp-9',
    },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });
});

describe('the payable breakdown', () => {
  it('shows the allowance and the type the server computed', async () => {
    vi.mocked(overtimeService.getById).mockResolvedValue({
      success: true,
      data: { ...REQUEST, preview: SERVER_PREVIEW },
    } as never);

    renderDetail();
    await waitFor(() => expect(breakdown()).toBeInTheDocument());

    expect(breakdown()?.getAttribute('data-food-allowance')).toBe('4');
    expect(breakdown()?.getAttribute('data-ot-type')).toBe('LATE');
    expect(breakdown()?.textContent).toContain('Projects Ops');
  });

  it('splits the hours across the tiers the server reported', async () => {
    vi.mocked(overtimeService.getById).mockResolvedValue({
      success: true,
      data: { ...REQUEST, preview: SERVER_PREVIEW },
    } as never);

    renderDetail();
    await waitFor(() => expect(breakdown()).toBeInTheDocument());

    expect(tiers()).toEqual([
      ['regular', '3.5'],
      ['late', '1'],
    ]);
    expect(breakdown()?.getAttribute('data-total-hours')).toBe('4.5');
  });

  it("folds a double day's post-threshold hours into the late row at their own multiplier", async () => {
    vi.mocked(overtimeService.getById).mockResolvedValue({
      success: true,
      data: {
        ...REQUEST,
        otType: 'DOUBLE_LATE',
        preview: {
          ...SERVER_PREVIEW,
          dayType: 'SUNDAY',
          isDoubleOtDay: true,
          otType: 'DOUBLE_LATE',
          regularHours: 0,
          lateHours: 0,
          doubleHours: 3.5,
          doubleLateHours: 1,
          doubleRate: 2,
          doubleLateRate: 2.5,
        },
      },
    } as never);

    renderDetail();
    await waitFor(() => expect(breakdown()).toBeInTheDocument());

    expect(tiers()).toEqual([
      ['late', '1'],
      ['double', '3.5'],
    ]);
    // The late row carries the double-late multiplier, because that is the
    // bucket the hours actually came from.
    expect(breakdown()?.textContent).toContain('×2.5');
  });

  it('falls back to the row as stored when the payload carries no preview', async () => {
    // Not a local recompute: the browser cannot see the policy, so the persisted
    // columns are the closest thing to the truth it has.
    vi.mocked(overtimeService.getById).mockResolvedValue({
      success: true,
      data: { ...REQUEST },
    } as never);

    renderDetail();
    await waitFor(() => expect(breakdown()).toBeInTheDocument());

    expect(breakdown()?.getAttribute('data-ot-type')).toBe('LATE');
    expect(breakdown()?.getAttribute('data-food-allowance')).toBe('4');
    expect(tiers()).toEqual([
      ['regular', '3.5'],
      ['late', '1'],
    ]);
  });
});

describe('who may decide', () => {
  it('offers the decision to an approver named on the live step, whatever their role', async () => {
    // A supervisor holds the EMPLOYEE role. Gating on the role would refuse a
    // decision the engine is about to authorise.
    useAuthStore.setState({
      user: {
        id: 'u-2',
        email: 'lead@example.com',
        role: 'EMPLOYEE',
        isActive: true,
        employeeId: 'emp-7',
      },
      isAuthenticated: true,
      isLoading: false,
      hasHydrated: true,
    });
    vi.mocked(approvalWorkflowService.trail).mockResolvedValue({
      success: true,
      data: {
        engaged: true,
        canAct: true,
        activeStep: 1,
        steps: [
          {
            id: 's1',
            stepOrder: 1,
            approverType: 'SUPERVISOR',
            status: 'ACTIVE',
            comment: null,
            decidedById: null,
            decidedAt: null,
          },
        ],
      },
    } as never);
    vi.mocked(overtimeService.getById).mockResolvedValue({
      success: true,
      data: { ...REQUEST, preview: SERVER_PREVIEW },
    } as never);

    renderDetail();

    await waitFor(() =>
      expect(document.querySelector('[data-testid="overtime-approve"]')).toBeInTheDocument(),
    );
    expect(document.querySelector('[data-testid="ot-trail-step"]')).toBeInTheDocument();
  });

  it('withholds the decision from someone the chain is not waiting on', async () => {
    vi.mocked(approvalWorkflowService.trail).mockResolvedValue({
      success: true,
      data: {
        engaged: true,
        canAct: false,
        activeStep: 2,
        steps: [
          {
            id: 's1',
            stepOrder: 1,
            approverType: 'SUPERVISOR',
            status: 'APPROVED',
            comment: null,
            decidedById: 'u-3',
            decidedAt: '2026-08-19T09:00:00.000Z',
          },
          {
            id: 's2',
            stepOrder: 2,
            approverType: 'HR_MANAGER',
            status: 'ACTIVE',
            comment: null,
            decidedById: null,
            decidedAt: null,
          },
        ],
      },
    } as never);
    vi.mocked(overtimeService.getById).mockResolvedValue({
      success: true,
      data: { ...REQUEST, preview: SERVER_PREVIEW },
    } as never);

    renderDetail();
    await waitFor(() => expect(breakdown()).toBeInTheDocument());

    // An ADMIN who is not the live approver still gets no button: a dead
    // control is worse than no control.
    expect(document.querySelector('[data-testid="overtime-approve"]')).toBeNull();
    expect(document.querySelector('[data-testid="ot-trail-waiting"]')).toBeInTheDocument();
  });
});
