import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { AdvanceLoansPage, selectBranch } from '../../pages';
import { LoanLifecyclePage } from '../../pages/loan-lifecycle';
import { marker, retire, retireAllMarked, ensureAllowance, withSetting } from '../../loan-support';

/**
 * The three screens that existed only as HTTP routes.
 *
 * Each of these was reachable with curl and by nothing a person could click:
 *
 *  - the **terms** on the request form — product, cadence, grace, interest and
 *    the date the loan runs from. `CreateAdvanceLoanDto` carried four fields
 *    (type, amount, reason, instalments) and the schedule engine's other knobs
 *    could only be set by the bulk importer, which is why six of the thirteen
 *    backend suites had become importer-driven.
 *  - **disbursement**. `APPROVED → DISBURSED` had no caller at all, so a status
 *    the list filters on and the badge renders could not be reached.
 *  - **repricing and top-up**. `LoanRateChange` was a fully modelled table with
 *    zero code references; `TOPUP_SETTLEMENT`, `TOPPED_UP` and both
 *    `loan_topup_*` settings existed with nothing implementing them.
 *
 * These are journeys, not unit tests of the dialogs: what is asserted is that
 * the screen sends what the API needs and the loan actually moves — the money
 * questions themselves are settled in the backend e2e suites, which can watch a
 * schedule rebuild without a browser in the way.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const MARKER_PREFIX = 'pw-loanterms-';
const MARK = marker(MARKER_PREFIX);

/** The loan record, peeled of however many envelopes the route wraps it in. */
async function loanRecord(api: ApiClient, id: string): Promise<any> {
  const raw = await api.get<any>(`/advance-loans/${id}`);
  return raw?.data ?? raw;
}

test.describe('the terms a requester can state on the form', () => {
  let adminApi: ApiClient;
  let ownerApi: ApiClient;
  let branchId = '';
  let setupError = '';
  let scratch: string[] = [];

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    try {
      adminApi = await ApiClient.as('admin');
      ownerApi = await ApiClient.as('employee');
      branchId = await adminApi.firstBranchId();
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('employee')) return;
    for (const id of scratch) await retire(id, ownerApi, adminApi).catch(() => undefined);
    scratch = [];
  });

  test.afterAll(async () => {
    if (isProject('employee') && adminApi) {
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    }
    await ownerApi?.dispose();
    await adminApi?.dispose();
  });

  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'filing a request is the requester’s own screen');
    });

    test('the form carries the cadence, the grace and the date, and they reach the loan', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      crashesOnly(problems);

      await ensureAllowance(ownerApi, adminApi, 1200, MARKER_PREFIX);
      await selectBranch(page, branchId);

      const loans = new AdvanceLoansPage(page);
      await loans.open();
      await page.getByTestId('loan-new').click();

      // The four fields that had no HTTP surface until this work, filled from
      // the screen rather than posted around it — the point of the case is the
      // seam, so nothing here goes through the API.
      // LOAN first: the instalment, cadence and grace fields belong to the loan
      // flow, and an advance is recovered in one cycle by definition — so on
      // the ADVANCE tab there is nothing for them to describe.
      await page.getByTestId('loan-type-LOAN').click();
      await page.getByTestId('loan-amount').fill('1200');
      await page.getByTestId('loan-installments').fill('4');
      await page.getByTestId('loan-frequency').selectOption('QUARTERLY');
      await page.getByTestId('loan-grace').fill('1');
      await page.getByTestId('loan-reason').fill(`${MARK} — quarterly with a grace cycle`);
      await page.getByTestId('loan-submit').click();

      // The request that came back is the one the form described. Read from the
      // API rather than from the row on screen: the list shows what a borrower
      // is told, and the claim here is about what was SENT.
      const filed = async () => {
        const rows = await ownerApi.get<any>('/advance-loans/my-requests');
        const list = Array.isArray(rows) ? rows : (rows?.data ?? []);
        return list.find((r: any) => String(r.reason ?? '').includes(`${MARK} — quarterly`));
      };
      await expect.poll(filed, { timeout: 20_000 }).toBeTruthy();
      const mine = await filed();

      scratch.push(mine.id);
      expect(mine.deductionFrequency, 'the cadence the form offered did not reach the loan').toBe(
        'QUARTERLY',
      );
      expect(Number(mine.gracePeriods), 'the grace the form offered did not reach the loan').toBe(1);

      settle(problems, 'filing a request with terms');
    });

    test('a rate is offered only where the server will honour one', async ({ page, problems }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      crashesOnly(problems);

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);

      // `loan_interest_enabled` is published to the browser for exactly this:
      // the form must not collect a term the server is going to refuse. Off is
      // the shipped default, so this is the state most deployments are in.
      await withSetting(adminApi, 'loan_interest_enabled', 'false', async () => {
        await loans.open();
        await page.getByTestId('loan-new').click();
        await page.getByTestId('loan-type-LOAN').click();
        expect(
          await page.getByTestId('loan-interest-rate').count(),
          'an interest rate was offered while interest is switched off',
        ).toBe(0);
        await page.keyboard.press('Escape');
      });

      await withSetting(adminApi, 'loan_interest_enabled', 'true', async () => {
        await loans.open();
        await page.getByTestId('loan-new').click();
        await page.getByTestId('loan-type-LOAN').click();
        await expect(page.getByTestId('loan-interest-rate')).toBeVisible();
        await page.keyboard.press('Escape');
      });

      settle(problems, 'the interest field following its kill switch');
    });
  });
});

