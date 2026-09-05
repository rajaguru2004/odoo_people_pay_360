import { describe, expect, it, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import TimeAttendanceHubPage from './page';
import type { AttendanceHubSummary } from '@/types/attendanceHub';

/**
 * The Time & Attendance hub.
 *
 * Four properties are worth pinning, all of them things that were wrong before:
 *
 *  1. The KPI cards follow the Today / Week / Month / Year selector — and change
 *     LABEL with it. "Present today: 6" over a month figure would be a lie the
 *     reader cannot see, so a month reads "Attendance: 75%" instead.
 *  2. Rates divide by EXPECTED — the branch working calendar minus approved
 *     leave — not by headcount, so a weekend is not mass absence.
 *  3. A rate with nothing to divide by prints as unknown, never as 0%.
 *  4. The correction queue is judged by AGE, not size: three waiting a week is
 *     worse than ten waiting an hour, and a count cannot say so.
 */

vi.mock('@/services/attendanceService', () => ({
  default: { getHubSummary: vi.fn() },
}));
vi.mock('@/lib/axios', () => ({ default: { get: vi.fn() } }));

// Both hero panels measure their container, which jsdom reports as zero.
vi.mock('@/components/attendance/hub/PresenceRing', () => ({
  default: ({ present, total, onLeave }: any) => (
    <div data-testid="ring">{`${present}/${total}/${onLeave}`}</div>
  ),
}));
vi.mock('@/components/attendance/hub/DepartmentAttendanceBars', () => ({
  default: ({ rows, periodLabel }: any) => (
    <div data-testid="dept">{`${rows?.length ?? 0}|${rows?.[0]?.name ?? ''}|${periodLabel ?? ''}`}</div>
  ),
}));

import attendanceService from '@/services/attendanceService';
import axiosInstance from '@/lib/axios';

const getHubSummary = vi.mocked(attendanceService.getHubSummary);
const axiosGet = vi.mocked(axiosInstance.get);

const DAY = 86_400_000;

let correctionStats: any;
function routeAxios() {
  axiosGet.mockImplementation(
    (url: string) =>
      (correctionStats instanceof Error
        ? Promise.reject(correctionStats)
        : Promise.resolve({ data: correctionStats })) as never,
  );
}

/** A settled day: 20 expected, 14 in, 3 of them late, 2 on leave, 4 absent. */
function hub(overrides: Partial<AttendanceHubSummary> = {}): AttendanceHubSummary {
  return {
    period: 'today',
    anchor: '2026-08-23',
    range: {
      start: '2026-08-23',
      end: '2026-08-23',
      through: '2026-08-23',
      label: 'Aug 23',
      prevAnchor: '2026-08-22',
      nextAnchor: '2026-08-24',
      hasNext: false,
      isCurrent: true,
    },
    today: {
      date: '2026-08-23',
      expected: 20,
      present: 14,
      onTime: 11,
      late: 3,
      absent: 4,
      onLeave: 2,
      notCheckedOut: 2,
      notCheckedIn: 4,
      avgWorkHours: 7.4,
      presentRate: 70,
      lateRate: 21.4,
      absentRate: 20,
      onTimeRate: 55,
      settled: true,
    },
    yesterday: {
      date: '2026-08-22',
      expected: 20,
      present: 16,
      onTime: 15,
      late: 1,
      absent: 4,
      onLeave: 0,
      notCheckedOut: 0,
      notCheckedIn: 4,
      avgWorkHours: 8.0,
      presentRate: 80,
      lateRate: 6.3,
      absentRate: 20,
      onTimeRate: 75,
      settled: true,
    },
    // `period: 'today'` by default, so periodStats IS today's day.
    periodStats: {
      expected: 20,
      present: 14,
      late: 3,
      absent: 4,
      onLeave: 2,
      attendanceRate: 70,
      lateRate: 21.4,
      absentRate: 20,
      avgWorkHours: 7.4,
      lateOccurrences: 3,
      daysCounted: 1,
      bucketCount: 16,
    },
    // Yesterday, on the same terms — what every delta compares against.
    previousStats: {
      expected: 20,
      present: 16,
      late: 1,
      absent: 4,
      onLeave: 0,
      attendanceRate: 80,
      lateRate: 6.3,
      absentRate: 20,
      avgWorkHours: 8,
      lateOccurrences: 1,
      daysCounted: 1,
      bucketCount: 16,
    },
    previousRange: { start: '2026-08-22', end: '2026-08-22', label: 'Aug 22' },
    trendKind: 'day',
    trend: [
      {
        key: '2026-08-22',
        label: 'Aug 22',
        expected: 20,
        present: 16,
        onTime: 15,
        late: 1,
        absent: 4,
        onLeave: 0,
        attendanceRate: 80,
      },
      {
        key: '2026-08-23',
        label: 'Aug 23',
        expected: 20,
        present: 14,
        onTime: 11,
        late: 3,
        absent: 4,
        onLeave: 2,
        attendanceRate: 70,
      },
    ],
    departments: [
      {
        id: 'd1',
        name: 'Ops',
        headcount: 8,
        expected: 160,
        present: 100,
        late: 12,
        absent: 60,
        onLeave: 0,
        rate: 62.5,
        hasData: true,
      },
    ],
    arrivalPattern: [
      { hour: 8, label: '8 AM', onTime: 9, late: 0 },
      { hour: 9, label: '9 AM', onTime: 2, late: 3 },
    ],
    shifts: {
      shiftCount: 3,
      source: 'roster',
      scheduled: 20,
      checkedIn: 14,
      onShift: 11,
      late: 3,
      absent: 4,
      onLeave: 2,
      yetToCheckIn: 4,
      shifts: [{ type: 'FULL_DAY', count: 20 }],
    },
    attention: {
      notCheckedIn: { count: 4, names: ['Sam Ali', 'Ravi P'] },
      notCheckedOut: { count: 2, names: ['Meera Nair'] },
      overScheduledHours: { count: 1, names: ['Karim Idris'] },
      pendingCorrections: 2,
      absent: { count: 4, names: ['Karim Idris'] },
      late: { count: 3, names: ['Asha Rahman'] },
    },
    ...overrides,
  };
}

/** The same database seen as a month: 400 expected days, 300 worked. */
function monthHub(): AttendanceHubSummary {
  const base = hub();
  return {
    ...base,
    period: 'month',
    range: {
      ...base.range,
      start: '2026-08-01',
      end: '2026-08-31',
      label: 'Aug 2026',
      prevAnchor: '2026-07-01',
      nextAnchor: '2026-09-01',
    },
    periodStats: {
      expected: 400,
      present: 300,
      late: 40,
      absent: 90,
      onLeave: 10,
      attendanceRate: 75,
      lateRate: 13.3,
      absentRate: 22.5,
      avgWorkHours: 7.9,
      lateOccurrences: 40,
      daysCounted: 23,
      bucketCount: 23,
    },
    previousStats: {
      expected: 380,
      present: 300,
      late: 20,
      absent: 70,
      onLeave: 10,
      attendanceRate: 78.9,
      lateRate: 6.7,
      absentRate: 18.4,
      avgWorkHours: 8.1,
      lateOccurrences: 20,
      daysCounted: 22,
      bucketCount: 22,
    },
    previousRange: { start: '2026-07-01', end: '2026-07-31', label: 'Jul 2026' },
  };
}

function seed(summary: AttendanceHubSummary = hub()) {
  getHubSummary.mockResolvedValue({ data: summary } as never);
  correctionStats = {
    pending: 2,
    olderThan3Days: 1,
    oldestPendingAt: new Date(Date.now() - 5 * DAY).toISOString(),
    avgResolutionHours: 6.5,
    decidedSampleSize: 12,
  };
  routeAxios();
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ hasHydrated: true });
  seed();
});

