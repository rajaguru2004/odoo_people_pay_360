import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import PeopleHubPage from './page';

/**
 * The People hub, on the Time & Attendance template.
 *
 * It answers ONE question — what is about to happen to the workforce. Two Phase
 * C rules are still asserted here and must stay asserted:
 *
 *   1. no headcount-by-department chart (that moved to Organization), and
 *   2. no who-is-in-today figure (Time & Attendance owns today).
 *
 * Plus the permit rules Phase C bought with a production incident: a failed
 * permit lookup must never read as "nothing expires soon".
 */

vi.mock('@/services/employeeService', () => ({
  default: { getPeopleHubSummary: vi.fn() },
}));
vi.mock('@/services/visaService', () => ({
  default: { getSummary: vi.fn(), getExpiring: vi.fn() },
}));

import employeeService from '@/services/employeeService';
import visaService from '@/services/visaService';

const getHub = vi.mocked(employeeService.getPeopleHubSummary);
const visaSummary = vi.mocked(visaService.getSummary);
const visaExpiring = vi.mocked(visaService.getExpiring);

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

function summary(overrides: Record<string, unknown> = {}) {
  return {
    months: 6,
    headcount: {
      active: 121,
      inactive: 4,
      byStatus: [
        { status: 'ACTIVE', count: 121 },
        { status: 'INACTIVE', count: 4 },
      ],
    },
    lifecycle: {
      joinersThisMonth: 4,
      leaversThisMonth: 2,
      netChangeThisMonth: 2,
      previousMonth: { joiners: 1, leavers: 3 },
      startingSoon: [
        { id: 'n1', fullName: 'Priya Menon', startDate: inDays(3), department: 'Sales' },
        { id: 'n2', fullName: 'Dev Patel', startDate: inDays(21), department: null },
      ],
      probationEndingSoon: [
        { contractId: 'c1', employeeId: 'e1', fullName: 'Tara Shah', endDate: inDays(9) },
      ],
    },
    contracts: {
      total: 40,
      active: 36,
      expired: 2,
      expiringSoon: 5,
      expiring: [
        {
          id: 'ct1',
          employeeId: 'e5',
          fullName: 'Omar Said',
          endDate: inDays(10),
          daysUntilExpiry: 10,
        },
      ],
    },
    terminations: { awaitingApproval: 2, thisMonth: 1 },
    statusSplit: [
      { key: 'active', label: 'Active', count: 110 },
      { key: 'probation', label: 'Probation', count: 8 },
      { key: 'notice', label: 'Notice', count: 3 },
      { key: 'inactive', label: 'Inactive', count: 4 },
    ],
    trend: {
      months: 6,
      buckets: [
        { key: '2026-03', label: 'Mar 2026', joiners: 3, leavers: 1, net: 2, headcountEnd: 113 },
        { key: '2026-04', label: 'Apr 2026', joiners: 4, leavers: 2, net: 2, headcountEnd: 115 },
        { key: '2026-05', label: 'May 2026', joiners: 2, leavers: 0, net: 2, headcountEnd: 117 },
        { key: '2026-06', label: 'Jun 2026', joiners: 3, leavers: 1, net: 2, headcountEnd: 119 },
        { key: '2026-07', label: 'Jul 2026', joiners: 1, leavers: 3, net: -2, headcountEnd: 117 },
        { key: '2026-08', label: 'Aug 2026', joiners: 4, leavers: 2, net: 2, headcountEnd: 121 },
      ],
      netChange: 8,
      turnoverRate: 7.9,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ hasHydrated: true });
  getHub.mockResolvedValue({ data: summary() } as never);
  visaSummary.mockResolvedValue({
    data: { active: 20, expiringSoon: 3, expired: 1, cancelled: 0, renewedThisYear: 4, alertDays: 30 },
  } as never);
  visaExpiring.mockResolvedValue({
    data: [
      { id: 'v-1', daysUntilExpiry: 4, documentNumber: 'A1', employee: { fullName: 'Nadia Farouk' } },
      { id: 'v-2', daysUntilExpiry: 21, documentNumber: 'A2', employee: { fullName: 'Omar Said' } },
      { id: 'v-3', daysUntilExpiry: -2, documentNumber: 'A3', employee: { fullName: 'Lina Haddad' } },
    ],
  } as never);
});

