import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import type { LegalDocument, LegalDocumentSummary } from '@/types/legalDocument';
import type { PeopleHubSummary } from '@/types/peopleHub';
import PeopleHubPage from './page';

/**
 * The hub is mocked at the HOOK, not at axios.
 *
 * What this screen has to get right is how it reads three separate answers —
 * the lifecycle aggregate, the permit summary and the permit expiry list — and
 * that logic lives entirely between the hook's return value and the DOM. Mocking
 * the transport instead would test react-query.
 */
const usePeopleHub = vi.fn();
vi.mock('@/hooks/usePeopleHub', () => ({
  usePeopleHub: (...args: unknown[]) => usePeopleHub(...args),
}));

const summary: PeopleHubSummary = {
  months: 6,
  headcount: {
    active: 18,
    inactive: 2,
    byStatus: [
      { status: 'ACTIVE', count: 18 },
      { status: 'TERMINATED', count: 1 },
      { status: 'ON_LEAVE', count: 1 },
    ],
  },
  lifecycle: {
    joinersThisMonth: 3,
    leaversThisMonth: 1,
    netChangeThisMonth: 2,
    previousMonth: { joiners: 1, leavers: 2 },
    startingSoon: [
      { id: 'e-1', fullName: 'Noor Al Kindi', startDate: '2026-09-20', department: 'Operations' },
    ],
    probationEndingSoon: [
      { contractId: 'c-9', employeeId: 'e-9', fullName: 'Sara Nasser', endDate: '2026-09-12' },
    ],
  },
  contracts: {
    total: 20,
    active: 18,
    expired: 1,
    expiringSoon: 2,
    expiring: [
      { id: 'c-1', employeeId: 'e-2', fullName: 'Ahmed Al Farsi', endDate: '2026-09-18', daysUntilExpiry: 13 },
    ],
  },
  terminations: { awaitingApproval: 1, thisMonth: 1 },
  statusSplit: [
    { key: 'active', label: 'Active', count: 16 },
    { key: 'probation', label: 'On probation', count: 2 },
    { key: 'inactive', label: 'Inactive', count: 2 },
  ],
  trend: {
    months: 6,
    buckets: [
      { key: '2026-04', label: 'Apr 2026', joiners: 2, leavers: 1, net: 1, headcountEnd: 17 },
      { key: '2026-05', label: 'May 2026', joiners: 3, leavers: 0, net: 3, headcountEnd: 20 },
    ],
    netChange: 4,
    turnoverRate: 5.5,
  },
};

const visaSummary: LegalDocumentSummary = {
  active: 9,
  expiringSoon: 2,
  expired: 1,
  cancelled: 0,
  renewedThisYear: 3,
  alertDays: 30,
};

const permit = {
  id: 'v-1',
  employeeId: 'e-3',
  category: 'VISA',
  status: 'ACTIVE',
  documentNumber: 'VISA-OM-0003',
  country: 'Oman',
  issueDate: '2024-09-01',
  expiryDate: '2026-09-14',
  isCurrent: true,
  daysUntilExpiry: 9,
  isExpiringSoon: true,
  employee: { id: 'e-3', employeeCode: 'EMP-0003', firstName: 'Maryam', lastName: 'Al Zadjali' },
  createdAt: '2024-09-01T00:00:00.000Z',
  updatedAt: '2024-09-01T00:00:00.000Z',
} as unknown as LegalDocument;

/** The hook's return value, with the happy path as the baseline. */
function hubState(overrides: Record<string, unknown> = {}) {
  return {
    summary,
    months: 6 as const,
    setMonths: vi.fn(),
    loading: false,
    fetching: false,
    failed: false,
    visaSummary,
    visaExpiring: [permit],
    visaLoading: false,
    visaUnavailable: false,
    visaExpiringFailed: false,
    ...overrides,
  };
}

beforeEach(() => {
  usePeopleHub.mockReset();
  useAuthStore.setState({
    user: { id: 'u1', email: 'hr@example.com', role: 'ADMIN', isActive: true },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });
});

describe('People hub', () => {
  it('reports the workforce figures the aggregate answered with', () => {
    usePeopleHub.mockReturnValue(hubState());
    renderWithProviders(<PeopleHubPage />);

    expect(screen.getByTestId('kpi-active')).toHaveTextContent('18');
    expect(screen.getByTestId('kpi-joiners')).toHaveTextContent('3');
    expect(screen.getByTestId('kpi-terminations')).toHaveTextContent('1');
    expect(screen.getByTestId('kpi-contracts')).toHaveTextContent('2');
    // One permit, one probation and one termination, summed on the card and
    // split in its footnote.
    expect(screen.getByTestId('kpi-pending')).toHaveTextContent('3');
  });

  it('prints an em dash rather than a zero when the aggregate failed', () => {
    usePeopleHub.mockReturnValue(hubState({ summary: undefined, failed: true }));
    renderWithProviders(<PeopleHubPage />);

    for (const key of ['kpi-active', 'kpi-joiners', 'kpi-terminations', 'kpi-contracts', 'kpi-pending']) {
      const card = screen.getByTestId(key);
      expect(card).toHaveTextContent('—');
      // Zero is a claim; a failed read cannot support it.
      expect(card).not.toHaveTextContent(/(^|\s)0(\s|$)/);
    }
  });

  it('says the lifecycle read failed rather than leaving the strip silent', () => {
    usePeopleHub.mockReturnValue(hubState({ summary: undefined, failed: true }));
    renderWithProviders(<PeopleHubPage />);

    expect(screen.getByText(/lifecycle figures could not be read/i)).toBeInTheDocument();
  });

  it('drops only the permit panel when the permit module is out of reach', () => {
    usePeopleHub.mockReturnValue(
      hubState({
        visaSummary: undefined,
        visaExpiring: [],
        visaUnavailable: true,
        visaExpiringFailed: true,
      }),
    );
    renderWithProviders(<PeopleHubPage />);

    // The permit panel removes itself…
    expect(screen.queryByText(/work permit runway/i)).not.toBeInTheDocument();
    // …and everything fed by the aggregate keeps working.
    expect(screen.getByTestId('kpi-active')).toHaveTextContent('18');
    expect(screen.getByText(/headcount movement/i)).toBeInTheDocument();
    expect(screen.getByText(/due next/i)).toBeInTheDocument();
  });

  it('draws the permit panel when permits are reachable', () => {
    usePeopleHub.mockReturnValue(hubState());
    renderWithProviders(<PeopleHubPage />);

    expect(screen.getByText(/work permit runway/i)).toBeInTheDocument();
    // The window is named rather than left as an undefined "soon".
    expect(screen.getByText(/within 30 days/i)).toBeInTheDocument();
  });

  it('never reports a failed permit lookup as nothing expiring', () => {
    // The summary answered but the expiry list did not. An empty list and a
    // failed request look identical downstream, and "no permit expires soon" is
    // the most dangerous sentence this page could print when it does not know.
    usePeopleHub.mockReturnValue(hubState({ visaExpiring: [], visaExpiringFailed: true }));
    renderWithProviders(<PeopleHubPage />);

    expect(screen.getByText(/permit expiries could not be read/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing falls due in the next 30 days/i)).not.toBeInTheDocument();
    // The tally that would have included them refuses to report a total.
    expect(screen.getByTestId('kpi-pending')).toHaveTextContent('—');
  });
});
