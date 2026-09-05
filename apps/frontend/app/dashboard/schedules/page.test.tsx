import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor, within } from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import scheduleService from '@/services/scheduleService';
import type {
  SchedulePeriodStats,
  SchedulesHubSummary,
} from '@/types/schedules';
import SchedulesHubPage from './page';

vi.mock('@/services/scheduleService', () => ({
  default: { hubSummary: vi.fn() },
}));

const hubSummary = vi.mocked(scheduleService.hubSummary);

const stats = (over: Partial<SchedulePeriodStats> = {}): SchedulePeriodStats => ({
  activeHeadcount: 10,
  scheduledEmployees: 6,
  unscheduled: 4,
  shiftRows: 22,
  workingDays: 5,
  scheduledToday: 3,
  coverageRate: 60,
  coverageGaps: 2,
  conflicts: { onHoliday: 1, onWeeklyOff: 1, overlaps: 0, total: 2 },
  ...over,
});

function summary(
  anchor: string | undefined,
  over: Partial<SchedulesHubSummary> = {},
): SchedulesHubSummary {
  const isCurrent = anchor === undefined;
  return {
    period: 'week',
    anchor: anchor ?? '2026-03-11',
    range: {
      start: isCurrent ? '2026-03-09' : '2026-03-02',
      end: isCurrent ? '2026-03-15' : '2026-03-08',
      through: isCurrent ? '2026-03-15' : '2026-03-08',
      label: isCurrent ? '9 – 15 Mar 2026' : '2 – 8 Mar 2026',
      prevAnchor: '2026-03-04',
      nextAnchor: '2026-03-18',
      // A roster is a PLAN, so the stepper walks forward from the current
      // window as well as back — unlike the attendance hub.
      hasNext: true,
      isCurrent,
    },
    periodStats: stats(),
    previousStats: stats({ coverageRate: 50 }),
    previousRange: { start: '2026-03-02', end: '2026-03-08', label: '2 – 8 Mar 2026' },
    trendKind: 'day',
    trend: [
      {
        key: '2026-03-09',
        label: '9 Mar',
        expected: 10,
        scheduled: 6,
        unassigned: 4,
        coverageRate: 60,
      },
      // Friday: the branch rests, so nobody is expected and the rate is unknown.
      {
        key: '2026-03-13',
        label: '13 Mar',
        expected: 0,
        scheduled: 0,
        unassigned: 0,
        coverageRate: null,
      },
    ],
    shiftMix: [
      { type: 'NIGHT', count: 14, employees: 2, share: 33.3 },
      { type: 'FULL_DAY', count: 8, employees: 4, share: 66.7 },
    ],
    status: {
      assigned: 4,
      unassigned: 4,
      onHoliday: 1,
      onWeeklyOff: 1,
      overlaps: 0,
    },
    staffCoverage: {
      activeBaseline: 10,
      flexibleExcluded: 3,
      hours: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        label: `${hour}`,
        onShift: hour === 9 ? 4 : 0,
      })),
    },
    departments: [
      {
        id: 'd1',
        name: 'Operations',
        headcount: 6,
        scheduled: 6,
        unscheduled: 0,
        rate: 100,
        hasData: true,
      },
      {
        id: 'd2',
        name: 'Maintenance',
        headcount: 4,
        scheduled: 0,
        unscheduled: 4,
        rate: 0,
        hasData: true,
      },
    ],
    attention: {
      unassigned: { count: 4, names: ['Imran Sheikh', 'Deepak Rao'] },
      onHoliday: {
        count: 1,
        samples: [
          {
            employeeId: 'e9',
            fullName: 'Ahmed Al Farsi',
            date: '2026-03-12',
            reason: 'National Day',
          },
        ],
      },
      onWeeklyOff: {
        count: 1,
        samples: [
          {
            employeeId: 'e8',
            fullName: 'Ravi Kumar',
            date: '2026-03-13',
            reason: 'Weekly off',
          },
        ],
      },
      overlaps: { count: 0, samples: [] },
      thinnestDay: { date: '2026-03-12', label: '12 Mar', scheduled: 1 },
    },
    holidays: [{ date: '2026-03-12', name: 'National Day' }],
    ...over,
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
});

