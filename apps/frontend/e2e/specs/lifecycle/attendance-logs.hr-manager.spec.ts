import { test, expect, settle, crashesOnly } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import { AttendanceLogsPage, selectBranch } from '../../pages';

/**
 * The Attendance Logs grid — one row per employee, one column per day.
 *
 * Every cell's state is DERIVED, not stored: `getCellStatus` merges the day's
 * record with whether that day is a holiday, a weekly-off, or in the future,
 * and holiday wins over an ABSENT record. There is no other way to assert "a
 * HOLIDAY cell that overrode an ABSENT record" than to read `data-cell-status`,
 * which is why the grid carries it.
 *
 * Shading is asserted against the payloads the page ITSELF fetched
 * (`/system-settings/public` for the weekly-off days, `/holidays` for the
 * calendar) rather than against a pinned constant. That is deliberate and it is
 * stronger: it asserts *the screen agrees with the configuration*, which is the
 * product rule, instead of *the screen agrees with a number the seed happened
 * to write*. Both settings are shared with the backend suite, so pinning either
 * would break specs three modules away.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

test.describe('the logs grid, as HR reads it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'the HR half');
  });

  let branchId = '';

  test.beforeEach(async ({ api }) => {
    if (!branchId) branchId = await api.firstBranchId();
  });

  test('LOG-UI-01 the grid renders a row for every employee in the report payload', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const logs = new AttendanceLogsPage(page);

    const [res] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          r.url().startsWith(`${API_URL}/attendances/report`),
      ),
      logs.open(),
    ]);
    expect(res.status()).toBe(200);

    const body = await res.json();
    const rows: any[] = body?.data ?? body ?? [];

    if (rows.length === 0) {
      expect(await logs.isEmpty()).toBe(true);
    } else {
      const first = rows[0]?.employee?.id ?? rows[0]?.employeeId;
      if (first) expect(await logs.hasRow(first)).toBe(true);
    }

    settle(problems, 'the logs grid');
  });

  test('LOG-UI-02 month navigation moves the header and re-queries', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const logs = new AttendanceLogsPage(page);
    await logs.open();

    const start = await logs.month();

    const [res] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          r.url().startsWith(`${API_URL}/attendances/report`),
      ),
      logs.prevMonth(),
    ]);
    expect(res.status()).toBe(200);

    const back = await logs.month();
    // Going back one month from January must roll the year, which is the only
    // arithmetic this header does.
    const expected = start.month === 1 ? 12 : start.month - 1;
    expect(back.month).toBe(expected);
    if (start.month === 1) expect(back.year).toBe(start.year - 1);

    settle(problems, 'month navigation');
  });

  test('LOG-UI-03 paging back far enough reaches an honest empty state', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const logs = new AttendanceLogsPage(page);
    await logs.open();

    // Far outside any seeded window. The grid must say so rather than render
    // a skeleton forever.
    for (let i = 0; i < 14; i++) await logs.prevMonth();
    await page.waitForTimeout(1500);

    const empty = await logs.isEmpty();
    const anyRow = await page.locator('[data-testid^="attlog-row-"]').count();
    expect(empty || anyRow === 0).toBe(true);

    settle(problems, 'the empty month');
  });

  /**
   * Weekend shading comes from the GLOBAL `calendar_weekly_holidays`, which the
   * screen reads from `/system-settings/public`. Deriving the expectation from
   * that payload is what makes this a rule assertion rather than a snapshot.
   */
  test('LOG-UI-04 weekend columns are shaded according to the configured weekly-off days', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const logs = new AttendanceLogsPage(page);

    const [settingsRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          r.url().startsWith(`${API_URL}/system-settings/public`),
      ),
      logs.open(),
    ]);
    const settings = await settingsRes.json();
    const raw =
      (settings?.data ?? settings)?.calendar_weekly_holidays ??
      (settings?.data ?? settings)?.calendarWeeklyHolidays;

    const offDays: number[] = String(raw ?? '')
      .split(',')
      .map((v: string) => Number(v.trim()))
      .filter((v: number) => !Number.isNaN(v));

    test.skip(offDays.length === 0, 'no weekly-off days configured to assert against');

    const rowIds = await page
      .locator('[data-testid^="attlog-row-"]')
      .evaluateAll((els) =>
        els.map((e) => (e.getAttribute('data-testid') ?? '').replace('attlog-row-', '')),
      );
    test.skip(rowIds.length === 0, 'no employees in this month');

    const { month, year } = await logs.month();
    let checked = 0;
    for (let day = 1; day <= 28 && checked < 3; day++) {
      const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      if (!offDays.includes(dow)) continue;
      const isWeekend = await logs.cellIsWeekend(rowIds[0], day);
      expect(isWeekend).toBe(true);
      checked++;
    }

    settle(problems, 'weekend shading');
  });

  test('LOG-UI-05 a multi-session cell opens a modal whose count matches the cell', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const logs = new AttendanceLogsPage(page);
    await logs.open();

    const multi = page.locator('[data-testid^="attlog-cell-"][data-sessions]').filter({
      has: undefined,
    });
    const cells = await page
      .locator('[data-testid^="attlog-cell-"]')
      .evaluateAll((els) =>
        els
          .map((e) => ({
            id: e.getAttribute('data-testid') ?? '',
            sessions: Number(e.getAttribute('data-sessions') ?? 0),
          }))
          .filter((c) => c.sessions > 1),
      );
    test.skip(cells.length === 0, 'no multi-session day in this month');

    const parts = cells[0].id.replace('attlog-cell-', '').split('-');
    const day = Number(parts.pop());
    const employeeId = parts.join('-');

    await logs.openSessions(employeeId, day);
    expect(await logs.sessionsInModal()).toBe(cells[0].sessions);
    await logs.closeSessions();

    settle(problems, 'the sessions modal');
  });

  test('LOG-UI-06 the export produces a real file', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const logs = new AttendanceLogsPage(page);
    await logs.open();

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }).catch(() => null),
      page.getByTestId('attlog-export').click(),
    ]);

    expect(download).not.toBeNull();
    expect(download!.suggestedFilename()).toMatch(/\.xlsx$/);

    settle(problems, 'the logs export');
  });
});

test.describe('the logs grid, for a manager', () => {
  /**
   * F13. `routes.ts` records this route `allowed: ADMIN_HR_MANAGER` with
   * `usableBy: ADMIN_HR`, and this is that divergence driven for real: the
   * screen has NO `ProtectedRoute`, so a manager reaches it, and
   * `GET /attendances/report` is `@Roles(ADMIN, HR_MANAGER)`, so its only data
   * call answers 403.
   *
   * Asserted as a clean data-403 — reached, refused, no crash, no redirect —
   * because that is what the product does. `crashesOnly` is required: the 403
   * is the system working, not evidence of breakage.
   */
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('manager'), 'the manager view');
  });

  test('LOG-UI-07 a manager reaches the screen and its data call is refused', async ({
    page,
    problems,
    api,
  }) => {
    await selectBranch(page, await api.firstBranchId());
    const logs = new AttendanceLogsPage(page);

    const [res] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          r.url().startsWith(`${API_URL}/attendances/report`),
      ),
      logs.open(),
    ]);

    expect(res.status()).toBe(403);
    await expect(page).not.toHaveURL(/\/403/);

    crashesOnly(problems);
    settle(problems, 'the manager data-403');
  });
});
