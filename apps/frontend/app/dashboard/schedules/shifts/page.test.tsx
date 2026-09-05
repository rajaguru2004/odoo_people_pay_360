import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor, within } from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import scheduleService from '@/services/scheduleService';
import workScheduleService from '@/services/workScheduleService';
import employeeService from '@/services/employeeService';
import branchService from '@/services/branchService';
import type { ScheduleCoverage } from '@/types/schedules';
import type { WorkSchedule } from '@/types/attendance';
import ShiftManagementPage from './page';

vi.mock('@/services/scheduleService', () => ({
  default: { coverage: vi.fn() },
}));
vi.mock('@/services/workScheduleService', () => ({
  default: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    bulk: vi.fn(),
  },
}));
vi.mock('@/services/employeeService', () => ({ default: { list: vi.fn() } }));
vi.mock('@/services/branchService', () => ({ default: { list: vi.fn() } }));

const coverage = vi.mocked(scheduleService.coverage);
const listShifts = vi.mocked(workScheduleService.list);
const createShift = vi.mocked(workScheduleService.create);
const updateShift = vi.mocked(workScheduleService.update);
const removeShift = vi.mocked(workScheduleService.remove);
const bulkShifts = vi.mocked(workScheduleService.bulk);
const listEmployees = vi.mocked(employeeService.list);
const listBranches = vi.mocked(branchService.list);

const EMPLOYEE = {
  id: 'e2',
  employeeCode: 'EMP-0012',
  firstName: 'Hassan',
  lastName: 'Al Hinai',
  avatarUrl: null,
};

const nightShift: WorkSchedule = {
  id: 's1',
  employeeId: 'e2',
  date: '2026-03-10',
  shiftType: 'NIGHT',
  startTime: '20:00',
  endTime: '04:00',
  requiredHours: null,
  isWorkDay: true,
  notes: 'Night rotation',
  employee: EMPLOYEE,
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
};

const coverageData: ScheduleCoverage = {
  window: { startDate: '2026-03-09', endDate: '2026-03-15' },
  activeHeadcount: 10,
  scheduledEmployees: 6,
  unscheduled: 4,
  shifts: 22,
  byDay: [],
  thinnestDay: null,
  conflicts: {
    onHoliday: 1,
    onWeeklyOff: 0,
    overlaps: 0,
    total: 1,
    samples: [
      {
        employeeId: 'e9',
        fullName: 'Ahmed Al Farsi',
        date: '2026-03-12',
        reason: 'National Day',
      },
    ],
  },
};

beforeEach(() => {
  // Calls, not implementations. Without this a "was never called" assertion
  // sees the previous test's click and passes or fails on test ORDER.
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-03-11T09:00:00.000Z'));

  useAuthStore.setState({
    user: { id: 'u1', email: 'admin@example.com', role: 'ADMIN', isActive: true },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });

  listShifts.mockResolvedValue({ success: true, data: [nightShift] });
  coverage.mockResolvedValue({ success: true, data: coverageData });
  listEmployees.mockResolvedValue({
    success: true,
    data: [{ ...EMPLOYEE, status: 'ACTIVE', createdAt: '', updatedAt: '' } as never],
  });
  listBranches.mockResolvedValue({ success: true, data: [] });
  createShift.mockResolvedValue({ success: true, data: nightShift });
  updateShift.mockResolvedValue({ success: true, data: nightShift });
  removeShift.mockResolvedValue({ success: true, data: { deleted: true } });
});

// Fake timers are process-wide. Left running they break every LATER test file
// that drives a real user interaction, which is a failure with no connection to
// the test that caused it.
afterEach(() => {
  vi.useRealTimers();
});

