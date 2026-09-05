import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import attendanceService from '@/services/attendanceService';
import attendanceCorrectionService from '@/services/attendanceCorrectionService';
import type { AttendanceHubSummary, HubDaySnapshot, HubPeriodStats } from '@/types/attendanceHub';
import TimeAttendanceHubPage from './page';

vi.mock('@/services/attendanceService', () => ({
  default: { hubSummary: vi.fn() },
}));

vi.mock('@/services/attendanceCorrectionService', () => ({
  default: { stats: vi.fn() },
}));

const hubSummary = vi.mocked(attendanceService.hubSummary);
const correctionStats = vi.mocked(attendanceCorrectionService.stats);

const day: HubDaySnapshot = {
  date: '2026-09-05',
  expected: 0,
  present: 0,
  onTime: 0,
  late: 0,
  absent: 0,
  onLeave: 0,
  notCheckedOut: 0,
  notCheckedIn: 0,
  avgWorkHours: null,
  presentRate: null,
  lateRate: null,
  absentRate: null,
  onTimeRate: null,
  settled: true,
};

/** Nobody was expected, so every rate is genuinely unknown. */
const unknownStats: HubPeriodStats = {
  expected: 0,
  present: 0,
  late: 0,
  absent: 0,
  onLeave: 0,
  attendanceRate: null,
  lateRate: null,
  absentRate: null,
  avgWorkHours: null,
  lateOccurrences: 0,
  daysCounted: 0,
  bucketCount: 0,
};

function summary(anchor: string | undefined): AttendanceHubSummary {
  // The current window has nothing later to step into; a window paged back does.
  const isCurrent = anchor === undefined;
  return {
    period: 'month',
    anchor: anchor ?? '2026-09-05',
    range: {
      start: isCurrent ? '2026-09-01' : '2026-08-01',
      end: isCurrent ? '2026-09-30' : '2026-08-31',
      through: isCurrent ? '2026-09-05' : '2026-08-31',
      label: isCurrent ? 'September 2026' : 'August 2026',
      prevAnchor: '2026-08-15',
      nextAnchor: '2026-09-15',
      hasNext: !isCurrent,
      isCurrent,
    },
    today: day,
    yesterday: day,
    periodStats: unknownStats,
    previousStats: unknownStats,
    previousRange: { start: '2026-08-01', end: '2026-08-31', label: 'August 2026' },
    trendKind: 'day',
    trend: [],
    departments: [],
    arrivalPattern: [],
    shifts: {
      shiftCount: 0,
      source: 'calendar',
      scheduled: 0,
      checkedIn: 0,
      onShift: 0,
      late: 0,
      absent: 0,
      onLeave: 0,
      yetToCheckIn: 0,
      shifts: [],
    },
    attention: {
      notCheckedIn: { count: 0, names: [] },
      notCheckedOut: { count: 0, names: [] },
      overScheduledHours: { count: 0, names: [] },
      pendingCorrections: 0,
      absent: { count: 0, names: [] },
      late: { count: 0, names: [] },
    },
  };
}

beforeEach(() => {
  useAuthStore.setState({
    user: { id: 'u1', email: 'admin@example.com', role: 'ADMIN', isActive: true },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });

  hubSummary.mockImplementation(async (_period, anchor) => ({
    success: true,
    data: summary(anchor),
  }));

  correctionStats.mockResolvedValue({
    success: true,
    data: { pending: 0, approved: 0, rejected: 0, cancelled: 0, total: 0, avgResolutionHours: null },
  });
});

describe('Time & attendance hub', () => {
  it('offers all four periods', async () => {
    renderWithProviders(<TimeAttendanceHubPage />);

    for (const period of ['Today', 'Week', 'Month', 'Year']) {
      expect(await screen.findByRole('button', { name: period })).toBeInTheDocument();
    }
  });

  it('will not step forward out of the current period', async () => {
    // The stepper must not walk into a window that has not happened: every
    // figure behind it would be zero, and a page of zeros is indistinguishable
    // from a page that failed to load.
    const user = userEvent.setup();
    renderWithProviders(<TimeAttendanceHubPage />);

    const next = await screen.findByRole('button', { name: /next period/i });
    await waitFor(() => expect(next).toBeDisabled());

    await user.click(screen.getByRole('button', { name: /previous period/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /next period/i })).toBeEnabled(),
    );
    expect(screen.getByTestId('hub-period-label')).toHaveTextContent('August 2026');
  });

  it('keeps the stepper dim until there is a window to step from', async () => {
    // Both arrows page by anchors that arrive WITH the summary, so before the
    // first one lands there is nowhere to step. Left live over that gap the
    // press is simply swallowed and the label never moves, which reads as a
    // dead button rather than a slow one — and on a loaded server the gap is
    // long enough for a reader, or a browser test, to land inside it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    hubSummary.mockImplementationOnce(async (_period, anchor) => {
      await held;
      return { success: true, data: summary(anchor) };
    });

    renderWithProviders(<TimeAttendanceHubPage />);

    const previous = await screen.findByRole('button', { name: /previous period/i });
    expect(previous).toBeDisabled();

    release();
    await waitFor(() => expect(previous).toBeEnabled());
  });

  it('prints an em dash for a rate nobody could compute, never 0%', async () => {
    // A rate is null when nothing was expected. 0% is a claim that everybody
    // failed to turn up, which on a closed office is simply false.
    renderWithProviders(<TimeAttendanceHubPage />);

    await waitFor(() => expect(screen.getAllByText('—').length).toBeGreaterThan(0));
    expect(screen.queryByText('0.0%')).toBeNull();
  });
});
