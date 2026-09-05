import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import MyLoanStatementPage from './page';

/**
 * A borrower's own ledger.
 *
 * `GET /advance-loans/reports/my-statement` was implemented, tested, and given
 * a client wrapper that no page called — so an employee could see their balance
 * and never the ledger behind it.
 *
 * The load-bearing rule is that the screen must not state a debt that is not
 * owed. The server sets `outstanding` to zero for every terminal status; a
 * screen that recomputed `amount - repaid` would tell someone whose loan was
 * written off that they still owe the lot. So the figure is displayed, never
 * derived.
 */

vi.mock('@/services/loanReportService', () => ({
  default: {
    outstanding: vi.fn(),
    portfolio: vi.fn(),
    emiDue: vi.fn(),
    overdue: vi.fn(),
    interestEarned: vi.fn(),
    myStatement: vi.fn(),
    employeeStatement: vi.fn(),
  },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import loanReportService from '@/services/loanReportService';
import { toast } from '@/lib/toast';

const myStatement = vi.mocked(loanReportService.myStatement);
const toastError = vi.mocked(toast.error);

function interceptorRejection(statusCode: number, message: string) {
  return {
    success: false,
    statusCode,
    message,
    timestamp: '2026-08-19T00:00:00.000Z',
    path: '/advance-loans/reports/my-statement',
    errors: null,
    details: { message },
  };
}

function loan(over: Record<string, unknown> = {}) {
  return {
    id: 'loan-1',
    type: 'LOAN',
    referenceNo: 'LN-202608-0001',
    status: 'ACTIVE',
    amount: '1200.00',
    amountRepaid: '400.00',
    outstanding: 800,
    installments: 6,
    installmentAmount: '200.00',
    interestMethod: 'NONE',
    createdAt: '2026-08-01T09:00:00.000Z',
    schedules: [
      {
        version: 1,
        installmentNo: 1,
        dueDate: '2026-09-30',
        emiAmount: '200.00',
        principalComponent: '200.00',
        interestComponent: '0.00',
        status: 'PAID',
      },
      {
        version: 1,
        installmentNo: 2,
        dueDate: '2026-10-31',
        emiAmount: '200.00',
        principalComponent: '200.00',
        interestComponent: '0.00',
        status: 'SCHEDULED',
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ hasHydrated: true });
  myStatement.mockResolvedValue({ data: [] } as never);
});

async function renderPage(
  options: Parameters<typeof renderWithProviders>[1] = {},
) {
  const result = renderWithProviders(<MyLoanStatementPage />, {
    role: 'EMPLOYEE',
    ...options,
  });
  await waitFor(() => expect(myStatement).toHaveBeenCalled());
  return result;
}

describe('the statement itself', () => {
  it('lists a loan with what was borrowed, repaid and still due', async () => {
    myStatement.mockResolvedValue({ data: [loan()] } as never);

    await renderPage();

    await waitFor(() => expect(screen.queryAllByTestId('statement-loan').length).toBe(1));
    const row = screen.getByTestId('statement-loan');
    expect(within(row).getByTestId('statement-outstanding').textContent).toContain('800');
    expect(within(row).getByTestId('statement-repaid').textContent).toContain('400');
  });

  it('states zero due on a written-off loan, whatever the other columns say', async () => {
    // The whole reason `outstanding` is taken from the server: `amount -
    // repaid` here would be 1200, and telling someone whose debt was forgiven
    // that they still owe all of it is the worst thing this screen could do.
    myStatement.mockResolvedValue({
      data: [
        loan({
          status: 'WRITTEN_OFF',
          amountRepaid: '0.00',
          outstanding: 0,
        }),
      ],
    } as never);

    await renderPage();

    await waitFor(() => expect(screen.queryAllByTestId('statement-loan').length).toBe(1));
    expect(screen.getByTestId('statement-outstanding').textContent).toMatch(/0(\.00)?/);
    expect(screen.getByTestId('statement-loan').getAttribute('data-outstanding')).toBe('0');
  });

  it('names the status rather than leaving a code on screen', async () => {
    myStatement.mockResolvedValue({ data: [loan({ status: 'WRITTEN_OFF' })] } as never);

    await renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('statement-status').textContent).toMatch(/written off/i),
    );
  });

  it('says plainly when there is nothing to show', async () => {
    await renderPage();
    await waitFor(() => expect(screen.queryByTestId('statement-empty')).toBeTruthy());
  });
});

describe('the schedule behind a loan', () => {
  it('is hidden until asked for, then shows every instalment', async () => {
    myStatement.mockResolvedValue({ data: [loan()] } as never);

    const { user } = await renderPage();
    await waitFor(() => expect(screen.queryAllByTestId('statement-loan').length).toBe(1));

    expect(screen.queryAllByTestId('statement-schedule-row').length).toBe(0);
    await user.click(screen.getByTestId('statement-toggle'));
    expect(screen.queryAllByTestId('statement-schedule-row').length).toBe(2);
  });

  it('shows which instalments have actually been taken', async () => {
    myStatement.mockResolvedValue({ data: [loan()] } as never);

    const { user } = await renderPage();
    await waitFor(() => expect(screen.queryAllByTestId('statement-loan').length).toBe(1));
    await user.click(screen.getByTestId('statement-toggle'));

    const rows = screen.getAllByTestId('statement-schedule-row');
    expect(rows[0].getAttribute('data-status')).toBe('PAID');
    expect(rows[1].getAttribute('data-status')).toBe('SCHEDULED');
  });

  it('says so when a loan has no plan yet', async () => {
    // A PENDING request has no schedule; an empty table would read as a bug.
    myStatement.mockResolvedValue({
      data: [loan({ status: 'PENDING', schedules: [] })],
    } as never);

    const { user } = await renderPage();
    await waitFor(() => expect(screen.queryAllByTestId('statement-loan').length).toBe(1));
    await user.click(screen.getByTestId('statement-toggle'));

    expect(screen.queryByTestId('statement-schedule-empty')).toBeTruthy();
  });
});

describe('when the statement cannot be read', () => {
  it('says so, rather than showing an empty statement', async () => {
    // "You have no loans" and "we could not read your loans" are different
    // sentences, and only one of them is reassuring.
    myStatement.mockRejectedValue(
      interceptorRejection(
        400,
        'Your account is not linked to an employee record, so it has no loan statement',
      ),
    );

    await renderPage();

    await waitFor(() => expect(screen.queryByTestId('statement-failed')).toBeTruthy());
    expect(screen.getByTestId('statement-failed').textContent).toContain(
      'not linked to an employee record',
    );
    expect(screen.queryByTestId('statement-empty')).toBeNull();
    expect(toastError).toHaveBeenCalled();
  });

  it('falls back to its own sentence when the server sends none', async () => {
    myStatement.mockRejectedValue(interceptorRejection(500, ''));

    await renderPage();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Could not load your loan statement'),
    );
  });
});
