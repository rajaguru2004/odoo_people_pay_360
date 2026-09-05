import { expect, test } from '@playwright/test';

/**
 * The shell, for every signed-in role.
 *
 * No role segment in the filename, so this runs in all four projects — which is
 * the point: what each role is offered differs, and the assertions below are
 * about the rail behaving consistently rather than about any one menu.
 */
test.describe('Dashboard shell', () => {
  test('greets the signed-in user in the one heading slot', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Welcome/i);
  });

  test('renders one heading, not two', async ({ page }) => {
    await page.goto('/dashboard');

    // The shell owns a single heading slot. A page painting its own <h1> as
    // well is the duplicate-title defect the page-header store exists to stop.
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });

  test('marks exactly one rail entry as the current page', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
  });

  test('signing out returns to login', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('Route gating', () => {
  test('a route the role may not see lands on 403, not on a crashed page', async ({
    page,
  }, testInfo) => {
    // Only the two roles without the module are worth asserting here; for hr and
    // admin the denial path is never taken.
    test.skip(
      testInfo.project.name === 'admin' || testInfo.project.name === 'hr',
      'This role is entitled to the Organisation module.',
    );

    await page.goto('/dashboard/organization');
    await expect(page).toHaveURL(/\/403$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});
