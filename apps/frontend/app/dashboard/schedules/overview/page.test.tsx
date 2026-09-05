import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import scheduleService from '@/services/scheduleService';
import branchService from '@/services/branchService';
import departmentService from '@/services/departmentService';
import type { ScheduleOverview } from '@/types/schedules';
import WorkingSchedulePage from './page';

vi.mock('@/services/scheduleService', () => ({
  default: { overview: vi.fn() },
}));
vi.mock('@/services/branchService', () => ({ default: { list: vi.fn() } }));
vi.mock('@/services/departmentService', () => ({ default: { list: vi.fn() } }));

const overview = vi.mocked(scheduleService.overview);
const branches = vi.mocked(branchService.list);
const departments = vi.mocked(departmentService.list);

/**
 * March 2026. The 13th is a Friday and the 14th a Saturday, which is what the
 * Head Office calendar below rests on; the plant rests Friday only.
 */
const HQ = {
  branchId: 'b1',
  zone: 'Asia/Muscat',
  officeStart: '08:00',
  officeEnd: '17:00',
  weeklyOffDays: [5, 6],
};

const PLANT = {
  branchId: 'b2',
  zone: 'Asia/Muscat',
  officeStart: '07:00',
  officeEnd: '16:00',
  weeklyOffDays: [5],
};

const data: ScheduleOverview = {
  range: { startDate: '2026-03-01', endDate: '2026-03-31' },
  employees: [
    {
      id: 'e1',
      employeeCode: 'EMP-0001',
      fullName: 'Aisha Al Balushi',
      avatarUrl: null,
      status: 'ACTIVE',
      branchId: 'b1',
      branchName: 'Head Office',
      departmentId: 'd1',
      departmentName: 'Executive',
    },
    {
      id: 'e2',
      employeeCode: 'EMP-0012',
      fullName: 'Hassan Al Hinai',
      avatarUrl: null,
      status: 'ACTIVE',
      branchId: 'b2',
      branchName: 'Sohar Plant',
      departmentId: 'd2',
      departmentName: 'Operations',
    },
  ],
  schedules: [
    {
      id: 's1',
      employeeId: 'e2',
      date: '2026-03-10',
      shiftType: 'NIGHT',
      startTime: '20:00',
      endTime: '04:00',
      isWorkDay: true,
      notes: 'Night rotation',
      hours: 8,
    },
    // Rostered OFF for this one person: a row exists, but no hours are owed.
    {
      id: 's2',
      employeeId: 'e1',
      date: '2026-03-11',
      shiftType: 'FULL_DAY',
      startTime: '08:00',
      endTime: '17:00',
      isWorkDay: false,
      notes: null,
      hours: 9,
    },
  ],
  leaves: [{ id: 'l1', employeeId: 'e1', date: '2026-03-12' }],
  holidays: [
    { id: 'h1', date: '2026-03-20', name: 'National Day', branchId: null },
    { id: 'h2', date: '2026-03-25', name: 'Plant Shutdown', branchId: 'b2' },
  ],
  branchCalendars: [HQ, PLANT],
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-03-11T09:00:00.000Z'));

  useAuthStore.setState({
    user: { id: 'u1', email: 'admin@example.com', role: 'ADMIN', isActive: true },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });

  overview.mockResolvedValue({ success: true, data });
  branches.mockResolvedValue({ success: true, data: [] });
  departments.mockResolvedValue({ success: true, data: [] });
});

// Fake timers are process-wide. Left running they break every LATER test file
// that drives a real user interaction, which is a failure with no connection to
// the test that caused it.
afterEach(() => {
  vi.useRealTimers();
});

