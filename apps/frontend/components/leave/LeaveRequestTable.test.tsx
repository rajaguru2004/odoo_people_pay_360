import { describe, expect, it } from 'vitest';
import { renderWithProviders, screen, within } from '@/test/utils';
import type { LeaveRequest } from '@/types/leave';
import LeaveRequestTable from './LeaveRequestTable';

/**
 * The one table four leave screens draw.
 *
 * All of them — everything, the queue, one employee's, the caller's own —
 * share this markup, so a column that means the wrong thing here means it in
 * four places at once. Two of its decisions are worth pinning.
 *
 * `showEmployee` is not cosmetic. On a personal list every row is the reader,
 * and a name column there is a column of the same name repeated; on a queue it
 * is the only thing that says whose leave is waiting. Dropping the HEADER as
 * well as the cells matters, because a header with no cells under it shifts
 * every column after it.
 *
 * The staleness warning is the table's only editorial claim. Two days is the
 * point at which a pending approval stops being "not yet" and starts being
 * "forgotten", and a fresh request wearing that warning would train an approver
 * to ignore it on the ones that have genuinely been sitting there.
 *
 * Dates go through `formatDateOnly`: a leave date has no time of day, and an
 * instant parse lands 2026-01-15 on the 14th anywhere west of Greenwich.
 */
const DAY = 86_400_000;

function request(overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  return {
    id: 'lr-1',
    employeeId: 'emp-1',
    leaveType: 'Annual Leave',
    startDate: '2026-01-15',
    endDate: '2026-01-17',
    totalDays: 3,
    reason: 'Family visit to Salalah',
    status: 'APPROVED',
    approverId: 'u1',
    approvedAt: '2026-01-10T09:00:00.000Z',
    rejectedReason: null,
    createdAt: '2026-01-08T09:00:00.000Z',
    updatedAt: '2026-01-10T09:00:00.000Z',
    employee: {
      id: 'emp-1',
      employeeCode: 'EMP-0001',
      firstName: 'Aisha',
      lastName: 'Al Balushi',
      department: { id: 'd1', name: 'Executive' },
    },
    ...overrides,
  };
}

/** Ages a request by whole days, measured from now so no clock is stubbed. */
function filedDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

describe('LeaveRequestTable', () => {
  it('draws a row with its dates, its cost in days and its status', () => {
    renderWithProviders(<LeaveRequestTable rows={[request()]} />);

    const row = screen.getByRole('row', { name: /Aisha Al Balushi/ });
    expect(within(row).getByText('Annual Leave')).toBeInTheDocument();
    expect(within(row).getByText('EMP-0001 · Executive')).toBeInTheDocument();
    // Date-only, unshifted: the 15th is the 15th in every zone.
    expect(within(row).getByText('15/01/2026 – 17/01/2026')).toBeInTheDocument();
    expect(within(row).getByText('3')).toBeInTheDocument();
    // "Approved", not "APPROVED" — a column of shouting enums is not a table.
    expect(within(row).getByText('Approved')).toBeInTheDocument();
  });

  it('labels each status in the reader language rather than the enum', () => {
    renderWithProviders(
      <LeaveRequestTable
        rows={[
          request({ id: 'lr-1', status: 'PENDING', createdAt: filedDaysAgo(0) }),
          request({ id: 'lr-2', status: 'REJECTED' }),
          // Withdrawn is not refused, and the queue must not read as a wall of
          // rejections because the two were coloured the same.
          request({ id: 'lr-3', status: 'CANCELLED' }),
        ]}
      />,
    );

    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('drops the employee column, header included, on a personal list', () => {
    renderWithProviders(
      <LeaveRequestTable rows={[request()]} showEmployee={false} />,
    );

    expect(
      screen.queryByRole('columnheader', { name: 'Employee' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Aisha Al Balushi')).not.toBeInTheDocument();

    // The rest of the row is untouched.
    expect(screen.getByRole('columnheader', { name: 'Type' })).toBeInTheDocument();
    expect(screen.getByText('Annual Leave')).toBeInTheDocument();
  });

  it('flags a pending request that has been waiting more than two days', () => {
    renderWithProviders(
      <LeaveRequestTable
        rows={[request({ status: 'PENDING', createdAt: filedDaysAgo(3) })]}
      />,
    );

    expect(screen.getByText('waiting 3 days')).toBeInTheDocument();
  });

  it('leaves a request filed today alone', () => {
    renderWithProviders(
      <LeaveRequestTable
        rows={[request({ status: 'PENDING', createdAt: filedDaysAgo(0) })]}
      />,
    );

    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByText(/waiting/)).not.toBeInTheDocument();
  });

  it('does not age a request that has already been decided', () => {
    // An approval from a fortnight ago is not a queue item; "waiting 14 days"
    // beside "Approved" is a contradiction on the same row.
    renderWithProviders(
      <LeaveRequestTable
        rows={[request({ status: 'APPROVED', createdAt: filedDaysAgo(14) })]}
      />,
    );

    expect(screen.queryByText(/waiting/)).not.toBeInTheDocument();
  });

  it('offers a way out of the empty state rather than only naming it', () => {
    renderWithProviders(
      <LeaveRequestTable
        rows={[]}
        emptyTitle="No leave requests"
        emptyDescription="Nothing has been filed for this period."
        emptyAction={<button type="button">File leave</button>}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'No leave requests' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Nothing has been filed for this period.'),
    ).toBeInTheDocument();
    // The action is the point: an empty queue with no next step is a dead end.
    expect(screen.getByRole('button', { name: 'File leave' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
