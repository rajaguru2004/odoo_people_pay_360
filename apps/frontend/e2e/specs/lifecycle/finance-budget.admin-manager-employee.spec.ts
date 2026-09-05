import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { ToastArea, selectBranch } from '../../pages';
import { BudgetsPage, BudgetVariancePage } from '../../pages/budgets';
import { TravelPage } from '../../pages/travel';

/**
 * An HR budget, from a draft nobody can spend against to a closed one nobody
 * can spend against any more.
 *
 * ── Why this flow is in the suite ───────────────────────────────────────────
 *
 * The variance report is the only screen in the product that answers "can we
 * still afford what we have already agreed to". It answers it with
 *
 *     Remaining = Planned − OPEN commitments − Actual
 *
 * and the middle term is the one that makes the answer honest: a trip approved
 * today is money gone, but it will not appear in `Actual` until the payroll run
 * that pays it is locked, possibly a month later. A ledger that lost its
 * commitments would not look broken — it would look generous, right up to the
 * moment the money left.
 *
 * That number is written by an approval on a COMPLETELY DIFFERENT SCREEN. Nobody
 * on `/dashboard/budgets` presses anything to produce it; an approver on
 * `/dashboard/travel` does, and this file is the only place the two halves are
 * exercised against each other. `BUD-UI-05` is that seam.
 *
 * ── The property that makes a silent failure likely ─────────────────────────
 *
 * **Budgeting never blocks an approval.** Every commitment method swallows its
 * own exception on purpose: this is a reporting ledger, not a spending control,
 * and one that could strand a traveller mid-trip would be worse than none at
 * all. The consequence is that every way this can break is silent by
 * construction — no 500, no toast, no refused button, just a number that is
 * quietly wrong. `BUD-UI-12` asserts the deliberate half of that (a closed
 * budget takes no commitment, and the approval succeeds anyway).
 *
 * ── Facts the cases encode ──────────────────────────────────────────────────
 *
 *   • Only an **ACTIVE** budget whose period covers the spend date attracts
 *     commitments. DRAFT and CLOSED take none.
 *   • A **department** line beats the **company-wide** fallback for the same
 *     category. Both exist here so the resolution has something to get wrong.
 *   • `Budget.branchId` is NOT NULL and scoped `direct`, so the list is a
 *     per-branch view and changing branch has to change it (`BUD-UI-13`).
 *   • Deleting a line cascades its commitments, which would silently free money
 *     still held against approved requests — so it is refused while any are
 *     open (`BUD-UI-06`).
 *
 * ── Fiscal period ───────────────────────────────────────────────────────────
 *
 * NEXT year, deliberately. The baseline seeds an ACTIVE budget for the current
 * year in the same branch, and `resolveLine` picks the first ACTIVE budget whose
 * window contains the spend date — two of them overlapping would make every
 * assertion here a coin toss. A next-year window also guarantees zero actuals,
 * which is what lets `Remaining` be asserted exactly.
 *
 * There is no DELETE route for a budget, so this file retires its own the way
 * the product does: it closes it.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** Distinct per run and visible on screen, so leftovers are identifiable. */
const marker = `pw-budget-${Date.now().toString(36)}`;

/**
 * `TRAVEL_BUDGET_CATEGORY` in `travel.service.ts`.
 *
 * A product constant rather than configuration — the server attributes every
 * trip to this heading — but the picker only offers it if the `BUDGET_CATEGORY`
 * library holds a row with the same label, which is asserted rather than
 * assumed.
 */
const TRAVEL_CATEGORY = 'Travel';

const NEXT_YEAR = new Date().getFullYear() + 1;
const PERIOD_START = `${NEXT_YEAR}-01-01`;
const PERIOD_END = `${NEXT_YEAR}-12-31`;
/** Inside the period, and far enough from its edges to survive a timezone. */
const DEPARTURE = `${NEXT_YEAR}-06-15`;
const RETURN = `${NEXT_YEAR}-06-17`;

const PLANNED_DEPARTMENT = 5000;
const PLANNED_FALLBACK = 2000;
const TRIP_COST = 300;

interface BudgetRecord {
  id: string;
  name: string;
  status: string;
  fiscalYear: number;
  branchId: string;
}

