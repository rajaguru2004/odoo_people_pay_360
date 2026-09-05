import { expect, test } from '@playwright/test';

test.describe('Sign in', () => {
  test('the root redirects to the one canonical login URL', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('the form is reachable and labelled', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  test('wrong credentials show an error and do NOT navigate', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('nobody@peoplepay360.com');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('an unauthenticated visit to the shell is bounced to login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
  });
});
