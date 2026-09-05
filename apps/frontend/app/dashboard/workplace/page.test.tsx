import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import WorkplaceHubPage from './page';

/**
 * The Workplace hub, rebuilt onto the Time & Attendance template.
 *
 * Two rules this page has to keep straight, and they pull in opposite
 * directions. A FAILED read shows an em dash, because a zero would be a claim.
 * An EMPTY result shows its real value, because "no project is overdue" is
 * true — but it ships with how many projects carry no end date, or a zero there
 * reads as full coverage rather than as no coverage.
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
  assets: {
    total: 86,
    byStatus: { AVAILABLE: 26, ASSIGNED: 52, IN_REPAIR: 4, LOST: 2, RETIRED: 2 },
    held: 52,
    heldAsOfPrev: 49,
    heldDelta: { value: 6.1, direction: 'up', absolute: 3 },
    unacknowledged: 7,
    warrantyExpired: 3,
    warrantyExpiring60: 5,
    valueAtRisk: 41200,
    needingAttention: 9,
    assignedInWindow: 6,
    prevAssignedInWindow: 4,
    assignedDelta: { value: 50, direction: 'up', absolute: 2 },
    returnedInWindow: 3,
  },
  clearances: {
    outstandingCount: 2,
    top: [
      {
        assignmentId: 'aa1',
        assetTag: 'LAP-004',
        assetName: 'ThinkPad',
        employeeName: 'Kabir Gupta',
        employeeStatus: 'TERMINATED',
        assignedAt: '2026-02-01T00:00:00.000Z',
      },
    ],
  },
  letters: {
    pending: 4,
    byStatus: { PENDING: 4, ISSUED: 11, REJECTED: 1 },
    byTemplate: [{ key: 'SALARY_CERTIFICATE', count: 9 }],
    oldestPendingAt: '2026-08-10T00:00:00.000Z',
    requestedInWindow: 6,
    issuedInWindow: 5,
    prevIssuedInWindow: 3,
    issuedDelta: { value: 66.7, direction: 'up', absolute: 2 },
    avgIssueTurnaroundDays: 2.4,
    rejectTurnaroundMeasurable: false,
  },
  projects: {
    total: 12,
    byStatus: { PLANNING: 2, ACTIVE: 8, ON_HOLD: 1, COMPLETED: 1, CANCELLED: 0 },
    overdue: 2,
    dueIn30Days: 3,
    withoutEndDate: 4,
    projectsAreBranchScoped: false,
  },
  trendKind: 'month',
  trend: Array.from({ length: 12 }, (_, i) => ({
    key: `2026-${String(i + 1).padStart(2, '0')}`,
    label: 'M',
    value: i === 7 ? 6 : 2,
    segments: [
      { key: 'issued', value: i === 7 ? 5 : 2 },
      { key: 'outstanding', value: i === 7 ? 1 : 0 },
    ],
  })),
};

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ hasHydrated: true });
  axiosGet.mockResolvedValue({ data: payload } as never);
});

describe('the workplace hub', () => {
  it('renders five KPI cards, one per concern', async () => {
    renderWithProviders(<WorkplaceHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Assets with staff')).toBeTruthy());
    for (const label of [
      'Assets with staff',
      'Assets needing attention',
      'Pending letter requests',
      'Active projects',
      'Projects overdue',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('reads one aggregate instead of fanning out', async () => {
    renderWithProviders(<WorkplaceHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Assets with staff')).toBeTruthy());
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(axiosGet).toHaveBeenCalledWith('/workplace/hub-summary');
  });

  it('itemises the composite attention card so the number can be read', async () => {
    renderWithProviders(<WorkplaceHubPage />, { role: 'ADMIN' });
    // A composite is only honest if the reader can see what produced it.
    await waitFor(() =>
      expect(screen.getByText('4 in repair · 2 lost · 3 out of warranty')).toBeTruthy(),
    );
  });

  it('names the leaver whose clearance is holding up a settlement', async () => {
    renderWithProviders(<WorkplaceHubPage />, { role: 'ADMIN' });
    await waitFor(() =>
      expect(screen.getByText('2 leavers still hold company property')).toBeTruthy(),
    );
    expect(screen.getByText('Kabir Gupta')).toBeTruthy();
  });

  it('shows zero overdue projects with how many have no end date to miss', async () => {
    axiosGet.mockResolvedValue({
      data: { ...payload, projects: { ...payload.projects, overdue: 0, withoutEndDate: 4 } },
    } as never);
    renderWithProviders(<WorkplaceHubPage />, { role: 'ADMIN' });

    await waitFor(() => expect(screen.getByText('Projects overdue')).toBeTruthy());
    // 0 is correct here: the query succeeded and found nothing. The em-dash
    // contract covers failed reads, not empty results.
    expect(screen.getByText('4 projects have no end date')).toBeTruthy();
  });

  it('draws all five project statuses, including the two /projects/stats drops', async () => {
    renderWithProviders(<WorkplaceHubPage />, { role: 'ADMIN' });
    // Waiting on the panel TITLE is not enough — `PanelHeader` renders before
    // the fetch resolves, so the assertions below would run against the empty
    // state and pass or fail for the wrong reason.
    await waitFor(() => {
      const missing = ['Planning', 'Active', 'On hold', 'Completed'].filter(
        (label) => screen.queryAllByText(label).length === 0,
      );
      expect(missing).toEqual([]);
    });
    // CANCELLED is at zero and is deliberately not drawn — a legend row for a
    // status with no rows is noise, and the total below already accounts for it.
    expect(screen.queryAllByText('Cancelled')).toHaveLength(0);
  });

  it('declares that project figures do not narrow with the branch', async () => {
    renderWithProviders(<WorkplaceHubPage />, { role: 'ADMIN' });
    await waitFor(() =>
      expect(
        screen.getByText(
          'Project figures are company-wide and do not narrow with the branch selector.',
        ),
      ).toBeTruthy(),
    );
  });

  it('declares that rejection turnaround is not measurable', async () => {
    renderWithProviders(<WorkplaceHubPage />, { role: 'ADMIN' });
    await waitFor(() =>
      expect(
        screen.getByText(
          'Turnaround covers issued letters only — rejections carry no decision date.',
        ),
      ).toBeTruthy(),
    );
  });

  it('says turnaround is unknown, not zero, when nothing has been issued', async () => {
    axiosGet.mockResolvedValue({
      data: { ...payload, letters: { ...payload.letters, avgIssueTurnaroundDays: null } },
    } as never);
    renderWithProviders(<WorkplaceHubPage />, { role: 'ADMIN' });

    await waitFor(() => expect(screen.getByText('Letter workload')).toBeTruthy());
    // "0 days" would read as instant service.
    expect(screen.queryByText('0 days')).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows an em dash and refuses to say all-clear when the read fails', async () => {
    axiosGet.mockRejectedValue(new Error('500'));
    renderWithProviders(<WorkplaceHubPage />, { role: 'ADMIN' });

    await waitFor(() => expect(screen.getByText('Assets with staff')).toBeTruthy());
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(
      screen.getByText('Could not read the workplace summary — this is not an all-clear.'),
    ).toBeTruthy();
    expect(screen.queryByText('Nothing needs chasing.')).toBeNull();
  });

  it('carries no period filter', async () => {
    renderWithProviders(<WorkplaceHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Assets with staff')).toBeTruthy());
    expect(screen.queryByText('Week')).toBeNull();
    expect(screen.queryByTestId('period-label')).toBeNull();
  });
});