interface VarianceRowRecord {
  budgetLineId: string;
  departmentId: string | null;
  category: string;
  planned: number;
  committed: number;
  actual: number;
  remaining: number;
}

interface VarianceReportRecord {
  rows: VarianceRowRecord[];
  totals: { planned: number; committed: number; actual: number; remaining: number };
  unbudgeted: Array<{ departmentId: string | null; category: string; actual: number }>;
}

interface TravelRecord {
  id: string;
  status: string;
  employee?: { id: string; departmentId: string | null };
  claims?: Array<{ id: string; amount: string; status: string }>;
}

interface DestinationItem {
  label: string;
  perDiemRate: string | number | null;
}

/** A destination the library rates above zero — see the travel journey for why. */
async function ratedDestination(api: ApiClient): Promise<DestinationItem> {
  const list = await api.get<DestinationItem[]>(
    '/library-items?type=PER_DIEM_DESTINATION&activeOnly=true',
  );
  const rated = list.find((d) => Number(d.perDiemRate ?? 0) > 0);
  if (!rated) {
    throw new Error(
      'No PER_DIEM_DESTINATION carries a rate above zero — the baseline seed did not run',
    );
  }
  return rated;
}

/** Withdraws a trip this file raised, which also releases whatever it committed. */
async function retire(travelId: string, api: ApiClient): Promise<void> {
  const trip = await api.get<TravelRecord>(`/travel-requests/${travelId}`).catch(() => null);
  if (!trip || !['PENDING', 'APPROVED'].includes(trip.status)) return;
  await api.delete(`/travel-requests/${travelId}`).catch(() => undefined);
}

/**
 * The last toast, whichever toaster raised it.
 *
 * These screens call `sonner` directly rather than the app's own `lib/toast`,
 * so `ToastArea.waitFor()` — which watches the app's component — never sees
 * them. `latest()` reads both, hence the poll.
 */
async function lastToast(toasts: ToastArea): Promise<{ type: string; text: string }> {
  await expect
    .poll(async () => (await toasts.latest())?.text ?? '', { timeout: 15_000 })
    .not.toBe('');
  return (await toasts.latest())!;
}

