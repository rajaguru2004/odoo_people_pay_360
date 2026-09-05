import { describe, expect, it, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import SchedulesHubPage from './page';
import type { SchedulesHubSummary } from '@/types/schedulesHub';

/**
 * The Schedules hub.
 *
 * The page used to have four KPIs, two chip strips and no chart at all — the
 * window was a hard-coded Monday–Sunday with no way to move it. It now follows
 * the Time & Attendance template, and the properties worth pinning are the ones
 * that would otherwise let it report a confident wrong answer:
 *
 *  1. The whole page follows one Week / Month / Year clock, and paging uses the
 *     ANCHORS the server returned — the client does no calendar arithmetic.
 *  2. A rate with nothing to divide by prints as an em dash, never as 0%.
 *  3. The main chart is stacked from the server's numbers, not painted on.
 *  4. Every KPI drills into the screen behind it.
 */

vi.mock('@/services/calendarService', () => ({
  default: { getHubSummary: vi.fn() },
}));

import calendarService from '@/services/calendarService';

const getHubSummary = vi.mocked(calendarService.getHubSummary);

/** A covered week: 10 active, 8 rostered, 2 with no shift, 1 conflict. */
function hub(overrides: Partial<SchedulesHubSummary> = {}): SchedulesHubSummary {
  return {
    period: 'week',
    anchor: '2026-08-17',
    range: {
      start: '2026-08-17',
      end: '2026-08-23',
      through: '2026-08-23',
      label: 'Aug 17 – 23',
      prevAnchor: '2026-08-10',
      nextAnchor: '2026-08-24',
      hasNext: true,
      isCurrent: true,
    },
    periodStats: {
      activeHeadcount: 10,
      scheduledEmployees: 8,
      unscheduled: 2,
      shiftRows: 34,
      workingDays: 5,
      scheduledToday: 7,
      coverageRate: 80,
      coverageGaps: 1,
      conflicts: { onHoliday: 1, onWeeklyOff: 0, overlaps: 0, total: 1 },
    },
    previousStats: {
      activeHeadcount: 10,
      scheduledEmployees: 7,
      unscheduled: 3,
      shiftRows: 30,
      workingDays: 5,
      scheduledToday: 0,
      coverageRate: 70,
      coverageGaps: 2,
      conflicts: { onHoliday: 0, onWeeklyOff: 0, overlaps: 0, total: 0 },
    },
    previousRange: { start: '2026-08-10', end: '2026-08-16', label: 'Aug 10 – 16' },
    trendKind: 'day',
    trend: [
      { key: '2026-08-17', label: 'Aug 17', expected: 10, scheduled: 8, unassigned: 2, coverageRate: 80 },
      { key: '2026-08-18', label: 'Aug 18', expected: 10, scheduled: 9, unassigned: 1, coverageRate: 90 },
      { key: '2026-08-22', label: 'Aug 22', expected: 0, scheduled: 0, unassigned: 0, coverageRate: null },
    ],
    shiftMix: [
      { type: 'MORNING', count: 20, employees: 5, share: 62.5 },
      { type: 'NIGHT', count: 14, employees: 3, share: 37.5 },
    ],
    status: { assigned: 7, unassigned: 2, onHoliday: 1, onWeeklyOff: 0, overlaps: 0 },
    staffCoverage: {
      activeBaseline: 10,
      flexibleExcluded: 0,
      hours: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        label: `${hour}h`,
        onShift: hour >= 8 && hour < 17 ? 6 : 0,
      })),
    },
    departments: [
      { id: 'd1', name: 'Operations', headcount: 6, scheduled: 6, unscheduled: 0, rate: 100, hasData: true },
      { id: 'd2', name: 'Sales', headcount: 4, scheduled: 2, unscheduled: 2, rate: 50, hasData: true },
    ],
    attention: {
      unassigned: { count: 2, names: ['Asha', 'Karim'] },
      onHoliday: {
        count: 1,
        samples: [{ employeeId: 'e3', fullName: 'Meera', date: '2026-08-20', holiday: 'National Day' }],
      },
      onWeeklyOff: { count: 0, samples: [] },
      overlaps: { count: 0, samples: [] },
      thinnestDay: { date: '2026-08-19', label: 'Aug 19', scheduled: 4 },
    },
    holidays: [{ date: '2026-08-20', name: 'National Day' }],
    weeklyOffDays: [5, 6],
    ...overrides,
  };
}

let payload: SchedulesHubSummary | Error;

function route() {
  getHubSummary.mockImplementation((period: any, anchor?: string) => {
    if (payload instanceof Error) return Promise.reject(payload) as never;
    const base = payload;
    return Promise.resolve({
      success: true,
      data: { ...base, period, anchor: anchor ?? base.anchor },
    }) as never;
  });
}

const render = () => renderWithProviders(<SchedulesHubPage />, { role: 'ADMIN' });

