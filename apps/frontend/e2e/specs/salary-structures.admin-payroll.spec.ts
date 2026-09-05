import { expect, test } from '@playwright/test';

/**
 * The two catalogues a payroll run reads: what each employee is paid, and the
 * components those amounts hang off.
 *
 * Loaded by the `admin` and `payroll` projects — both hold MANAGE_PAYROLL and
 * MANAGE_SALARY_COMPONENTS, so both see the same affordances here.
 *
 * Nothing in this file writes. A component that was deactivated by a browser
 * test would still be retired on the next pass — the catalogue has no delete
 * precisely because retirement is permanent — and the structures register is
 * what the payroll hub counts "cannot be paid yet" from.
 */

test.describe('The salary structure register', () => {
  test('names itself and counts what is assigned', async ({ page }) => {
    await page.goto('/dashboard/payroll/structures');

    await expect(page.getByRole('heading', { name: /salary structures/i })).toBeVisible();

    // Counted in the database and read off the envelope's meta, never from the
    // length of a page: a register of twenty rows is not the size of a payroll.
    for (const label of [
      'Employees assigned',
      'Components in the catalogue',
      'Still active',
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    // A row IS a person: the register answers "is this employee payable".
    await expect(page.getByRole('columnheader', { name: 'Employee' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Gross' })).toBeVisible();
    await expect(
      page.locator('table a[href^="/dashboard/payroll/structures/"]').first(),
    ).toBeVisible();
  });

  test('does not list the employee the seed leaves without one', async ({ page }) => {
    await page.goto('/dashboard/payroll/structures');

    // EMP-0021, Reem Al Saadi — the newest hire, deliberately unassigned, and
    // the reason the pre-flight has a real blocker to report. Searched for by
    // name rather than counted, so the assertion says nothing about how many
    // structures exist.
    await page.getByLabel('Search salary structures').fill('Reem');

    await expect(page.getByText('No matches')).toBeVisible();
    await expect(page.getByText('Reem Al Saadi')).toHaveCount(0);
  });

  test('finds an assigned employee by their code', async ({ page }) => {
    await page.goto('/dashboard/payroll/structures');
    await page.getByLabel('Search salary structures').fill('EMP-0001');

    const row = page.locator('table a[href^="/dashboard/payroll/structures/"]').first();
    await expect(row).toBeVisible();
    await expect(row).toHaveText('Aisha Al Balushi');
  });

  test('shows a structure as its lines, with the employer cost kept outside the net', async ({
    page,
  }) => {
    await page.goto('/dashboard/payroll/structures');
    await page.locator('table a[href^="/dashboard/payroll/structures/"]').first().click();

    await expect(page).toHaveURL(/\/dashboard\/payroll\/structures\/[0-9a-f-]{36}$/);

    // Four totals, and the fourth is the one that is in none of the other
    // three: employer contributions are recorded and never paid.
    for (const total of ['Gross', 'Deductions', 'Net', 'Employer cost']) {
      await expect(page.getByText(total, { exact: true }).first()).toBeVisible();
    }

    await expect(page.getByRole('heading', { name: 'Lines' })).toBeVisible();
    await expect(
      page.getByText('Fixed amounts, in the order they print on a payslip.'),
    ).toBeVisible();
  });
});

test.describe('The salary component catalogue', () => {
  test('lists the seeded components with what uses them', async ({ page }) => {
    await page.goto('/dashboard/payroll/salary-components');

    await expect(page.getByRole('heading', { name: /salary rules/i })).toBeVisible();

    // The codes the seeded structures are built from. Named, rather than
    // counted, so a catalogue somebody has added to still passes.
    for (const code of ['BASIC', 'HRA', 'SOCIAL_SEC_ER']) {
      await expect(
        page.locator('table a[href^="/dashboard/payroll/salary-components/"]', {
          hasText: code,
        }).first(),
      ).toBeVisible();
    }

    await expect(page.getByRole('columnheader', { name: 'In use' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'State' })).toBeVisible();
  });

  test('retires a component rather than deleting it', async ({ page }) => {
    await page.goto('/dashboard/payroll/salary-components');

    // A component is referenced by every payslip line ever built from it, so a
    // payslip from two years ago must keep resolving. The screen offers the
    // reversible move and no destructive one — and neither does the API.
    await expect(page.getByRole('button', { name: 'Deactivate' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /delete/i })).toHaveCount(0);
  });

  test('offers no deletion on a component either', async ({ page }) => {
    await page.goto('/dashboard/payroll/salary-components');
    await page.locator('table a[href^="/dashboard/payroll/salary-components/"]').first().click();

    await expect(page).toHaveURL(/\/dashboard\/payroll\/salary-components\/[0-9a-f-]{36}$/);

    // Deactivate for a live component, Activate for a retired one. Never
    // Delete, on either.
    await expect(
      page.getByRole('button', { name: /^(Deactivate|Activate)$/ }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);
  });
});