test.describe('an HR budget from draft to closed', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the budget-owning role');
  });

  let adminApi: ApiClient;
  let employeeApi: ApiClient;
  let branchId = '';
  let departmentId = '';
  let budgetId = '';
  let deptLineId = '';
  let fallbackLineId = '';
  let tripId = '';
  let secondTripId = '';
  let setupError = '';

  const budgetName = `${marker} FY${NEXT_YEAR}`;

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    adminApi = await ApiClient.as('admin');
    employeeApi = await ApiClient.as('employee');

    try {
      branchId = await adminApi.firstBranchId();

      /**
       * Close anything a crashed earlier run of THIS file left ACTIVE.
       *
       * Two ACTIVE budgets covering the same branch and window would make
       * `resolveLine`'s `findFirst` pick one of them arbitrarily, and every
       * commitment assertion below would pass or fail by luck. Narrowed to this
       * file's own naming so it can never touch a real budget or one another
       * project is using.
       */
      const existing = await adminApi.get<BudgetRecord[]>(
        `/budgets?fiscalYear=${NEXT_YEAR}`,
      );
      for (const stale of existing.filter(
        (b) =>
          b.branchId === branchId && b.status === 'ACTIVE' && b.name.startsWith('pw-budget-'),
      )) {
        await adminApi
          .patch(`/budgets/${stale.id}/status`, { status: 'CLOSED' })
          .catch(() => undefined);
      }

      const destination = await ratedDestination(employeeApi);
      const file = async (tag: string): Promise<TravelRecord> =>
        employeeApi.post<TravelRecord>('/travel-requests', {
          purpose: `Automated journey ${marker} — ${tag}`,
          travelType: 'DOMESTIC',
          destination: destination.label,
          departureDate: DEPARTURE,
          returnDate: RETURN,
          estimatedCost: TRIP_COST,
        });

      const trip = await file('the commitment');
      tripId = trip.id;
      // The commitment resolves against the TRAVELLER's department, not the
      // approver's, so this is read from the trip rather than assumed.
      departmentId = trip.employee?.departmentId ?? '';

      secondTripId = (await file('the closed budget')).id;
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin')) {
      if (tripId) await retire(tripId, adminApi);
      if (secondTripId) await retire(secondTripId, adminApi);
      // No DELETE route exists for a budget; closing is how the product retires
      // one, and it is what stops a half-finished run leaving an ACTIVE budget
      // that the next run's commitments could land in.
      if (budgetId) {
        await adminApi
          .patch(`/budgets/${budgetId}/status`, { status: 'CLOSED' })
          .catch(() => undefined);
      }
    }
    await adminApi?.dispose();
    await employeeApi?.dispose();
  });

  test('BUD-UI-01 a new budget is created as a DRAFT', async ({ page, problems }) => {
    expect(tripId, `setup failed: ${setupError}`).toBeTruthy();

    await selectBranch(page, branchId);
    const budgets = new BudgetsPage(page);
    await budgets.open();

    await budgets.create({
      name: budgetName,
      fiscalYear: NEXT_YEAR,
      branchId,
      startDate: PERIOD_START,
      endDate: PERIOD_END,
    });

    // Read back from the server rather than from the screen: what matters is
    // that a budget exists in the state the form promised, not that a row drew.
    await expect
      .poll(
        async () =>
          (await adminApi.get<BudgetRecord[]>(`/budgets?fiscalYear=${NEXT_YEAR}`)).some(
            (b) => b.name === budgetName,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);

    const created = (
      await adminApi.get<BudgetRecord[]>(`/budgets?fiscalYear=${NEXT_YEAR}`)
    ).find((b) => b.name === budgetName)!;
    budgetId = created.id;

    // DRAFT is not a formality: `resolveLine` filters on ACTIVE, so a budget in
    // this state takes no commitments however many lines it has.
    expect(created.status, 'a new budget was created ready to spend against').toBe('DRAFT');
    expect(created.branchId).toBe(branchId);

    await budgets.expectRowStatus(budgetId, 'DRAFT');
    expect(await budgets.canActivate(budgetId)).toBe(true);
    expect(await budgets.canClose(budgetId), 'a DRAFT was offered Close').toBe(false);

    settle(problems, 'creating a budget');
  });

  test('BUD-UI-02 a budget with no lines reports an empty variance and zero totals', async ({
    page,
    problems,
  }) => {
    test.skip(!budgetId, 'no budget was created');

    await selectBranch(page, branchId);
    const budgets = new BudgetsPage(page);
    await budgets.open();
    // Through the row's own link, so the navigation is exercised too — this is
    // a dynamic route and `e2e/routes.ts` cannot see it.
    await budgets.openVariance(budgetId);

    const variance = new BudgetVariancePage(page);
    expect(await variance.isVarianceEmpty()).toBe(true);
    expect(await variance.lineCount()).toBe(0);
    expect(await variance.totals()).toEqual({
      planned: 0,
      committed: 0,
      actual: 0,
      remaining: 0,
    });
    // A future fiscal window cannot contain paid money, so there is nothing to
    // report as unbudgeted either.
    expect(await variance.hasUnbudgetedBanner()).toBe(false);
    expect(await variance.canExport(), 'the report offered no export').toBe(true);

    settle(problems, 'the variance report of an empty budget');
  });

  test('BUD-UI-03 activating it offers Close instead of Activate', async ({
    page,
    problems,
  }) => {
    test.skip(!budgetId, 'no budget was created');

    await selectBranch(page, branchId);
    const budgets = new BudgetsPage(page);
    await budgets.open();
    await budgets.activate(budgetId);

    await expect
      .poll(
        async () => (await adminApi.get<BudgetRecord>(`/budgets/${budgetId}`)).status,
        { timeout: 15_000 },
      )
      .toBe('ACTIVE');

    await budgets.expectRowStatus(budgetId, 'ACTIVE');
    expect(await budgets.canActivate(budgetId), 'an ACTIVE budget was offered Activate').toBe(
      false,
    );
    expect(await budgets.canClose(budgetId)).toBe(true);

    settle(problems, 'activating a budget');
  });

  test('BUD-UI-04 a department line and a company-wide fallback are planned', async ({
    page,
    problems,
  }) => {
    test.skip(!budgetId || !departmentId, 'no budget, or no department to plan for');

    await selectBranch(page, branchId);
    const variance = new BudgetVariancePage(page);
    await variance.open(budgetId);

    await variance.openLineForm();
    // The category the server attributes travel to has to be offerable, or the
    // rest of this journey is asserting a line nothing will ever commit against.
    expect(
      await variance.categoryOptions(),
      'the BUDGET_CATEGORY library has no Travel row — the baseline seed did not run',
    ).toContain(TRAVEL_CATEGORY);
    expect(await variance.departmentOptions()).toContain(departmentId);
    await variance.fillLine({
      category: TRAVEL_CATEGORY,
      departmentId,
      plannedAmount: PLANNED_DEPARTMENT,
    });
    await variance.saveLine();

    await variance.addLine({
      category: TRAVEL_CATEGORY,
      plannedAmount: PLANNED_FALLBACK,
    });

    const report = await adminApi.get<VarianceReportRecord>(`/budgets/${budgetId}/variance`);
    expect(report.rows, 'the two lines did not both persist').toHaveLength(2);
    deptLineId = report.rows.find((r) => r.departmentId === departmentId)!.budgetLineId;
    fallbackLineId = report.rows.find((r) => r.departmentId === null)!.budgetLineId;
    expect(deptLineId, 'no department line was created').toBeTruthy();
    expect(fallbackLineId, 'no company-wide fallback line was created').toBeTruthy();

    await variance.open(budgetId);
    await expect.poll(() => variance.lineCount(), { timeout: 15_000 }).toBe(2);
    expect(await variance.linePlanned(deptLineId)).toBe(PLANNED_DEPARTMENT);
    expect(await variance.linePlanned(fallbackLineId)).toBe(PLANNED_FALLBACK);
    expect(await variance.total('planned')).toBe(PLANNED_DEPARTMENT + PLANNED_FALLBACK);
    // Nothing is committed or spent yet, so Remaining is the whole plan.
    expect(await variance.total('remaining')).toBe(PLANNED_DEPARTMENT + PLANNED_FALLBACK);

    settle(problems, 'planning budget lines');
  });

  test('BUD-UI-05 approving a trip moves the Committed tile onto the department line', async ({
    page,
    problems,
  }) => {
    test.skip(!deptLineId || !tripId, 'no line to commit against');

    await selectBranch(page, branchId);

    // The seam. Nothing on the budget screens produces this number; an approver
    // on another screen entirely does, and the two have never been exercised
    // against each other before.
    const travel = new TravelPage(page);
    await travel.open();
    // Narrowed to the queue: the list pages at 25 by departure date, and every
    // run of the Finance suites leaves its settled trips in it.
    await travel.filterByStatus('PENDING');
    await expect.poll(() => travel.hasRow(tripId), { timeout: 15_000 }).toBe(true);
    await travel.approve(tripId);

    await expect
      .poll(
        async () => (await adminApi.get<TravelRecord>(`/travel-requests/${tripId}`)).status,
        { timeout: 20_000 },
      )
      .toBe('APPROVED');

    // Read the ledger over the API before opening the screen. The variance page
    // fetches once on mount and never again, so polling the rendered tile could
    // only ever re-read a number that was already stale when it was drawn.
    await expect
      .poll(
        async () =>
          (await adminApi.get<VarianceReportRecord>(`/budgets/${budgetId}/variance`)).totals
            .committed,
        { timeout: 20_000 },
      )
      .toBe(TRIP_COST);

    const variance = new BudgetVariancePage(page);
    await variance.open(budgetId);

    await variance.expectTotal('committed', TRIP_COST);
    // Department-specific beats the company-wide fallback. Getting this backwards
    // would still add up at the top and charge the wrong team.
    expect(await variance.lineCommitted(deptLineId)).toBe(TRIP_COST);
    expect(
      await variance.lineCommitted(fallbackLineId),
      "the fallback line absorbed spend the traveller's own department has a line for",
    ).toBe(0);

    // Remaining = Planned − OPEN − Actual, and Actual is zero in a future year.
    expect(await variance.total('remaining')).toBe(
      PLANNED_DEPARTMENT + PLANNED_FALLBACK - TRIP_COST,
    );
    expect(await variance.total('actual'), 'unpaid money was reported as spent').toBe(0);

    settle(problems, 'the commitment raised by approving a trip');
  });

  test('BUD-UI-06 a line holding commitments cannot be deleted', async ({
    page,
    problems,
  }) => {
    test.skip(!deptLineId, 'no line to delete');

    await selectBranch(page, branchId);
    const variance = new BudgetVariancePage(page);
    await variance.open(budgetId);

    await variance.deleteLine(deptLineId);

    // Deleting cascades the commitments, so allowing it would silently free
    // money still held against an approved trip — Remaining would go up and
    // nothing anywhere would say why.
    const report = await adminApi.get<VarianceReportRecord>(`/budgets/${budgetId}/variance`);
    expect(
      report.rows.some((r) => r.budgetLineId === deptLineId),
      'a line with open commitments was deleted',
    ).toBe(true);
    expect(await variance.hasLine(deptLineId)).toBe(true);

    const toast = await lastToast(new ToastArea(page));
    expect(toast.type, 'the refusal was not shown to the user at all').toBe('error');

    // The refusal is the point of the test, and the 400 behind it is logged.
    crashesOnly(problems);
    settle(problems, 'deleting a committed budget line');
  });

  test('BUD-UI-07 the refusal reaches the user in the SERVER\'s words', async ({
    page,
    problems,
  }) => {
    test.skip(!deptLineId, 'no line to delete');

    /**
     * FIXED. The server explains itself precisely — "This line has open
     * commitments from approved requests. Release or realize them before
     * deleting it." — and the screen used to throw that away. It read
     * `e?.response?.data?.message`, but `lib/axios.ts` rejects with a FLAT
     * object that has no `.response`, so the expression was always `undefined`
     * and the fallback won. The user was told "Failed to delete the line",
     * which does not say what to do next.
     *
     * That is the incident recorded in `docs/LOAN-ADVANCES-TEST-CASES.md`,
     * repeated: nine sites in advance-loans were fixed by routing through
     * `apiErrorMessage()`, and the budgets and travel screens were never
     * audited. All fourteen of those sites now go through the same helper.
     *
     * The assertion is on the CONTENT of the refusal, not its status code,
     * because the content is the only part the user can act on.
     */
    await selectBranch(page, branchId);
    const variance = new BudgetVariancePage(page);
    await variance.open(budgetId);
    await variance.deleteLine(deptLineId);

    const toast = await lastToast(new ToastArea(page));
    crashesOnly(problems);
    expect(toast.text, "the server's reason never reached the user").toMatch(
      /open commitments/i,
    );

    settle(problems, 'the wording of the delete refusal');
  });

  test('BUD-UI-08 cancelling the trip releases the commitment and Remaining comes back', async ({
    page,
    problems,
  }) => {
    test.skip(!tripId || !deptLineId, 'nothing was committed');

    await selectBranch(page, branchId);
    const travel = new TravelPage(page);
    await travel.open();
    await travel.filterByStatus('APPROVED');
    await expect.poll(() => travel.hasRow(tripId), { timeout: 15_000 }).toBe(true);
    await travel.cancel(tripId);

    await expect
      .poll(
        async () => (await adminApi.get<TravelRecord>(`/travel-requests/${tripId}`)).status,
        { timeout: 20_000 },
      )
      .toBe('CANCELLED');

    await expect
      .poll(
        async () =>
          (await adminApi.get<VarianceReportRecord>(`/budgets/${budgetId}/variance`)).totals
            .committed,
        { timeout: 20_000 },
      )
      .toBe(0);

    // Money that is no longer going to be spent has to stop being held. A
    // release that never happened is invisible: the budget simply looks fuller
    // than it is, for the rest of the fiscal year.
    const variance = new BudgetVariancePage(page);
    await variance.open(budgetId);
    await variance.expectTotal('committed', 0);
    expect(await variance.lineCommitted(deptLineId)).toBe(0);
    expect(await variance.total('remaining')).toBe(PLANNED_DEPARTMENT + PLANNED_FALLBACK);

    settle(problems, 'releasing a commitment');
  });

  test('BUD-UI-09 a line with no commitments deletes', async ({ page, problems }) => {
    test.skip(!fallbackLineId, 'no line to delete');

    await selectBranch(page, branchId);
    const variance = new BudgetVariancePage(page);
    await variance.open(budgetId);

    await variance.deleteLine(fallbackLineId);

    await expect.poll(() => variance.hasLine(fallbackLineId), { timeout: 15_000 }).toBe(false);
    const report = await adminApi.get<VarianceReportRecord>(`/budgets/${budgetId}/variance`);
    expect(report.rows.some((r) => r.budgetLineId === fallbackLineId)).toBe(false);
    expect(await variance.total('planned')).toBe(PLANNED_DEPARTMENT);

    /**
     * KNOWN GAP, asserted as it behaves. `useConfirm().handleConfirm` leaves the
     * dialog open on purpose and hands the caller a `closeModal()` to call when
     * the work finishes — which `advance-loans` does and this screen does not.
     * So a successful delete leaves "Processing…" on screen over a table that
     * has already refreshed underneath it.
     *
     * Intended behaviour: close the dialog once the delete resolves.
     */
    expect(
      await variance.confirmDialogIsOpen(),
      'the confirm dialog now closes itself — delete this pin and the comment above it',
    ).toBe(true);

    settle(problems, 'deleting an uncommitted budget line');
  });

  test('BUD-UI-10 the unbudgeted banner is shown exactly where there is over-run spend', async ({
    page,
    problems,
  }) => {
    test.skip(!budgetId, 'no budget was created');

    await selectBranch(page, branchId);
    const variance = new BudgetVariancePage(page);

    // Real spend in a (department, category) with no line is invisible in the
    // rows — surfacing it is the whole point of the banner, because silently
    // dropping it makes an over-run read as an under-spend. Asserted as an
    // invariant against the server across every budget in this branch rather
    // than by manufacturing paid money, which needs a locked payroll run and
    // would be a payroll test wearing a budget test's clothes.
    const budgets = (await adminApi.get<BudgetRecord[]>('/budgets')).filter(
      (b) => b.branchId === branchId,
    );
    expect(budgets.length, 'no budget is visible in this branch').toBeGreaterThan(0);

    for (const budget of budgets.slice(0, 3)) {
      const report = await adminApi.get<VarianceReportRecord>(
        `/budgets/${budget.id}/variance`,
      );
      await variance.open(budget.id);
      expect(
        await variance.hasUnbudgetedBanner(),
        `the banner disagrees with the server on "${budget.name}" (server reported ${report.unbudgeted.length} unbudgeted row(s))`,
      ).toBe(report.unbudgeted.length > 0);
    }

    settle(problems, 'the unbudgeted-spend banner');
  });

  test('BUD-UI-11 closing the budget retires it', async ({ page, problems }) => {
    test.skip(!budgetId, 'no budget was created');

    await selectBranch(page, branchId);
    const budgets = new BudgetsPage(page);
    await budgets.open();
    await budgets.close(budgetId);

    await expect
      .poll(
        async () => (await adminApi.get<BudgetRecord>(`/budgets/${budgetId}`)).status,
        { timeout: 15_000 },
      )
      .toBe('CLOSED');

    await budgets.expectRowStatus(budgetId, 'CLOSED');
    // A closed budget is history: it is still readable, and there is nothing
    // left to do to it from this screen.
    expect(await budgets.canClose(budgetId)).toBe(false);
    expect(await budgets.canActivate(budgetId), 'a CLOSED budget could be re-opened').toBe(
      false,
    );

    settle(problems, 'closing a budget');
  });

  test('BUD-UI-12 a closed budget takes no commitment, and the approval still succeeds', async ({
    page,
    problems,
  }) => {
    test.skip(!secondTripId || !deptLineId, 'no second trip to approve');

    await selectBranch(page, branchId);
    const travel = new TravelPage(page);
    await travel.open();
    await travel.filterByStatus('PENDING');
    await expect.poll(() => travel.hasRow(secondTripId), { timeout: 15_000 }).toBe(true);
    await travel.approve(secondTripId);

    await expect
      .poll(
        async () =>
          (await adminApi.get<TravelRecord>(`/travel-requests/${secondTripId}`)).status,
        { timeout: 20_000 },
      )
      .toBe('APPROVED');

    // The deliberate half of "budgeting never blocks an approval": the trip is
    // approved and its per-diem claim raised even though no ACTIVE budget was
    // there to hold the money. A traveller stranded by an unconfigured budget
    // would be a worse failure than an incomplete ledger.
    const trip = await adminApi.get<TravelRecord>(`/travel-requests/${secondTripId}`);
    expect(trip.claims ?? [], 'the approval was blocked by the closed budget').toHaveLength(1);

    const variance = new BudgetVariancePage(page);
    await variance.open(budgetId);
    expect(
      await variance.total('committed'),
      'a CLOSED budget attracted a commitment',
    ).toBe(0);
    expect(await variance.lineCommitted(deptLineId)).toBe(0);

    settle(problems, 'approving against a closed budget');
  });
});

