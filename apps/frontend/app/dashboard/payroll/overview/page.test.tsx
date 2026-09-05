import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import PayrollHubPage from './page';
import type { PayrollHubSummary } from '@/types/payrollHub';

/**
 * The Payroll hub's numbers.
 *
 * Every figure here is money or a queue, and the failure this file guards is
 * the quiet one: an aggregate that did not load rendering as a confident zero.
 * "Every run is locked and everyone can be paid" and "we could not ask" are
 * opposite answers to the same question, and only one of them is safe to act on.
 *
 * The other rule pinned here is that money means LOCKED. A DRAFT run is work in
 * progress, not money — so it must reach the page as a count and never as an
 * amount.
 */

vi.mock('@/services/payrollExtensionsService', () => ({
  payrollHubService: { getHubSummary: vi.fn() },
}));

// The statutory card and the composition panel name their lines from the
// tenant's own country — SPF here, not a hardcoded "Insurance".
vi.mock('@/services/systemSettingsService', () => ({
  default: {
    getPublic: vi.fn().mockResolvedValue({
      success: true,
      data: { payroll_country: 'OM', payroll_currency: 'OMR' },
    }),
  },
}));

import { payrollHubService } from '@/services/payrollExtensionsService';

const getHubSummary = vi.mocked(payrollHubService.getHubSummary);

/** A full, healthy payload. Tests override only the slice they are about. */
function summary(over: Partial<PayrollHubSummary> = {}): PayrollHubSummary {
  return {
    months: 6,
    anchor: {
      month: 8,
      year: 2026,
      label: 'Aug 2026',
      resolvedFrom: 'current-month',
      previous: { month: 7, year: 2026, label: 'Jul 2026' },
    },
    runs: {
      windowByStatus: { LOCKED: 4, DRAFT: 1 },
      total: 5,
      locked: 4,
      inProgress: 1,
      pendingApproval: 0,
      approvedNotLocked: 0,
      draft: 1,
      rejected: 0,
      oldestPendingAt: null,
      draftForClosedPeriod: 0,
      pending: [],
      rejectedRuns: [],
    },
    money: {
      net: 420000,
      previousNet: 400000,
      gross: 500000,
      previousGross: 480000,
      statutory: 20000,
      previousStatutory: 19000,
      deductions: 80000,
      previousDeductions: 80000,
      currency: '',
    },
    employees: { paid: 24, inOpenRun: 0, active: 24, notInAnyRun: 0, names: [] },
    readiness: {
      population: 'run',
      total: 24,
      ready: 24,
      readyRate: 100,
      noBankRecord: 0,
      incompleteFields: 0,
      pendingChange: 0,
      bankInactive: 0,
      countryNotAllowed: 0,
      unknown: 0,
      names: [],
    },
    trend: [
      { key: '2026-07', label: 'Jul 2026', month: 7, year: 2026, net: 400000, gross: 480000, statutory: 19000, employees: 23, runs: 1, lockedRuns: 1, locked: true },
      { key: '2026-08', label: 'Aug 2026', month: 8, year: 2026, net: 420000, gross: 500000, statutory: 20000, employees: 24, runs: 1, lockedRuns: 1, locked: true },
    ],
    composition: {
      earnings: [
        { key: 'baseSalary', amount: 450000 },
        { key: 'allowances', amount: 50000 },
      ],
      deductions: [
        { key: 'tax', amount: 60000 },
        { key: 'insurance', amount: 20000 },
      ],
      grossReported: 500000,
      deductionsTotal: 80000,
      net: 420000,
      residual: 0,
    },
    carryForward: { outstanding: 0 },
    settlements: { draft: 0, awaitingPayment: 0, openPayout: 0 },
    unscopedLegacyRuns: 0,
    ...over,
  };
}

const resolve = (s: PayrollHubSummary) =>
  getHubSummary.mockResolvedValue({ data: s } as never);

const render = () => renderWithProviders(<PayrollHubPage />, { role: 'ADMIN' });

