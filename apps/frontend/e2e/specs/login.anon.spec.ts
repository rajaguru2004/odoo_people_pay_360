import { expect, test } from '@playwright/test';

test.describe('Sign in', () => {
  test('the root redirects to the one canonical login URL', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('the form is reachable and labelled', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  test('wrong credentials show an error and do NOT navigate', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email', { exact: true }).fill('nobody@peoplepay360.com');
    await page.getByLabel('Password', { exact: true }).fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('an unauthenticated visit to the shell is bounced to login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('Demo accounts', () => {
  /**
   * The panel is off in a production build unless somebody sets
   * NEXT_PUBLIC_DEMO_LOGINS at build time. This project sets it (see the
   * webServer env in playwright.config.ts), so its presence here is evidence
   * the opt-in works rather than evidence the default is permissive.
   */
  test('fills the form from a seeded account without signing in', async ({ page }) => {
    await page.goto('/login');

    await page.getByRole('button', { name: /demo accounts/i }).click();
    await page
      .getByRole('button', { name: /fill the form with the administrator account/i })
      .click();

    await expect(page.getByLabel('Email', { exact: true })).toHaveValue(
      'admin@peoplepay360.com',
    );
    await expect(page.getByLabel('Password', { exact: true })).not.toHaveValue('');

    // Filled, not submitted: the reader sees which of four accounts they are
    // about to use before they use it.
    await expect(page).toHaveURL(/\/login$/);
  });

  test('the filled credentials actually work', async ({ page }) => {
    await page.goto('/login');

    await page.getByRole('button', { name: /demo accounts/i }).click();
    await page
      .getByRole('button', { name: /fill the form with the hr manager account/i })
      .click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // A panel offering credentials that no longer match the seed is worse than
    // no panel: it looks like the login is broken.
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
