import { expect, test } from '@playwright/test';

/**
 * Who the Schedules module is NOT for.
 *
 * Loaded only by the `payroll` and `employee` projects. Neither role appears in
 * the module's nav group, and the API refuses both: `GET /schedules/hub-summary`
 * is ADMIN, HR and MANAGER only, and every `/work-schedules` write is ADMIN and
 * HR alone.
 *
 * The rail hiding an entry is a UI affordance, never the boundary — so this
 * asserts the DENIAL as well as the absence. A user who follows a bookmark, or
 * types the URL, has to land somewhere that says no.
 */
test.describe('Schedules is not offered to this role', () => {
  test('the rail has no Schedules section', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('link', { name: 'Schedules', exact: true })).toHaveCount(
      0,
    );
  });

  test.describe('and every screen in it refuses', () => {
    for (const [name, path] of [
      ['the dashboard', '/dashboard/schedules'],
      ['the working schedule', '/dashboard/schedules/overview'],
      ['the shift calendar', '/dashboard/schedules/calendar'],
      ['shift management', '/dashboard/schedules/shifts'],
    ] as const) {
      test(`${name} lands on 403 rather than on a crashed page`, async ({ page }) => {
        await page.goto(path);

        await expect(page).toHaveURL(/\/403$/);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      });
    }
  });
});
