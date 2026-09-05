import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import GarnishmentsPage from './page';

/**
 * Court orders on screen.
 *
 * The rung the recovery ladder was missing: `PayrollItem.garnishment` and the
 * allocator's `CycleContext.garnishment` existed and payroll passed a hard
 * zero, because there was nowhere to record that an order existed.
 *
 * The form's job is to stop two mistakes an administrator actually makes —
 * stating both an amount and a percentage (two conflicting instructions), or
 * neither (none at all) — before they become a 400.
 */

vi.mock('@/services/garnishmentService', () => ({
  default: { getAll: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));

vi.mock('@/services/employeeService', () => ({
  default: { getDirectory: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const confirmMock = vi.fn(async () => true);
vi.mock('@/hooks/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock, ConfirmDialog: () => null }),
}));

import garnishmentService from '@/services/garnishmentService';
import employeeService from '@/services/employeeService';
import { toast } from '@/lib/toast';

const getAll = vi.mocked(garnishmentService.getAll);
const create = vi.mocked(garnishmentService.create);
const update = vi.mocked(garnishmentService.update);
const remove = vi.mocked(garnishmentService.remove);
const getDirectory = vi.mocked(employeeService.getDirectory);
const toastError = vi.mocked(toast.error);
const toastWarning = vi.mocked(toast.warning);

function interceptorRejection(statusCode: number, message: string) {
  return {
    success: false,
    statusCode,
    message,
    timestamp: '2026-08-19T00:00:00.000Z',
    path: '/garnishments',
    errors: null,
    details: { message },
  };
}

function order(over: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    employeeId: 'emp-1',
    reference: 'CIV/2026/8891',
    authority: 'District Court',
    amount: '150.00',
    percentOfNet: null,
    totalCap: null,
    collected: '450.00',
    startDate: '2026-01-01',
    endDate: null,
    isActive: true,
    notes: null,
    employee: { id: 'emp-1', employeeCode: 'E-001', fullName: 'Ada Lovelace' },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  confirmMock.mockResolvedValue(true);
  useAuthStore.setState({ hasHydrated: true });
  getAll.mockResolvedValue({ data: [] } as never);
  getDirectory.mockResolvedValue({
    data: [{ id: 'emp-1', fullName: 'Ada Lovelace', employeeCode: 'E-001' }],
  } as never);
});

async function renderPage(
  options: Parameters<typeof renderWithProviders>[1] = {},
) {
  return renderWithProviders(<GarnishmentsPage />, { role: 'HR_MANAGER', ...options });
}

async function openNew(user: ReturnType<typeof renderWithProviders>['user']) {
  await waitFor(() => expect(screen.queryByTestId('garnishment-new')).toBeTruthy());
  await user.click(screen.getByTestId('garnishment-new'));
  await waitFor(() => expect(screen.queryByTestId('garnishment-modal')).toBeTruthy());
}

describe('who may see court orders', () => {
  it.each(['MANAGER', 'EMPLOYEE'] as const)('tells a %s the rule', async (role) => {
    await renderPage({ role });

    await waitFor(() => expect(screen.queryByTestId('garnishment-forbidden')).toBeTruthy());
    expect(getAll, 'and asks for nothing it may not have').not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'HR_MANAGER'] as const)('shows %s the list', async (role) => {
    await renderPage({ role });
    await waitFor(() => expect(getAll).toHaveBeenCalled());
  });
});

describe('a refused list is not an empty list', () => {
  it('says the orders could not be read', async () => {
    // Telling a payroll officer there are none when they may simply not see
    // them is how a deduction goes unexplained.
    getAll.mockRejectedValue(interceptorRejection(403, 'Another branch'));

    await renderPage();

    await waitFor(() => expect(screen.queryByTestId('garnishment-failed')).toBeTruthy());
    expect(screen.queryByTestId('garnishment-empty')).toBeNull();
    expect(toastError).toHaveBeenCalledWith('Another branch');
  });

  it('says so plainly when there really are none', async () => {
    await renderPage();
    await waitFor(() => expect(screen.queryByTestId('garnishment-empty')).toBeTruthy());
  });
});

describe('what the list shows', () => {
  it('states what an order takes and what it has collected', async () => {
    getAll.mockResolvedValue({ data: [order()] } as never);

    await renderPage();

    await waitFor(() => expect(screen.queryAllByTestId('garnishment-row').length).toBe(1));
    const row = screen.getByTestId('garnishment-row');
    expect(within(row).getByTestId('garnishment-takes').textContent).toContain('150');
    expect(within(row).getByTestId('garnishment-collected').textContent).toContain('450');
  });

  it('shows a percentage order as a percentage', async () => {
    getAll.mockResolvedValue({
      data: [order({ amount: null, percentOfNet: '15.00' })],
    } as never);

    await renderPage();

    await waitFor(() => expect(screen.queryAllByTestId('garnishment-row').length).toBe(1));
    expect(screen.getByTestId('garnishment-takes').textContent).toMatch(/15% of net/);
  });

  it('marks a stopped order as stopped', async () => {
    getAll.mockResolvedValue({ data: [order({ isActive: false })] } as never);

    await renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('garnishment-state').getAttribute('data-active')).toBe(
        'false',
      ),
    );
  });
});

describe('the two mistakes the form refuses', () => {
  const fill = async (
    user: ReturnType<typeof renderWithProviders>['user'],
    opts: { amount?: string; percent?: string } = {},
  ) => {
    await user.selectOptions(screen.getByTestId('garnishment-employee'), 'emp-1');
    await user.type(screen.getByTestId('garnishment-reference'), 'CIV/2026/1');
    if (opts.amount) await user.type(screen.getByTestId('garnishment-amount'), opts.amount);
    if (opts.percent) await user.type(screen.getByTestId('garnishment-percent'), opts.percent);
  };

  it('refuses both an amount and a percentage', async () => {
    const { user } = await renderPage();
    await openNew(user);
    await fill(user, { amount: '150', percent: '15' });
    await user.click(screen.getByTestId('garnishment-save'));

    expect(toastWarning).toHaveBeenCalledWith(
      'An order states either a fixed amount or a percentage of net pay, not both',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses neither', async () => {
    const { user } = await renderPage();
    await openNew(user);
    await fill(user);
    await user.click(screen.getByTestId('garnishment-save'));

    expect(toastWarning).toHaveBeenCalledWith(
      'An order needs either a fixed amount or a percentage of net pay',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an order with no employee', async () => {
    const { user } = await renderPage();
    await openNew(user);
    await user.type(screen.getByTestId('garnishment-reference'), 'CIV/2026/1');
    await user.type(screen.getByTestId('garnishment-amount'), '150');
    await user.click(screen.getByTestId('garnishment-save'));

    expect(toastWarning).toHaveBeenCalledWith(
      'Choose the employee this order is against',
    );
  });

  it('refuses an order with no court reference', async () => {
    // The reference is what a payslip query is answered with.
    const { user } = await renderPage();
    await openNew(user);
    await user.selectOptions(screen.getByTestId('garnishment-employee'), 'emp-1');
    await user.type(screen.getByTestId('garnishment-amount'), '150');
    await user.click(screen.getByTestId('garnishment-save'));

    expect(toastWarning).toHaveBeenCalledWith(
      expect.stringContaining('court reference is required'),
    );
  });

  it('refuses an order that ends before it starts', async () => {
    const { user } = await renderPage();
    await openNew(user);
    await fill(user, { amount: '150' });
    await user.clear(screen.getByTestId('garnishment-start'));
    await user.type(screen.getByTestId('garnishment-start'), '2026-09-01');
    await user.type(screen.getByTestId('garnishment-end'), '2026-01-01');
    await user.click(screen.getByTestId('garnishment-save'));

    expect(toastWarning).toHaveBeenCalledWith('The order ends before it starts');
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a coherent order', async () => {
    create.mockResolvedValue({ data: order() } as never);

    const { user } = await renderPage();
    await openNew(user);
    await fill(user, { amount: '150' });
    await user.click(screen.getByTestId('garnishment-save'));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          employeeId: 'emp-1',
          reference: 'CIV/2026/1',
          amount: 150,
          percentOfNet: null,
        }),
      ),
    );
  });
});