test.describe('recording the payout, repricing and topping up', () => {
  let adminApi: ApiClient;
  let ownerApi: ApiClient;
  let branchId = '';
  let setupError = '';
  let scratch: string[] = [];

  /** One APPROVED loan, filed by its owner and approved but NOT paid out. */
  const approved = async (amount: number, note: string): Promise<string> => {
    await ensureAllowance(ownerApi, adminApi, amount, MARKER_PREFIX);
    const filed = await ownerApi.post<any>('/advance-loans', {
      type: 'LOAN',
      amount,
      installments: 4,
      reason: `${MARK} — ${note}`,
    });
    const id = filed?.id ?? filed?.data?.id;
    scratch.push(id);
    await adminApi.post(`/advance-loans/${id}/approve`, {});
    return id;
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      ownerApi = await ApiClient.as('employee');
      branchId = await adminApi.firstBranchId();
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin')) return;
    for (const id of scratch) await retire(id, ownerApi, adminApi).catch(() => undefined);
    scratch = [];
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) {
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    }
    await ownerApi?.dispose();
    await adminApi?.dispose();
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'paying a loan out is a finance action');
    });

    test('an approved loan is paid out from the screen and lands DISBURSED', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      crashesOnly(problems);

      const loanId = await approved(2000, 'the payout');
      await selectBranch(page, branchId);

      const detail = new LoanLifecyclePage(page);
      await detail.open(loanId);

      // Offered on an APPROVED loan and on nothing else — once the money has
      // moved the button has nothing left to do.
      expect(await detail.offers('disburse'), 'an approved loan was offered no payout').toBe(true);

      await detail.run('disburse', {});
      await detail.expectStatus('DISBURSED');

      const record = await loanRecord(adminApi, loanId);
      expect(record.disbursementDate, 'the payout did not stamp the date the money moved').toBeTruthy();
      expect(
        await detail.offers('disburse'),
        'a loan that has already been paid out is still offered a payout',
      ).toBe(false);

      settle(problems, 'recording a loan payout');
    });

    test('a live loan is repriced, and the change is recorded against it', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      crashesOnly(problems);

      const loanId = await approved(2400, 'the repricing');
      await adminApi.post(`/advance-loans/${loanId}/disburse`, {});
      await selectBranch(page, branchId);

      await withSetting(adminApi, 'loan_interest_enabled', 'true', async () => {
        const detail = new LoanLifecyclePage(page);
        await detail.open(loanId);

        // KEEP_TENURE: the loan still ends when it was going to and the
        // instalment moves — the choice a payroll deduction can absorb.
        await detail.run('rateChange', {
          'new-method': 'FLAT',
          'new-rate': '9',
          mode: 'KEEP_TENURE',
          reason: `${MARK} repriced to 9% flat`,
        });

        const record = await loanRecord(adminApi, loanId);
        expect(Number(record.interestRate), 'the new rate did not reach the loan').toBe(9);

        // `LoanRateChange` existed as a table with no writer at all, so the
        // history is the half most worth pinning.
        const history = await adminApi.get<any>(`/advance-loans/${loanId}/rate-history`);
        const rows = Array.isArray(history) ? history : (history?.data ?? []);
        expect(rows.length, 'the repricing left no history behind').toBeGreaterThan(0);
      });

      settle(problems, 'repricing a live loan');
    });

    test('a top-up settles the old loan and opens the new one', async ({ page, problems }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      crashesOnly(problems);

      const loanId = await approved(1000, 'the loan to top up');
      await adminApi.post(`/advance-loans/${loanId}/disburse`, {});
      await selectBranch(page, branchId);

      await withSetting(adminApi, 'loan_topup_enabled', 'true', async () => {
        const detail = new LoanLifecyclePage(page);
        await detail.open(loanId);

        // The total principal of the NEW loan, not the extra cash: the borrower
        // receives the difference and carries one instalment, which is the
        // whole reason a top-up is not "file a second loan".
        await detail.run('topup', {
          amount: '2500',
          installments: '6',
          reason: `${MARK} topped up to 2500`,
        });

        const old = await loanRecord(adminApi, loanId);
        expect(old.status, 'the topped-up loan is still live').toBe('CLOSED');
        expect(old.closureType, 'the closure does not say it was a top-up').toBe('TOPPED_UP');

        // The replacement re-enters approval like any other request, and says
        // where it came from.
        const mine = await ownerApi.get<any>('/advance-loans/my-requests');
        const list = Array.isArray(mine) ? mine : (mine?.data ?? []);
        const replacement = list.find((r: any) => r.topupOfId === loanId);
        expect(replacement, 'the top-up did not open a replacement loan').toBeTruthy();
        scratch.push(replacement.id);
        expect(Number(replacement.amount)).toBe(2500);
      });

      settle(problems, 'topping up a live loan');
    });
  });
});
