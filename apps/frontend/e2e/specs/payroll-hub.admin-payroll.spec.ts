import { expect, test } from '@playwright/test';

/**
 * The Payroll hub — what the month cost, who is waiting on a decision and who
 * cannot be paid yet.
 *
 * Loaded by the `admin` and `payroll` projects, mirroring the `@Roles` on
 * `GET /payroll/hub-summary` (ADMIN, HR_MANAGER, PAYROLL_OFFICER). HR's view of
 * the same page is asserted in `payroll.hr.spec.ts`, because what HR may READ
 * and what HR may DECIDE are different questions.
 *
 * Nothing here writes, and nothing here counts rows in a table: every assertion
 * is either about a NAMED figure or about the shape of the page. The one seeded
 * fact it leans on is the employee left without a salary structure, which is the
 * same fact the pre-flight spec leans on.
 */

test.describe('The Payroll hub', () => {
  test('is reachable from the rail and names itself', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Payroll', exact: true }).first().click();

    await expect(page).toHaveURL(/\/dashboard\/payroll$/);
    await expect(page.getByRole('heading', { name: 'Payroll' })).toBeVisible();
  });

  test('leads on the five figures the module is judged by', async ({ page }) => {
    await page.goto('/dashboard/payroll');

    for (const key of ['awaiting', 'gross', 'net', 'employees', 'blocked']) {
      await expect(page.getByTestId(`kpi-${key}`)).toBeVisible();
    }

    // Each card is a real anchor at the screen that answers it, so a figure and
    // the work behind it are one click apart.
    await expect(page.getByTestId('kpi-awaiting')).toHaveAttribute(
      'href',
      '/dashboard/payroll/runs?status=CALCULATED',
    );
    await expect(page.getByTestId('kpi-blocked')).toHaveAttribute(
      'href',
      '/dashboard/payroll/structures',
    );
  });

  /**
   * The rule the whole hub is built on.
   *
   * Money means APPROVED or PAID, so the seeded run for the current month —
   * calculated and still waiting for a decision — pays nobody yet. "Net per
   * employee" therefore has NOTHING TO DIVIDE BY, and a card printing 0 for
   * that would be telling the reader the average wage was zero. It prints an em
   * dash instead.
   *
   * Gross beside it is a genuine zero and prints as one: nothing was approved
   * is an answer, and the two must not be confused.
   */
  test('prints an em dash where there is nothing to divide by, never a zero', async ({
    page,
  }) => {
    await page.goto('/dashboard/payroll');

    const net = page.getByTestId('kpi-net');
    await expect(net).toBeVisible();

    const perEmployee = net
      .getByText('Per employee', { exact: true })
      .locator('xpath=following-sibling::p[1]');

    await expect(perEmployee).toHaveText('—');
    // Said explicitly: the failure this assertion exists to catch is the em
    // dash quietly becoming a formatted zero.
    await expect(perEmployee).not.toHaveText(/\d/);

    // And the denominator is genuinely nothing, which is what makes the em dash
    // the right answer rather than a missing read.
    await expect(page.getByTestId('kpi-employees')).toContainText(
      /0 of \d+ active employees/,
    );
  });

  test('names who cannot be paid, and links to where that is fixed', async ({ page }) => {
    await page.goto('/dashboard/payroll');

    // The strip is the server's own list — the page never invents a row the
    // aggregate did not send. Collapsed until it is asked for.
    await page.getByRole('button', { name: /needs attention/i }).click();

    const missingStructure = page
      .getByRole('link')
      .filter({ hasText: 'no salary structure' });
    await expect(missingStructure.first()).toBeVisible();
    // The count is the truth and the names are a capped sample of it — EMP-0021
    // is the one the seed leaves unassigned.
    await expect(missingStructure.first()).toContainText('Reem Al Saadi');
    await expect(missingStructure.first()).toHaveAttribute(
      'href',
      '/dashboard/payroll/structures',
    );
  });

  test('names them again on the coverage panel', async ({ page }) => {
    await page.goto('/dashboard/payroll');

    await expect(page.getByText('Processing coverage')).toBeVisible();
    await expect(page.getByTestId('coverage-missing-employee').first()).toContainText(
      'Reem Al Saadi',
    );
  });

  test('moves the trend window between six and twelve months', async ({ page }) => {
    await page.goto('/dashboard/payroll');
    await expect(page.getByRole('button', { name: '6M', exact: true })).toBeVisible();

    // The window is a SERVER question — the buckets arrive already labelled, so
    // the browser does no calendar maths. Asserted on the request the toggle
    // makes rather than on a bar count the seed could change.
    const twelve = page.waitForResponse(
      (response) =>
        response.url().includes('/payroll/hub-summary') &&
        response.url().includes('months=12'),
    );
    await page.getByRole('button', { name: '12M', exact: true }).click();
    expect((await twelve).ok()).toBeTruthy();
  });

  test('offers a tile per screen this role may actually open', async ({ page }) => {
    await page.goto('/dashboard/payroll');

    // Runs, Run payroll, Payslips, Salary structures, Salary rules, Reports.
    // Fed from the same menu as the rail, so a tile can never hand the reader a
    // screen ProtectedRoute then refuses.
    await expect(page.getByTestId('module-tile')).toHaveCount(6);
    await expect(
      page.getByTestId('module-tile').filter({ hasText: 'Run payroll' }),
    ).toHaveCount(1);
  });
});
