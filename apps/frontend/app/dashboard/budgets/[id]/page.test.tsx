import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { navigationState } from '@/test/router-mock';
import { useAuthStore } from '@/store/authStore';
import BudgetVariancePage from './page';

/**
 * Planned vs Committed vs Actual, and the line form that feeds it.
 *
 * The arithmetic on this screen belongs to the server — `Remaining = Planned −
 * OPEN − Actual` is computed and tested in `finance-budget.e2e-spec.ts`. What
 * this layer owns is the part that decides whether the right numbers are asked
 * for and the right figures displayed:
 *
 *  - a line needs a category, because a category is what spend is matched on;
 *  - an OMITTED `departmentId` is not a missing field, it is the company-wide
 *    fallback line — the row that catches spend from departments with no line
 *    of their own — so it must be sent as an absence, not as an empty string;
 *  - the totals tiles must render the report's own totals. Re-adding the
 *    visible rows would agree with the server most of the time and disagree
 *    exactly when it matters, because the rows a caller may see are branch- and
 *    department-scoped while the totals are not;
 *  - deleting a line is blocked while approved requests still hold commitments
 *    against it, so the confirm has to branch and the refusal has to carry the
 *    server's own sentence rather than a shrug.
 *
 * One thing below is asserted as it BEHAVES rather than as it reads: the
 * confirm dialog is never closed after a confirmed delete. See that case.
 */

vi.mock('@/services/budgetService', () => ({
  default: {
    variance: vi.fn(),
    upsertLine: vi.fn(),
    removeLine: vi.fn(),
  },
}));

vi.mock('@/services/libraryService', () => ({
  default: { getAll: vi.fn() },
}));

