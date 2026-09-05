import { expect, test } from '@playwright/test';

/**
 * The Leave & Overtime hub.
 *
 * `.hr-admin.` because the aggregate behind the page — `GET
 * /leave-requests/hub-summary` — is ADMIN, HR and MANAGER only: it answers by
 * name and by reason, and a sick note is not a payroll fact. There is no
 * manager project, so the two roles that can open the hub are the two that load
 * this file.
 *
 * Nothing here pins a KPI to a figure. The approval spec decides a seeded
 * request while this one runs, so the numbers are entitled to move underneath
 * it — what the assertions care about is that the aggregate RESOLVED, which is
 * exactly what an em dash says it did not. `null` renders as a dash and 0 does
 * not, and the whole point of that rule is that "nothing was filed" and "the
 * endpoint failed" must not print the same character.
 */
test.describe('Leave & overtime hub', () => {
  test('is reachable from the sidebar and names itself', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Leave & overtime', exact: true }).click();

    await expect(page).toHaveURL(/\/dashboard\/leave$/);
    await expect(
      page.getByRole('heading', { name: 'Leave & overtime' }),
    ).toBeVisible();
  });

  test('reports the five figures the module is about', async ({ page }) => {
    await page.goto('/dashboard/leave');

    for (const key of ['pending', 'days', 'away', 'balance', 'overtime']) {
      await expect(page.getByTestId(`kpi-${key}`)).toBeVisible();
    }

    // The queue card counts in the database rather than measuring a page, so a
    // dash here is a failed aggregate and not an empty one.
    await expect(page.getByTestId('kpi-pending')).not.toContainText('—');
    await expect(page.getByTestId('kpi-pending')).toContainText(
      'Awaiting a decision',
    );
  });

  test('offers the three periods, and each one names its own window', async ({
    page,
  }) => {
    await page.goto('/dashboard/leave');

    // No `Today`: "leave filed today" is not a question anybody opens this
    // module with, and a tab nobody presses hides the three that get used.
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toHaveCount(0);

    const label = page.getByTestId('hub-period-label');

    // The server formats every label, so these shapes are the server's own
    // answer — the browser does no calendar maths to produce them.
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    await expect(label).toHaveText(/^[A-Z][a-z]{2} \d{4}$/);

    await page.getByRole('button', { name: 'Year', exact: true }).click();
    await expect(label).toHaveText(/^\d{4}$/);

    await page.getByRole('button', { name: 'Week', exact: true }).click();
    // A week is a span, and it is rendered as one: "Aug 3 – 9".
    await expect(label).toContainText('–');
  });

  test('steps the window backwards and forwards, and finds its way home', async ({
    page,
  }) => {
    await page.goto('/dashboard/leave');

    const label = page.getByTestId('hub-period-label');
    await expect(label).not.toBeEmpty();
    const current = (await label.textContent()) ?? '';

    await page.getByRole('button', { name: 'Previous period' }).click();
    await expect(label).not.toHaveText(current);

    // Unlike attendance, forward is allowed here: leave is FILED AHEAD, so next
    // month is a window with rows in it rather than a guaranteed blank.
    await expect(page.getByRole('button', { name: 'Next period' })).toBeEnabled();

    // The reset only appears once the view has been paged off the current
    // window, and it is named for what it does rather than for where it lands.
    await page.getByRole('button', { name: 'Back to the current period' }).click();
    await expect(label).toHaveText(current);
  });

  test('carries the attention strip', async ({ page }) => {
    await page.goto('/dashboard/leave');

    await expect(page.getByText('Needs a decision')).toBeVisible();

    // Either shape is the strip working. A queue that another spec has just
    // emptied is a legitimate answer, and the strip says so in words rather
    // than drawing a row reading "0 waiting" — which is not a task.
    await expect(
      page
        .getByRole('link', { name: 'Open the queue' })
        .or(page.getByText('Nothing is waiting on anybody right now.')),
    ).toBeVisible();
  });

  test('offers a tile per child route, and the tiles navigate', async ({ page }) => {
    await page.goto('/dashboard/leave');

    // Seven: the five leave screens plus the two overtime ones. The tiles are
    // built from the same filtered menu as the rail, so a tile can never hand
    // the reader a screen ProtectedRoute then refuses.
    await expect(page.getByTestId('module-tile')).toHaveCount(7);

    await page.getByRole('link', { name: /pending leave/i }).first().click();
    await expect(page).toHaveURL(/\/dashboard\/leaves\/pending$/);
  });
});
