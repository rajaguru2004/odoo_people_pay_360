import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import TalentHubPage from './page';

/**
 * The Talent hub, rebuilt onto the Time & Attendance template.
 *
 * The page this replaces counted rewards and disciplinary actions in the
 * BROWSER over one page of each list, and rendered a panel admitting it. These
 * cases pin the three honesty rules that survived the rebuild: one request, a
 * completion rate that stays unknown rather than becoming 0%, and a fifth KPI
 * that counts disciplinary ACTIONS because there is no case to count.
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
  grievances: {
    open: 7,
    byStatus: { OPEN: 2, ACKNOWLEDGED: 1, INVESTIGATING: 4, RESOLVED: 9, CLOSED: 3 },
    openStatuses: ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'],
    agingDays: 14,
    olderThanAgingDays: 2,
    oldestOpenAt: '2026-07-02T00:00:00.000Z',
    unassignedOpen: 1,
    raisedInWindow: 3,
    resolvedInWindow: 2,
    openAsOfPrev: 6,
    openDelta: { value: 16.7, direction: 'up', absolute: 1 },
  },
  training: {
    activeCourses: 5,
    upcomingSessions30Days: 2,
    sessionsByStatus: { SCHEDULED: 2, COMPLETED: 4 },
    nominationsByStatus: {
      PENDING: 5,
      APPROVED: 4,
      ATTENDED: 12,
      NO_SHOW: 4,
      REJECTED: 6,
      CANCELLED: 1,
    },
    obligations: 20,
    attended: 12,
    completionRate: 60,
    attendedInWindow: 6,
    prevAttendedInWindow: 4,
    attendedDelta: { value: 50, direction: 'up', absolute: 2 },
    certificatesExpiring60: 3,
    sessionsEndedUnrecorded: 2,
  },
  appraisal: {
    runsByStatus: { COMPLETED: 2, RUNNING: 1 },
    runsCompleted: 2,
    referenceRun: {
      id: 'run-live',
      status: 'RUNNING',
      periodLabel: 'H1 2026',
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-06-30T00:00:00.000Z',
      totalEmployees: 40,
      completedEmployees: 30,
      completedAt: null,
    },
    completionRate: 75,
    prevCompletionRate: 50,
    completionDelta: { value: 25, direction: 'up', absolute: 25 },
    resultsByStatus: { COMPLETED: 30, PENDING: 8, FAILED: 1, DEGRADED: 1 },
    failedOrDegraded: 2,
  },
  conduct: {
    rewardsCount: 4,
    rewardsAmount: 2500,
    disciplinesCount: 1,
    disciplinesAmount: 75,
    prevRewardsCount: 2,
    prevDisciplinesCount: 3,
    rewardsDelta: { value: 100, direction: 'up', absolute: 2 },
    disciplinesDelta: { value: -66.7, direction: 'down', absolute: -2 },
  },
  trendKind: 'month',
  trend: Array.from({ length: 12 }, (_, i) => ({
    key: `2026-${String(i + 1).padStart(2, '0')}`,
    label: 'M',
    value: i === 7 ? 5 : 1,
    segments: [
      { key: 'rewards', value: i === 7 ? 4 : 1 },
      { key: 'disciplines', value: i === 7 ? 1 : 0 },
    ],
  })),
};

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ hasHydrated: true });
  axiosGet.mockResolvedValue({ data: payload } as never);
});

describe('the talent hub', () => {
  it('renders five KPI cards, one per concern', async () => {
    renderWithProviders(<TalentHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Appraisal completion')).toBeTruthy());
    for (const label of [
      'Appraisal completion',
      'Training completion',
      'Open grievances',
      'Rewards this month',
      'Disciplinary actions',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('counts conduct on the server, in one request', async () => {
    renderWithProviders(<TalentHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Appraisal completion')).toBeTruthy());
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(axiosGet).toHaveBeenCalledWith('/talent/hub-summary');
  });

  it('no longer tells the reader its own numbers are browser counts', async () => {
    renderWithProviders(<TalentHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Appraisal completion')).toBeTruthy());
    // The panel the old hub carried, verbatim from its message file.
    expect(screen.queryByText(/counted in the browser/i)).toBeNull();
  });

  it('says the fifth card counts actions, because there is no case to close', async () => {
    renderWithProviders(<TalentHubPage />, { role: 'ADMIN' });
    await waitFor(() =>
      expect(screen.getByText('Actions recorded — there is no case to close')).toBeTruthy(),
    );
  });

  it('reports appraisal completion against the run in flight', async () => {
    renderWithProviders(<TalentHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('30 of 40 in H1 2026')).toBeTruthy());
    expect(screen.getAllByText('75.0%').length).toBeGreaterThan(0);
  });

  it('says appraisal completion is unknown, not 0%, when no run exists', async () => {
    axiosGet.mockResolvedValue({
      data: {
        ...payload,
        appraisal: {
          ...payload.appraisal,
          referenceRun: null,
          completionRate: null,
          completionDelta: null,
          resultsByStatus: {},
          failedOrDegraded: 0,
        },
      },
    } as never);
    renderWithProviders(<TalentHubPage />, { role: 'ADMIN' });

    await waitFor(() =>
      expect(screen.getAllByText('No appraisal run yet').length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.queryByText('0.0%')).toBeNull();
  });

  it('says completion is unknown when a run has not resolved its scope', async () => {
    axiosGet.mockResolvedValue({
      data: {
        ...payload,
        appraisal: {
          ...payload.appraisal,
          referenceRun: { ...payload.appraisal.referenceRun, status: 'PENDING', totalEmployees: 0, completedEmployees: 0 },
          completionRate: null,
          completionDelta: null,
        },
      },
    } as never);
    renderWithProviders(<TalentHubPage />, { role: 'ADMIN' });

    await waitFor(() =>
      expect(screen.getByText('The run has not resolved its scope yet')).toBeTruthy(),
    );
  });

  it('shows an em dash and refuses to say all-clear when the read fails', async () => {
    axiosGet.mockRejectedValue(new Error('500'));
    renderWithProviders(<TalentHubPage />, { role: 'ADMIN' });

    await waitFor(() => expect(screen.getByText('Open grievances')).toBeTruthy());
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(
      screen.getByText('Could not read the talent summary — this is not an all-clear.'),
    ).toBeTruthy();
    expect(screen.queryByText('Nothing needs chasing.')).toBeNull();
  });

  it('surfaces training that finished with no attendance recorded', async () => {
    renderWithProviders(<TalentHubPage />, { role: 'ADMIN' });
    await waitFor(() =>
      expect(screen.getByText('2 nominations with no attendance recorded')).toBeTruthy(),
    );
  });

  it('carries no period filter', async () => {
    renderWithProviders(<TalentHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Open grievances')).toBeTruthy());
    expect(screen.queryByText('Week')).toBeNull();
    expect(screen.queryByTestId('period-label')).toBeNull();
  });
});
