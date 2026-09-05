import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor, within } from '@/test/utils';
import { routerMock } from '@/test/router-mock';
import { useAuthStore } from '@/store/authStore';
import MyLeavesPage from './page';

/**
 * An employee's own leave screen.
 *
 * What is defended here is what the employee acts on: the standing of each
 * request, the filter that narrows to one standing, and the dates. The dates
 * matter most — a leave day is a DATE, not an instant, and putting one through
 * a zoned parse moves it to the previous day for anyone west of Greenwich.
 */

vi.mock('@/services/leaveService', () => ({
  default: {
    myRequests: vi.fn(),
    balance: vi.fn(),
  },
}));

import leaveService from '@/services/leaveService';

const myRequests = vi.mocked(leaveService.myRequests);
const balance = vi.mocked(leaveService.balance);

const REQUESTS = [
  {
    id: 'lr-1',
    employeeId: 'e-1',
    leaveType: 'Annual Leave',
    startDate: '2026-01-15',
    endDate: '2026-01-17',
    totalDays: 3,
    reason: 'Family commitment abroad',
    status: 'PENDING',
    createdAt: '2026-01-02T08:00:00.000Z',
    updatedAt: '2026-01-02T08:00:00.000Z',
  },
  {
    id: 'lr-2',
    employeeId: 'e-1',
    leaveType: 'Sick Leave',
    startDate: '2025-11-03',
    endDate: '2025-11-03',
    totalDays: 1,
    reason: 'Doctor appointment',
    status: 'APPROVED',
    createdAt: '2025-11-01T08:00:00.000Z',
    updatedAt: '2025-11-02T08:00:00.000Z',
  },
];

const BALANCE = {
  id: 'lb-1',
  employeeId: 'e-1',
  year: 2026,
  annualLeave: 30,
  usedAnnual: 4,
  sickLeave: 15,
  usedSick: 1,
  carriedOver: 2,
  leaveTypeBalances: [
    {
      id: 'ltb-1',
      employeeId: 'e-1',
      year: 2026,
      leaveTypeKey: 'Annual Leave',
      allocated: 30,
      used: 4,
      carriedOver: 2,
      remaining: 28,
    },
  ],
};

beforeEach(() => {
  myRequests.mockReset();
  balance.mockReset();
  myRequests.mockResolvedValue({ success: true, data: REQUESTS } as never);
  balance.mockResolvedValue({ success: true, data: BALANCE } as never);

  useAuthStore.setState({
    user: {
      id: 'u-1',
      email: 'aisha@example.com',
      role: 'EMPLOYEE',
      isActive: true,
      employeeId: 'e-1',
    },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });
});

/**
 * The desktop table.
 *
 * The screen draws the same rows twice — a table above `md`, a stack of cards
 * below it — and jsdom honours neither breakpoint, so every unscoped query
 * matches both. Assertions go through the table so a count means what it says.
 */
const table = () => within(screen.getByRole('table'));

describe('My leaves', () => {
  it('lists the requests the employee has filed', async () => {
    renderWithProviders(<MyLeavesPage />);

    await waitFor(() => expect(table().getByText('Annual Leave')).toBeInTheDocument());
    expect(table().getByText('Sick Leave')).toBeInTheDocument();
  });

  it('prints a leave date on the day it was booked, not the day before', async () => {
    // `2026-01-15` through an instant parse is midnight UTC, which is the 14th
    // in every zone west of Greenwich. A leave day has no time of day.
    renderWithProviders(<MyLeavesPage />);

    await waitFor(() => expect(screen.getAllByText('15/01/2026').length).toBeGreaterThan(0));
    expect(screen.queryByText('14/01/2026')).toBeNull();
  });

  it('shows what is left of the entitlement it was drawn from', async () => {
    renderWithProviders(<MyLeavesPage />);

    const card = await screen.findByTestId('my-leave-balance-card');
    expect(within(card).getByText('28')).toBeInTheDocument();
    expect(within(card).getByText('/ 32d')).toBeInTheDocument();
  });

  it('narrows to one standing, and back again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MyLeavesPage />);

    await waitFor(() => expect(table().getByText('Annual Leave')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Approved' }));
    await waitFor(() => expect(table().queryByText('Annual Leave')).toBeNull());
    expect(table().getByText('Sick Leave')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(table().getByText('Annual Leave')).toBeInTheDocument());
  });

  it('tells a filtered-empty list apart from an empty one', async () => {
    // "Nothing matches this filter" must not read as "your requests are gone".
    const user = userEvent.setup();
    renderWithProviders(<MyLeavesPage />);

    await waitFor(() => expect(table().getByText('Annual Leave')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Rejected' }));

    expect(await screen.findByText('Nothing with that standing')).toBeInTheDocument();
    expect(screen.queryByText('No leave requests yet')).toBeNull();
  });

  it('offers the next step when nothing has been filed at all', async () => {
    myRequests.mockResolvedValue({ success: true, data: [] } as never);
    const user = userEvent.setup();
    renderWithProviders(<MyLeavesPage />);

    const empty = await screen.findByText('No leave requests yet');

    // The empty state's own call to action, not the one in the header — they
    // lead to the same place, and clicking the wrong one proves nothing.
    await user.click(
      within(empty.parentElement!).getByRole('button', { name: 'Request leave' }),
    );
    expect(routerMock.push).toHaveBeenCalledWith('/dashboard/leaves/new');
  });

  it('opens a request from its row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MyLeavesPage />);

    const open = await screen.findByRole('button', {
      name: /Open the Annual Leave request from 15\/01\/2026/i,
    });
    await user.click(open);

    expect(routerMock.push).toHaveBeenCalledWith('/dashboard/leaves/lr-1');
  });
});
