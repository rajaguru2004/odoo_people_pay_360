import { expect, test } from '@playwright/test';

/**
 * The overtime rule sets.
 *
 * `.hr-admin.` — these rates decide what an hour is worth, so a payroll officer
 * reads the requests and HR owns the rules behind them.
 *
 * The chain resolves top-down: an employee override, then their employment
 * type, then the company default. It ALWAYS resolves — there is no off switch —
 * which is why the default has to be visibly marked. Losing track of which
 * policy is the default would drop every uncovered employee onto the raw
 * company settings silently, and the screen that edits those would no longer be
 * the screen that decides their pay. So the badge is not decoration: it is the
 * only thing on the page that says where an unmatched employee lands.
 */
test.describe('Overtime policies', () => {
  test('lists both seeded policies', async ({ page }) => {
    await page.goto('/dashboard/overtime/policies');

    await expect(
      page.getByRole('heading', { name: 'Overtime policies' }),
    ).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Company Default' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Daily Wage OT' })).toBeVisible();
  });

  test('marks the one every uncovered employee falls back to', async ({ page }) => {
    await page.goto('/dashboard/overtime/policies');

    await expect(page.getByText('Company default', { exact: true })).toBeVisible();

    // Exactly one default, and it is not offered a "make me the default"
    // button — promoting the policy that already holds the role is a no-op the
    // reader would have to think about.
    await expect(page.getByText('Company default', { exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Make default' })).toHaveCount(1);
  });

  test('shows what each rule set actually pays', async ({ page }) => {
    await page.goto('/dashboard/overtime/policies');

    // The company default mirrors the global settings: 1.25× ordinary overtime.
    await expect(page.getByText('1.25×')).toBeVisible();
    // The daily-wage set pays its own rates, and treats a public holiday as an
    // ordinary day because those staff are already paid per day worked.
    await expect(page.getByText('1.75×')).toBeVisible();
    await expect(page.getByText('holidays as ordinary days')).toBeVisible();

    // Which employees the middle tier of the chain governs.
    await expect(page.getByText('Daily Wage', { exact: true })).toBeVisible();
  });

  test('explains that an approved request keeps the rates it was decided under', async ({
    page,
  }) => {
    await page.goto('/dashboard/overtime/policies');

    await expect(
      page.getByRole('heading', { name: 'How a policy is chosen' }),
    ).toBeVisible();
    await expect(
      page.getByText(/never on ones already approved/i),
    ).toBeVisible();
  });
});
