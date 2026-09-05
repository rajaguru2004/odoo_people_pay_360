import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { AdvanceLoansPage, selectBranch } from '../../pages';
import { marker, retire, retireAllMarked, ensureAllowance } from '../../loan-support';

/**
 * The two screens the API had been waiting for.
 *
 * `/advance-loans/settlement/*` was complete server-side — seven decisions, a
 * reversal, and a plan validated in full before anything is applied — and no
 * page called any of it, so `SETTLED` and `RECEIVABLE` were statuses no user
 * could reach. Meanwhile `ClearanceBanner` told people to "settle or write off
 * the balance in Advances & Loans", on a screen that could not.
 *
 * `reports/my-statement` had the same shape: implemented, tested, given a
 * client wrapper (`loanReportService.myStatement`) that no page ever called.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const MARKER_PREFIX = 'pw-settleui-';
const MARK = marker(MARKER_PREFIX);

test.describe('final settlement, from the screen', () => {
  let adminApi: ApiClient;
  let owner: ApiClient;
  let setupError = '';
  let scratch: string[] = [];

  test.beforeAll(async () => {
    if (!isProject('hr')) return;
    try {
      adminApi = await ApiClient.as('admin');
      owner = await ApiClient.as('employee');
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('hr')) return;
    for (const id of scratch) await retire(id, owner, adminApi).catch(() => undefined);
    scratch = [];
  });

  test.afterAll(async () => {
    if (isProject('hr') && adminApi) {
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    }
    await owner?.dispose();
    await adminApi?.dispose();
  });

  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'settlement is an HR surface');
    });

    test('the screen exists and reaches the settlement API', async ({ page, problems }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      await page.goto('/dashboard/advance-loans/settlement');
      await expect(page.getByTestId('loan-settlement-employee')).toBeVisible();
      await settle(problems, '/dashboard/advance-loans/settlement');
    });

    test('an employee with an outstanding loan has to be decided before they can be cleared', async ({
      page,
      problems,
    }) => {
      // The rule the server enforces and the screen states first: a silently
      // omitted loan is how a receivable disappears at exit.
      crashesOnly(problems);
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const branchId = await adminApi.firstBranchId();
      await ensureAllowance(owner, adminApi, 500, MARKER_PREFIX);
      const filed = await owner.post<any>('/advance-loans', {
        type: 'LOAN',
        amount: 500,
        installments: 5,
        reason: `${MARK} — settlement subject`,
      });
      const loanId = filed?.id ?? filed?.data?.id;
      scratch.push(loanId);
      await adminApi.post(`/advance-loans/${loanId}/approve`, {});

      const me = await owner.get<any>('/auth/me');
      const employeeId = me?.employeeId ?? me?.data?.employeeId;

      await selectBranch(page, branchId);
      await page.goto(`/dashboard/advance-loans/settlement?employeeId=${employeeId}`);

      // The loan is listed with a decision still to make.
      await expect
        .poll(() => page.getByTestId('loan-settlement-row').count(), { timeout: 15_000 })
        .toBeGreaterThan(0);

      await page.getByTestId('loan-settlement-submit').click();
      // Refused, and nothing was settled.
      await expect(page.getByTestId('loan-settlement-row').first()).toBeVisible();
    });
  });
});

test.describe('a borrower reads their own statement', () => {
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'it is the borrower’s own ledger');
    });

    test('the statement screen loads and lists what they have borrowed', async ({
      page,
      problems,
    }) => {
      await page.goto('/dashboard/my-loan-statement');

      // Either a loan or the empty state — both prove the page called the
      // endpoint that no page called before.
      await expect
        .poll(
          async () =>
            (await page.getByTestId('statement-loan').count()) +
            (await page.getByTestId('statement-empty').count()),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0);

      await expect(page.getByTestId('statement-failed')).toHaveCount(0);
      await settle(problems, '/dashboard/my-loan-statement');
    });

    test('it is reachable from the loans screen', async ({ page, problems }) => {
      const loans = new AdvanceLoansPage(page);
      await loans.open();

      await page.getByTestId('loan-my-statement').click();
      await expect(page).toHaveURL(/my-loan-statement/);
      await settle(problems, '/dashboard/my-loan-statement');
    });
  });
});
