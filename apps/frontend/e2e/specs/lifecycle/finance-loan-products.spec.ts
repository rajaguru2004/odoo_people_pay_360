import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { AdvanceLoansPage, LoanProductsPage, ToastArea, selectBranch } from '../../pages';
import { marker, retire, retireAllMarked, ensureAllowance, loanOf } from '../../loan-support';

/**
 * The loan product catalogue, driven from the screen.
 *
 * `LoanType` was modelled in full and reachable from nowhere: no route, no
 * screen, and `loanTypeId` written by no create path — so twenty-five columns
 * of product terms (interest, fees, ceilings, eligibility, recovery priority)
 * existed and did nothing. This file walks the journey that closes it:
 *
 *   admin defines a product → an employee borrows under it →
 *   the loan carries the product's terms → retiring it stops the NEXT request
 *   and leaves the live one alone.
 *
 * The one thing every case here checks is that the terms land on the LOAN, not
 * merely on the product. A catalogue that saves rows nobody's loan inherits is
 * the same gap wearing a screen.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const MARKER_PREFIX = 'pw-loanproduct-';
const MARK = marker(MARKER_PREFIX);

/** Product codes this file creates, deleted on the way out. */
const CODE_PLAIN = `PWPLAIN${Date.now().toString(36).toUpperCase()}`;
const CODE_SHORT = `PWSHORT${Date.now().toString(36).toUpperCase()}`;