describe('the people hub', () => {
  it('leads with movement and the deadlines behind it', async () => {
    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });

    await screen.findByText('4 inactive records');
    // Scoped by the card that carries each label: several cards legitimately
    // point at the directory, so href alone does not identify one.
    const cards = Array.from(document.querySelectorAll('a.stat-card'));
    for (const label of [
      'Active employees',
      'New joiners',
      'Terminations',
      'Contracts expiring',
      'Pending actions',
    ]) {
      expect([label, cards.some((c) => c.textContent?.includes(label))]).toEqual([label, true]);
    }
    // Pending actions goes to the approvals queue, not to the directory again.
    expect(document.querySelector('a.stat-card[href="/dashboard/approvals"]')).toBeTruthy();
  });

  it('keeps headcount as context under the movement, not as the headline', async () => {
    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });
    expect(await screen.findByText('4 inactive records')).toBeTruthy();
    expect(screen.getByText('on staff')).toBeTruthy();
  });

  it('names the window a delta is measured against', async () => {
    // "+3" on its own is not checkable; "vs last month" points at a window the
    // reader can go and look at.
    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });
    const labels = await screen.findAllByText('vs last month');
    expect(labels.length).toBeGreaterThan(0);
  });

  it('splits the pending-actions figure so the number is never a mystery', async () => {
    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });
    // 3 permits + 1 probation + 2 terminations.
    expect(await screen.findByText('3 permits · 1 probations · 2 terminations')).toBeTruthy();
    const card = document.querySelector('a.stat-card[href="/dashboard/approvals"]')!;
    expect(card.textContent).toContain('6');
  });

  it('sorts the expiry feed by urgency, not by record order', async () => {
    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });

    await screen.findByText('Lina Haddad');
    const text = document.body.textContent ?? '';
    // Already expired first, then 4 days, then 21.
    expect(text.indexOf('Lina Haddad')).toBeLessThan(text.indexOf('Nadia Farouk'));
    expect(text.indexOf('Nadia Farouk')).toBeLessThan(text.indexOf('Omar Said'));
  });

  it('says how overdue an expired permit already is', async () => {
    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });
    expect(await screen.findByText('expired 2 days ago')).toBeTruthy();
  });

  it('draws the workforce as a flow and states the identity it is drawing', async () => {
    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });
    expect(await screen.findByText('Workforce trend')).toBeTruthy();
    expect(
      screen.getByText('Ending headcount = starting + joiners − leavers'),
    ).toBeTruthy();
  });

  it('shows where everybody stands, with the derivation disclosed', async () => {
    // Probation and notice are derived from contracts, not stored on the
    // employee record, and the panel says so rather than implying a field.
    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });
    expect(await screen.findByText('Employee status')).toBeTruthy();
    expect(
      screen.getByText(
        'Probation and notice are derived from contracts, not stored on the record',
      ),
    ).toBeTruthy();
  });

  it('measures the lifecycle bars in time remaining, not in quantity', async () => {
    // Every row is exactly one person, so a bar drawn from a count would say
    // nothing. Length is how close the deadline is.
    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });
    expect(await screen.findByText('Joining · Priya Menon · Sales')).toBeTruthy();
    expect(screen.getByText('in 3 days')).toBeTruthy();
    // Soonest first, whichever table the date came out of.
    const panel = screen.getByText('Employee lifecycle').closest('.surface-panel')!;
    const text = panel.textContent ?? '';
    expect(text.indexOf('Priya Menon')).toBeLessThan(text.indexOf('Tara Shah'));
    expect(text.indexOf('Tara Shah')).toBeLessThan(text.indexOf('Omar Said'));
  });

  it('does not draw the headcount distribution — that moved to Organization', async () => {
    // The Phase C duplication rule, still enforced.
    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });
    await screen.findByText('Active employees');
    expect(screen.queryByText('Where people sit')).toBeNull();
    expect(screen.queryByText(/Department workforce/)).toBeNull();
  });

  it('carries no who-is-in-today card — Time & Attendance owns today', async () => {
    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });
    await screen.findByText('Active employees');
    expect(screen.queryByText(/On leave today/i)).toBeNull();
    expect(screen.queryByText(/Present today/i)).toBeNull();
  });

  it('renders no period filter row in the header', async () => {
    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });
    await screen.findByText('Active employees');
    expect(screen.queryByTestId('period-label')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Today$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Years$/ })).toBeNull();
  });

  it('keeps the trend window inside the chart that it moves', async () => {
    const { user } = renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });
    await screen.findByText('Workforce trend');

    await user.click(screen.getByRole('button', { name: '12M' }));
    await screen.findByText('Workforce trend');
    expect(getHub).toHaveBeenCalledWith(12);
  });

  it('escalates the permit feed when something expires within a week', async () => {
    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });
    const item = await screen.findByText('Nadia Farouk');
    // Critical tone inside seven days — this one is four days out.
    expect(item.closest('a')?.className).toContain('status-error');
  });

  it('falls quiet about permits when that module answers 403, and keeps the rest', async () => {
    visaSummary.mockRejectedValue(new Error('403'));
    visaExpiring.mockRejectedValue(new Error('403'));

    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });

    expect(await screen.findByText('Active employees')).toBeTruthy();
    expect(screen.queryByText('Permit runway')).toBeNull();
    // The lifecycle and movement panels keep working.
    expect(screen.getByText('Employee lifecycle')).toBeTruthy();
    expect(screen.getByText('Headcount movement')).toBeTruthy();
  });

  it('refuses to call a failed permit lookup an all-clear', async () => {
    // An empty list and a failed request look identical downstream, and "no
    // permit expires in the next 30 days" is the worst possible guess.
    visaExpiring.mockRejectedValue(new Error('500'));

    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });

    const warnings = await screen.findAllByText(
      'Could not read the permit list — this is not an all-clear.',
    );
    expect(warnings.length).toBeGreaterThan(0);
    // The summary still answered, so the runway keeps showing what IS known.
    expect(screen.getByText('Permit runway')).toBeTruthy();
  });

  it('prints an em dash, never a zero, when the aggregate failed', async () => {
    getHub.mockRejectedValue(new Error('500'));

    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });

    // Exactly ONE "not an all-clear" sentence: the attention strip owns it.
    const warnings = await screen.findAllByText(
      'Could not read the lifecycle — this is not an all-clear.',
    );
    expect(warnings).toHaveLength(1);
    // The FIGURE, not the whole card: the footnote legitimately says
    // "Ending within 30 days", so a card-wide scan for "0" proves nothing.
    const figure = document
      .querySelector('a.stat-card[href="/dashboard/contracts"]')!
      .querySelector('span.tabular-nums')!;
    expect(figure.textContent).toBe('—');
  });

  it('reports fewer leavers as good news, not as a fall', async () => {
    // goodDirection has to be told which way is which: two people leaving
    // instead of three is an improvement, and an unqualified red arrow is wrong.
    renderWithProviders(<PeopleHubPage />, { role: 'ADMIN' });
    await screen.findByText('Active employees');
    const card = document.querySelector(
      'a.stat-card[href="/dashboard/contracts/terminations"]',
    )!;
    // 2 this month against 3 last month.
    expect(card.textContent).toContain('-1');
  });
});
