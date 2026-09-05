import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';

/**
 * Court orders and the loan ledger — two surfaces that did not exist at all.
 *
 * `PayrollItem.garnishment` had been a column of zeroes since v2 because there
 * was nowhere to record that a court order existed, and there was no accounting
 * module anywhere: `LoanTransaction.journalRef` was declared, indexed and
 * written by nothing.
 *
 * These journeys check the doors and the shapes, not the arithmetic — the money
 * itself is proved in `finance-garnishment.e2e-spec.ts` and
 * `finance-accounting.e2e-spec.ts`, where a payroll can actually be run.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

test.describe('court orders', () => {
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'an order is an HR record');
    });

    test('the register opens and offers a new order', async ({ page, problems }) => {
      await page.goto('/dashboard/garnishments');

      await expect(page.getByTestId('garnishment-new')).toBeVisible();
      await expect(page.getByTestId('garnishment-failed')).toHaveCount(0);
      await settle(problems, '/dashboard/garnishments');
    });

    test('refuses an order that states both an amount and a percentage', async ({
      page,
      problems,
    }) => {
      // Two conflicting instructions, and the payroll run would have to guess.
      await page.goto('/dashboard/garnishments');
      await page.getByTestId('garnishment-new').click();
      await expect(page.getByTestId('garnishment-modal')).toBeVisible();

      await page.getByTestId('garnishment-reference').fill('CIV/PW/1');
      await page.getByTestId('garnishment-amount').fill('150');
      await page.getByTestId('garnishment-percent').fill('15');
      await page.getByTestId('garnishment-save').click();

      // The modal stays open with the work still in it.
      await expect(page.getByTestId('garnishment-modal')).toBeVisible();
      await settle(problems, '/dashboard/garnishments');
    });
  });

  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the denial is role-specific');
    });

    test('an employee is told the rule, not shown the register', async ({
      page,
      problems,
    }) => {
      await page.goto('/dashboard/garnishments');
      await expect(page.getByTestId('garnishment-forbidden')).toBeVisible();
      await settle(problems, '/dashboard/garnishments');
    });
  });
});

test.describe('the loan ledger', () => {
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the ledger is an admin surface');
    });

    test('opens on accounts, and says nothing can post while it is empty', async ({
      page,
      problems,
    }) => {
      await page.goto('/dashboard/accounting');

      await expect(page.getByTestId('accounting-tab-accounts')).toBeVisible();
      await expect
        .poll(
          async () =>
            (await page.getByTestId('accounting-account-row').count()) +
            (await page.getByTestId('accounting-accounts-empty').count()),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0);
      await settle(problems, '/dashboard/accounting');
    });

    test('an account, a mapping and a posting, in that order', async ({ page, problems }) => {
      // The setup order is the journey: name the accounts, say which event
      // posts to which pair, then post.
      crashesOnly(problems);

      const stamp = Date.now().toString(36).toUpperCase();
      await page.goto('/dashboard/accounting');

      for (const [code, name] of [
        [`PW${stamp}A`, 'Bank'],
        [`PW${stamp}B`, 'Staff loans receivable'],
      ]) {
        await page.getByTestId('accounting-account-code').fill(code);
        await page.getByTestId('accounting-account-name').fill(name);
        await page.getByTestId('accounting-account-add').click();
        await expect
          .poll(() => page.locator(`[data-testid="accounting-account-row"][data-code="${code}"]`).count(), {
            timeout: 15_000,
          })
          .toBe(1);
      }

      await page.getByTestId('accounting-tab-mappings').click();
      await page.getByTestId('accounting-mapping-debit').selectOption({ label: `PW${stamp}A Bank` });
      await page
        .getByTestId('accounting-mapping-credit')
        .selectOption({ label: `PW${stamp}B Staff loans receivable` });
      await page.getByTestId('accounting-mapping-add').click();

      await expect
        .poll(() => page.locator('[data-testid="accounting-mapping-row"][data-event="EMI_RECOVERY"]').count(), {
          timeout: 15_000,
        })
        .toBeGreaterThan(0);

      // Posting is safe to run with nothing pending: it reports zero rather
      // than failing.
      await page.getByTestId('accounting-post').click();
      await expect(page.getByTestId('accounting-tab-journal')).toBeVisible();
    });
  });

  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the denial is role-specific');
    });

    test('an employee is told the ledger is not theirs', async ({ page, problems }) => {
      await page.goto('/dashboard/accounting');
      await expect(page.getByTestId('accounting-forbidden')).toBeVisible();
      await settle(problems, '/dashboard/accounting');
    });
  });
});