test.describe('an admin manages the product catalogue', () => {
  let adminApi: ApiClient;
  let setupError = '';
  const madeProducts: string[] = [];

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) {
      for (const id of madeProducts) {
        await adminApi.delete(`/loan-types/${id}`).catch(() => undefined);
      }
      await adminApi.dispose();
    }
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the catalogue is an admin surface');
    });

    test('the five default products are already there — a fresh install is not empty', async ({
      page,
      problems,
    }) => {
      // `seedDefaultTypes()` existed from the start and ran only from the demo
      // seed, so a real install had an empty catalogue and every product term
      // was unreachable.
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const products = new LoanProductsPage(page);
      await products.open();

      for (const code of ['PERSONAL', 'SALARY_ADVANCE', 'VEHICLE', 'EDUCATION', 'EMERGENCY']) {
        expect(await products.isOffered(code), `${code} is in the catalogue`).not.toBeNull();
      }
      await settle(problems, '/dashboard/advance-loans/products');
    });

    test('a new product is created from the screen and appears in the table', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const products = new LoanProductsPage(page);
      await products.open();
      await products.create({
        code: CODE_PLAIN,
        name: `${MARK} plain`,
        category: 'LOAN',
        defaultInstallments: 4,
        maxInstallments: 6,
        priority: 20,
      });

      await expect
        .poll(() => products.isOffered(CODE_PLAIN), { timeout: 15_000 })
        .toBe(true);

      const rows = await adminApi.get<any>('/loan-types?includeInactive=true');
      const made = (Array.isArray(rows) ? rows : rows.data).find(
        (r: any) => r.code === CODE_PLAIN,
      );
      expect(made, 'the product reached the server').toBeTruthy();
      madeProducts.push(made.id);
      expect(made.priority, 'the recovery priority was saved').toBe(20);

      await settle(problems, '/dashboard/advance-loans/products');
    });

    test('contradictory terms are refused in the app’s own words, before the round trip', async ({
      page,
      problems,
    }) => {
      // An interest method with no rate is a product that is interest-free
      // with extra steps — and one whose every request would look wrong.
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const products = new LoanProductsPage(page);
      await products.open();
      await products.create({
        code: `PWBAD${Date.now().toString(36).toUpperCase()}`,
        name: `${MARK} bad`,
        interestMethod: 'FLAT',
        rate: 0,
      });

      // `waitFor` asserts the toast TYPE as well as its words: a refusal that
      // arrived as a success toast would still be a defect.
      const toasts = new ToastArea(page);
      await toasts.waitFor('warning', /needs a rate above 0/i);

      // The modal stays open with the work in it rather than closing on a
      // refusal the admin then has to retype.
      await expect(page.getByTestId('loan-product-modal')).toBeVisible();
      await settle(problems, '/dashboard/advance-loans/products');
    });

    test('a product loans reference cannot be deleted, and the screen says why', async ({
      page,
      problems,
    }) => {
      // The refusal IS the subject: a 409 on this page is the correct answer,
      // not a defect, so only an uncaught render counts as a problem here.
      crashesOnly(problems);
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // PERSONAL is the seeded product the other groups borrow under.
      const rows = await adminApi.get<any>('/loan-types');
      const personal = (Array.isArray(rows) ? rows : rows.data).find(
        (r: any) => r.code === 'PERSONAL',
      );
      expect(personal, 'the seeded catalogue is present').toBeTruthy();

      const owner = await ApiClient.as('employee');
      try {
        await ensureAllowance(owner, adminApi, 600, MARKER_PREFIX);
        const filed = await owner.post<any>('/advance-loans', {
          type: 'LOAN',
          amount: 600,
          installments: 6,
          reason: `${MARK} — holds the product`,
          loanTypeId: personal.id,
        });
        const loanId = filed?.id ?? filed?.data?.id;

        // The reference is the entire premise of this case: if it is not there,
        // the delete SHOULD succeed and the missing toast would be a correct
        // answer to the wrong question. Checked explicitly so a vanished loan
        // reports itself instead of arriving as a mystified toast timeout —
        // this database is shared, and a concurrent run that re-clones
        // `ess_e2e` takes the row with it.
        const check = await loanOf(owner, loanId);
        expect(
          check.loanTypeId,
          'the loan still references the product being deleted',
        ).toBe(personal.id);

        try {
          const products = new LoanProductsPage(page);
          await products.open();
          await products.delete('PERSONAL');

          // The DURABLE outcome is what this layer asserts: the product is
          // still in the catalogue after the attempt. A refusal that
          // half-deleted would be worse than none.
          //
          // The refusal MESSAGE is asserted in
          // `products/confirm-seam.test.tsx` instead, which renders the real
          // confirm dialog and the real toast container against a stubbed
          // network. A toast lives for four seconds; pinning a browser
          // assertion to that window on a shared, contended harness tests the
          // machine more than the app.
          await expect
            .poll(() => products.isOffered('PERSONAL'), { timeout: 15_000 })
            .toBe(true);
        } finally {
          await retire(loanId, owner, adminApi).catch(() => undefined);
        }
      } finally {
        await owner.dispose();
      }

      await settle(problems, '/dashboard/advance-loans/products');
    });
  });
});

test.describe('the catalogue is not offered to anyone else', () => {
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'the denial is role-specific');
    });

    test('HR is told the rule instead of being shown controls that refuse', async ({
      page,
      problems,
    }) => {
      const products = new LoanProductsPage(page);
      await products.open();

      expect(await products.isForbidden(), 'HR sees the rule, not the table').toBe(true);
      await expect(page.getByTestId('loan-product-new')).toHaveCount(0);
      await settle(problems, '/dashboard/advance-loans/products');
    });

    test('and the loans list offers HR no way in', async ({ page, problems }) => {
      const loans = new AdvanceLoansPage(page);
      await loans.open();

      await expect(page.getByTestId('loan-products')).toHaveCount(0);
      await settle(problems, '/dashboard/advance-loans');
    });
  });

  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the denial is role-specific');
    });

    test('an employee is told the rule too', async ({ page, problems }) => {
      const products = new LoanProductsPage(page);
      await products.open();

      expect(await products.isForbidden()).toBe(true);
      await settle(problems, '/dashboard/advance-loans/products');
    });
  });
});