describe('the time & attendance hub', () => {
  it('leads with who turned up, measured against who was expected', async () => {
    renderWithProviders(<TimeAttendanceHubPage />, { role: 'ADMIN' });

    await waitFor(() => expect(screen.getByText('Present today')).toBeTruthy());
    // 70% of 20 EXPECTED — not of headcount, which would report every branch
    // holiday as a collapse in attendance.
    expect(screen.getByText('70.0% of 20 expected in')).toBeTruthy();

    const card = document.querySelector('a.stat-card[href="/dashboard/attendance"]')!;
    expect(card.textContent).toContain('14');
  });

  it('compares the window with the one before it, in points', async () => {
    renderWithProviders(<TimeAttendanceHubPage />, { role: 'ADMIN' });

    // 70% today against 80% yesterday is ten POINTS down. Calling it "12.5%"
    // invites the reader to think twelve people.
    await waitFor(() => expect(screen.getByText('10.0 pts')).toBeTruthy());
    // Named, so the comparison cannot be mistaken for the period beside it.
    expect(screen.getAllByText('vs Aug 22').length).toBeGreaterThan(0);
  });

  it('turns each attention item into a count that links to its list', async () => {
    renderWithProviders(<TimeAttendanceHubPage />, { role: 'ADMIN' });

    await waitFor(() => expect(screen.getByText("4 haven't checked in")).toBeTruthy());
    expect(screen.getByText("2 haven't checked out")).toBeTruthy();
    expect(screen.getByText('2 corrections pending')).toBeTruthy();
    expect(screen.getByText('1 over scheduled hours')).toBeTruthy();
    // And the names behind the loudest one, so the strip is workable as it is.
    expect(screen.getByText('Sam Ali')).toBeTruthy();
  });

  it('moves the KPI cards with the period, and relabels them', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TimeAttendanceHubPage />, { role: 'ADMIN' });

    // Today: counts, labelled as today.
    await waitFor(() => expect(screen.getByText('Present today')).toBeTruthy());
    const presentCard = () =>
      document.querySelector('a.stat-card[href="/dashboard/attendance"]')!;
    expect(presentCard().textContent).toContain('14');

    seed(monthHub());
    await user.click(screen.getByRole('button', { name: 'Month' }));
    await waitFor(() => expect(getHubSummary).toHaveBeenCalledWith('month', undefined));

    // Month: a RATE, under a label that says so. 300 employee-days present is
    // not a number anybody can hold, and "Present today: 300" would be false.
    // ("Attendance" also appears in the tooltip legend, so assert on the card.)
    await waitFor(() => expect(presentCard().textContent).toContain('Attendance'));
    expect(screen.queryByText('Present today')).toBeNull();
    await waitFor(() => expect(presentCard().textContent).toContain('75.0%'));
    expect(screen.getByText('300 of 400 expected days worked')).toBeTruthy();
    expect(screen.getByText('Absence rate')).toBeTruthy();
    expect(screen.getByText('Late arrivals')).toBeTruthy();
  });

  it('keeps the correction queue live whatever the period says', async () => {
    // A queue is what is waiting NOW. "Corrections raised last March" is not
    // something anybody acts on, so this one card never follows the selector.
    const user = userEvent.setup();
    renderWithProviders(<TimeAttendanceHubPage />, { role: 'ADMIN' });

    await waitFor(() => expect(screen.getByText('Corrections waiting')).toBeTruthy());
    const card = () =>
      document.querySelector('a.stat-card[href="/dashboard/attendance/corrections"]')!;
    const before = card().textContent;

    seed(monthHub());
    await user.click(screen.getByRole('button', { name: 'Year' }));
    await waitFor(() => expect(getHubSummary).toHaveBeenCalledWith('year', undefined));

    expect(card().textContent).toBe(before);
  });

  it('pages the period with the anchors the server returned', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TimeAttendanceHubPage />, { role: 'ADMIN' });

    await waitFor(() => expect(screen.getByTestId('period-label').textContent).toBe('Aug 23'));
    // Forward is refused on the current period — there is no future to page into.
    expect(screen.getByRole('button', { name: 'Next period' }).hasAttribute('disabled')).toBe(true);

    // The same arrows step a day back on Today, and a month back on Month.
    await user.click(screen.getByRole('button', { name: 'Previous period' }));
    await waitFor(() =>
      expect(getHubSummary).toHaveBeenCalledWith('today', '2026-08-22'),
    );
  });

  it('says the day is still open rather than calling missing punches absences', async () => {
    seed(
      hub({
        today: { ...hub().today, settled: false, absent: 0, notCheckedIn: 6 },
        periodStats: { ...hub().periodStats, absent: 0 },
      }),
    );
    renderWithProviders(<TimeAttendanceHubPage />, { role: 'ADMIN' });

    await waitFor(() =>
      expect(screen.getByText('Day still open · 6 yet to check in')).toBeTruthy(),
    );
    // Nobody has been declared absent while the day can still fix itself.
    const card = document.querySelector('a.stat-card[href="/dashboard/attendance"]')!;
    expect(card).toBeTruthy();
  });

  it('says nothing rather than 0% when a rate has nothing to divide by', async () => {
    seed(
      hub({
        today: {
          ...hub().today,
          expected: 0,
          present: 0,
          late: 0,
          absent: 0,
          presentRate: null,
          lateRate: null,
          absentRate: null,
          onTimeRate: null,
          avgWorkHours: null,
        },
        periodStats: {
          ...hub().periodStats,
          expected: 0,
          present: 0,
          late: 0,
          absent: 0,
          attendanceRate: null,
          lateRate: null,
          absentRate: null,
          avgWorkHours: null,
        },
      }),
    );
    renderWithProviders(<TimeAttendanceHubPage />, { role: 'ADMIN' });

    await waitFor(() => expect(screen.getByText('Absent today')).toBeTruthy());
    expect(screen.getByText('Nobody is scheduled to work today')).toBeTruthy();
    expect(screen.getByText('Nobody has checked in yet')).toBeTruthy();
    // The hours card cannot be computed, so it shows an em dash — not 0.0h.
    const hours = document.querySelector('a.stat-card[href="/dashboard/attendance/reports"]')!;
    expect(hours.textContent).toContain('—');
  });

  it('judges the correction queue by how long it has waited', async () => {
    renderWithProviders(<TimeAttendanceHubPage />, { role: 'ADMIN' });

    await waitFor(() =>
      expect(screen.getByText('Oldest waiting 5d · usually answered in 6.5h')).toBeTruthy(),
    );
    // Five days old is the danger tone, not merely the warning one.
    const card = document.querySelector('a.stat-card[href="/dashboard/attendance/corrections"]')!;
    expect(card.querySelector('.bg-status-error-bg')).toBeTruthy();
  });

  it('shows an em dash for the correction count when that request fails', async () => {
    correctionStats = new Error('500');
    routeAxios();

    renderWithProviders(<TimeAttendanceHubPage />, { role: 'ADMIN' });

    await waitFor(() => expect(screen.getByText('Corrections waiting')).toBeTruthy());
    const card = document.querySelector('a.stat-card[href="/dashboard/attendance/corrections"]')!;
    expect(card.textContent).toContain('—');
    // And it must not claim the queue is empty while admitting it cannot read it.
    expect(card.textContent).toContain('Could not read the queue');
    expect(card.textContent).not.toContain('Queue is empty');
  });

  it('says everyone is accounted for when nothing needs chasing', async () => {
    seed(
      hub({
        attention: {
          notCheckedIn: { count: 0, names: [] },
          notCheckedOut: { count: 0, names: [] },
          overScheduledHours: { count: 0, names: [] },
          pendingCorrections: 0,
          absent: { count: 0, names: [] },
          late: { count: 0, names: [] },
        },
      }),
    );
    correctionStats = {
      pending: 0,
      olderThan3Days: 0,
      oldestPendingAt: null,
      avgResolutionHours: null,
      decidedSampleSize: 0,
    };
    routeAxios();

    renderWithProviders(<TimeAttendanceHubPage />, { role: 'ADMIN' });

    await waitFor(() => expect(screen.getByText('Everyone is accounted for today.')).toBeTruthy());
    expect(screen.getByText('Queue is empty')).toBeTruthy();
  });

  it('offers no Add new button — nothing is created from this hub', async () => {
    renderWithProviders(<TimeAttendanceHubPage />, { role: 'ADMIN' });

    await waitFor(() => expect(screen.getByText('Present today')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /add new/i })).toBeNull();
    // Export stays, because it is wired to something.
    expect(screen.getByRole('button', { name: /export/i })).toBeTruthy();
  });
});
