import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import OrganizationHubPage from './page';

/**
 * The Organization hub, on the Time & Attendance template.
 *
 * It answers ONE question — where the workforce sits, and what has nobody in
 * charge of it. The Phase C rule still holds and is still asserted here: no
 * attendance figure appears on this page, because repeating Time & Attendance's
 * numbers is what made three hubs look like three views of one page.
 *
 * The header carries no period filter. Every figure but the growth curve is a
 * fact about the structure right now, and the curve owns its own 6M/12M switch.
 */

vi.mock('@/services/organizationService', () => ({
  default: { getHubSummary: vi.fn() },
}));

import organizationService from '@/services/organizationService';

const getHubSummary = vi.mocked(organizationService.getHubSummary);

function summary(overrides: Record<string, unknown> = {}) {
  return {
    months: 6,
    headcount: { active: 30, inactive: 2, total: 32 },
    branches: {
      total: 3,
      withoutManager: 1,
      rows: [
        { id: 'b1', name: 'Muscat', employees: 18, share: 60 },
        { id: 'b2', name: 'Bengaluru', employees: 12, share: 40 },
        { id: 'b3', name: 'Coimbatore', employees: 0, share: 0 },
      ],
    },
    departments: {
      total: 3,
      withoutHead: 2,
      unmanagedHeadcount: 15,
      rows: [
        { id: 'd1', name: 'Engineering', employees: 15, share: 50 },
        { id: 'd2', name: 'Operations', employees: 9, share: 30 },
        { id: 'd3', name: 'Facilities', employees: 6, share: 20 },
      ],
      headless: [
        { id: 'd2', name: 'Operations', employees: 9 },
        { id: 'd3', name: 'Facilities', employees: 6 },
      ],
    },
    managers: {
      total: 7,
      deptHeads: 1,
      branchManagers: 2,
      supervisors: 5,
      widestSpan: {
        supervisorId: 's1',
        name: 'Asha Rahman',
        department: 'Engineering',
        reports: 14,
      },
    },
    changeRequests: { pending: 5, approved: 8, rejected: 2, cancelled: 0, total: 15 },
    unassigned: { noBranch: 4 },
    growth: {
      months: 6,
      buckets: [
        { key: '2026-03', label: 'Mar 2026', joiners: 1, leavers: 0, net: 1, headcountEnd: 26 },
        { key: '2026-04', label: 'Apr 2026', joiners: 2, leavers: 1, net: 1, headcountEnd: 27 },
        { key: '2026-05', label: 'May 2026', joiners: 0, leavers: 0, net: 0, headcountEnd: 27 },
        { key: '2026-06', label: 'Jun 2026', joiners: 2, leavers: 0, net: 2, headcountEnd: 29 },
        { key: '2026-07', label: 'Jul 2026', joiners: 1, leavers: 1, net: 0, headcountEnd: 29 },
        { key: '2026-08', label: 'Aug 2026', joiners: 2, leavers: 1, net: 1, headcountEnd: 30 },
      ],
      netChange: 5,
      growthPct: 20,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ hasHydrated: true });
  getHubSummary.mockResolvedValue({ data: summary() } as never);
});

