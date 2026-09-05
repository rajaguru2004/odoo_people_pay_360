import { describe, expect, it, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import AttendanceManagementPage from './page';

/**
 * The payload shape is the whole point of this test.
 *
 * `POST /attendances/bulk` runs behind `forbidNonWhitelisted`, so a payload
 * carrying a batch-level `status` and `employeeIds` is a 400 rather than a
 * silently-ignored field — and the failure surfaces as "something went wrong"
 * on a grid the user has just spent a minute filling in. Pinning the shape here
 * catches a drift that types alone would not, because the mutation is reached
 * through a hook the screen only calls at submit time.
 */
const mutateAsync = vi.fn();

vi.mock('@/hooks/useAttendance', () => ({
  useBulkAttendance: () => ({ mutateAsync, isPending: false }),
}));

vi.mock('@/hooks/useEmployees', () => ({
  useEmployees: () => ({
    data: {
      data: [
        {
          id: 'emp-1',
          employeeCode: 'EMP-0001',
          firstName: 'Aisha',
          lastName: 'Al Balushi',
          status: 'ACTIVE',
          department: { id: 'd1', code: 'EXEC', name: 'Executive' },
          branch: { id: 'b1', code: 'HQ', name: 'Head Office' },
        },
        {
          id: 'emp-2',
          employeeCode: 'EMP-0002',
          firstName: 'Khalid',
          lastName: 'Al Harthy',
          status: 'ACTIVE',
          department: { id: 'd2', code: 'HR', name: 'Human Resources' },
          branch: { id: 'b1', code: 'HQ', name: 'Head Office' },
        },
      ],
      meta: { total: 2, page: 1, limit: 50, totalPages: 1 },
    },
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('@/hooks/useDepartments', () => ({
  useDepartments: () => ({ data: { data: [] }, isLoading: false }),
}));
vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: { data: [] }, isLoading: false }),
}));

describe('Attendance manager', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({
      data: {
        date: '2026-09-05',
        applied: 2,
        created: 2,
        updated: 0,
        failed: [],
        results: [
          { employeeId: 'emp-1', outcome: 'created' },
          { employeeId: 'emp-2', outcome: 'created' },
        ],
      },
    });
    useAuthStore.setState({
      user: { id: 'u1', email: 'admin@peoplepay360.com', role: 'ADMIN' } as never,
      isAuthenticated: true,
      isLoading: false,
      hasHydrated: true,
    });
  });

  it('sends one call whose verdict rides on each entry', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AttendanceManagementPage />);

    await user.selectOptions(
      await screen.findByLabelText('Mark Aisha Al Balushi as'),
      'ABSENT',
    );
    await user.selectOptions(
      screen.getByLabelText('Mark Khalid Al Harthy as'),
      'ON_LEAVE',
    );

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));

    const payload = mutateAsync.mock.calls[0][0];
    expect(payload).toMatchObject({
      date: expect.any(String),
      entries: [
        { employeeId: 'emp-1', status: 'ABSENT' },
        { employeeId: 'emp-2', status: 'ON_LEAVE' },
      ],
    });

    // The two fields the endpoint rejects outright.
    expect(payload).not.toHaveProperty('employeeIds');
    expect(payload).not.toHaveProperty('status');
  });

  it('names each row the server refused instead of failing the batch', async () => {
    mutateAsync.mockResolvedValue({
      data: {
        date: '2026-09-05',
        applied: 1,
        created: 1,
        updated: 0,
        failed: [{ employeeId: 'emp-2', message: 'Employee not found' }],
        results: [
          { employeeId: 'emp-1', outcome: 'created' },
          { employeeId: 'emp-2', outcome: 'failed', message: 'Employee not found' },
        ],
      },
    });

    const user = userEvent.setup();
    renderWithProviders(<AttendanceManagementPage />);

    await user.selectOptions(
      await screen.findByLabelText('Mark Aisha Al Balushi as'),
      'ABSENT',
    );
    await user.selectOptions(
      screen.getByLabelText('Mark Khalid Al Harthy as'),
      'ABSENT',
    );
    await user.click(screen.getByRole('button', { name: /save/i }));

    // One row the server could not place must be named, not folded into a
    // single "something went wrong" over a grid that mostly succeeded.
    //
    // `findAllByText` because the name legitimately appears twice — once in the
    // grid row and once in the outcome list. Asserting on a single match would
    // be asserting that the grid had been torn down, which is the opposite of
    // what should happen after a partial failure.
    expect(await screen.findAllByText(/Khalid Al Harthy/)).not.toHaveLength(0);
    expect(screen.getAllByText(/employee not found/i).length).toBeGreaterThan(0);
  });

  it('does not offer Save to a role that may read the roster but not write it', async () => {
    useAuthStore.setState({
      user: { id: 'u2', email: 'payroll@peoplepay360.com', role: 'PAYROLL_OFFICER' } as never,
      isAuthenticated: true,
      isLoading: false,
      hasHydrated: true,
    });

    renderWithProviders(<AttendanceManagementPage />);

    const save = screen.queryByRole('button', { name: /save/i });
    expect(save === null || save.hasAttribute('disabled')).toBe(true);
  });
});