describe('Shift management', () => {
  it('lists a rostered shift with its window and its length', async () => {
    renderWithProviders(<ShiftManagementPage />);

    const row = await screen.findByTestId('shift-row-s1');
    expect(row).toHaveAttribute('data-shift-type', 'NIGHT');
    expect(within(row).getByText('Hassan Al Hinai')).toBeInTheDocument();
    // 20:00 to 04:00 is eight hours, not minus sixteen.
    expect(within(row).getByText('8h')).toBeInTheDocument();
    expect(within(row).getByText('8:00 PM – 4:00 AM')).toBeInTheDocument();
  });

  it('names the conflicts behind the count, not just the number', async () => {
    // A count on its own tells a scheduler that something is wrong and not
    // which day to open.
    renderWithProviders(<ShiftManagementPage />);

    const list = await screen.findByTestId('shift-conflict-list');
    expect(within(list).getByText('Ahmed Al Farsi')).toBeInTheDocument();
    expect(within(list).getByText(/National Day/)).toBeInTheDocument();
  });

  it('re-queries when the shift-type filter narrows', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShiftManagementPage />);

    await screen.findByTestId('shift-row-s1');
    await user.selectOptions(screen.getByTestId('shift-type-filter'), 'NIGHT');

    await waitFor(() =>
      expect(listShifts).toHaveBeenCalledWith(
        expect.objectContaining({ shiftType: 'NIGHT' }),
      ),
    );
  });

  it('opens the edit form seeded from the row that was clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShiftManagementPage />);

    await user.click(await screen.findByTestId('shift-edit-s1'));

    const modal = await screen.findByTestId('schedule-modal');
    expect(within(modal).getByTestId('schedule-modal-type')).toHaveValue('NIGHT');
    expect(within(modal).getByTestId('schedule-modal-start')).toHaveValue('20:00');
    expect(within(modal).getByTestId('schedule-modal-end')).toHaveValue('04:00');
    // The date is fixed: the table is unique on employee and date, so moving a
    // row to another day is a different row.
    expect(within(modal).getByTestId('schedule-modal-date')).toBeDisabled();
  });

  it('reports a midnight crossing as eight hours, not as an error', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShiftManagementPage />);

    await user.click(await screen.findByTestId('shift-edit-s1'));

    expect(await screen.findByTestId('schedule-modal-length')).toHaveTextContent(
      'Runs to 04:00 the next day — 8h.',
    );
  });

  it('sends the resolved shape, clearing what the new type cannot carry', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShiftManagementPage />);

    await user.click(await screen.findByTestId('shift-edit-s1'));
    await user.selectOptions(
      await screen.findByTestId('schedule-modal-type'),
      'FLEXIBLE',
    );
    await user.click(screen.getByTestId('schedule-modal-save'));

    // A flexible shift has no window, so the clocks go null and the hours go up.
    await waitFor(() =>
      expect(updateShift).toHaveBeenCalledWith('s1', {
        shiftType: 'FLEXIBLE',
        startTime: null,
        endTime: null,
        requiredHours: 8,
        isWorkDay: true,
        notes: 'Night rotation',
      }),
    );
  });

  it('pre-fills the window when a shift type is picked, without locking it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShiftManagementPage />);

    await user.click(await screen.findByTestId('shift-create'));
    await user.selectOptions(
      await screen.findByTestId('schedule-modal-type'),
      'MORNING',
    );

    const start = screen.getByTestId('schedule-modal-start');
    expect(start).toHaveValue('06:00');

    // A plant that runs its mornings from 05:00 must be able to say so.
    await user.clear(start);
    await user.type(start, '05:00');
    expect(start).toHaveValue('05:00');
  });

  it('confirms before deleting, and does nothing when the confirm is refused', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithProviders(<ShiftManagementPage />);

    await user.click(await screen.findByTestId('shift-delete-s1'));

    expect(confirmSpy).toHaveBeenCalled();
    expect(removeShift).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('surfaces a refused delete rather than leaving the row looking removed', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    removeShift.mockRejectedValue(new Error('Referenced by a payslip'));

    renderWithProviders(<ShiftManagementPage />);
    await user.click(await screen.findByTestId('shift-delete-s1'));

    expect(await screen.findByTestId('shift-error')).toBeInTheDocument();
    expect(screen.getByTestId('shift-row-s1')).toBeInTheDocument();
  });

  it('sends the weekdays a pattern APPLIES to, never a skip list', async () => {
    const user = userEvent.setup();
    bulkShifts.mockResolvedValue({
      success: true,
      data: {
        range: { startDate: '2026-03-11', endDate: '2026-03-11' },
        days: 1,
        employees: 1,
        created: 1,
        replaced: 0,
        skipped: 0,
        failed: 0,
        results: [],
      },
    });

    renderWithProviders(<ShiftManagementPage />);
    await user.click(await screen.findByTestId('shift-bulk-create'));

    const modal = await screen.findByTestId('bulk-schedule-modal');
    await user.click(within(modal).getByTestId('bulk-select-all'));

    // The range defaults to today alone, and today is a Wednesday. Ticking
    // Wednesday must therefore INCLUDE it — read as a skip list the pattern
    // would land on nothing and the button would go dead.
    await user.click(within(modal).getByTestId('bulk-weekday-3'));

    const apply = within(modal).getByTestId('bulk-apply');
    expect(apply).toBeEnabled();
    expect(apply).toHaveTextContent('Roster 1 days for 1 people');

    await user.click(apply);

    await waitFor(() =>
      expect(bulkShifts).toHaveBeenCalledWith(
        expect.objectContaining({ employeeIds: ['e2'], weekdays: [3] }),
      ),
    );
  });

  it('will not run a pattern that lands on no days at all', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShiftManagementPage />);
    await user.click(await screen.findByTestId('shift-bulk-create'));

    const modal = await screen.findByTestId('bulk-schedule-modal');
    await user.click(within(modal).getByTestId('bulk-select-all'));
    // Monday, against a range that is a single Wednesday.
    await user.click(within(modal).getByTestId('bulk-weekday-1'));

    expect(within(modal).getByTestId('bulk-apply')).toBeDisabled();
    expect(bulkShifts).not.toHaveBeenCalled();
  });

  it('reports what the bulk run skipped, not only what it created', async () => {
    const user = userEvent.setup();
    bulkShifts.mockResolvedValue({
      success: true,
      data: {
        range: { startDate: '2026-03-11', endDate: '2026-03-11' },
        days: 1,
        employees: 1,
        created: 0,
        replaced: 0,
        skipped: 1,
        failed: 0,
        results: [
          {
            employeeId: 'e2',
            date: '2026-03-11',
            outcome: 'skipped',
            message: 'Already rostered — send overwrite to replace it',
          },
        ],
      },
    });

    renderWithProviders(<ShiftManagementPage />);
    await user.click(await screen.findByTestId('shift-bulk-create'));

    const modal = await screen.findByTestId('bulk-schedule-modal');
    await user.click(within(modal).getByTestId('bulk-select-all'));
    await user.click(within(modal).getByTestId('bulk-apply'));

    const result = await screen.findByTestId('bulk-result');
    expect(result).toHaveTextContent('1 skipped');
    expect(result).toHaveTextContent('Already rostered');
  });
});