/** The five KPI cards, in DOM order. */
const cards = () => Array.from(document.querySelectorAll('a.stat-card, .stat-card'));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Payroll hub', () => {
  describe('the KPI row', () => {
    it('renders exactly five cards, whatever the payload holds', async () => {
      resolve(summary());
      render();
      await waitFor(() => expect(cards().length).toBe(5));
    });

    it('still renders five cards when the optional sections are absent', async () => {
      // The old hub pushed Settlements and Gratuity in conditionally, so the
      // row was four to six wide depending on a feature flag and the grid
      // changed shape underneath the reader.
      resolve(summary({ readiness: null, settlements: null }));
      render();
      await waitFor(() => expect(cards().length).toBe(5));
    });

    it('leads with the cost, the take-home, the statutory line and coverage', async () => {
      resolve(summary());
      render();
      await screen.findByText(/^Gross payroll \(/);
      expect(screen.getByText(/^Net paid \(/)).toBeTruthy();
      // Named by the regulator this tenant files with, not "Insurance".
      expect(screen.getByText('SPF contributions')).toBeTruthy();
      expect(screen.getByText('Total employees')).toBeTruthy();
      expect(screen.getByText('Ready to pay')).toBeTruthy();
      // '100%' legitimately appears twice: the KPI and the readiness panel.
      expect(screen.getAllByText('100%').length).toBeGreaterThan(0);
    });

    it('carries the supporting figures on the card rather than a screen away', async () => {
      // The complaint the sub-stats answer: a card that is one number and a
      // lot of whitespace, with the two figures that give it meaning behind
      // another click.
      resolve(summary());
      render();
      const gross = (await screen.findByText(/^Gross payroll \(/)).closest('.stat-card');
      expect(gross?.textContent).toContain('Basic');
      expect(gross?.textContent).toContain('Allowances');

      const net = screen.getByText(/^Net paid \(/).closest('.stat-card');
      expect(net?.textContent).toContain('Deductions');
      expect(net?.textContent).toContain('Per employee');
    });

    it('labels the money card with the tenant currency, not a hardcoded one', async () => {
      // `kpiNetThisMonth` used to be the literal string "Net Salary (OMR)", so
      // an INR or SGD tenant read an OMR label over its own money.
      resolve(summary());
      render();
      const label = await screen.findByText(/^Net paid \(/);
      expect(label.textContent).not.toContain('OMR');
      expect(label.textContent).toMatch(/^Net paid \(INR\)$/);
    });

    it('every card drills somewhere', async () => {
      resolve(summary());
      render();
      await waitFor(() => expect(cards().length).toBe(5));
      for (const c of cards()) {
        expect(c.getAttribute('href')).toMatch(/^\/dashboard\//);
      }
    });
  });

  describe('an empty database', () => {
    it('says no run has been created, not "every run is locked"', async () => {
      // Both leave the count at 0, and only one of them is good news. The card
      // used to congratulate the reader over a database with nothing in it.
      resolve(
        summary({
          runs: {
            ...summary().runs,
            windowByStatus: {},
            total: 0,
            locked: 0,
            inProgress: 0,
            draft: 0,
          },
          money: { ...summary().money, net: null, previousNet: null, gross: null, previousGross: null, statutory: null, previousStatutory: null, deductions: null, previousDeductions: null },
          trend: [],
        }),
      );
      render();
      // The pipeline panel is where runs live now, and an empty database must
      // read as "nothing has been created", never as "nothing is waiting".
      expect(await screen.findByText('No payroll run in this window.')).toBeTruthy();
      expect(screen.getByText('No run is waiting for anyone.')).toBeTruthy();
    });

    it('names every open run in the queue, and links each one to its screen', async () => {
      resolve(
        summary({
          runs: {
            ...summary().runs,
            pendingApproval: 2,
            approvedNotLocked: 1,
            inProgress: 4,
            draft: 1,
            rejected: 1,
            oldestPendingAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
          },
        }),
      );
      render();
      const pending = await screen.findByTestId('payroll-queue-pendingApproval');
      expect(pending.getAttribute('href')).toBe('/dashboard/payroll/approvals');
      expect(pending.textContent).toContain('2');
      expect(
        screen.getByTestId('payroll-queue-approvedNotLocked').getAttribute('href'),
      ).toBe('/dashboard/payroll/manage');
      expect(screen.getByTestId('payroll-queue-rejected').textContent).toContain(
        'Needs correction',
      );
    });
  });

  describe('a failed read', () => {
    it('prints em dashes, never zeros', async () => {
      getHubSummary.mockRejectedValue(new Error('boom'));
      render();
      await waitFor(() => expect(cards().length).toBe(5));
      // Five unknown figures, five dashes — not five confident zeros.
      const dashes = cards().filter((c) => c.textContent?.includes('—'));
      expect(dashes.length).toBe(5);
      for (const c of cards()) expect(c.textContent).not.toMatch(/\b0\b/);
    });

    it('never shows the all-clear — the worst possible guess', async () => {
      getHubSummary.mockRejectedValue(new Error('boom'));
      render();
      // Every panel says so, which is the point — none of them guesses.
      await screen.findAllByText(/could not be read/i);
      expect(screen.queryByText('Payroll is on track — nothing is waiting.')).toBeNull();
    });

    it('shows the genuine all-clear when the aggregate really did load clean', async () => {
      resolve(summary());
      render();
      expect(
        await screen.findByText('Payroll is on track — nothing is waiting.'),
      ).toBeTruthy();
    });
  });

  describe('money means LOCKED', () => {
    it('a period with no locked run reports no amount, not a zero', async () => {
      resolve(
        summary({
          money: { ...summary().money, net: null, gross: null, statutory: null, deductions: null },
          runs: {
            ...summary().runs,
            windowByStatus: { DRAFT: 1 },
            inProgress: 1,
            draft: 1,
          },
          employees: { paid: 0, inOpenRun: 24, active: 24, notInAnyRun: 0, names: [] },
          trend: [
            { key: '2026-08', label: 'Aug 2026', month: 8, year: 2026, net: null, gross: null, statutory: null, employees: 0, runs: 1, lockedRuns: 0, locked: false },
          ],
        }),
      );
      render();

      const net = (await screen.findByText(/^Net paid \(/)).closest('.stat-card');
      expect(net?.textContent).toContain('—');
      // Gross and the statutory line follow the same rule, or the reader gets
      // an authoritative cost for a run that has not been finalised.
      const gross = screen.getByText(/^Gross payroll \(/).closest('.stat-card');
      expect(gross?.textContent).toContain('—');
      expect(screen.getAllByText('No locked run in Aug 2026 yet').length).toBeGreaterThan(0);
      // The work in flight is still visible — as a count, which is honest.
      expect(screen.getByTestId('payroll-queue-draft').textContent).toContain('1');
    });

    it('prints the movement in money rather than in percent', async () => {
      resolve(summary());
      render();
      // 420,000 - 400,000 = 20,000, and it names the window it compares to.
      // Gross and the statutory line carry their own delta against the same
      // month, so the label legitimately appears on more than one card.
      await screen.findAllByText(/20,000/);
      expect(screen.getAllByText('vs Jul 2026').length).toBeGreaterThan(0);
    });

    it('reads a FALLING payroll cost as good news, and a rising one as not', async () => {
      // Neither direction is inherently good for a payroll total, but the one
      // somebody has to go and explain is the rise — so `goodDirection` is
      // 'down' and the colours must follow it rather than the arrow.
      resolve(summary({ money: { ...summary().money, net: 390000, previousNet: 400000 } }));
      const down = render();
      const fell = (await screen.findByText(/^Net paid \(/)).closest('.stat-card');
      const fellBadge = fell?.querySelector('.text-status-success');
      expect(fellBadge?.textContent).toMatch(/10,000/);
      down.unmount();

      getHubSummary.mockReset();
      resolve(summary({ money: { ...summary().money, net: 440000, previousNet: 400000 } }));
      render();
      const rose = (await screen.findByText(/^Net paid \(/)).closest('.stat-card');
      const roseBadge = rose?.querySelector('.text-status-error');
      expect(roseBadge?.textContent).toMatch(/40,000/);
    });
  });

  describe('the reporting period', () => {
    it('names the month it landed on', async () => {
      resolve(summary());
      render();
      await waitFor(() => expect(screen.getAllByText(/Aug 2026/).length).toBeGreaterThan(0));
    });

    it('follows the anchor when the current month has no run yet', async () => {
      resolve(
        summary({
          anchor: {
            month: 6,
            year: 2026,
            label: 'Jun 2026',
            resolvedFrom: 'latest-run',
            previous: { month: 5, year: 2026, label: 'May 2026' },
          },
        }),
      );
      render();
      await waitFor(() => expect(screen.getAllByText(/Jun 2026/).length).toBeGreaterThan(0));
    });
  });

  describe('the trend window', () => {
    it('offers 6M and 12M, and re-queries with the one chosen', async () => {
      resolve(summary());
      const { user } = render();
      await screen.findByText('Payroll paid');
      expect(getHubSummary).toHaveBeenCalledWith(6);

      await user.click(screen.getByRole('button', { name: '12M' }));
      await waitFor(() => expect(getHubSummary).toHaveBeenCalledWith(12));
    });

    it('does not move the approval queue — a queue is what is waiting now', async () => {
      // The queue must read the same on both windows: an open run older than
      // the chart is exactly the one somebody needs to be told about. It sits
      // on the pipeline panel now, under a heading that says "all periods".
      resolve(
        summary({
          runs: {
            ...summary().runs,
            pendingApproval: 2,
            inProgress: 2,
            draft: 0,
            oldestPendingAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
            pending: [
              { id: 'r1', month: 3, year: 2026, label: 'Mar 2026', submittedAt: new Date(Date.now() - 5 * 86_400_000).toISOString() },
              { id: 'r2', month: 4, year: 2026, label: 'Apr 2026', submittedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
            ],
          },
        }),
      );
      const { user } = render();

      const queueBefore = await screen.findByTestId('payroll-queue-pendingApproval');
      expect(queueBefore.textContent).toContain('2');

      await user.click(screen.getByRole('button', { name: '12M' }));
      await waitFor(() => expect(getHubSummary).toHaveBeenCalledWith(12));

      expect(screen.getByTestId('payroll-queue-pendingApproval').textContent).toContain('2');
    });
  });

  describe('needs attention', () => {
    it('names each run waiting for approval, and scores it by age', async () => {
      const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
      resolve(
        summary({
          runs: {
            ...summary().runs,
            pendingApproval: 1,
            inProgress: 1,
            draft: 0,
            oldestPendingAt: old,
            pending: [{ id: 'r1', month: 3, year: 2026, label: 'Mar 2026', submittedAt: old }],
          },
        }),
      );
      render();
      expect(await screen.findByText('Mar 2026 awaiting approval')).toBeTruthy();
      expect(screen.getByText('Waiting 9 days')).toBeTruthy();
    });

    it('surfaces employees who cannot be paid at all', async () => {
      resolve(
        summary({
          readiness: {
            ...summary().readiness!,
            ready: 21,
            readyRate: 87.5,
            noBankRecord: 2,
            incompleteFields: 1,
          },
        }),
      );
      render();
      expect(await screen.findByText('3 cannot be paid')).toBeTruthy();
      expect(screen.getByText('Bank details missing or invalid')).toBeTruthy();
    });

    it('warns that a pending bank change would pay the old account', async () => {
      resolve(
        summary({
          readiness: { ...summary().readiness!, ready: 23, readyRate: 95.8, pendingChange: 1 },
        }),
      );
      render();
      expect(await screen.findByText('1 bank change awaiting approval')).toBeTruthy();
      // Said twice on purpose: once in the strip, once beside the readiness
      // meter that counts it — and both go to the approvals queue.
      expect(screen.getAllByText('Pay would go to the old account').length).toBe(2);
    });

    it('names employees left out of the run rather than only counting them', async () => {
      resolve(
        summary({
          employees: {
            paid: 22,
            inOpenRun: 0,
            active: 24,
            notInAnyRun: 2,
            names: [
              { id: 'e1', employeeCode: 'E-1', fullName: 'Aisha Al-Zadjali' },
              { id: 'e2', employeeCode: 'E-2', fullName: 'Ahmed Al-Habsi' },
            ],
          },
        }),
      );
      render();
      // Named in the strip and counted again in the coverage panel.
      expect((await screen.findAllByText('2 employees in no run')).length).toBeGreaterThan(0);
      expect(screen.getByText(/Aisha Al-Zadjali/)).toBeTruthy();
    });

    it('names legacy company-wide runs instead of letting them vanish', async () => {
      // They carry no branch, so every other figure on the page excludes them.
      resolve(summary({ unscopedLegacyRuns: 2 }));
      render();
      expect(
        await screen.findByText('2 company-wide runs are not shown here'),
      ).toBeTruthy();
      expect(screen.getByText('No branch assigned')).toBeTruthy();
    });
  });

  describe('payment readiness', () => {
    it('prints an em dash, never 100%, when nothing could be judged', async () => {
      // A branch with no banking country has no required fields, so everybody
      // would validate as ready. That is a fabricated all-clear.
      resolve(
        summary({
          readiness: {
            population: 'active',
            total: 6,
            ready: 0,
            readyRate: null,
            noBankRecord: 0,
            incompleteFields: 0,
            pendingChange: 0,
            bankInactive: 0,
            countryNotAllowed: 0,
            unknown: 6,
            names: [],
          },
        }),
      );
      render();

      const card = (await screen.findByText('Ready to pay')).closest('.stat-card');
      expect(card?.textContent).toContain('—');
      expect(card?.textContent).not.toContain('100%');
      expect(
        screen.getAllByText('No banking country configured, so nothing could be checked').length,
      ).toBeGreaterThan(0);
    });
  });

  describe('the money composition', () => {
    it('lists the payslip columns that carry money', async () => {
      resolve(summary());
      render();
      // The panel HEADER renders while loading, so waiting on it proves
      // nothing about the rows. Wait for a row.
      expect(await screen.findAllByText('Basic')).toBeTruthy();
      // Named by the tenant's country, so an Oman install reads "Income Tax"
      // here and on its payslip rather than a generic "Tax".
      expect(screen.getAllByText('Income Tax').length).toBeGreaterThan(0);
    });

    it('prints the residual rather than rounding away a payslip that does not reconcile', async () => {
      resolve(
        summary({
          composition: { ...summary().composition, residual: 1200 },
        }),
      );
      render();
      expect(
        await screen.findByText(/does not reconcile with what was paid/i),
      ).toBeTruthy();
    });

    it('says there is no locked run rather than drawing an empty breakdown', async () => {
      resolve(
        summary({
          money: { ...summary().money, net: null, previousNet: null, gross: null, previousGross: null, statutory: null, previousStatutory: null, deductions: null, previousDeductions: null },
          composition: {
            earnings: [],
            deductions: [],
            grossReported: 0,
            deductionsTotal: 0,
            net: null,
            residual: 0,
          },
          trend: [],
        }),
      );
      render();
      await waitFor(() =>
        expect(screen.getAllByText(/No locked run in this period yet/).length).toBeGreaterThan(0),
      );
    });
  });

  describe('what this hub deliberately does not show', () => {
    /**
     * The card LABELS, not the whole card. A footnote may legitimately mention
     * the active workforce — it is the denominator of "employees paid" — and
     * matching on card text would fail on that while proving nothing.
     */
    const kpiLabels = () =>
      cards().map((c) => c.querySelector('.line-clamp-2')?.textContent?.trim() ?? '');

    it('owns exactly the five payroll-position questions', async () => {
      resolve(summary());
      render();
      await waitFor(() => expect(cards().length).toBe(5));
      // The payroll ledger read top to bottom: what it cost, what reached
      // people, what the regulator takes, who it covered, whether it can be
      // paid. The run queue moved to the pipeline panel, which is the panel
      // about runs — the counts are still on the page, and still unwindowed.
      expect(kpiLabels()).toEqual([
        'Gross payroll (INR)',
        'Net paid (INR)',
        'SPF contributions',
        'Total employees',
        'Ready to pay',
      ]);
    });

    it('scopes its employee card to payroll, not to the People hub headcount', async () => {
      // A bare headcount belongs to People. This card exists because the
      // question here is coverage — how much of the workforce this run
      // actually reached — so it must carry the run split, not just a total.
      resolve(summary());
      render();
      const card = (await screen.findByText('Total employees')).closest('.stat-card');
      expect(card?.textContent).toContain('Paid');
      expect(card?.textContent).toContain('In an open run');
    });

    it('carries no budget variance — that is the Finance hub', async () => {
      resolve(summary());
      render();
      await waitFor(() => expect(cards().length).toBe(5));
      expect(kpiLabels().some((l) => /Budget|Utilization|Planned/i.test(l))).toBe(false);
    });
  });
});