describe('stopping and deleting', () => {
  it('stops an order in force', async () => {
    getAll.mockResolvedValue({ data: [order()] } as never);
    update.mockResolvedValue({ data: order() } as never);

    const { user } = await renderPage();
    await waitFor(() => expect(screen.queryAllByTestId('garnishment-row').length).toBe(1));
    await user.click(screen.getByTestId('garnishment-toggle'));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('ord-1', { isActive: false }),
    );
  });

  it('offers deletion to an admin only', async () => {
    getAll.mockResolvedValue({ data: [order()] } as never);

    await renderPage({ role: 'HR_MANAGER' });
    await waitFor(() => expect(screen.queryAllByTestId('garnishment-row').length).toBe(1));
    expect(screen.queryByTestId('garnishment-delete')).toBeNull();
  });

  it('passes the server’s "deactivate instead" refusal through unchanged', async () => {
    // What was deducted under a court order is not ours to erase, and the
    // server's sentence is the one that explains why.
    getAll.mockResolvedValue({ data: [order()] } as never);
    remove.mockRejectedValue(
      interceptorRejection(
        400,
        '450 has already been collected under this order, so it cannot be deleted. Deactivate it instead.',
      ),
    );

    const { user } = await renderPage({ role: 'ADMIN' });
    await waitFor(() => expect(screen.queryAllByTestId('garnishment-row').length).toBe(1));
    await user.click(screen.getByTestId('garnishment-delete'));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining('Deactivate it instead'),
      ),
    );
  });
});
