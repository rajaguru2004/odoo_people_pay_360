import { expect, test } from '@playwright/test';

/**
 * What an HR manager may READ in payroll, and what they may DECIDE: everything,
 * and nothing.
 *
 * Loaded only by the `hr` project. HR holds VIEW_ALL_PAYROLL, VIEW_REPORTS and
 * EXPORT_DATA — and deliberately not MANAGE_PAYROLL, APPROVE_PAYROLL or
 * MANAGE_SALARY_COMPONENTS. So the whole module opens for them and not one
 * button on it moves anything: they read the payroll, they do not run it.
 *
 * Nothing here writes, which is also why HR is the right role to assert the
 * READ side of every screen on.
 */

test.describe('The rail an HR manager is given', () => {
  test('offers the hub, and not the screen that opens a run', async ({ page }) => {
    await page.goto('/dashboard');

    const rail = page.locator('aside nav');
    await expect(rail.locator('a[href="/dashboard/payroll"]').first()).toBeVisible();

    // POST /payroll-runs refuses HR, so the rail must not offer the screen that
    // calls it: the rail never offers a route the server refuses.
    await expect(
      rail.locator('a[href="/dashboard/payroll/runs/new"]'),
    ).toHaveCount(0);
  });

  test('and that screen refuses when it is reached by URL', async ({ page }) => {
    await page.goto('/dashboard/payroll/runs/new');

    await expect(page).toHaveURL(/\/403$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});

test.describe('The hub, read by HR', () => {
  test('opens, because GET /payroll/hub-summary is theirs too', async ({ page }) => {
    await page.goto('/dashboard/payroll');

    await expect(page.getByRole('heading', { name: 'Payroll' })).toBeVisible();
    await expect(page.getByTestId('kpi-net')).toBeVisible();
    await expect(page.getByTestId('kpi-blocked')).toBeVisible();
  });

  test('offers one tile fewer than a payroll officer gets', async ({ page }) => {
    await page.goto('/dashboard/payroll');

    // Runs, Payslips, Salary structures, Salary rules, Reports — and no
    // Run payroll, because the tiles are built from the same menu as the rail.
    await expect(page.getByTestId('module-tile')).toHaveCount(5);
    await expect(
      page.getByTestId('module-tile').filter({ hasText: 'Run payroll' }),
    ).toHaveCount(0);
  });
});

test.describe('A payroll run, read by HR', () => {
  test('the list opens and offers no way to start one', async ({ page }) => {
    await page.goto('/dashboard/payroll/runs');

    await expect(page.getByRole('heading', { name: 'Payroll runs' })).toBeVisible();
    await expect(page.getByTestId('payroll-run-list-row').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'New run' })).toHaveCount(0);
  });

  test('a calculated run shows its figures and none of its decisions', async ({ page }) => {
    await page.goto('/dashboard/payroll/runs');
    // Narrowed to the state where a decision is actually pending — the state in
    // which an admin WOULD be offered Approve and Reject.
    await page.getByLabel('Status', { exact: true }).selectOption('CALCULATED');

    const row = page.getByTestId('payroll-run-list-row').first();
    await expect(row).toBeVisible();
    await row.locator('a[href^="/dashboard/payroll/runs/"]').first().click();

    await expect(page).toHaveURL(/\/dashboard\/payroll\/runs\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('payroll-run-card-net')).toBeVisible();
    await expect(page.getByTestId('payroll-run-row').first()).toBeVisible();

    // Every lifecycle move is gated twice — by the run's STATUS and by the
    // reader's PERMISSION — and HR fails the second gate on all of them.
    for (const action of [
      'run-approve',
      'run-reject',
      'run-calculate',
      'run-cancel',
      'run-mark-paid',
    ]) {
      await expect(page.getByTestId(action)).toHaveCount(0);
    }

    // Reading is not withdrawn by it: EXPORT_DATA is HR's, and the export is a
    // read.
    await expect(page.getByTestId('run-export')).toBeVisible();
  });
});

test.describe('The payslips, read by HR', () => {
  test('lists them and opens one', async ({ page }) => {
    await page.goto('/dashboard/payroll/payslips');

    await expect(page.getByRole('heading', { name: 'Payslips' })).toBeVisible();
    await expect(page.getByTestId('payslip-list-row').first()).toBeVisible();

    await page.locator('a[href^="/dashboard/payroll/payslips/"]').first().click();
    await expect(page).toHaveURL(/\/dashboard\/payroll\/payslips\/[0-9a-f-]{36}$/);
  });

  test('states the employer contribution as money that is in none of the totals', async ({
    page,
  }) => {
    await page.goto('/dashboard/payroll/payslips');
    await page.locator('a[href^="/dashboard/payroll/payslips/"]').first().click();

    const employer = page.getByTestId('employer-contributions');
    await expect(employer).toBeVisible();
    await expect(employer).toContainText(
      'NOT part of gross, deductions or net pay',
    );

    await expect(page.getByTestId('payslip-print')).toBeVisible();
  });
});

test.describe('The catalogues, read by HR', () => {
  test('the structure register opens and offers no assignment', async ({ page }) => {
    await page.goto('/dashboard/payroll/structures');

    await expect(page.getByRole('heading', { name: /salary structures/i })).toBeVisible();
    await expect(
      page.locator('table a[href^="/dashboard/payroll/structures/"]').first(),
    ).toBeVisible();

    // MANAGE_PAYROLL is what assigns one, and HR does not hold it.
    await expect(page.getByRole('link', { name: 'Assign a structure' })).toHaveCount(0);
  });

  test('the component catalogue opens and offers no retirement', async ({ page }) => {
    await page.goto('/dashboard/payroll/salary-components');

    await expect(page.getByRole('heading', { name: /salary rules/i })).toBeVisible();
    await expect(
      page.locator('table a[href^="/dashboard/payroll/salary-components/"]').first(),
    ).toBeVisible();

    // MANAGE_SALARY_COMPONENTS. Reading the catalogue and changing it are
    // separate, and there is no delete for anybody: retirement is deactivation.
    await expect(page.getByRole('button', { name: 'Deactivate' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'New component' })).toHaveCount(0);
  });
});

test.describe('The reports, read by HR', () => {
  test('offer the four registers over an approved run', async ({ page }) => {
    await page.goto('/dashboard/payroll/reports');

    for (const tab of ['register', 'cost', 'statutory', 'ytd']) {
      await expect(page.getByTestId(`report-tab-${tab}`)).toBeVisible();
    }

    // Nothing is read until a run is named: a register is about ONE period, and
    // the picker offers approved and paid runs only, because a draft is a
    // working figure still being corrected.
    await expect(
      page.getByText('Choose a payroll run above to read this report.'),
    ).toBeVisible();

    // Whichever settled run sorts first — never a fixed period, which a later
    // pass would have added to.
    await page.getByLabel('Payroll run', { exact: true }).selectOption({ index: 1 });

    await expect(page.getByTestId('report-register')).toBeVisible();

    await page.getByTestId('report-tab-cost').click();
    await expect(page.getByTestId('report-cost')).toBeVisible();
  });
});
