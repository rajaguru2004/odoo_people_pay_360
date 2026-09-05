import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, within } from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import type { OrganizationHubSummary } from '@/types/organizationHub';

const hubState = vi.hoisted(() => ({
  current: {} as {
    summary?: OrganizationHubSummary;
    months: 6 | 12;
    setMonths: () => void;
    loading: boolean;
    fetching: boolean;
    failed: boolean;
  },
}));

vi.mock('@/hooks/useOrganizationHub', () => ({
  useOrganizationHub: () => hubState.current,
}));

import OrganizationHubPage from './page';

/** The seed: twenty people across two branches and seven departments. */
const SEEDED: OrganizationHubSummary = {
  months: 6,
  headcount: { active: 18, inactive: 2, total: 20 },
  branches: {
    total: 2,
    withoutManager: 0,
    rows: [
      { id: 'b1', name: 'Head Office', employees: 11, share: 61.1 },
      { id: 'b2', name: 'Sohar Plant', employees: 7, share: 38.9 },
    ],
  },
  departments: {
    total: 7,
    withoutHead: 1,
    unmanagedHeadcount: 2,
    rows: [
      { id: 'd1', name: 'Operations', employees: 4, share: 22.2 },
      { id: 'd2', name: 'Human Resources', employees: 3, share: 16.7 },
    ],
    headless: [{ id: 'd3', name: 'Administration', employees: 2 }],
  },
  managers: {
    total: 6,
    deptHeads: 6,
    branchManagers: 0,
    supervisors: 5,
    widestSpan: { supervisorId: 'e1', name: 'Ahmed Al Farsi', department: 'Operations', reports: 3 },
  },
  changeRequests: { pending: 2, approved: 0, rejected: 0, cancelled: 0, total: 2 },
  unassigned: { noBranch: 0, noDepartment: 0 },
  growth: {
    months: 6,
    buckets: [
      { key: '2026-04', label: 'Apr 2026', joiners: 1, leavers: 0, net: 1, headcountEnd: 17 },
      { key: '2026-05', label: 'May 2026', joiners: 2, leavers: 1, net: 1, headcountEnd: 18 },
    ],
    netChange: 2,
    growthPct: 12.5,
  },
};

/** The five cards the hub promises, keyed by their test id. */
const KPI_IDS = [
  'kpi-employees',
  'kpi-branches',
  'kpi-departments',
  'kpi-managers',
  'kpi-change-requests',
];

function setHub(overrides: Partial<typeof hubState.current>) {
  hubState.current = {
    summary: SEEDED,
    months: 6,
    setMonths: vi.fn(),
    loading: false,
    fetching: false,
    failed: false,
    ...overrides,
  };
}

beforeEach(() => {
  useAuthStore.setState({
    user: { id: 'u1', email: 'admin@peoplepay360.com', role: 'ADMIN', isActive: true },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });
  setHub({});
});

describe('Organisation hub', () => {
  it('reports the seeded structure as real figures', () => {
    renderWithProviders(<OrganizationHubPage />);

    expect(within(screen.getByTestId('kpi-employees')).getByText('18')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-branches')).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-departments')).getByText('7')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-managers')).getByText('6')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('kpi-change-requests')).getByText('2'),
    ).toBeInTheDocument();
  });

  /**
   * The single most important behaviour on this page. A failed aggregate must
   * never be printed as zero: an empty organisation and an unreachable endpoint
   * are different claims, and 0 makes the wrong one on the reader's behalf.
   */
  it('prints an em dash rather than a zero when the aggregate failed', () => {
    setHub({ summary: undefined, failed: true });
    renderWithProviders(<OrganizationHubPage />);

    for (const id of KPI_IDS) {
      const card = screen.getByTestId(id);
      expect(within(card).getByText('—')).toBeInTheDocument();
      expect(within(card).queryByText('0')).not.toBeInTheDocument();
    }
  });

  it('keeps the em dash even when a stale summary is still in the cache', () => {
    // `placeholderData` hands the last good payload back while a refetch is
    // failing, so `failed` — not the absence of data — has to be what decides.
    setHub({ summary: SEEDED, failed: true });
    renderWithProviders(<OrganizationHubPage />);

    for (const id of KPI_IDS) {
      expect(within(screen.getByTestId(id)).getByText('—')).toBeInTheDocument();
    }
  });

  it('names the department nobody is in charge of', () => {
    renderWithProviders(<OrganizationHubPage />);

    expect(screen.getByText(/Administration has no head/i)).toBeInTheDocument();
  });

  it('offers a tile per child route of the module', () => {
    renderWithProviders(<OrganizationHubPage />);

    expect(screen.getAllByTestId('module-tile')).toHaveLength(4);
  });
});
