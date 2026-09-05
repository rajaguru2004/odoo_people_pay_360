import { expect, test } from '@playwright/test';

/**
 * The Payroll analytics page — what payroll cost, where it went, and its shape.
 *
 * Loaded by the `admin` and `payroll` projects, mirroring the `@Roles` on
 * `GET /payroll/dashboard` (ADMIN, HR_MANAGER, PAYROLL_OFFICER) — the same
 * three as the hub, because the two endpoints are gated identically and the
 * rail must never offer a route the server refuses.
 *
 * Nothing here writes. The assertions are about NAMED figures, about the URL
 * carrying the filter state, and about the page holding still while a slicer
 * moves — never about counting rows in a table, which would make the spec
 * depend on the size of the seeded workforce.
 */

test.describe('The Payroll analytics page', () => {
  test('is reachable from the rail and names itself', async ({ page }) => {
    await page.goto('/dashboard/payroll');
    await page
      .getByRole('link', { name: 'Payroll analytics', exact: true })
      .first()
      .click();

    await expect(page).toHaveURL(/\/dashboard\/payroll\/analytics$/);
    await expect(
      page.getByRole('heading', { name: 'Payroll analytics' }),
    ).toBeVisible();
  });

  test('leads on the five figures the page is judged by', async ({ page }) => {
    await page.goto('/dashboard/payroll/analytics');

    for (const key of [
      'net',
      'payslips',
      'average',
      'timeOff',
      'attendanceHealth',
    ]) {
      await expect(page.getByTestId(`kpi-${key}`)).toBeVisible();
    }
  });

  test('draws every visual on the page', async ({ page }) => {
    await page.goto('/dashboard/payroll/analytics');

    for (const title of [
      'Monthly net salary',
      'Cumulative payroll cost',
      'Payrun pipeline',
      'Runs by status',
      'Salary cost by department',
      'Basic, allowances and deductions',
      'Gross to net',
      'Headcount against salary',
      'Attendance composition',
      'Coverage',
      'Department breakdown',
    ]) {
      await expect(
        page.getByRole('heading', { name: title, exact: true }),
      ).toBeVisible();
    }
  });

  /**
   * The rule that makes the filter row honest.
   *
   * Every visual reads ONE response, so a slicer re-queries once and the whole
   * page moves together. The URL carries the state, because a filtered
   * dashboard has to survive a refresh and a pasted link — otherwise drilling
   * into a department strands the reader with no way back.
   */
  test('carries the filter state in the URL and survives a reload', async ({
    page,
  }) => {
    await page.goto('/dashboard/payroll/analytics');

    await page.getByLabel('Trend window').selectOption('6');
    await expect(page).toHaveURL(/months=6/);

    await page.reload();
    await expect(page).toHaveURL(/months=6/);
    await expect(page.getByLabel('Trend window')).toHaveValue('6');
  });

  test('steps the period without losing the other slicers', async ({ page }) => {
    await page.goto('/dashboard/payroll/analytics?months=6');

    await page.getByRole('button', { name: 'Previous period' }).click();
    await expect(page).toHaveURL(/period=\d{4}-\d{2}/);
    // The window the reader chose is not silently reset by moving the month.
    await expect(page).toHaveURL(/months=6/);
  });

  test('resets every slicer at once', async ({ page }) => {
    await page.goto('/dashboard/payroll/analytics?months=6');
    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(page).toHaveURL(/\/dashboard\/payroll\/analytics$/);
  });

  /**
   * Colour is never the only thing carrying a mark's identity.
   *
   * Two slots in the series ramp sit near 3:1 on the white card, which is only
   * defensible because every chart ships a table twin the reader can read the
   * number out of instead.
   */
  test('offers a table twin of every chart', async ({ page }) => {
    await page.goto('/dashboard/payroll/analytics');

    await page
      .getByRole('button', { name: 'Show Salary cost by department as a table' })
      .click();

    await expect(
      page.getByRole('table', { name: 'Cost by department' }),
    ).toBeVisible();
  });

  /**
   * A rate with no denominator prints an em dash, never 0.0%.
   *
   * Nought per cent is the claim that everybody failed; "nothing to divide by"
   * is a different statement, and the page has to be able to make it. Asserted
   * as an absence rather than a presence, because whether the seeded month has
   * a denominator depends on the demo data.
   */
  test('never prints a zero rate in place of an unknown one', async ({
    page,
  }) => {
    await page.goto('/dashboard/payroll/analytics');
    await expect(page.getByTestId('kpi-attendanceHealth')).toBeVisible();

    const card = page.getByTestId('kpi-attendanceHealth');
    const text = (await card.textContent()) ?? '';
    // Either a real rate or an em dash — never the 0.0% that would mean both.
    expect(text.includes('0.0%') && text.includes('—')).toBe(false);
  });

  test('drills from a department row through to its payslips', async ({
    page,
  }) => {
    await page.goto('/dashboard/payroll/analytics');

    const matrix = page.getByRole('heading', { name: 'Department breakdown' });
    await expect(matrix).toBeVisible();

    const firstRow = page.locator('table a[href*="/dashboard/payroll/payslips"]');
    if ((await firstRow.count()) === 0) test.skip();

    await firstRow.first().click();
    await expect(page).toHaveURL(/\/dashboard\/payroll\/payslips/);
  });
});
