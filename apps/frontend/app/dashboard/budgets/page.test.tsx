import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import BudgetsPage from './page';

/**
 * Creating an HR budget, and moving one through its three states.
 *
 * Everything on this screen that can go wrong quietly is form- or
 * status-shaped. A budget with no branch cannot be committed against; a budget
 * left in DRAFT receives no commitments at all, which is why the two controls
 * that move it are drawn strictly per status — offering Activate on an already
 * ACTIVE budget, or Close on a DRAFT one, would put the user one click from a
 * refusal the screen could have prevented.
 *
 * The branch auto-select is small and load-bearing: single-branch companies are
 * the common case, and a required picker that the user must open to choose the
 * only possible answer is a step that exists solely to be got wrong.
 *
 * Refusals go through `apiErrorMessage` because `lib/axios.ts` rejects with a
 * FLAT object — the stubs below reject with that shape, not with an AxiosError.
 */

vi.mock('@/services/budgetService', () => ({
  default: {
    getAll: vi.fn(),
    create: vi.fn(),
    setStatus: vi.fn(),
  },
}));

vi.mock('@/services/branchService', () => ({
  default: { getAll: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import budgetService from '@/services/budgetService';
import branchService from '@/services/branchService';
import { toast } from 'sonner';

const getAll = vi.mocked(budgetService.getAll);
const create = vi.mocked(budgetService.create);
const setStatus = vi.mocked(budgetService.setStatus);
const branchGetAll = vi.mocked(branchService.getAll);
const toastError = vi.mocked(toast.error);
const toastWarning = vi.mocked(toast.warning);

/**
 * The page defaults the whole form to the current fiscal year, so the expected
 * payload is derived the same way rather than hard-coded to a year that would
 * make this file expire on 1 January.
 */
const YEAR = new Date().getFullYear();

const BRANCHES = [
  { id: 'br-1', code: 'HO', name: 'Head Office' },
  { id: 'br-2', code: 'SLL', name: 'Salalah' },
];

function budget(over: Record<string, unknown> = {}) {
  return {
    id: 'bud-1',
    name: `FY${YEAR} Operating Budget`,
    fiscalYear: YEAR,
    startDate: `${YEAR}-01-01`,
    endDate: `${YEAR}-12-31`,
    branchId: 'br-1',
    currency: 'OMR',
    status: 'DRAFT',
    branch: { id: 'br-1', code: 'HO', name: 'Head Office' },
    _count: { lines: 3 },
    ...over,
  };
}

/** The FLAT object `lib/axios.ts` really rejects with — no `.response`. */
function interceptorRejection(statusCode: number, message: string) {
  return {
    success: false,
    statusCode,
    message,
    timestamp: '2026-08-16T00:00:00.000Z',
    path: '/budgets',
    errors: null,
    details: { message },
  };
}

function mockBudgets(rows: unknown[] = []) {
  getAll.mockResolvedValue({ data: rows } as never);
}

function mockBranches(rows: unknown[] = BRANCHES) {
  branchGetAll.mockResolvedValue({ success: true, data: rows } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // `renderWithProviders` seeds user/isAuthenticated/isLoading but not
  // `hasHydrated`, and `ProtectedRoute` renders nothing until that flag is set.
  useAuthStore.setState({ hasHydrated: true });
  mockBudgets();
  mockBranches();
});

/** Renders as ADMIN by default; the list has settled when this returns. */
async function renderPage(
  options: Parameters<typeof renderWithProviders>[1] = {},
) {
  const result = renderWithProviders(<BudgetsPage />, { role: 'ADMIN', ...options });
  await waitFor(() => expect(getAll, 'the list loads on mount').toHaveBeenCalled());
  await waitFor(() =>
    expect(
      screen.queryByTestId('budget-empty') ?? screen.queryAllByTestId('budget-row')[0],
      'the loading placeholder has been replaced by the list',
    ).toBeTruthy(),
  );
  return result;
}

/** Opens the create form and waits for the branch master to arrive. */
async function openForm(user: ReturnType<typeof renderWithProviders>['user']) {
  await user.click(screen.getByTestId('budget-new'));
  await waitFor(() =>
    expect(
      within(screen.getByTestId('budget-branch')).queryAllByRole('option').length,
      'the branch picker has been populated',
    ).toBeGreaterThan(1),
  );
}

describe('the fields a budget cannot be created without', () => {
  it('refuses a budget with no name', async () => {
    // The name ships pre-filled, so this only happens when a user clears it —
    // and an unnamed budget is unidentifiable in the list it lands in.
    const { user } = await renderPage();
    await openForm(user);

    await user.clear(screen.getByTestId('budget-name'));
    await user.selectOptions(screen.getByTestId('budget-branch'), 'br-2');
    await user.click(screen.getByTestId('budget-submit'));

    expect(
      toastWarning,
      'one sentence names both required fields',
    ).toHaveBeenCalledWith('Name and branch are required');
    expect(create, 'nothing reaches the server').not.toHaveBeenCalled();
  });

  it('refuses a budget with no branch', async () => {
    // A budget is committed against per branch; without one the commitments
    // raised by approvals have nowhere to land.
    const { user } = await renderPage();
    await openForm(user);

    await user.click(screen.getByTestId('budget-submit'));

    expect(
      toastWarning,
      'the branch is required even though the name arrives pre-filled',
    ).toHaveBeenCalledWith('Name and branch are required');
    expect(create, 'nothing reaches the server').not.toHaveBeenCalled();
  });

  it('treats a name of only spaces as no name at all', async () => {
    const { user } = await renderPage();
    await openForm(user);

    await user.clear(screen.getByTestId('budget-name'));
    await user.type(screen.getByTestId('budget-name'), '   ');
    await user.selectOptions(screen.getByTestId('budget-branch'), 'br-2');
    await user.click(screen.getByTestId('budget-submit'));

    expect(
      toastWarning,
      'whitespace does not satisfy the name field',
    ).toHaveBeenCalledWith('Name and branch are required');
    expect(create, 'nothing reaches the server').not.toHaveBeenCalled();
  });
});

describe('the branch picker', () => {
  it('pre-selects the only branch when the company has exactly one', async () => {
    // Single-branch companies are the common case; making the user open a
    // dropdown to pick the sole possible answer is a step that only ever
    // produces the "Name and branch are required" refusal above.
    mockBranches([BRANCHES[0]]);
    const { user } = await renderPage();

    await user.click(screen.getByTestId('budget-new'));

    await waitFor(() =>
      expect(
        (screen.getByTestId('budget-branch') as HTMLSelectElement).value,
        'the only branch is chosen for the user',
      ).toBe('br-1'),
    );
  });

  it('leaves the branch unchosen when the company has more than one', async () => {
    // Guessing here would silently file the budget against the wrong branch.
    const { user } = await renderPage();
    await openForm(user);

    expect(
      (screen.getByTestId('budget-branch') as HTMLSelectElement).value,
      'no branch is assumed when there is a real choice to make',
    ).toBe('');
  });

  it('offers one option per branch the user can reach', async () => {
    const { user } = await renderPage();
    await openForm(user);

    const select = screen.getByTestId('budget-branch') as HTMLSelectElement;
    expect(
      Array.from(select.options).map((o) => o.value).filter(Boolean),
      'every accessible branch is selectable',
    ).toEqual(['br-1', 'br-2']);
  });

  it('keeps the form usable when the branch list fails to load', async () => {
    // Non-fatal by design — the picker is empty, but the page must not crash.
    branchGetAll.mockRejectedValue(new Error('network'));
    const { user } = await renderPage();

    await user.click(screen.getByTestId('budget-new'));

    expect(
      screen.getByTestId('budget-name'),
      'the rest of the form still renders',
    ).toBeInTheDocument();
  });
});

describe('what a valid create sends', () => {
  it('posts the typed name, the chosen branch and a full-year default period', async () => {
    // Asserted as a whole object rather than with `objectContaining`: an extra
    // key here is a 400 from the DTO whitelist, so "nothing else" is the rule.
    create.mockResolvedValue({ data: { id: 'bud-9' } } as never);
    const { user } = await renderPage();
    await openForm(user);

    await user.clear(screen.getByTestId('budget-name'));
    await user.type(screen.getByTestId('budget-name'), 'Recruitment Budget');
    await user.selectOptions(screen.getByTestId('budget-branch'), 'br-2');
    await user.click(screen.getByTestId('budget-submit'));

    await waitFor(() =>
      expect(create, 'the budget is created once').toHaveBeenCalledTimes(1),
    );
    expect(create, 'the payload is exactly what the form holds').toHaveBeenCalledWith({
      name: 'Recruitment Budget',
      fiscalYear: YEAR,
      startDate: `${YEAR}-01-01`,
      endDate: `${YEAR}-12-31`,
      branchId: 'br-2',
    });
  });

  it('does not send a status, so the server decides the budget opens as DRAFT', async () => {
    // A budget must not start ACTIVE: commitments would attach to lines that do
    // not exist yet.
    create.mockResolvedValue({ data: { id: 'bud-9' } } as never);
    const { user } = await renderPage();
    await openForm(user);

    await user.selectOptions(screen.getByTestId('budget-branch'), 'br-2');
    await user.click(screen.getByTestId('budget-submit'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(
      create.mock.calls[0][0].status,
      'the client never asks for a starting status',
    ).toBeUndefined();
  });

  it('reloads the list after a successful create', async () => {
    create.mockResolvedValue({ data: { id: 'bud-9' } } as never);
    const { user } = await renderPage();
    await openForm(user);

    await user.selectOptions(screen.getByTestId('budget-branch'), 'br-2');
    await user.click(screen.getByTestId('budget-submit'));

    await waitFor(() =>
      expect(
        getAll,
        'the new budget appears without a manual refresh',
      ).toHaveBeenCalledTimes(2),
    );
  });
});

describe('the DRAFT → ACTIVE → CLOSED controls', () => {
  it('offers only Activate on a DRAFT budget', async () => {
    // DRAFT receives no commitments at all, so Activate is the only move that
    // makes sense — and Close would answer a refusal.
    mockBudgets([budget({ id: 'bud-draft', status: 'DRAFT' })]);
    await renderPage();

    expect(
      screen.getByTestId('budget-activate'),
      'a draft budget can be activated',
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('budget-close'),
      'a draft budget has nothing to close',
    ).not.toBeInTheDocument();
  });

  it('offers only Close on an ACTIVE budget', async () => {
    mockBudgets([budget({ id: 'bud-active', status: 'ACTIVE' })]);
    await renderPage();

    expect(
      screen.getByTestId('budget-close'),
      'an active budget can be closed',
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('budget-activate'),
      'an active budget is not offered Activate again',
    ).not.toBeInTheDocument();
  });

  it('offers neither control on a CLOSED budget, which is the end of the line', async () => {
    mockBudgets([budget({ id: 'bud-closed', status: 'CLOSED' })]);
    await renderPage();

    expect(
      screen.getByTestId('budget-row'),
      'the budget is on screen — the absent controls are a status rule, not an empty list',
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('budget-activate'),
      'a closed budget cannot be re-opened from here',
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('budget-close'),
      'a closed budget cannot be closed twice',
    ).not.toBeInTheDocument();
  });

  it('warns on a DRAFT row that it is not receiving commitments yet', async () => {
    // The single most confusing state on this screen: lines exist, approvals
    // are happening, and the budget shows nothing committed.
    mockBudgets([budget({ status: 'DRAFT' })]);
    await renderPage();

    expect(
      screen.getByText(/Draft budgets do not receive commitments/i),
      'the screen says why a draft budget looks empty',
    ).toBeInTheDocument();
  });

  it('activates the budget it was clicked on', async () => {
    setStatus.mockResolvedValue({ data: {} } as never);
    mockBudgets([budget({ id: 'bud-draft', status: 'DRAFT' })]);
    const { user } = await renderPage();

    await user.click(screen.getByTestId('budget-activate'));

    await waitFor(() =>
      expect(
        setStatus,
        'the row’s own id and the next status are sent',
      ).toHaveBeenCalledWith('bud-draft', 'ACTIVE'),
    );
  });

  it('closes the budget it was clicked on', async () => {
    setStatus.mockResolvedValue({ data: {} } as never);
    mockBudgets([budget({ id: 'bud-active', status: 'ACTIVE' })]);
    const { user } = await renderPage();

    await user.click(screen.getByTestId('budget-close'));

    await waitFor(() =>
      expect(
        setStatus,
        'the row’s own id and the next status are sent',
      ).toHaveBeenCalledWith('bud-active', 'CLOSED'),
    );
  });
});

describe('when the server refuses', () => {
  it('shows the server’s own sentence on a refused create', async () => {
    // The defect this guards: `e.response?.data?.message` is `undefined` on the
    // shape our interceptor produces, so a precise refusal reached the user as
    // "Failed to create budget".
    create.mockRejectedValue(
      interceptorRejection(
        409,
        'A budget for FY2026 already exists on this branch',
      ) as never,
    );
    const { user } = await renderPage();
    await openForm(user);

    await user.selectOptions(screen.getByTestId('budget-branch'), 'br-2');
    await user.click(screen.getByTestId('budget-submit'));

    await waitFor(() =>
      expect(
        toastError,
        'the backend explanation reaches the user verbatim',
      ).toHaveBeenCalledWith('A budget for FY2026 already exists on this branch'),
    );
    expect(
      toastError,
      'the generic fallback never appears when the server explained itself',
    ).not.toHaveBeenCalledWith('Failed to create budget');
  });

  it('shows the server’s own sentence on a refused status change', async () => {
    setStatus.mockRejectedValue(
      interceptorRejection(
        400,
        'A budget with no lines cannot be activated',
      ) as never,
    );
    mockBudgets([budget({ id: 'bud-draft', status: 'DRAFT' })]);
    const { user } = await renderPage();

    await user.click(screen.getByTestId('budget-activate'));

    await waitFor(() =>
      expect(
        toastError,
        'the reason a budget could not be activated is the server’s to give',
      ).toHaveBeenCalledWith('A budget with no lines cannot be activated'),
    );
    expect(
      toastError,
      'the generic fallback never appears when the server explained itself',
    ).not.toHaveBeenCalledWith('Failed to change status');
  });

  it('re-enables the create form after a refusal, so the budget can be retried', async () => {
    create.mockRejectedValue(interceptorRejection(500, 'Database unavailable') as never);
    const { user } = await renderPage();
    await openForm(user);

    await user.selectOptions(screen.getByTestId('budget-branch'), 'br-2');
    await user.click(screen.getByTestId('budget-submit'));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(
      screen.getByTestId('budget-submit'),
      'the create button is not left spinning',
    ).not.toBeDisabled();
  });
});

describe('who reaches the screen', () => {
  it.each(['MANAGER', 'EMPLOYEE'] as const)(
    'renders nothing for %s, who has no business planning spend',
    (role) => {
      renderWithProviders(<BudgetsPage />, { role });

      expect(
        screen.queryByTestId('budget-new'),
        `${role} is outside the ADMIN/HR_MANAGER guard on this route`,
      ).not.toBeInTheDocument();
    },
  );
});
