import { expect, test } from '@playwright/test';

/**
 * Self-service payslips.
 *
 * Loaded only by the `employee` project. An employee holds VIEW_OWN_PAYSLIP and
 * nothing else in payroll: the workforce-wide screens answer BY NAME — what
 * everybody earns — which is why the same person entitled to their own payslip
 * is refused the payslip list.
 *
 * The rail hiding an entry is an affordance, never the boundary, so this
 * asserts the DENIAL as well as the absence. Nothing here writes.
 */

test.describe('The rail an employee is given', () => {
  test('offers their own payslips', async ({ page }) => {
    await page.goto('/dashboard');

    const rail = page.locator('aside nav');
    await expect(rail.getByRole('link', { name: 'My payslips' })).toHaveAttribute(
      'href',
      '/dashboard/my-payslips',
    );
  });

  test('offers no route that would 403', async ({ page }) => {
    await page.goto('/dashboard');

    // The module hub and every screen under it are refused to this role, so the
    // rail must not contain a link to any of them — a user must never be sent
    // to /403 by way of their own sidebar.
    await expect(
      page.locator('aside nav a[href="/dashboard/payroll"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('aside nav a[href^="/dashboard/payroll/"]'),
    ).toHaveCount(0);
  });
});

test.describe('And the screens behind those routes refuse', () => {
  for (const [name, path] of [
    ['the payroll hub', '/dashboard/payroll'],
    ['the payslip list', '/dashboard/payroll/payslips'],
    ['the runs', '/dashboard/payroll/runs'],
    ['the salary structures', '/dashboard/payroll/structures'],
  ] as const) {
    test(`${name} lands on 403 rather than on a crashed page`, async ({ page }) => {
      await page.goto(path);

      await expect(page).toHaveURL(/\/403$/);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });
  }
});

test.describe('My payslips', () => {
  test('lists the periods that have been settled', async ({ page }) => {
    await page.goto('/dashboard/my-payslips');

    await expect(page.getByRole('heading', { name: 'My payslips' })).toBeVisible();
    await expect(page.getByTestId('run-status').first()).toBeVisible();
  });

  test('shows nothing from a run that has not been approved', async ({ page }) => {
    await page.goto('/dashboard/my-payslips');
    await expect(page.getByTestId('run-status').first()).toBeVisible();

    // `/payslips/my` answers APPROVED and PAID runs only. A month still being
    // calculated is not a fault and not a secret — it is simply not a payslip
    // yet, and the seed keeps one run in exactly that state.
    await expect(
      page.locator('[data-testid="run-status"][data-status="CALCULATED"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="run-status"][data-status="DRAFT"]'),
    ).toHaveCount(0);

    // Said the other way round, so the assertion cannot pass on an empty table:
    // every badge on the page is a settled one.
    const settled = page.locator(
      '[data-testid="run-status"][data-status="APPROVED"], [data-testid="run-status"][data-status="PAID"]',
    );
    expect(await settled.count()).toBe(await page.getByTestId('run-status').count());
  });

  test('opens one, and keeps the employer contribution out of the money', async ({ page }) => {
    await page.goto('/dashboard/my-payslips');
    await page.locator('a[href^="/dashboard/my-payslips/"]').first().click();

    await expect(page).toHaveURL(/\/dashboard\/my-payslips\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('my-payslip')).toBeVisible();
    await expect(page.getByTestId('payslip-net')).toBeVisible();

    // Recorded, never paid. Printed among the earnings it would read as money
    // somebody was owed and did not receive, so the sheet says so in words.
    const employer = page.getByTestId('employer-contributions');
    await expect(employer).toBeVisible();
    await expect(employer).toContainText('not part of your gross pay');
    await expect(employer).toContainText('do not change the net pay above');

    // The browser's own print dialogue is how this is saved as a PDF; a second
    // renderer would paginate it differently from the page on screen.
    await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
  });

  test('refuses a payslip that is not theirs, and says so as a sentence', async ({ page }) => {
    // A well-formed id belonging to nobody. The server narrows /payslips/my/:id
    // to the caller's own record, so somebody else's is answered the same way
    // as one that does not exist — which is the point.
    await page.goto('/dashboard/my-payslips/00000000-0000-0000-0000-000000000000');

    await expect(page.getByText('Payslip not found')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Back to my payslips' }),
    ).toBeVisible();
  });
});