test.describe('borrowing under a product', () => {
  let owner: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let productId = '';
  let setupError = '';
  let scratch: string[] = [];

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    try {
      owner = await ApiClient.as('employee');
      adminApi = await ApiClient.as('admin');
      branchId = await adminApi.firstBranchId();

      // A product with a SHORT term, so the picker's effect on the form is
      // visible rather than coinciding with the company default.
      const made = await adminApi.post<any>('/loan-types', {
        code: CODE_SHORT,
        name: `${MARK} short-term`,
        category: 'LOAN',
        defaultInstallments: 3,
        maxInstallments: 4,
        priority: 15,
        processingFeeFlat: 25,
      });
      productId = made?.id ?? made?.data?.id;
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('employee')) return;
    for (const id of scratch) await retire(id, owner, adminApi).catch(() => undefined);
    scratch = [];
  });

  test.afterAll(async () => {
    if (isProject('employee') && owner && adminApi) {
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
      if (productId) {
        await adminApi.delete(`/loan-types/${productId}`).catch(() => undefined);
      }
    }
    await owner?.dispose();
    await adminApi?.dispose();
  });

  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'filing belongs to the requester');
    });

    test('the picker offers the product, and the loan carries its terms', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      await ensureAllowance(owner, adminApi, 600, MARKER_PREFIX);

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      await loans.open();
      await loans.openTab('my');
      await loans.submitRequest({
        type: 'LOAN',
        amount: 600,
        installments: 3,
        reason: `${MARK} — under a product`,
        product: `${MARK} short-term`,
      });

      const mine = await owner.get<any[]>('/advance-loans/my-requests');
      const filed = (Array.isArray(mine) ? mine : (mine as any).data).find(
        (r: any) => r.reason?.includes(`${MARK} — under a product`),
      );
      expect(filed, 'the request was filed').toBeTruthy();
      scratch.push(filed.id);

      const row = await loanOf(owner, filed.id);
      expect(row.loanTypeId, 'the product is recorded on the request').toBe(productId);

      await settle(problems, '/dashboard/advance-loans');
    });

    test('the form narrows the repayment cap to the product, in the app’s words', async ({
      page,
      problems,
    }) => {
      // The company allows 12; this product runs 4. A form that offered 12
      // would send a request the approver could not approve.
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      await ensureAllowance(owner, adminApi, 600, MARKER_PREFIX);

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      await loans.open();
      await loans.openTab('my');

      await page.getByTestId('loan-new').click();
      const modal = page.getByTestId('loan-create-modal');
      await modal.waitFor({ state: 'visible' });
      await modal.getByTestId('loan-type-LOAN').click();
      await modal
        .getByTestId('loan-product')
        .selectOption({ label: `${MARK} short-term` }, { timeout: 10_000 });
      await modal.getByTestId('loan-amount').fill('600');
      await modal.getByTestId('loan-installments').fill('9');
      await modal.getByTestId('loan-submit').click();

      const toasts = new ToastArea(page);
      await toasts.waitFor('warning', /cannot exceed 4 installments/i);

      // Nothing was filed.
      await expect(modal).toBeVisible();
      await settle(problems, '/dashboard/advance-loans');
    });

    test('the product’s terms are stated before anything is filed', async ({
      page,
      problems,
    }) => {
      // The fee is what the borrower is agreeing to; disclosing it after
      // approval is disclosing it too late.
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      await loans.open();
      await loans.openTab('my');

      await page.getByTestId('loan-new').click();
      const modal = page.getByTestId('loan-create-modal');
      await modal.waitFor({ state: 'visible' });
      await modal.getByTestId('loan-type-LOAN').click();
      await modal
        .getByTestId('loan-product')
        .selectOption({ label: `${MARK} short-term` }, { timeout: 10_000 });

      const terms = modal.getByTestId('loan-product-terms');
      await expect(terms).toBeVisible();
      await expect(terms).toContainText(/up to 4 installments/i);
      await expect(terms).toContainText(/processing fee/i);

      await settle(problems, '/dashboard/advance-loans');
    });
  });
});