describe('Working schedule grid', () => {
  it('draws a column for every day of the month', async () => {
    renderWithProviders(<WorkingSchedulePage />);

    expect(await screen.findByTestId('schedule-day-header-1')).toBeInTheDocument();
    expect(screen.getByTestId('schedule-day-header-31')).toBeInTheDocument();
    expect(screen.getByTestId('schedule-current-month')).toHaveTextContent(
      'March 2026',
    );
  });

  it('shades each branch by its OWN working week, not one company weekend', async () => {
    // Head Office rests Friday and Saturday; the plant rests Friday only. One
    // shared calendar would close the plant on a day it is open.
    renderWithProviders(<WorkingSchedulePage />);

    const hqSaturday = await screen.findByTestId(
      'schedule-cell-EMP-0001-2026-03-14',
    );
    const plantSaturday = screen.getByTestId('schedule-cell-EMP-0012-2026-03-14');

    expect(hqSaturday).toHaveAttribute('data-weekly-off', 'true');
    expect(plantSaturday).toHaveAttribute('data-weekly-off', 'false');
  });

  it('applies a branch holiday only to that branch', async () => {
    renderWithProviders(<WorkingSchedulePage />);

    const plantShutdown = await screen.findByTestId(
      'schedule-cell-EMP-0012-2026-03-25',
    );
    const hqSameDay = screen.getByTestId('schedule-cell-EMP-0001-2026-03-25');

    expect(plantShutdown).toHaveAttribute('data-holiday', 'true');
    expect(hqSameDay).toHaveAttribute('data-holiday', 'false');
  });

  it('applies a company-wide holiday to everybody', async () => {
    renderWithProviders(<WorkingSchedulePage />);

    expect(
      await screen.findByTestId('schedule-cell-EMP-0001-2026-03-20'),
    ).toHaveAttribute('data-holiday', 'true');
    expect(screen.getByTestId('schedule-cell-EMP-0012-2026-03-20')).toHaveAttribute(
      'data-holiday',
      'true',
    );
  });

  it('measures a night shift across midnight rather than as a negative', async () => {
    renderWithProviders(<WorkingSchedulePage />);

    const cell = await screen.findByTestId('schedule-cell-EMP-0012-2026-03-10');
    expect(cell).toHaveAttribute('data-shift-type', 'NIGHT');
    expect(cell).toHaveTextContent('8h');
  });

  it('prints an em dash for a day rostered OFF, never "0h"', async () => {
    // A row with isWorkDay false is a deliberate day off for one person. "0h"
    // would read as a data error.
    renderWithProviders(<WorkingSchedulePage />);

    const cell = await screen.findByTestId('schedule-cell-EMP-0001-2026-03-11');
    expect(cell).toHaveTextContent('—');
    expect(cell).not.toHaveTextContent('0h');
  });

  it('marks a recorded leave day as leave', async () => {
    renderWithProviders(<WorkingSchedulePage />);

    const cell = await screen.findByTestId('schedule-cell-EMP-0001-2026-03-12');
    expect(cell).toHaveTextContent('On leave');
  });

  it('filters by name without going back to the server', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkingSchedulePage />);

    await screen.findByTestId('schedule-employee-row-EMP-0001');
    const callsBefore = overview.mock.calls.length;

    await user.type(screen.getByTestId('schedule-search'), 'Hassan');

    await waitFor(() =>
      expect(screen.queryByTestId('schedule-employee-row-EMP-0001')).toBeNull(),
    );
    expect(screen.getByTestId('schedule-employee-row-EMP-0012')).toBeInTheDocument();
    // A name is a filter over rows already on screen; round-tripping it would
    // put a spinner between every keystroke.
    expect(overview.mock.calls.length).toBe(callsBefore);
  });

  it('re-queries when the month steps, because the window changed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkingSchedulePage />);

    await screen.findByTestId('schedule-current-month');
    await user.click(screen.getByTestId('schedule-prev-month'));

    await waitFor(() =>
      expect(screen.getByTestId('schedule-current-month')).toHaveTextContent(
        'February 2026',
      ),
    );
    await waitFor(() =>
      expect(overview).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: '2026-02-01', endDate: '2026-02-28' }),
      ),
    );
  });

  it('says the load failed rather than rendering a quiet empty month', async () => {
    overview.mockRejectedValue(new Error('boom'));
    renderWithProviders(<WorkingSchedulePage />);

    expect(await screen.findByTestId('schedule-error')).toBeInTheDocument();
  });
});