vi.mock('@/services/departmentService', () => ({
  default: { getAll: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import budgetService from '@/services/budgetService';
import libraryService from '@/services/libraryService';
import departmentService from '@/services/departmentService';
import { toast } from 'sonner';

const variance = vi.mocked(budgetService.variance);
const upsertLine = vi.mocked(budgetService.upsertLine);
const removeLine = vi.mocked(budgetService.removeLine);
const libraryGetAll = vi.mocked(libraryService.getAll);
const departmentGetAll = vi.mocked(departmentService.getAll);
const toastError = vi.mocked(toast.error);
const toastWarning = vi.mocked(toast.warning);

const BUDGET_ID = 'bud-1';

const CATEGORIES = [
  { id: 'lib-1', label: 'Training', isActive: true },
  { id: 'lib-2', label: 'Recruitment', isActive: true },
];

const DEPARTMENTS = [
  { id: 'dep-1', name: 'Engineering' },
  { id: 'dep-2', name: 'Operations' },
];

/**
 * A report whose totals deliberately do NOT equal the sum of its visible rows.
 *
 * That is not a contrived fixture — it is the real case. The rows a caller may
 * read are scoped, the totals are the budget's, and any screen that re-adds the
 * rows to produce the tiles would show a smaller budget to a scoped user and
 * agree with the server for everyone else. Visible rows sum to 14,000 planned;
 * the budget's planned figure is 25,000.
 */
const REPORT = {
  budget: {
    id: BUDGET_ID,
    name: 'FY2026 Operating Budget',
    fiscalYear: 2026,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    currency: 'OMR',
    status: 'ACTIVE',
    branch: { id: 'br-1', code: 'HO', name: 'Head Office' },
  },
  rows: [
    {
      budgetLineId: 'line-1',
      departmentId: 'dep-1',
      departmentName: 'Engineering',
      category: 'Training',
      planned: 10000,
      committed: 2000,
      actual: 3000,
      remaining: 5000,
      utilization: 0.5,
    },
    {
      budgetLineId: 'line-2',
      departmentId: null,
      departmentName: 'Company-wide',
      category: 'Recruitment',
      planned: 4000,
      committed: 1000,
      actual: 500,
      remaining: 2500,
      utilization: 0.375,
    },
  ],
  totals: { planned: 25000, committed: 3000, actual: 3500, remaining: 18500 },
  unbudgeted: [{ departmentId: null, category: 'Relocation', actual: 1200 }],
};

/** The FLAT object `lib/axios.ts` really rejects with — no `.response`. */
function interceptorRejection(statusCode: number, message: string) {
  return {
    success: false,
    statusCode,
    message,
    timestamp: '2026-08-16T00:00:00.000Z',
    path: `/budgets/${BUDGET_ID}/lines`,
    errors: null,
    details: { message },
  };
}

function mockReport(over: Record<string, unknown> = {}) {
  variance.mockResolvedValue({ data: { ...REPORT, ...over } } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // `renderWithProviders` seeds user/isAuthenticated/isLoading but not
  // `hasHydrated`, and `ProtectedRoute` renders nothing until that flag is set.
  useAuthStore.setState({ hasHydrated: true });
  // The screen reads its budget id from the route, not from a prop.
  navigationState.params = { id: BUDGET_ID };
  mockReport();
  libraryGetAll.mockResolvedValue({ success: true, data: CATEGORIES } as never);
  departmentGetAll.mockResolvedValue({ success: true, data: DEPARTMENTS } as never);
});

/** Renders as ADMIN by default; the report has settled when this returns. */
async function renderPage(
  options: Parameters<typeof renderWithProviders>[1] = {},
) {
  const result = renderWithProviders(<BudgetVariancePage />, {
    role: 'ADMIN',
    ...options,
  });
  await waitFor(() =>
    expect(
      variance,
      'the report is fetched for the budget named in the route',
    ).toHaveBeenCalledWith(BUDGET_ID),
  );
  await waitFor(() =>
    expect(
      screen.queryByTestId('budget-total-planned') ??
        screen.queryByTestId('budget-variance-empty'),
      'the loading placeholder has been replaced by the report',
    ).toBeTruthy(),
  );
  return result;
}

/** Opens the line form and waits for the category master to arrive. */
async function openLineForm(user: ReturnType<typeof renderWithProviders>['user']) {
  await user.click(screen.getByTestId('budget-line-new'));
  await waitFor(() =>
    expect(
      screen.getByRole('option', { name: 'Training' }),
      'the category picker has been populated',
    ).toBeInTheDocument(),
  );
}

/** Reads the raw figure a totals tile publishes beside its formatted money. */
const tileAmount = (label: string) =>
  screen.getByTestId(`budget-total-${label}`).getAttribute('data-amount');

describe('the budget line form', () => {
  it('refuses a line with no category, because a category is what spend matches on', async () => {
    const { user } = await renderPage();
    await openLineForm(user);

    await user.click(screen.getByTestId('budget-line-save'));

    expect(toastWarning, 'the user is told what is missing').toHaveBeenCalledWith(
      'Pick a category',
    );
    expect(upsertLine, 'nothing reaches the server').not.toHaveBeenCalled();
  });

  it('asks the library for ACTIVE budget categories only', async () => {
    await renderPage();

    await waitFor(() =>
      expect(
        libraryGetAll,
        'the picker is fed from the BUDGET_CATEGORY master, active rows only',
      ).toHaveBeenCalledWith('BUDGET_CATEGORY', true),
    );
  });

  it('points at the master when no budget categories are configured', async () => {
    // Without the hint the select renders as a bare placeholder and the form
    // looks broken, with no clue that the fix is one screen away.
    libraryGetAll.mockResolvedValue({ success: true, data: [] } as never);
    const { user } = await renderPage();

    await user.click(screen.getByTestId('budget-line-new'));

    expect(
      screen.getByText(/No budget categories configured yet/i),
      'the empty-master hint replaces a silently empty dropdown',
    ).toBeInTheDocument();
  });

  it('keeps the form usable when the pickers fail to load', async () => {
    // Non-fatal by design — the selects are empty, but the page must not crash.
    libraryGetAll.mockRejectedValue(new Error('network'));
    const { user } = await renderPage();

    await user.click(screen.getByTestId('budget-line-new'));

    expect(
      screen.getByTestId('budget-line-amount'),
      'the rest of the form still renders',
    ).toBeInTheDocument();
  });
});

describe('the company-wide fallback line', () => {
  it('offers the fallback as the department picker’s default', async () => {
    // Not a "choose one" placeholder: leaving it alone is a real, meaningful
    // choice, and the label has to say so.
    const { user } = await renderPage();
    await openLineForm(user);

    const select = screen.getByTestId('budget-line-department') as HTMLSelectElement;
    expect(
      select.value,
      'no department is pre-selected, so the line defaults to company-wide',
    ).toBe('');
    expect(
      screen.getByRole('option', { name: 'Company-wide (fallback)' }),
      'the default is named as the fallback it is, not as an empty choice',
    ).toBeInTheDocument();
  });

  it('sends no departmentId at all when the line is company-wide', async () => {
    // An empty string would reach a `@IsUUID()` validator and be refused; the
    // fallback line is expressed as the ABSENCE of a department.
    upsertLine.mockResolvedValue({ data: { id: 'line-9' } } as never);
    const { user } = await renderPage();
    await openLineForm(user);

    await user.selectOptions(screen.getByTestId('budget-line-category'), 'Training');
    await user.clear(screen.getByTestId('budget-line-amount'));
    await user.type(screen.getByTestId('budget-line-amount'), '5000');
    await user.click(screen.getByTestId('budget-line-save'));

    await waitFor(() =>
      expect(upsertLine, 'the line is saved once').toHaveBeenCalledTimes(1),
    );
    expect(
      upsertLine,
      'the budget id travels separately and the body carries no department',
    ).toHaveBeenCalledWith(BUDGET_ID, { category: 'Training', plannedAmount: 5000 });
    expect(
      upsertLine.mock.calls[0][1].departmentId,
      'a company-wide line omits departmentId rather than sending an empty string',
    ).toBeUndefined();
  });

  it('sends the chosen department when the line belongs to one', async () => {
    upsertLine.mockResolvedValue({ data: { id: 'line-9' } } as never);
    const { user } = await renderPage();
    await openLineForm(user);

    await user.selectOptions(screen.getByTestId('budget-line-category'), 'Training');
    await user.selectOptions(screen.getByTestId('budget-line-department'), 'dep-1');
    await user.clear(screen.getByTestId('budget-line-amount'));
    await user.type(screen.getByTestId('budget-line-amount'), '5000');
    await user.click(screen.getByTestId('budget-line-save'));

    await waitFor(() => expect(upsertLine).toHaveBeenCalledTimes(1));
    expect(
      upsertLine,
      'a departmental line carries the department it was filed against',
    ).toHaveBeenCalledWith(BUDGET_ID, {
      category: 'Training',
      plannedAmount: 5000,
      departmentId: 'dep-1',
    });
  });

  it('reloads the report after a saved line', async () => {
    upsertLine.mockResolvedValue({ data: { id: 'line-9' } } as never);
    const { user } = await renderPage();
    await openLineForm(user);

    await user.selectOptions(screen.getByTestId('budget-line-category'), 'Training');
    await user.click(screen.getByTestId('budget-line-save'));

    await waitFor(() =>
      expect(
        variance,
        'the new line shows in the table without a manual refresh',
      ).toHaveBeenCalledTimes(2),
    );
  });

  it('shows the server’s own sentence when a line is refused', async () => {
    upsertLine.mockRejectedValue(
      interceptorRejection(400, 'A closed budget cannot take new lines') as never,
    );
    const { user } = await renderPage();
    await openLineForm(user);

    await user.selectOptions(screen.getByTestId('budget-line-category'), 'Training');
    await user.click(screen.getByTestId('budget-line-save'));

    await waitFor(() =>
      expect(
        toastError,
        'the backend explanation reaches the user verbatim',
      ).toHaveBeenCalledWith('A closed budget cannot take new lines'),
    );
    expect(
      toastError,
      'the generic fallback never appears when the server explained itself',
    ).not.toHaveBeenCalledWith('Failed to save the line');
  });
});

describe('the totals tiles', () => {
  it('renders the report’s own totals rather than re-adding the visible rows', async () => {
    // The fixture's rows sum to 10,000 + 4,000 = 14,000 planned while the
    // budget's planned figure is 25,000 — which is what a scoped caller really
    // sees. A screen that summed the rows would understate the budget for
    // exactly the users who most need it right.
    await renderPage();

    expect(tileAmount('planned'), 'Planned comes from report.totals').toBe('25000');
    expect(tileAmount('planned'), 'Planned is not the sum of the visible rows').not.toBe(
      '14000',
    );
    expect(tileAmount('committed'), 'Committed comes from report.totals').toBe('3000');
    expect(tileAmount('actual'), 'Actual comes from report.totals').toBe('3500');
    expect(tileAmount('remaining'), 'Remaining comes from report.totals').toBe('18500');
    // `Remaining = Planned − OPEN − Actual` is the server's rule, applied to
    // every line including the ones this caller cannot read. Adding up the row
    // remainings gives 7,500 — the number a client-side computation would show.
    expect(
      tileAmount('remaining'),
      'Remaining is not the sum of the visible rows either',
    ).not.toBe('7500');
  });

  it('formats the tiles in the currency the report names', async () => {
    // The currency is the budget's, not the viewer's locale default.
    await renderPage();

    expect(
      screen.getByTestId('budget-total-planned').textContent,
      'the budget’s own currency prefixes its figures',
    ).toContain('OMR');
  });

  it('renders each budget line with the figures the report gave it', async () => {
    await renderPage();

    const rows = screen.getAllByTestId('budget-line-row');
    expect(rows, 'one row per reported line').toHaveLength(2);
    expect(
      rows[0].getAttribute('data-planned'),
      'the row publishes the raw figure behind its formatted money',
    ).toBe('10000');
    expect(
      rows[0].getAttribute('data-committed'),
      'committed counts OPEN commitments only',
    ).toBe('2000');
  });

  it('names spend that has no budget line at all', async () => {
    // Real money went out against a heading nothing was budgeted for. Leaving
    // it off the screen turns an over-run into an apparent under-spend.
    await renderPage();

    expect(
      screen.getByTestId('budget-unbudgeted'),
      'unbudgeted spend is surfaced, not swallowed',
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('budget-unbudgeted').textContent,
      'the offending category is named',
    ).toContain('Relocation');
  });

  it('says so plainly when the budget has no lines yet', async () => {
    mockReport({ rows: [], unbudgeted: [] });
    await renderPage();

    expect(
      screen.getByTestId('budget-variance-empty'),
      'an empty budget states its emptiness rather than rendering a blank table',
    ).toBeInTheDocument();
  });
});

describe('deleting a budget line', () => {
  it('deletes the line the user confirmed', async () => {
    removeLine.mockResolvedValue({ data: null } as never);
    const { user } = await renderPage();

    await user.click(screen.getAllByTestId('budget-line-delete')[0]);
    await user.click(screen.getByTestId('confirm-modal-confirm'));

    await waitFor(() =>
      expect(
        removeLine,
        'the confirmed row’s own id is the one deleted',
      ).toHaveBeenCalledWith(BUDGET_ID, 'line-1'),
    );
  });

  it('deletes nothing when the confirmation is dismissed', async () => {
    // The refusal path matters more than the happy one here: a delete is
    // blocked while commitments are held against the line, so a dismissed
    // dialog that deleted anyway would be unrecoverable.
    removeLine.mockResolvedValue({ data: null } as never);
    const { user } = await renderPage();

    await user.click(screen.getAllByTestId('budget-line-delete')[0]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(
        screen.queryByTestId('confirm-modal-confirm'),
        'dismissing closes the dialog',
      ).not.toBeInTheDocument(),
    );
    expect(removeLine, 'a dismissed confirmation deletes nothing').not.toHaveBeenCalled();
  });

  it('names the line in the confirmation, so the user knows which one they are on', async () => {
    const { user } = await renderPage();

    await user.click(screen.getAllByTestId('budget-line-delete')[0]);

    expect(
      screen.getByText(/Delete the Engineering \/ Training line\?/i),
      'the dialog identifies the row by department and category',
    ).toBeInTheDocument();
  });

  it('reloads the report after a confirmed delete', async () => {
    removeLine.mockResolvedValue({ data: null } as never);
    const { user } = await renderPage();

    await user.click(screen.getAllByTestId('budget-line-delete')[0]);
    await user.click(screen.getByTestId('confirm-modal-confirm'));

    await waitFor(() =>
      expect(
        variance,
        'the totals move with the deleted line, without a manual refresh',
      ).toHaveBeenCalledTimes(2),
    );
  });

  it('shows the server’s own sentence when a delete is refused', async () => {
    // The one refusal this screen exists to explain: a line cannot go while
    // approved requests still hold commitments against it. "Failed to delete
    // the line" would leave the user with no idea what to do next.
    removeLine.mockRejectedValue(
      interceptorRejection(
        409,
        'This line still holds 2 open commitments and cannot be deleted',
      ) as never,
    );
    const { user } = await renderPage();

    await user.click(screen.getAllByTestId('budget-line-delete')[0]);
    await user.click(screen.getByTestId('confirm-modal-confirm'));

    await waitFor(() =>
      expect(
        toastError,
        'the backend explanation reaches the user verbatim',
      ).toHaveBeenCalledWith(
        'This line still holds 2 open commitments and cannot be deleted',
      ),
    );
    expect(
      toastError,
      'the generic fallback never appears when the server explained itself',
    ).not.toHaveBeenCalledWith('Failed to delete the line');
  });

  it('dismisses the confirmation dialog once the delete has settled', async () => {
    // `confirm()` leaves the dialog up on purpose so the caller can paint
    // "Processing…" over its own work, so every exit owes it a `closeModal()`.
    // This page destructured it and never called it, stranding the modal in its
    // loading state over the reloaded report.
    removeLine.mockResolvedValue({ data: null } as never);
    const { user } = await renderPage();

    await user.click(screen.getAllByTestId('budget-line-delete')[0]);
    await user.click(screen.getByTestId('confirm-modal-confirm'));

    await waitFor(() => expect(removeLine).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.queryByTestId('confirm-modal-confirm'),
        'the dialog was left covering the refreshed report',
      ).not.toBeInTheDocument(),
    );
  });

  it('dismisses it when the delete is REFUSED, which is the likelier path here', async () => {
    // A line holding open commitments is refused, and that is the case a reader
    // is most likely to hit — so the close belongs in a `finally`, not on the
    // success path.
    removeLine.mockRejectedValue({
      message:
        'This line has open commitments from approved requests. Release or realize them before deleting it.',
    } as never);
    const { user } = await renderPage();

    await user.click(screen.getAllByTestId('budget-line-delete')[0]);
    await user.click(screen.getByTestId('confirm-modal-confirm'));

    await waitFor(() => expect(removeLine).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.queryByTestId('confirm-modal-confirm'),
        'a refused delete left the dialog up',
      ).not.toBeInTheDocument(),
    );
  });
});

describe('who reaches the screen', () => {
  it.each(['MANAGER', 'EMPLOYEE'] as const)(
    'renders nothing for %s, who has no business reading company spend',
    (role) => {
      renderWithProviders(<BudgetVariancePage />, { role });

      expect(
        screen.queryByTestId('budget-line-new'),
        `${role} is outside the ADMIN/HR_MANAGER guard on this route`,
      ).not.toBeInTheDocument();
    },
  );
});
