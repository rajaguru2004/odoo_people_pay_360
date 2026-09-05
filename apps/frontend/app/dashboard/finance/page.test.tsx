import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import FinanceHubPage from './page';

/**
 * The Finance hub, rebuilt onto the Time & Attendance template.
 *
 * The case that matters most is the arrears one: the page this replaces read
 * `overdueAmount`/`daysOverdue` off the overdue report, and the server sends
 * `amountDue`/`overdueDays` — so the Overdue KPI printed a formatted **zero**
 * and every aging pill read "overdue by 0 days". Reading one aggregate is what
 * makes a second, wrong derivation impossible.
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
  reimbursements: {
    pendingCount: 6,
    pendingAmount: 4200,
    olderThan7Days: 2,
    paidCount: 9,
    paidAmount: 18500,
    prevPaidAmount: 12000,
    paidDelta: { value: 54.2, direction: 'up', absolute: 6500 },
    byStatus: {
      PENDING: { count: 6, amount: 4200 },
      APPROVED: { count: 3, amount: 1500 },
      PAID: { count: 9, amount: 18500 },
      REJECTED: { count: 1, amount: 300 },
      CANCELLED: { count: 0, amount: 0 },
    },
    byCategory: [
      { key: 'Travel', label: 'Travel', amount: 11000 },
      { key: 'Other', label: 'Other', amount: 7500 },
    ],
  },
  travel: {
    pending: 2,
    onTripToday: 1,
    upcoming30Days: 4,
    perDiemPaidAmount: 11000,
    prevPerDiemPaidAmount: 9000,
    perDiemDelta: { value: 22.2, direction: 'up', absolute: 2000 },
  },
  loans: {
    outstanding: 96500,
    principal: 150000,
    accounts: 12,
    outstandingAsOfPrev: 101000,
    outstandingDelta: { value: -4.5, direction: 'down', absolute: -4500 },
    byStatus: [
      {
        status: 'ACTIVE',
        type: 'LOAN',
        count: 12,
        principal: 150000,
        repaid: 53500,
        writtenOff: 0,
        waived: 0,
        isDebt: true,
        outstanding: 96500,
      },
    ],
    overdue: {
      count: 3,
      amount: 7250,
      buckets: {
        '1-30': { count: 1, amount: 1250 },
        '31-60': { count: 1, amount: 2000 },
        '61-90': { count: 0, amount: 0 },
        '90+': { count: 1, amount: 4000 },
      },
      top: [
        {
          loanId: 'l1',
          referenceNo: 'LN-9',
          employeeName: 'Asha Menon',
          overdueDays: 96,
          amountDue: 4000,
          bucket: '90+',
        },
      ],
    },
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
  trendKind: 'month',
  trend: Array.from({ length: 12 }, (_, i) => ({
    key: `2026-${String(i + 1).padStart(2, '0')}`,
    label: 'M',
    value: i === 7 ? 18500 : 1000,
    segments: [
      { key: 'travel', value: i === 7 ? 11000 : 500 },
      { key: 'training', value: 0 },
      { key: 'other', value: i === 7 ? 7500 : 500 },
    ],
  })),
};

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ hasHydrated: true });
  axiosGet.mockResolvedValue({ data: payload } as never);
});

describe('the finance hub', () => {
  it('renders five KPI cards, one per concern', async () => {
    renderWithProviders(<FinanceHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Pending reimbursements')).toBeTruthy());
    for (const label of [
      'Pending reimbursements',
      'Reimbursed this month',
      'Travel spend (per diem)',
      'Advances & loans',
      'Budget utilization',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('reads one aggregate instead of fanning out', async () => {
    renderWithProviders(<FinanceHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Pending reimbursements')).toBeTruthy());
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(axiosGet).toHaveBeenCalledWith('/finance/hub-summary');
  });

  it('names the arrears with the days the server actually sent', async () => {
    renderWithProviders(<FinanceHubPage />, { role: 'ADMIN' });
    // The defect this replaced showed every row at 0 days and 0.00, because it
    // read field names the server has never sent.
    await waitFor(() => expect(screen.getByText('3 repayments overdue')).toBeTruthy());
    expect(screen.getByText('Worst bucket: 90+ days')).toBeTruthy();
  });

  it('labels travel as per diem, not as total travel cost', async () => {
    renderWithProviders(<FinanceHubPage />, { role: 'ADMIN' });
    // There is no travel-actuals column in this schema. Saying "travel spend"
    // without the qualifier would be a claim the data cannot support.
    await waitFor(() =>
      expect(
        screen.getByText('Per diem only — flights and hotels come in as claims'),
      ).toBeTruthy(),
    );
  });

  it('shows an em dash and refuses to say all-clear when the read fails', async () => {
    axiosGet.mockRejectedValue(new Error('500'));
    renderWithProviders(<FinanceHubPage />, { role: 'ADMIN' });

    await waitFor(() => expect(screen.getByText('Pending reimbursements')).toBeTruthy());
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

  it('draws the empty state rather than a flat line when nothing was reimbursed', async () => {
    axiosGet.mockResolvedValue({
      data: {
        ...payload,
        trend: payload.trend.map((b) => ({
          ...b,
          value: 0,
          segments: b.segments.map((s) => ({ ...s, value: 0 })),
        })),
      },
    } as never);
    renderWithProviders(<FinanceHubPage />, { role: 'ADMIN' });

    await waitFor(() =>
      expect(
        screen.getByText('Nothing has been reimbursed in the last twelve months.'),
      ).toBeTruthy(),
    );
  });

  it('carries no period filter', async () => {
    renderWithProviders(<FinanceHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Pending reimbursements')).toBeTruthy());
    // `showControls` is omitted, so the Today/Week/Month/Year row is not drawn.
    expect(screen.queryByText('Week')).toBeNull();
    expect(screen.queryByTestId('period-label')).toBeNull();
  });
});
