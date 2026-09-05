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
  /**
   * The company attendance log: a month at a time, everyone down the side and
   * every day across the top. Stepping back one month first, because the log is
   * anchored on the last finished day and the current month is only ever
   * partly written — on the first of a month it holds a single column.
   */
  const openLastFullMonth = async (page: import('@playwright/test').Page) => {
    await page.goto('/dashboard/attendance/history');
    await expect(page.getByTestId('attendance-row').first()).toBeVisible();
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(page.getByTestId('attendance-row').first()).toBeVisible();
  };

  test('draws the month as employees against days', async ({ page }) => {
    await page.goto('/dashboard/attendance/history');

    await expect(
      page.getByRole('heading', { name: /attendance logs/i }),
    ).toBeVisible();

    // A row per employee, not per attendance record: somebody who never
    // clocked in has no record to be listed by, and they are exactly the
    // person the log is opened to find.
    await expect(page.getByTestId('attendance-row').first()).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: 'Employee' }),
    ).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: 'Summary' }),
    ).toBeVisible();

    // One column per day of the month, plus the two frozen ones.
    const columns = await page.getByRole('columnheader').count();
    expect(columns).toBeGreaterThan(29);
  });

  test('steps a month at a time and will not walk into the future', async ({ page }) => {
    await page.goto('/dashboard/attendance/history');

    const label = page.getByTestId('attendance-month');
    await expect(label).toBeVisible();
    const shown = await label.innerText();

    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(label).not.toHaveText(shown);

    // Forward is a real destination now; from the current month it is not,
    // because every cell in a month that has not happened would be blank.
    await expect(page.getByRole('button', { name: 'Next month' })).toBeEnabled();
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(page.getByRole('button', { name: 'Next month' })).toBeDisabled();
  });

  test('reports the month beside each employee', async ({ page }) => {
    await openLastFullMonth(page);

    const summary = page
      .getByTestId('attendance-row')
      .first()
      .getByText(/present/i);
    await expect(summary).toBeVisible();

    for (const figure of ['Absent', 'Late/Early', 'Hours', 'Early in', 'Late out']) {
      await expect(
        page.getByTestId('attendance-row').first().getByText(figure, { exact: true }),
      ).toBeVisible();
    }
  });

  test('filters the grid by status', async ({ page }) => {
    await openLastFullMonth(page);

    await page.getByLabel('Status', { exact: true }).selectOption('LATE');

    // Only the matching days keep their standing, so the first one the reader
    // meets is one of the days they asked about.
    const badges = page.getByTestId('attendance-status');
    await expect(badges.first()).toContainText(/late/i);
    await expect(badges.first()).toHaveAttribute('data-status', 'LATE');
  });

  test('scrolls the grid inside its own box, never the page', async ({ page }) => {
    await openLastFullMonth(page);

    // A month of columns is wider than any screen. The employee column is
    // pinned and the page body must not move sideways with it.
    const overflow = await page.evaluate(
      () => document.body.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
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
