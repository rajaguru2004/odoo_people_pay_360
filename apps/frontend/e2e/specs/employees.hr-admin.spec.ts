import { expect, test } from '@playwright/test';

// The `.hr-admin.` segment means only the `hr` and `admin` projects load this
// file — an employee has no VIEW_EMPLOYEES permission, so the nav entry is not
// even rendered for them.
test.describe('Employees list', () => {
  test('is reachable from the sidebar', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Employees' }).click();
    await expect(page).toHaveURL(/\/dashboard\/employees$/);
    await expect(page.getByRole('heading', { name: 'Employees' })).toBeVisible();
  });

  test('the search box filters without a full page load', async ({ page }) => {
    await page.goto('/dashboard/employees');
    await page.getByLabel('Search employees').fill('zzz-no-such-employee');
    await expect(page.getByText(/nothing matches that search/i)).toBeVisible();
  });
});
