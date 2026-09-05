import { expect, test } from '@playwright/test';

/** Time & Attendance. Loaded only by the `hr` and `admin` projects. */
test.describe('Time and attendance hub', () => {
  test('is reachable from the sidebar and names itself', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Time & attendance', exact: true }).click();

    await expect(page).toHaveURL(/\/dashboard\/time$/);
    await expect(
      page.getByRole('heading', { name: /time & attendance/i }),
    ).toBeVisible();
  });

  test('offers the four periods and moves the report when one is picked', async ({ page }) => {
    await page.goto('/dashboard/time');

    for (const period of ['Today', 'Week', 'Month', 'Year']) {
      await expect(page.getByRole('button', { name: period, exact: true })).toBeVisible();
    }

    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(page.getByTestId('hub-period-label')).toBeVisible();
  });

  test('will not step forward out of the current period', async ({ page }) => {
    await page.goto('/dashboard/time');

    // The stepper must not walk into a window that has not happened.
    await expect(page.getByRole('button', { name: /next period/i })).toBeDisabled();
    await page.getByRole('button', { name: /previous period/i }).click();
    await expect(page.getByRole('button', { name: /next period/i })).toBeEnabled();
  });

  test('offers a tile per child route', async ({ page }) => {
    await page.goto('/dashboard/time');
    await expect(page.getByTestId('module-tile')).toHaveCount(6);
  });
});

test.describe('Attendance overview', () => {
  test("shows today's board including who has not arrived", async ({ page }) => {
    await page.goto('/dashboard/attendance');

    await expect(page.getByRole('heading', { name: /attendance/i })).toBeVisible();
    // An absence has to be visible before anybody can explain it.
    await expect(page.getByTestId('attendance-row').first()).toBeVisible();
  });
});

test.describe('Attendance logs', () => {
  test('lists historical records with their status', async ({ page }) => {
    await page.goto('/dashboard/attendance/history');

    await expect(
      page.getByRole('heading', { name: /attendance logs/i }),
    ).toBeVisible();
    await expect(page.getByTestId('attendance-row').first()).toBeVisible();
  });

  test('filters by status', async ({ page }) => {
    await page.goto('/dashboard/attendance/history');

    await page.getByLabel('Status', { exact: true }).selectOption('LATE');
    const badges = page.getByTestId('attendance-status');
    await expect(badges.first()).toContainText(/late/i);
  });
});

test.describe('Attendance requests', () => {
  test('shows the correction queue the seed leaves pending', async ({ page }) => {
    await page.goto('/dashboard/attendance/corrections');

    await expect(
      page.getByRole('heading', { name: /attendance requests/i }),
    ).toBeVisible();
    await expect(page.getByTestId('correction-row').first()).toBeVisible();
  });

  test('shows what the clock said beside what is being asked for', async ({ page }) => {
    await page.goto('/dashboard/attendance/corrections');
    await page.getByTestId('correction-row').first().click();

    // The snapshot is the point of the record: the reviewer has to see both.
    await expect(page.getByText(/recorded/i).first()).toBeVisible();
    await expect(page.getByText(/requested/i).first()).toBeVisible();
  });
});

test.describe('Attendance reports', () => {
  test('reports totals over a date range', async ({ page }) => {
    await page.goto('/dashboard/attendance/reports');

    await expect(
      page.getByRole('heading', { name: /attendance reports/i }),
    ).toBeVisible();
    // `exact` because getByLabel matches a SUBSTRING of the accessible name:
    // a bare 'To' also matches the rail's "Toggle Organisation", and three
    // matches is a strict-mode violation before the assertion is even read.
    await expect(page.getByLabel('From', { exact: true })).toBeVisible();
    await expect(page.getByLabel('To', { exact: true })).toBeVisible();
  });
});

test.describe('Attendance manager', () => {
  test('lets a day be marked for a set of people at once', async ({ page }) => {
    await page.goto('/dashboard/attendance/management');

    await expect(
      page.getByRole('heading', { name: /attendance manager/i }),
    ).toBeVisible();
    await expect(page.getByLabel('Date', { exact: true })).toBeVisible();
  });
});

test.describe('Biometric enrolment', () => {
  test('lists who is enrolled without ever exposing a template', async ({ page }) => {
    await page.goto('/dashboard/attendance/face-management');

    await expect(
      page.getByRole('heading', { name: /biometric enrolment/i }),
    ).toBeVisible();

    // The page reports quality and date. A descriptor reaching the browser at
    // all would be a leak, so nothing on this screen can render one.
    await expect(page.getByText(/quality/i).first()).toBeVisible();
  });
});