test.describe('budgets are a per-branch view', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the only globally-scoped role');
  });

  test.describe.configure({ mode: 'serial' });

  let adminApi: ApiClient;
  let branchId = '';
  let otherBranchId = '';
  let anyBudgetId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    adminApi = await ApiClient.as('admin');
    try {
      branchId = await adminApi.firstBranchId();
      const branches = await adminApi.get<Array<{ id: string; code: string }>>('/branches');
      otherBranchId = branches.find((b) => b.code === 'E2E-BR2')?.id ?? '';
      anyBudgetId =
        (await adminApi.get<BudgetRecord[]>('/budgets')).find((b) => b.branchId === branchId)
          ?.id ?? '';
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    await adminApi?.dispose();
  });

  test('BUD-UI-13 switching branch re-scopes the budget list', async ({ page, problems }) => {
    test.skip(!otherBranchId, 'the second branch is not seeded');
    expect(anyBudgetId, `setup failed: ${setupError}`).toBeTruthy();

    await selectBranch(page, branchId);
    const budgets = new BudgetsPage(page);
    await budgets.open();
    await expect.poll(() => budgets.hasRow(anyBudgetId), { timeout: 15_000 }).toBe(true);

    // `Budget.branchId` is NOT NULL and scoped `direct`, which is exactly what
    // makes plain scoping safe here where `LoanType` needs direct-or-global: a
    // budget belongs to one branch and must be invisible from the others.
    await selectBranch(page, otherBranchId);
    await budgets.open();
    await expect.poll(() => budgets.hasRow(anyBudgetId), { timeout: 15_000 }).toBe(false);
    expect(
      (await budgets.ids()).includes(anyBudgetId),
      "another branch's budget was listed",
    ).toBe(false);

    // And back, so the failure "the list is broken" cannot masquerade as
    // "scoping works".
    await selectBranch(page, branchId);
    await budgets.open();
    await expect.poll(() => budgets.hasRow(anyBudgetId), { timeout: 15_000 }).toBe(true);

    settle(problems, 'the branch-scoped budget list');
  });
});

