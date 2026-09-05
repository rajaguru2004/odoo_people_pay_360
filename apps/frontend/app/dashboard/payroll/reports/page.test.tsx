import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import PayrollReportsPage from './page';

/**
 * The payroll reports screen, and the one defect it kept quiet.
 *
 * The five tabs return five DIFFERENT row shapes off five different endpoints,
 * and the page held them all in one `data` state. Two things then went wrong,
 * and only the second one ever announced itself:
 *
 *  1. Clicking a tab re-renders BEFORE the effect runs, so there was one frame
 *     where `tab` was the new tab and `data` was still the old tab's payload.
 *  2. The effect re-fires on every keystroke in the month and year fields, and
 *     nothing cancelled a superseded request — so whenever two overlapped, the
 *     slower one won and wrote another tab's payload into `data`.
 *
 * Both render the wrong report under the right heading. It surfaced only as a
 * React "unique key" warning, because register rows carry no `key` field for
 * the cost table's `key={r.key}` to read — which is a symptom, not the bug.
 */

vi.mock('@/services/payrollExtensionsService', () => ({
  payrollReportService: {
    register: vi.fn(),
    cost: vi.fn(),
    statutory: vi.fn(),
    gratuityLiability: vi.fn(),
    variance: vi.fn(),
  },
}));

// `loaded` matters: the screen holds its verdict until the flags have actually
// been read, so a mock without it renders the "checking" placeholder forever.
vi.mock('@/hooks/usePayrollFeatures', () => ({
  usePayrollFeatures: () => ({ reports: true, loaded: true }),
}));

import { payrollReportService } from '@/services/payrollExtensionsService';

const register = vi.mocked(payrollReportService.register);
const cost = vi.mocked(payrollReportService.cost);

/** Register rows: no `key` field — this is the shape the cost table choked on. */
const REGISTER = {
  rows: [
    {
      fullName: 'Ahmed Al-Habsi',
      employeeCode: 'SMP-EMP-019',
      department: 'Operations',
      gross: 730,
      deductions: 111,
      netSalary: 551,
    },
  ],
  totals: { employees: 1, gross: 730, deductions: 111, net: 551 },
  meta: { openPayrolls: [] },
};

/**
 * Cost rows: keyed by department id, and deliberately labelled with a string
 * that appears NOWHERE in the register fixture — the register's `department`
 * column would otherwise make "this row leaked" indistinguishable from "this
 * row belongs here".
 */
const COST = {
  rows: [{ key: 'dept-1', label: 'Muscat cost centre', employees: 1, gross: 730, net: 551 }],
  totals: { gross: 730, net: 551 },
  meta: { openPayrolls: [] },
};

const render = () => renderWithProviders(<PayrollReportsPage />, { role: 'ADMIN' });

beforeEach(() => {
  vi.clearAllMocks();
  register.mockResolvedValue({ data: REGISTER } as never);
  cost.mockResolvedValue({ data: COST } as never);
});

describe('Payroll reports', () => {
  it('opens on the register', async () => {
    render();
    expect(await screen.findByTestId('report-register')).toBeTruthy();
    expect(screen.getByText('Ahmed Al-Habsi')).toBeTruthy();
  });

  it('never renders one tab’s rows through another tab’s columns', async () => {
    const { user } = render();
    await screen.findByTestId('report-register');

    // Cost never resolves, so the page sits in exactly the state the bug lived
    // in: `tab` is 'cost' and the only payload in hand is the register's.
    cost.mockReturnValue(new Promise(() => {}) as never);
    await user.click(screen.getByTestId('report-tab-cost'));

    // The register table must be GONE — not re-rendered under cost's headings.
    await waitFor(() => expect(screen.queryByTestId('report-register')).toBeNull());
    expect(screen.queryByText('Ahmed Al-Habsi')).toBeNull();
  });

  it('ignores a superseded response instead of letting it win the race', async () => {
    const { user } = render();
    await screen.findByTestId('report-register');

    // The reader flips to Cost and straight back. Cost resolves LAST, which is
    // what used to overwrite the register the reader is now looking at.
    let releaseCost: (v: unknown) => void = () => {};
    cost.mockReturnValue(
      new Promise((resolve) => {
        releaseCost = resolve;
      }) as never,
    );
    await user.click(screen.getByTestId('report-tab-cost'));
    await user.click(screen.getByTestId('report-tab-register'));
    releaseCost({ data: COST });

    await waitFor(() => expect(screen.queryByTestId('report-register')).toBeTruthy());
    // Cost's only row must not appear anywhere on a register view.
    expect(screen.queryByText('Muscat cost centre')).toBeNull();
  });

  it('renders the cost table once its own payload arrives', async () => {
    const { user } = render();
    await screen.findByTestId('report-register');

    await user.click(screen.getByTestId('report-tab-cost'));
    expect(await screen.findByText('Muscat cost centre')).toBeTruthy();
    expect(screen.queryByTestId('report-register')).toBeNull();
  });

  it('shows a refusal as a refusal, not as an empty report', async () => {
    // The incident this codebase already had: a correct 403 reaching the user
    // as a blank screen that reads as "there is nothing here".
    register.mockRejectedValue({ status: 403, message: 'Forbidden resource' } as never);
    render();
    expect(await screen.findByTestId('report-failed')).toBeTruthy();
  });
});
