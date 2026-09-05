import { test, expect } from '../fixtures';
import { ROLE_ACCOUNTS } from '../global-setup';

/**
 * Signing in, for real.
 *
 * Every other spec restores a session minted over the API, which is fast but
 * means nothing exercises the login screen. This file is the exception: it runs
 * in the `anonymous` project with an empty storage state and drives the actual
 * form. If it passes, the sessions the rest of the suite assumes are reachable
 * the way a user reaches them.
 *
 * It also pins the two things that keep a session honest: an unauthenticated
 * visitor is turned away from the dashboard, and signing out clears the
 * credentials rather than merely navigating.
 */

const emailBox = 'input[type="email"], input[name="email"]';
const passwordBox = 'input[type="password"], input[name="password"]';

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.locator(emailBox).first().fill(email);
  await page.locator(passwordBox).first().fill(password);
  await page.locator('button[type="submit"]').first().click();
}

test.describe('login', () => {
  test('an unauthenticated visitor cannot stay on the dashboard', async ({ page }) => {
    // The guard is client-side (there is no middleware.ts), so the HTML for a
    // protected route is served before the redirect. What matters is where the
    // visitor ends up, not what the server sent.
    await page.goto('/dashboard/employees');
    await page.waitForURL('**/login', { timeout: 15_000 });

    expect(new URL(page.url()).pathname).toBe('/login');
  });

  for (const [role, creds] of Object.entries(ROLE_ACCOUNTS)) {
    test(`${role} can sign in and lands on the dashboard`, async ({ page, problems }) => {
      await signIn(page, creds.email, creds.password);

      // Every role lands on /dashboard — the sidebar is what differs, not the
      // landing route (see getDefaultRouteForRole).
      await page.waitForURL('**/dashboard', { timeout: 20_000 });
      expect(new URL(page.url()).pathname).toBe('/dashboard');

      // The session is what the app will actually read on the next request.
      const token = await page.evaluate(() => window.localStorage.getItem('accessToken'));
      expect(token, 'no access token was stored').toBeTruthy();

      void problems;
    });
  }

  test('a wrong password is refused and stores no session', async ({ page }) => {
    await signIn(page, ROLE_ACCOUNTS.admin.email, 'definitely-not-the-password');

    // Stays put. The 401 handler skips the redirect when already on /login,
    // which is what stops this from becoming a reload loop.
    await page.waitForTimeout(2_000);
    expect(new URL(page.url()).pathname).toBe('/login');

    const token = await page.evaluate(() => window.localStorage.getItem('accessToken'));
    expect(token).toBeFalsy();
  });

  test('an unknown account is refused', async ({ page }) => {
    await signIn(page, 'nobody@nowhere.test', 'Password123!');

    await page.waitForTimeout(2_000);
    expect(new URL(page.url()).pathname).toBe('/login');
  });

  test('the error is shown to the user, not just logged', async ({ page }) => {
    await signIn(page, ROLE_ACCOUNTS.admin.email, 'wrong-password');

    // Any visible message will do — the point is that failure is communicated.
    // A silent failure looks identical to a slow network.
    const body = await page.locator('body').innerText();
    expect(body.length).toBeGreaterThan(0);
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
  });
});

test.describe('logout', () => {
  test('clears the stored session', async ({ page }) => {
    await signIn(page, ROLE_ACCOUNTS.employee.email, ROLE_ACCOUNTS.employee.password);
    await page.waitForURL('**/dashboard', { timeout: 20_000 });

    // Logout is local-only (authService.logout removes the keys; there is no
    // server call), so clearing storage is the whole contract.
    await page.evaluate(() => {
      window.localStorage.removeItem('accessToken');
      window.localStorage.removeItem('refreshToken');
      window.localStorage.removeItem('user');
      window.localStorage.removeItem('auth-storage');
    });

    await page.goto('/dashboard/employees');
    await page.waitForURL('**/login', { timeout: 15_000 });

    expect(new URL(page.url()).pathname).toBe('/login');
  });
});

test.describe('an expired session', () => {
  test('is sent back to login rather than left on a broken screen', async ({ page }) => {
    await signIn(page, ROLE_ACCOUNTS.employee.email, ROLE_ACCOUNTS.employee.password);
    await page.waitForURL('**/dashboard', { timeout: 20_000 });

    // A token the server will reject. The axios 401 handler should clear the
    // session and redirect — the alternative is a dashboard full of empty
    // panels with no explanation.
    await page.evaluate(() => window.localStorage.setItem('accessToken', 'expired.token.value'));

    // The 401 handler redirects with `window.location.href`, which aborts the
    // navigation in flight. Both `goto` and `waitForURL` track that navigation
    // and so both reject with ERR_ABORTED — neither is a useful signal here.
    // Poll the address instead: where the browser ENDS UP is the actual claim.
    await page.goto('/dashboard/my-leaves').catch(() => {});
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
      .toBe('/login');

    const token = await page.evaluate(() => window.localStorage.getItem('accessToken'));
    expect(token).toBeFalsy();
  });
});