test.describe('who reaches the budget screens', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('manager') && !isProject('employee'), 'the denied roles');
  });

  let adminApi: ApiClient;
  let anyBudgetId = '';

  test.beforeAll(async () => {
    if (!isProject('manager') && !isProject('employee')) return;
    adminApi = await ApiClient.as('admin');
    // A real id, so the case proves the guard refuses rather than that a made-up
    // route 404s.
    anyBudgetId = (await adminApi.get<BudgetRecord[]>('/budgets'))[0]?.id ?? '';
  });

  test.afterAll(async () => {
    await adminApi?.dispose();
  });

  test('BUD-UI-14 a manager and an employee are refused both budget screens', async ({
    page,
    problems,
  }) => {
    test.skip(!anyBudgetId, 'no budget exists to be refused');

    // Budgets are ADMIN/HR_MANAGER on every one of the seven routes behind them
    // and on both screens in front of them. `/dashboard/budgets/[id]` is a
    // dynamic route, so the route matrix never visits it and this is the only
    // case that proves its guard is there at all.
    await page.goto('/dashboard/budgets', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/403/, { timeout: 15_000 });

    await page.goto(`/dashboard/budgets/${anyBudgetId}`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/403/, { timeout: 15_000 });

    crashesOnly(problems);
    settle(problems, 'the budget denials');
  });
});
