import { expect, test } from '@playwright/test';

// No role segment in the filename — this runs in every signed-in project.
test.describe('Dashboard shell', () => {
  test('renders the welcome heading for a signed-in user', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Welcome/i);
  });

  test('signing out returns to login', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});