describe('Schedules hub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    payload = hub();
    route();
  });

  it('opens on the week, because scheduling is short-term', async () => {
    render();
    await waitFor(() => expect(getHubSummary).toHaveBeenCalled());
    // Not "today", and not "month": a scheduler opens this page asking whether
    // the coming week is covered.
    expect(getHubSummary.mock.calls[0][0]).toBe('week');
    expect(await screen.findByTestId('period-label')).toHaveTextContent('Aug 17 – 23');
  });

  it('leads with who is rostered, measured against who is active', async () => {
    render();
    // 8 of 10, not "34 shifts" — a shift count is neither good nor bad. Scoped
    // to the card rather than `getByText('8')`, which also matches an axis tick.
    const hint = await screen.findByText(/8 of 10 active/);
    const card = hint.closest('a.stat-card');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain('Total scheduled');
    expect(card!.querySelector('.tabular-nums')!.textContent).toBe('8');
  });

  it('compares the window with the one before it, in points', async () => {
    render();
    // Coverage 70% → 80% is up TEN POINTS. Calling it "up 14%" would invite the
    // reader to think fourteen people.
    expect(await screen.findByText('10.0 pts')).toBeTruthy();
    expect(screen.getByText(/vs Aug 10 – 16/)).toBeTruthy();
  });

  it('re-asks the server when the period changes, and keeps no anchor', async () => {
    render();
    await waitFor(() => expect(getHubSummary).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: 'Month' }));
    await waitFor(() => {
      const last = getHubSummary.mock.calls[getHubSummary.mock.calls.length - 1];
      expect(last[0]).toBe('month');
      // The reader asked a different question, not the same window in another
      // shape, so the anchor is dropped.
      expect(last[1]).toBeUndefined();
    });
  });

  it('pages backwards with the anchor the server handed back', async () => {
    render();
    await screen.findByTestId('period-label');

    await userEvent.click(screen.getByRole('button', { name: /previous/i }));
    await waitFor(() => {
      const last = getHubSummary.mock.calls[getHubSummary.mock.calls.length - 1];
      // Not "seven days ago" computed here — what a week means depends on the
      // branch working week, which only the server knows.
      expect(last[1]).toBe('2026-08-10');
    });
  });

  it('stacks the coverage chart from the server numbers', async () => {
    render();
    await screen.findByTestId('period-label');
    await waitFor(() => {
      expect(document.querySelector('[title="Scheduled: 8"]')).toBeTruthy();
      expect(document.querySelector('[title="Unassigned: 2"]')).toBeTruthy();
    });
  });

  it('draws no unassigned band on a day the branch was closed', async () => {
    render();
    await screen.findByTestId('period-label');
    // Aug 22 expected nobody. A full-height "unassigned" block there would
    // report a perfectly normal Saturday as a coverage disaster.
    await waitFor(() => {
      expect(document.querySelector('[title="Unassigned: 0"]')).toBeNull();
    });
  });

  it('says nothing rather than 0% when a department has nobody to count', async () => {
    payload = hub({
      departments: [
        { id: 'd1', name: 'Operations', headcount: 6, scheduled: 6, unscheduled: 0, rate: 100, hasData: true },
        { id: 'd3', name: 'Legal', headcount: 0, scheduled: 0, unscheduled: 0, rate: null, hasData: false },
      ],
    });
    route();
    render();
    expect(await screen.findByText('Legal')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('shows em dashes rather than zeros when the request fails', async () => {
    payload = new Error('boom');
    route();
    render();
    // A failed request is not "nobody is scheduled". Waited on the strip rather
    // than on any em dash: the hourly-curve panel prints one before the query
    // has even settled, so a bare `getAllByText('—')` passes too early and the
    // test then asserts against a half-rendered page.
    expect(await screen.findByText(/could not be read/i)).toBeTruthy();
    const cards = document.querySelectorAll('a.stat-card');
    expect(cards).toHaveLength(5);
    cards.forEach((c) =>
      expect(c.querySelector('.tabular-nums')!.textContent).toBe('—'),
    );
  });

  it('turns each conflict into a count that links to its screen', async () => {
    render();
    expect(await screen.findByText('2 with no shift')).toBeTruthy();
    expect(screen.getByText('1 rostered on a holiday')).toBeTruthy();
    // The names behind the loudest number, so the strip is workable as it is.
    expect(screen.getByText('Asha')).toBeTruthy();
  });

  it('says everything is clear when nothing needs chasing', async () => {
    payload = hub({
      periodStats: {
        ...hub().periodStats,
        unscheduled: 0,
        coverageGaps: 0,
        conflicts: { onHoliday: 0, onWeeklyOff: 0, overlaps: 0, total: 0 },
      },
      attention: {
        unassigned: { count: 0, names: [] },
        onHoliday: { count: 0, samples: [] },
        onWeeklyOff: { count: 0, samples: [] },
        overlaps: { count: 0, samples: [] },
        thinnestDay: null,
      },
    });
    route();
    render();
    expect(await screen.findByText(/roster is clear/i)).toBeTruthy();
  });

  it('says what the hourly curve leaves out rather than under-drawing it', async () => {
    payload = hub({
      staffCoverage: { ...hub().staffCoverage, flexibleExcluded: 4 },
    });
    route();
    render();
    // Flexible shifts have no fixed window, so they cannot sit on an hour axis.
    // Dropping them silently would make the morning look thin.
    expect(await screen.findByText(/4 flexible shifts have no fixed hours/i)).toBeTruthy();
  });

  it('every KPI drills into the screen behind it', async () => {
    render();
    await screen.findByTestId('period-label');
    const cards = document.querySelectorAll('a.stat-card');
    // Five, matching the template. Past that the numbers stop being a glance.
    expect(cards).toHaveLength(5);
    cards.forEach((c) => expect(c.getAttribute('href')).toMatch(/^\/dashboard\//));
  });

  it('offers no Add new button — nothing is created from this hub', async () => {
    render();
    await screen.findByTestId('period-label');
    expect(screen.queryByRole('button', { name: /add new/i })).toBeNull();
  });
});
