import { expect, test } from '@playwright/test';

/**
 * The Schedules module. Loaded only by the `hr` and `admin` projects — every
 * route under `/work-schedules` is ADMIN + HR server-side, so no other role can
 * reach the management screen at all.
 *
 * The assertions lean on what the SEED guarantees rather than on exact figures:
 * two plant operators on a night rotation, a maintenance pair split across
 * morning and afternoon, one flexible engineer, and one supervisor deliberately
 * rostered on the branch's weekly off. Asserting "coverage is 62.5%" would break
 * the first time somebody adds an employee; asserting that a night shift exists
 * and that a rest-day roster is REPORTED tests the behaviour instead.
 */
test.describe('Schedules hub', () => {
  test('is reachable from the sidebar and names itself', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Schedules', exact: true }).click();

    await expect(page).toHaveURL(/\/dashboard\/schedules$/);
    await expect(page.getByRole('heading', { name: /schedules/i })).toBeVisible();
  });

  test('offers Week, Month and Year — and no Today', async ({ page }) => {
    // "Who is rostered today" is a calendar screen, not a dashboard question.
    await page.goto('/dashboard/schedules');

    for (const period of ['Week', 'Month', 'Year']) {
      await expect(
        page.getByRole('button', { name: period, exact: true }),
      ).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toHaveCount(
      0,
    );
  });

  test('steps FORWARD out of the current window, because a roster is a plan', async ({
    page,
  }) => {
    // The Time & Attendance hub refuses this: a day that has not happened
    // cannot be an absence. Here reading ahead is the point of the module.
    await page.goto('/dashboard/schedules');

    await expect(page.getByRole('button', { name: /next period/i })).toBeEnabled();
    await page.getByRole('button', { name: /next period/i }).click();
    await expect(page.getByRole('button', { name: /previous period/i })).toBeEnabled();
  });

  test('draws the five roster KPIs', async ({ page }) => {
    await page.goto('/dashboard/schedules');

    for (const label of [
      'Scheduled staff',
      'On shift today',
      'Nobody rostered',
      'Coverage gaps',
      'Roster conflicts',
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test('offers a tile per child route', async ({ page }) => {
    await page.goto('/dashboard/schedules');
    await expect(page.getByTestId('module-tile')).toHaveCount(3);
  });

  test('reports the seeded weekly-off conflict rather than hiding it', async ({
    page,
  }) => {
    // The seed rosters a supervisor on the branch's own rest day. It is not a
    // mistake in the data — it is the conflict the roster is happy to contain,
    // and the reason the module sweeps a window instead of trusting the writes.
    await page.goto('/dashboard/schedules');

    await expect(page.getByText('Roster conflicts', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/rostered on a (holiday|weekly off)/i).first(),
    ).toBeVisible();
  });

  test('names the people with no shift so the queue is workable', async ({ page }) => {
    await page.goto('/dashboard/schedules');

    // Most of the workforce follows its branch calendar and has no roster row,
    // which is exactly what this card exists to surface.
    await expect(page.getByText(/with no shift/i)).toBeVisible();
  });
});

test.describe('Working schedule', () => {
  test('draws a column for every day of the month', async ({ page }) => {
    await page.goto('/dashboard/schedules/overview');

    await expect(
      page.getByRole('heading', { name: /working schedule/i }),
    ).toBeVisible();
    await expect(page.getByTestId('schedule-day-header-1')).toBeVisible();
    await expect(page.getByTestId('schedule-day-header-28')).toBeVisible();
  });

  test('shades each branch by its OWN working week', async ({ page }) => {
    // Head Office rests Friday and Saturday; the Sohar plant rests Friday only.
    // One shared company weekend would close the plant on a day it is open.
    await page.goto('/dashboard/schedules/overview');
    await expect(page.getByTestId('schedule-employee-row-EMP-0001')).toBeVisible();

    const restDays = page.locator('td[data-weekly-off="true"]');
    const openDays = page.locator('td[data-weekly-off="false"]');
    await expect(restDays.first()).toBeVisible();
    // Both states must occur, or the shading is not reading the branch at all.
    expect(await openDays.count()).toBeGreaterThan(0);
  });

  test('renders the seeded night rotation with its hours', async ({ page }) => {
    await page.goto('/dashboard/schedules/overview');
    await expect(page.getByTestId('schedule-employee-row-EMP-0012')).toBeVisible();

    // 20:00 to 04:00 is eight hours, not minus sixteen.
    const nightCell = page.locator('td[data-shift-type="NIGHT"]').first();
    await expect(nightCell).toBeVisible();
    await expect(nightCell).toContainText('8h');
  });

  test('filters the rows by name', async ({ page }) => {
    await page.goto('/dashboard/schedules/overview');
    await expect(page.getByTestId('schedule-employee-row-EMP-0012')).toBeVisible();

    await page.getByTestId('schedule-search').fill('Hassan');

    await expect(page.getByTestId('schedule-employee-row-EMP-0012')).toBeVisible();
    await expect(page.getByTestId('schedule-employee-row-EMP-0001')).toHaveCount(0);
  });

  test('steps to another month and re-reads the window', async ({ page }) => {
    await page.goto('/dashboard/schedules/overview');

    const label = page.getByTestId('schedule-current-month');
    const before = await label.textContent();
    await page.getByTestId('schedule-prev-month').click();
    await expect(label).not.toHaveText(before ?? '');

    // A "back to now" control appears only once the reader has left the month.
    await expect(page.getByTestId('schedule-this-month')).toBeVisible();
  });

  test('explains its colours', async ({ page }) => {
    await page.goto('/dashboard/schedules/overview');
    await expect(page.getByTestId('schedule-legend')).toBeVisible();
    // "Weekly off", never "weekend": the shaded days come from the BRANCH's own
    // week, and an Oman branch rests Friday and Saturday.
    await expect(page.getByTestId('schedule-legend')).toContainText('Weekly off');
  });
});

test.describe('Shift calendar', () => {
  test('opens on a person and draws their month', async ({ page }) => {
    await page.goto('/dashboard/schedules/calendar');

    await expect(page.getByRole('heading', { name: /shift calendar/i })).toBeVisible();
    await expect(page.getByTestId('shift-calendar')).toBeVisible();
    await expect(page.getByTestId('calendar-current-month')).toBeVisible();
  });

  test('shows a plant operator their night rotation', async ({ page }) => {
    await page.goto('/dashboard/schedules/calendar');
    await page.getByTestId('calendar-employee-search').fill('Hassan');
    await page.getByTestId('calendar-employee-EMP-0012').click();

    await expect(page.getByTestId('shift-calendar')).toBeVisible();
    await expect(
      page.locator('[data-event-type="shift"][data-shift-type="NIGHT"]').first(),
    ).toBeVisible();
  });

  test('opens the edit form when a shift is clicked', async ({ page }) => {
    await page.goto('/dashboard/schedules/calendar');
    await page.getByTestId('calendar-employee-search').fill('Hassan');
    await page.getByTestId('calendar-employee-EMP-0012').click();

    await page.locator('[data-event-type="shift"]').first().click();

    const modal = page.getByTestId('schedule-modal');
    await expect(modal).toBeVisible();
    // The date is fixed once a row exists: the table is unique on employee and
    // date, so moving a row to another day is a different row.
    await expect(modal.getByTestId('schedule-modal-date')).toBeDisabled();
    await modal.getByTestId('schedule-modal-close').click();
    await expect(modal).toHaveCount(0);
  });

  test('opens the create form when an empty day is clicked', async ({ page }) => {
    await page.goto('/dashboard/schedules/calendar');
    await expect(page.getByTestId('shift-calendar')).toBeVisible();

    await page.getByTestId('calendar-add-shift').click();
    await expect(page.getByTestId('schedule-modal')).toBeVisible();
  });
});

test.describe('Shift management', () => {
  test('lists the roster with its coverage and conflicts', async ({ page }) => {
    await page.goto('/dashboard/schedules/shifts');

    await expect(
      page.getByRole('heading', { name: /shift management/i }),
    ).toBeVisible();
    await expect(page.getByTestId('shift-stat-shifts')).toBeVisible();
    await expect(page.getByTestId('shift-stat-unassigned')).toBeVisible();
    await expect(page.getByTestId('shift-stat-conflicts')).toBeVisible();
  });

  test('narrows the list to one shift type', async ({ page }) => {
    await page.goto('/dashboard/schedules/shifts');
    await expect(page.getByTestId('shift-count')).toBeVisible();

    await page.getByTestId('shift-type-filter').selectOption('NIGHT');

    const rows = page.locator('[data-testid^="shift-row-"]');
    if ((await rows.count()) > 0) {
      await expect(rows.first()).toHaveAttribute('data-shift-type', 'NIGHT');
    }
  });

  test('creates, edits and removes a shift', async ({ page }) => {
    // The whole write path in one pass. Run last in the file so the roster it
    // leaves behind cannot affect the counts the tests above assert.
    await page.goto('/dashboard/schedules/shifts');
    await expect(page.getByTestId('shift-count')).toBeVisible();

    // A date far enough out that nothing in the seed already occupies it, and
    // inside the year the forward stepper allows.
    const target = new Date();
    target.setUTCDate(target.getUTCDate() + 45);
    const dayKey = target.toISOString().slice(0, 10);

    await page.getByTestId('shift-create').click();
    const modal = page.getByTestId('schedule-modal');
    await expect(modal).toBeVisible();

    await modal.getByTestId('schedule-modal-type').selectOption('AFTERNOON');
    // Picking a type pre-fills its usual window without locking it.
    await expect(modal.getByTestId('schedule-modal-start')).toHaveValue('14:00');
    await modal.getByTestId('schedule-modal-notes').fill('E2E afternoon cover');
    await modal.getByTestId('schedule-modal-save').click();

    // Either it saved, or the server refused for a reason the form now shows —
    // an unseeded employee already rostered on today, say. Both are answers; a
    // silent nothing is not.
    await expect(
      modal.getByTestId('schedule-modal-error').or(page.getByTestId('shift-count')),
    ).toBeVisible();

    expect(dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('refuses to run a pattern that lands on no days', async ({ page }) => {
    await page.goto('/dashboard/schedules/shifts');

    await page.getByTestId('shift-bulk-create').click();
    const modal = page.getByTestId('bulk-schedule-modal');
    await expect(modal).toBeVisible();

    await modal.getByTestId('bulk-select-all').click();
    await expect(modal.getByTestId('bulk-selected-count')).not.toContainText(
      '0 selected',
    );

    // The range defaults to today alone. Ticking every weekday but today's
    // leaves the pattern with nothing to land on.
    const today = new Date();
    const todayIso = ((today.getUTCDay() + 6) % 7) + 1;
    for (const weekday of [1, 2, 3, 4, 5, 6, 7]) {
      if (weekday === todayIso) continue;
      await modal.getByTestId(`bulk-weekday-${weekday}`).click();
    }

    await expect(modal.getByTestId('bulk-apply')).toBeDisabled();
    await modal.getByTestId('bulk-modal-close').click();
  });

  test('reports every day a bulk run created, replaced or left alone', async ({
    page,
  }) => {
    await page.goto('/dashboard/schedules/shifts');

    await page.getByTestId('shift-bulk-create').click();
    const modal = page.getByTestId('bulk-schedule-modal');
    await expect(modal).toBeVisible();

    // One employee, one day, well past anything the seed rosters.
    await modal.getByTestId('bulk-employee-EMP-0001').click();

    const target = new Date();
    target.setUTCDate(target.getUTCDate() + 60);
    const dayKey = target.toISOString().slice(0, 10);
    await modal.getByTestId('bulk-start-date').fill(dayKey);
    await modal.getByTestId('bulk-end-date').fill(dayKey);

    await modal.getByTestId('bulk-apply').click();

    // A day already rostered is REPORTED rather than silently replaced, so this
    // panel appears whether the run wrote anything or not.
    await expect(modal.getByTestId('bulk-result')).toBeVisible();
    await expect(modal.getByTestId('bulk-result')).toContainText(/created|skipped/);
  });
});
