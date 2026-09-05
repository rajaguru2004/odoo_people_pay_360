import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import FinanceHubPage from './page';

/**
 * The Finance hub, on the Time & Attendance template.
 *
 * One aggregate, read once: the page this replaces fanned out to list endpoints
 * and re-derived its figures in the browser, which is how a panel comes to
 * disagree with the screen it links to. What it must never do is turn a failed
 * read or an absent denominator into a zero.
 */

vi.mock('@/lib/axios', () => ({ default: { get: vi.fn() } }));

import axiosInstance from '@/lib/axios';

const axiosGet = vi.mocked(axiosInstance.get);

const payload = {
  window: {
    key: '2026-08',
    label: 'Aug 2026',
    start: '2026-08-01T00:00:00.000Z',
    end: '2026-09-01T00:00:00.000Z',
    previous: {
      key: '2026-07',
      label: 'Jul 2026',
      start: '2026-07-01T00:00:00.000Z',
      end: '2026-08-01T00:00:00.000Z',
    },
  },
  travel: {
    pending: 2,
    onTripToday: 1,
    upcoming30Days: 4,
  },
  budgets: {
    budgets: 3,
    overBudget: 1,
    planned: 200000,
    committed: 40000,
    actual: 120000,
    remaining: 40000,
    utilization: 80,
    prevUtilization: 72,
    utilizationDelta: { value: 8, direction: 'up', absolute: 8 },
    rows: [
      {
        budgetId: 'b1',
        name: 'FY26 HR',
        fiscalYear: 2026,
        planned: 100000,
        committed: 20000,
        actual: 75000,
        remaining: 5000,
        utilization: 95,
      },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ hasHydrated: true });
  axiosGet.mockResolvedValue({ data: payload } as never);
});

describe('the finance hub', () => {
  it('renders one KPI card per budget figure', async () => {
    renderWithProviders(<FinanceHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Budget utilization')).toBeTruthy());
    for (const label of ['Budget utilization', 'Spent', 'Remaining']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('reads one aggregate instead of fanning out', async () => {
    renderWithProviders(<FinanceHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Budget utilization')).toBeTruthy());
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(axiosGet).toHaveBeenCalledWith('/finance/hub-summary');
  });

  it('puts the travel queue in the attention strip', async () => {
    renderWithProviders(<FinanceHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('2 trips awaiting approval')).toBeTruthy());
    // 95% used is past the 90% line but not yet a breach — a different pill
    // from the one budget that is genuinely over plan.
    expect(screen.getByText('1 budget is over plan')).toBeTruthy();
    expect(screen.getByText('1 budget is past 90% of plan')).toBeTruthy();
  });

  it('shows an em dash and refuses to say all-clear when the read fails', async () => {
    axiosGet.mockRejectedValue(new Error('500'));
    renderWithProviders(<FinanceHubPage />, { role: 'ADMIN' });

    await waitFor(() => expect(screen.getByText('Budget utilization')).toBeTruthy());
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // The strip must not fall back to its empty state, which reads as
    // "nothing needs doing".
    expect(
      screen.getByText('Could not read the finance summary — this is not an all-clear.'),
    ).toBeTruthy();
    expect(screen.queryByText('Nothing needs chasing.')).toBeNull();
  });

  it('says the budget rate is unknown rather than 0% when nothing is planned', async () => {
    axiosGet.mockResolvedValue({
      data: {
        ...payload,
        budgets: { ...payload.budgets, planned: 0, utilization: null, utilizationDelta: null },
      },
    } as never);
    renderWithProviders(<FinanceHubPage />, { role: 'ADMIN' });

    await waitFor(() =>
      expect(screen.getByText('No active budget has a plan yet')).toBeTruthy(),
    );
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('carries no period filter', async () => {
    renderWithProviders(<FinanceHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Budget utilization')).toBeTruthy());
    // `showControls` is omitted, so the Today/Week/Month/Year row is not drawn.
    expect(screen.queryByText('Week')).toBeNull();
    expect(screen.queryByTestId('period-label')).toBeNull();
  });
});
