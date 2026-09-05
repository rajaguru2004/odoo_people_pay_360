import { describe, expect, it, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import LeaveOvertimeHubPage from './page';
import type { LeaveHubSummary } from '@/types/leaveHub';

/**
 * The Leave & Overtime hub.
 *
 * The page used to be five KPIs and two meter lists with no period selector at
 * all — its "OT hours" card was permanently the current calendar month whatever
 * else was on screen, because the endpoint behind it took a month and nothing
 * else. Rebuilt on the Time & Attendance template, the properties worth pinning
 * are:
 *
 *  1. **The KPI row changes MEANING with the period**, not just its numbers. A
 *     week wants "leave days: 12"; a year wants utilisation, because 4,180
 *     employee-days is not a number anybody can hold.
 *  2. **Pending approvals does NOT move with the period.** A queue is what is
 *     waiting now.
 *  3. `overtime_enabled` off swaps the overtime card and panel for their
 *     stand-ins rather than drawing zeros, which would say "nobody worked late".
 *  4. A rate with nothing to divide by prints as an em dash, never 0%.
 */

vi.mock('@/services/leaveService', () => ({
  default: { getHubSummary: vi.fn() },
}));

import leaveService from '@/services/leaveService';

const getHubSummary = vi.mocked(leaveService.getHubSummary);

function hub(overrides: Partial<LeaveHubSummary> = {}): LeaveHubSummary {
  return {
    period: 'month',
    anchor: '2026-08-15',
    range: {
      start: '2026-08-01',
      end: '2026-08-31',
      through: '2026-08-15',
      label: 'Aug 2026',
      prevAnchor: '2026-07-01',
      nextAnchor: '2026-09-01',
      hasNext: true,
      isCurrent: true,
    },
    periodStats: {
      requests: 42,
      approved: 30,
      pending: 7,
      rejected: 4,
      cancelled: 1,
      approvalRate: 71.4,
      leaveDays: 96,
      onLeaveToday: 18,
      activeHeadcount: 246,
      onLeaveTodayRate: 7.3,
      pendingOlderThan2Days: 3,
      allocated: 1780,
      carriedOver: 20,
      used: 516,
      remaining: 1284,
      utilisation: 28.7,
      averageBalance: 5.2,
      overtimeHours: 326,
      overtimeRequests: 55,
      overtimeEmployees: 24,
      avgOvertimePerEmployee: 13.6,
      topLeaveType: 'Annual Leave',
    },
    previousStats: {
      requests: 39,
      approved: 28,
      pending: 5,
      rejected: 5,
      cancelled: 1,
      approvalRate: 71.8,
      leaveDays: 88,
      onLeaveToday: 12,
      activeHeadcount: 246,
      onLeaveTodayRate: 4.9,
      pendingOlderThan2Days: 0,
      allocated: 1780,
      carriedOver: 20,
      used: 420,
      remaining: 1380,
      utilisation: 23.3,
      averageBalance: 5.6,
      overtimeHours: 291,
      overtimeRequests: 48,
      overtimeEmployees: 22,
      avgOvertimePerEmployee: 13.2,
      topLeaveType: 'Annual Leave',
    },
    previousRange: { start: '2026-07-01', end: '2026-07-31', label: 'Jul 2026' },
    trendKind: 'day',
    trend: [
      { key: '2026-08-03', label: 'Aug 3', approved: 5, pending: 2, rejected: 1, cancelled: 0, total: 8 },
      { key: '2026-08-04', label: 'Aug 4', approved: 3, pending: 1, rejected: 0, cancelled: 1, total: 5 },
    ],
    leaveTypes: [
      { key: 'Annual Leave', name: 'Annual Leave', requests: 24, days: 52, share: 54.2 },
      { key: 'Sick Leave', name: 'Sick Leave', requests: 12, days: 28, share: 29.2 },
    ],
    status: { approved: 30, pending: 7, rejected: 4, cancelled: 1 },
    balance: {
      allocated: 1780,
      carriedOver: 20,
      used: 516,
      remaining: 1284,
      utilisation: 28.7,
      byType: [],
    },
    overtime: {
      enabled: true,
      totalHours: 326,
      trend: [
        { key: '2026-08-03', label: 'Aug 3', hours: 40 },
        { key: '2026-08-04', label: 'Aug 4', hours: 62 },
      ],
      byDepartment: [{ id: 'd1', name: 'Operations', hours: 86 }],
      topEmployees: [{ id: 'e1', name: 'Asha Rahman', hours: 24 }],
      topDepartment: { id: 'd1', name: 'Operations', hours: 86 },
      topEmployee: { id: 'e1', name: 'Asha Rahman', hours: 24 },
    },
    attention: {
      pending: { count: 7, names: ['Asha Rahman', 'Karim Said'] },
      stale: { count: 3, names: ['Asha Rahman'] },
      onLeaveToday: { count: 18, names: ['Meera Nair'] },
      highOvertime: { count: 2, names: ['Asha Rahman'] },
    },
    ...overrides,
  };
}

let payload: LeaveHubSummary | Error;

function route() {
  getHubSummary.mockImplementation((period: any, anchor?: string) => {
    if (payload instanceof Error) return Promise.reject(payload) as never;
    return Promise.resolve({
      success: true,
      data: { ...payload, period, anchor: anchor ?? payload.anchor },
    }) as never;
  });
}

const render = () => renderWithProviders(<LeaveOvertimeHubPage />, { role: 'ADMIN' });

/** The five KPI card labels, in row order. */
const kpiLabels = () =>
  [...document.querySelectorAll('a.stat-card')].map(
    (c) => c.querySelector('.text-text-body')?.textContent ?? '',
  );

describe('Leave & Overtime hub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    payload = hub();
    route();
  });

  it('opens on the month, the cycle leave and overtime are read in', async () => {
    render();
    await waitFor(() => expect(getHubSummary).toHaveBeenCalled());
    expect(getHubSummary.mock.calls[0][0]).toBe('month');
    expect(await screen.findByTestId('period-label')).toHaveTextContent('Aug 2026');
  });

  describe('the KPI row changes meaning with the period', () => {
    it('leads a month with requests, utilisation and the remaining balance', async () => {
      render();
      await screen.findByTestId('period-label');
      await waitFor(() => expect(kpiLabels()).toHaveLength(5));
      expect(kpiLabels()).toEqual([
        'Requests this month',
        'Pending approvals',
        'Leave utilisation',
        'Remaining balance',
        'Overtime hours',
      ]);
    });

    it('leads a week with the operational numbers instead', async () => {
      render();
      await screen.findByTestId('period-label');
      await userEvent.click(screen.getByRole('button', { name: 'Week' }));

      await waitFor(() =>
        expect(kpiLabels()).toEqual([
          'Requests this week',
          'Pending approvals',
          'On leave today',
          'Leave days',
          'Overtime this week',
        ]),
      );
    });

    it('leads a year with utilisation rather than a day count nobody can hold', async () => {
      render();
      await screen.findByTestId('period-label');
      await userEvent.click(screen.getByRole('button', { name: 'Year' }));

      await waitFor(() =>
        expect(kpiLabels()).toEqual([
          'Leave consumed',
          'Pending approvals',
          'Leave utilisation',
          'Most-used leave',
          'Average balance',
        ]),
      );
    });

    it('keeps Pending approvals in the same slot on every period', async () => {
      render();
      await screen.findByTestId('period-label');
      await waitFor(() => expect(kpiLabels()[1]).toBe('Pending approvals'));

      for (const tab of ['Week', 'Year', 'Month']) {
        await userEvent.click(screen.getByRole('button', { name: tab }));
        // A queue is what is waiting NOW. "Approvals pending last March" is not
        // a thing anybody acts on, so this card never moves with the window.
        await waitFor(() => expect(kpiLabels()[1]).toBe('Pending approvals'));
      }
    });
  });

  it('judges the pending queue by how long it has waited, not by its size', async () => {
    render();
    // Three waiting a fortnight is a worse state than ten waiting an hour, so
    // the count appears twice on purpose: as the KPI's footnote and as the
    // loudest item in the action strip.
    const seen = await screen.findAllByText('3 waiting more than two days');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const card = seen.map((el) => el.closest('a.stat-card')).find(Boolean);
    expect(card!.textContent).toContain('Pending approvals');
  });

  it('re-asks the server when the period changes, and keeps no anchor', async () => {
    render();
    await screen.findByTestId('period-label');

    await userEvent.click(screen.getByRole('button', { name: 'Year' }));
    await waitFor(() => {
      const last = getHubSummary.mock.calls[getHubSummary.mock.calls.length - 1];
      expect(last[0]).toBe('year');
      expect(last[1]).toBeUndefined();
    });
  });

  it('pages backwards with the anchor the server handed back', async () => {
    render();
    await screen.findByTestId('period-label');

    await userEvent.click(screen.getByRole('button', { name: /previous/i }));
    await waitFor(() => {
      const last = getHubSummary.mock.calls[getHubSummary.mock.calls.length - 1];
      expect(last[1]).toBe('2026-07-01');
    });
  });

  it('stacks the trend by all four statuses, cancelled included', async () => {
    render();
    await screen.findByTestId('period-label');
    await waitFor(() => {
      expect(document.querySelector('[title="Approved: 5"]')).toBeTruthy();
      expect(document.querySelector('[title="Pending: 2"]')).toBeTruthy();
      expect(document.querySelector('[title="Rejected: 1"]')).toBeTruthy();
      // The endpoint this replaced counted only three statuses, so a cancelled
      // request vanished and the donut never summed to its own caption.
      expect(document.querySelector('[title="Cancelled: 1"]')).toBeTruthy();
    });
  });

  it('reports the balance as used against entitled, with carry-over included', async () => {
    render();
    await screen.findByTestId('period-label');
    // 28.7% is both the KPI and the panel headline — deliberately the same
    // number, so scope the assertion to the panel rather than the page.
    const entitled = await screen.findByText(/1800 days entitled, including carry-over/);
    const panel = entitled.closest('.surface-panel')!;
    expect(panel.textContent).toContain('Leave balance');
    expect(panel.textContent).toContain('28.7%');
    // 1780 allocated + 20 carried. Ignoring carry-over would overstate the rate.
    expect(panel.textContent).toContain('Used');
    expect(panel.textContent).toContain('Remaining');
  });

  it('names the department and the person carrying the most overtime', async () => {
    render();
    expect(await screen.findByText(/Highest department — Operations, 86h/)).toBeTruthy();
    expect(screen.getByText(/Highest employee — Asha Rahman, 24h/)).toBeTruthy();
  });

  it('averages overtime over the people who worked it', async () => {
    render();
    // 326h over 24 people is 13.6h each — not 326/246, which would report the
    // average employee as working 1.3 hours of overtime.
    expect(await screen.findByText('24 people · 13.6h each on average')).toBeTruthy();
  });

  describe('when overtime is switched off', () => {
    beforeEach(() => {
      payload = hub({
        overtime: {
          enabled: false,
          totalHours: 0,
          trend: [],
          byDepartment: [],
          topEmployees: [],
          topDepartment: null,
          topEmployee: null,
        },
      });
      route();
    });

    it('swaps the overtime card for the approval rate rather than showing 0h', async () => {
      render();
      await screen.findByTestId('period-label');
      // 0h would say "nobody worked late", which is a different and false claim.
      await waitFor(() => expect(kpiLabels()[4]).toBe('Approval rate'));
      expect(kpiLabels()).not.toContain('Overtime hours');
    });

    it('replaces the overtime panel rather than leaving a hole in the row', async () => {
      render();
      expect(await screen.findByText(/switched off for this company/i)).toBeTruthy();
      expect(screen.queryByText(/Highest department/)).toBeNull();
      // Still three panels on the bottom row.
      expect(screen.getByText('Request status')).toBeTruthy();
      expect(screen.getByText('Leave balance')).toBeTruthy();
    });

    it('drops the overtime item from the action queue too', async () => {
      render();
      await screen.findByTestId('period-label');
      expect(screen.queryByText(/past a month of overtime/)).toBeNull();
    });
  });

  it('says nothing rather than 0% when there is no entitlement to divide by', async () => {
    payload = hub({
      periodStats: { ...hub().periodStats, utilisation: null },
      balance: { ...hub().balance, allocated: 0, carriedOver: 0, used: 0, remaining: 0, utilisation: null },
    });
    route();
    render();
    await screen.findByTestId('period-label');
    await waitFor(() => expect(screen.getAllByText('—').length).toBeGreaterThan(0));
  });

  it('shows em dashes rather than zeros when the request fails', async () => {
    payload = new Error('boom');
    route();
    render();
    // A failed request is not "no leave was requested".
    expect(await screen.findByText(/could not be read/i)).toBeTruthy();
    const cards = document.querySelectorAll('a.stat-card');
    expect(cards).toHaveLength(5);
    cards.forEach((c) => expect(c.querySelector('.tabular-nums')!.textContent).toBe('—'));
  });

  it('turns each queue into a count that links to its screen', async () => {
    render();
    expect(await screen.findByText('7 awaiting approval')).toBeTruthy();
    expect(screen.getByText('18 on leave today')).toBeTruthy();
    expect(screen.getByText('2 past a month of overtime')).toBeTruthy();
  });

  it('says both queues are clear when nothing is waiting', async () => {
    payload = hub({
      attention: {
        pending: { count: 0, names: [] },
        stale: { count: 0, names: [] },
        onLeaveToday: { count: 0, names: [] },
        highOvertime: { count: 0, names: [] },
      },
    });
    route();
    render();
    expect(await screen.findByText(/both queues are clear/i)).toBeTruthy();
  });

  it('every KPI drills into the screen behind it', async () => {
    render();
    await screen.findByTestId('period-label');
    const cards = document.querySelectorAll('a.stat-card');
    expect(cards).toHaveLength(5);
    cards.forEach((c) => expect(c.getAttribute('href')).toMatch(/^\/dashboard\//));
  });

  it('offers no Add new button — nothing is created from this hub', async () => {
    render();
    await screen.findByTestId('period-label');
    expect(screen.queryByRole('button', { name: /add new/i })).toBeNull();
  });
});