describe('Schedules hub', () => {
  it('offers Week, Month and Year — and no Today', async () => {
    // "Who is rostered today" is a calendar screen. A scheduler opens this page
    // to ask whether the coming week is covered, so Week leads.
    renderWithProviders(<SchedulesHubPage />);

    for (const period of ['Week', 'Month', 'Year']) {
      expect(await screen.findByRole('button', { name: period })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Today' })).toBeNull();
  });

  it('steps FORWARD out of the current window, because a roster is a plan', async () => {
    // The attendance hub refuses this: a day that has not happened cannot be an
    // absence. Here the whole point is reading ahead.
    renderWithProviders(<SchedulesHubPage />);

    const next = await screen.findByRole('button', { name: /next period/i });
    await waitFor(() => expect(next).toBeEnabled());
  });

  it('re-queries when the period changes and drops the stale anchor', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SchedulesHubPage />);

    await screen.findByRole('button', { name: 'Month' });
    await user.click(screen.getByRole('button', { name: 'Month' }));

    // An anchor picked inside a week is meaningless in a month, so it is
    // cleared rather than carried over.
    await waitFor(() =>
      expect(hubSummary).toHaveBeenCalledWith('month', undefined),
    );
  });

  it('names the people behind the loudest number', async () => {
    renderWithProviders(<SchedulesHubPage />);

    expect(await screen.findByText('4 with no shift')).toBeInTheDocument();
    expect(screen.getByText('Imran Sheikh')).toBeInTheDocument();
    expect(screen.getByText('Deepak Rao')).toBeInTheDocument();
  });

  it('lists every conflict kind it found, and none it did not', async () => {
    renderWithProviders(<SchedulesHubPage />);

    expect(await screen.findByText('1 rostered on a holiday')).toBeInTheDocument();
    expect(screen.getByText('1 rostered on a weekly off')).toBeInTheDocument();
    expect(screen.queryByText(/overlapping shifts/)).toBeNull();
  });

  it('says how many flexible shifts the hourly curve leaves out', async () => {
    // Silently dropping them would under-draw the morning with no way to tell.
    renderWithProviders(<SchedulesHubPage />);

    expect(
      await screen.findByText(
        '3 flexible shifts have no fixed window and are not drawn here.',
      ),
    ).toBeInTheDocument();
  });

  it('prints an em dash for an unknown rate, never 0%', async () => {
    // `null` is what the server sends when nothing was expected. 0% would be a
    // claim that nobody was scheduled on a day the branch was shut.
    hubSummary.mockResolvedValue({
      success: true,
      data: summary(undefined, {
        periodStats: stats({
          activeHeadcount: 0,
          scheduledEmployees: 0,
          unscheduled: 0,
          coverageRate: null,
          conflicts: { onHoliday: 0, onWeeklyOff: 0, overlaps: 0, total: 0 },
        }),
        departments: [
          {
            id: 'd3',
            name: 'Empty',
            headcount: 0,
            scheduled: 0,
            unscheduled: 0,
            rate: null,
            hasData: false,
          },
        ],
      }),
    });

    renderWithProviders(<SchedulesHubPage />);

    await waitFor(() => expect(screen.getAllByText('—').length).toBeGreaterThan(0));
    // Two KPIs share the sentence — "on shift today" and "nobody rostered" both
    // divide by the headcount — so this asserts the phrasing, not a count.
    expect(
      (await screen.findAllByText('Nobody is active, so there is nothing to cover.'))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('0.0%')).toBeNull();
  });

  it('reports a department with no roster at 0%, not as missing data', async () => {
    // Unlike the attendance hub, the absence of a roster row IS the fact — and
    // it is the most actionable number the panel carries.
    renderWithProviders(<SchedulesHubPage />);

    // The panel header renders immediately and the meters only once the query
    // lands, so this waits on the ROW rather than on the heading.
    const row = await screen.findByText('Maintenance');
    const panel = row.closest('.surface-panel') as HTMLElement;

    expect(within(panel).getByText('Department coverage')).toBeInTheDocument();
    expect(within(panel).getByText('Operations')).toBeInTheDocument();
    expect(within(panel).getByText('0%')).toBeInTheDocument();
    expect(within(panel).getByText('100%')).toBeInTheDocument();
  });

  it('leaves the strip clear rather than empty when there is nothing to act on', async () => {
    hubSummary.mockResolvedValue({
      success: true,
      data: summary(undefined, {
        attention: {
          unassigned: { count: 0, names: [] },
          onHoliday: { count: 0, samples: [] },
          onWeeklyOff: { count: 0, samples: [] },
          overlaps: { count: 0, samples: [] },
          thinnestDay: null,
        },
      }),
    });

    renderWithProviders(<SchedulesHubPage />);

    expect(
      await screen.findByText('The roster is covered and nothing contradicts it.'),
    ).toBeInTheDocument();
  });

  it('says coverage is unknown when the request failed, not that it is clear', async () => {
    hubSummary.mockRejectedValue(new Error('boom'));
    renderWithProviders(<SchedulesHubPage />);

    expect(await screen.findByText('Coverage could not be read.')).toBeInTheDocument();
  });
});