describe('the organization hub', () => {
  it('leads with where the workforce sits and what has no owner', async () => {
    renderWithProviders(<OrganizationHubPage />, { role: 'ADMIN' });

    expect(await screen.findByText('Total employees')).toBeTruthy();
    // getAllByText, not getByText: "Branches" and "Departments" are also the
    // structure blocks and the panel links. The KPI is identified by its href.
    for (const [label, href] of [
      ['Branches', '/dashboard/branches'],
      ['Departments', '/dashboard/departments'],
      ['Managers', '/dashboard/supervisor-teams'],
      ['Change requests', '/dashboard/departments/change-requests'],
    ] as const) {
      const card = document.querySelector(`a.stat-card[href="${href}"]`)!;
      expect([label, card.textContent?.includes(label)]).toEqual([label, true]);
    }
  });

  it('turns every inventory count into something to act on', async () => {
    // "Departments: 7" is the same number every week. The count is the LINK;
    // the footnote is the reason to follow it.
    renderWithProviders(<OrganizationHubPage />, { role: 'ADMIN' });

    expect(await screen.findByText('4 people have no branch')).toBeTruthy();
    expect(screen.getByText('1 has no manager')).toBeTruthy();
    expect(screen.getByText('2 have no head · 15 people with no approver')).toBeTruthy();
    expect(screen.getByText('Widest span: Asha Rahman, 14 reports')).toBeTruthy();
    expect(screen.getByText('8 approved · 2 rejected')).toBeTruthy();
  });

  it('names the headless departments so somebody can go and fix them', async () => {
    renderWithProviders(<OrganizationHubPage />, { role: 'ADMIN' });
    expect(await screen.findByText('Operations has no head')).toBeTruthy();
    expect(screen.getByText('Facilities has no head')).toBeTruthy();
  });

  it('escalates a department that has people under it, not just an empty one', async () => {
    // A headless department with nobody in it is untidy; one with staff means
    // those people have no approver, which is an outage.
    renderWithProviders(<OrganizationHubPage />, { role: 'ADMIN' });
    expect(await screen.findByText('9 people')).toBeTruthy();
    expect(screen.getByText('6 people')).toBeTruthy();
  });

  it('draws the department workforce as the main chart', async () => {
    renderWithProviders(<OrganizationHubPage />, { role: 'ADMIN' });
    expect(screen.getByText('Department workforce')).toBeTruthy();
    // The concentration line — no headcount total ever surfaces that one team
    // holds half the company.
    expect(await screen.findByText('Engineering holds 50% of the company')).toBeTruthy();
  });

  it('shows each branch as a share of the workforce, not against the biggest branch', async () => {
    renderWithProviders(<OrganizationHubPage />, { role: 'ADMIN' });
    expect(screen.getByText('Branch workforce')).toBeTruthy();
    expect(await screen.findByText('18 people · 60%')).toBeTruthy();
    expect(screen.getByText('12 people · 40%')).toBeTruthy();
  });

  it('leads the change-request donut with the number somebody must act on', async () => {
    renderWithProviders(<OrganizationHubPage />, { role: 'ADMIN' });
    // Pending appears twice inside this panel by design — once as the ring's
    // sub-caption and once in the legend — so scope to the panel, not the word.
    await screen.findByText('8 approved · 2 rejected');
    const donut = screen.getByText('Pending is what somebody has to act on').closest(
      '.surface-panel',
    )!;
    expect(donut.textContent).toContain('5');
    expect(donut.textContent).toContain('Approved');
  });

  it('trusts the server’s status counts rather than the length of a page', async () => {
    // The bug this endpoint closed: the list route sends no pagination meta, so
    // a hub counting rows under-reported every queue longer than a page.
    renderWithProviders(<OrganizationHubPage />, { role: 'ADMIN' });
    await screen.findByText('8 approved · 2 rejected');
    const card = document.querySelector(
      'a.stat-card[href="/dashboard/departments/change-requests"]',
    )!;
    expect(card.textContent).toContain('5');
  });

  it('carries no attendance figure — that belongs to Time & Attendance', async () => {
    // The Phase C duplication rule, still enforced. If an attendance KPI
    // reappears here, two hubs are answering the same question again.
    renderWithProviders(<OrganizationHubPage />, { role: 'ADMIN' });
    await screen.findByText('8 approved · 2 rejected');
    expect(screen.queryByText(/Departments below/)).toBeNull();
    expect(screen.queryByText(/Attendance by department/)).toBeNull();
    expect(screen.queryByText(/Present today/)).toBeNull();
  });

  it('renders no period filter row in the header', async () => {
    // Nine hubs used to draw Week/Month/Years tabs wired to nothing: they
    // moved, and the page did not.
    renderWithProviders(<OrganizationHubPage />, { role: 'ADMIN' });
    await screen.findByText('Total employees');
    expect(screen.queryByTestId('period-label')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Today$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Years$/ })).toBeNull();
  });

  it('keeps the trend window inside the growth panel', async () => {
    renderWithProviders(<OrganizationHubPage />, { role: 'ADMIN' });
    const panel = (await screen.findByText('Workforce growth')).closest('.surface-panel')!;
    expect(panel.textContent).toContain('6M');
    expect(panel.textContent).toContain('12M');
  });

  it('re-queries when the reader asks for twelve months', async () => {
    const { user } = renderWithProviders(<OrganizationHubPage />, { role: 'ADMIN' });
    await screen.findByText('Workforce growth');

    await user.click(screen.getByRole('button', { name: '12M' }));
    await waitFor(() => expect(getHubSummary).toHaveBeenCalledWith(12));
  });

  it('prints an em dash, never a zero, when the read failed', async () => {
    // "No department is missing a head" is the worst possible guess when the
    // question was never actually answered.
    getHubSummary.mockRejectedValue(new Error('500'));

    renderWithProviders(<OrganizationHubPage />, { role: 'ADMIN' });

    // Exactly ONE "not an all-clear" sentence on the page: the attention strip
    // owns it. It used to print three times — in the strip, on the chart and in
    // the structure blocks — which reads as three separate faults.
    const warnings = await screen.findAllByText(
      'Could not read the structure — this is not an all-clear.',
    );
    expect(warnings).toHaveLength(1);
    // The FIGURE, not the whole card: a footnote may legitimately contain a
    // digit, so a card-wide scan for "0" proves nothing.
    const figure = document
      .querySelector('a.stat-card[href="/dashboard/branches"]')!
      .querySelector('span.tabular-nums')!;
    expect(figure.textContent).toBe('—');
  });

  it('says the structure is healthy only when it actually read it', async () => {
    getHubSummary.mockResolvedValue({
      data: summary({
        branches: { total: 2, withoutManager: 0, rows: [] },
        departments: { total: 2, withoutHead: 0, unmanagedHeadcount: 0, rows: [], headless: [] },
        changeRequests: { pending: 0, approved: 3, rejected: 0, cancelled: 0, total: 3 },
        unassigned: { noBranch: 0 },
        managers: { total: 2, deptHeads: 2, branchManagers: 1, supervisors: 1, widestSpan: null },
      }),
    } as never);

    renderWithProviders(<OrganizationHubPage />, { role: 'ADMIN' });
    expect(await screen.findByText('Nothing in the structure needs attention.')).toBeTruthy();
  });
});
