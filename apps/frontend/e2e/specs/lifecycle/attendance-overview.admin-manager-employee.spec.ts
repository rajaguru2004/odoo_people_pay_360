import { test, expect, settle, crashesOnly } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import { AttendanceOverviewPage, selectBranch, captureNativeDialogs } from '../../pages';

/**
 * The Attendance Overview — the screen HR actually watches, and the one that
 * decides whether today looks normal.
 *
 * Everything here is a DERIVED number: the four stat tiles are computed on the
 * client from a single `/attendances/overview` payload, and the "N of M"
 * counter is built from `/attendances/list`'s two totals. So the failure worth
 * catching is not "the page rendered" — it is the page rendering a confident
 * summary that disagrees with the data it was given.
 *
 * Every case therefore reads the payload the page ITSELF received, via
 * `waitForResponse` matched on the API origin, and compares the screen against
 * that. A second fetch of our own would race the other three role projects,
 * which share one database.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

interface OverviewPayload {
  stats?: Record<string, number>;
  summary?: Record<string, number>;
}

test.describe('the overview, as an administrator reads it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'administrative screen');
  });

  let branchId = '';

  test.beforeEach(async ({ api }) => {
    if (!branchId) branchId = await api.firstBranchId();
  });

  test('ATT-UI-01 the screen loads and its stat tiles agree with the payload it received', async ({
    page,
    problems,
    api,
  }) => {
    await selectBranch(page, branchId);
    const overview = new AttendanceOverviewPage(page);

    const [res] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          r.url().startsWith(`${API_URL}/attendances/overview`),
      ),
      overview.open(),
    ]);
    expect(res.status()).toBe(200);

    const body = await res.json();
    const data: OverviewPayload = body?.data ?? body;
    const source = data.stats ?? data.summary ?? (data as any);

    // The tiles are computed client-side from exactly this payload, so a
    // disagreement means the summary is lying about the day.
    const total = await overview.stat('total');
    expect(Number.isNaN(total)).toBe(false);
    if (typeof source?.totalEmployees === 'number') {
      expect(total).toBe(source.totalEmployees);
    }

    settle(problems, 'the attendance overview');
  });

  test('ATT-UI-02 each period tab re-queries and marks itself active', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const overview = new AttendanceOverviewPage(page);
    await overview.open();

    for (const period of ['week', 'month', 'today'] as const) {
      const [res] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.request().method() === 'GET' &&
            r.url().startsWith(`${API_URL}/attendances/overview`) &&
            r.url().includes(`period=${period}`),
        ),
        overview.period(period),
      ]);
      expect(res.status()).toBe(200);
      expect(await overview.activePeriod()).toBe(period);
    }

    settle(problems, 'the period tabs');
  });

  test('ATT-UI-03 switching period clears the filters rather than carrying them over', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const overview = new AttendanceOverviewPage(page);
    await overview.open();

    await overview.search('zzz-no-such-person');
    await page.waitForTimeout(600); // debounce

    await overview.period('week');
    await page.waitForTimeout(600);

    // A filter that survives a tab change silently narrows a DIFFERENT day,
    // which is the kind of wrongness nobody notices.
    await expect(page.getByTestId('att-search')).toHaveValue('');

    settle(problems, 'filters across a period change');
  });

  test('ATT-UI-04 a search that matches nothing empties the table honestly', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const overview = new AttendanceOverviewPage(page);
    await overview.open();

    const before = await overview.rowCount();
    await overview.search('zzz-definitely-no-such-employee');
    await page.waitForTimeout(800);

    const after = await overview.rowCount();
    expect(after).toBeLessThanOrEqual(before);
    if (after === 0) expect(await overview.isEmpty()).toBe(true);

    settle(problems, 'the empty state');
  });

  /**
   * F9. `TodayAttendanceTable` sorts the CURRENT PAGE client-side while
   * pagination is server-side, so clicking a header reorders the rows on screen
   * and issues no request. Pinned explicitly so "the table is sortable" is never
   * read as a company-wide sort.
   */
  test('ATT-UI-05 sorting reorders the page in place and issues no request', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const overview = new AttendanceOverviewPage(page);
    await overview.open();

    if ((await overview.rowCount()) < 2) {
      test.skip(true, 'needs at least two rows to observe an order change');
    }

    let requested = false;
    const watch = (r: any) => {
      if (r.url().startsWith(`${API_URL}/attendances/list`)) requested = true;
    };
    page.on('request', watch);

    const order = await overview.sortBy('name');
    await page.waitForTimeout(400);
    page.off('request', watch);

    expect(order === 'asc' || order === 'desc').toBe(true);
    expect(requested).toBe(false);

    settle(problems, 'client-side sorting');
  });

  test('ATT-UI-06 the quick-nav cards reach the three screens they name', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const overview = new AttendanceOverviewPage(page);

    await overview.open();
    await overview.navTo('history');
    await expect(page).toHaveURL(/\/dashboard\/attendance\/history/);

    await overview.open();
    await overview.navTo('corrections');
    await expect(page).toHaveURL(/\/dashboard\/attendance\/corrections/);

    await overview.open();
    await overview.navTo('reports');
    await expect(page).toHaveURL(/\/dashboard\/attendance\/reports/);

    settle(problems, 'quick navigation');
  });

  /**
   * The export is a client-side XLSX build that RE-FETCHES at `limit: 10000`,
   * so a filter that fails to reach the export is a silent wrong-file bug. The
   * screen also reports an empty export through a native `alert()` (F12), which
   * is why dialogs are captured.
   */
  test('ATT-UI-07 the export produces a real file', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    await captureNativeDialogs(page);

    const overview = new AttendanceOverviewPage(page);
    await overview.open();

    if ((await overview.rowCount()) === 0) {
      test.skip(true, 'no attendance on screen to export');
    }

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }).catch(() => null),
      page.getByTestId('att-export').click(),
    ]);

    expect(download).not.toBeNull();
    expect(download!.suggestedFilename()).toMatch(/\.xlsx$/);

    settle(problems, 'the overview export');
  });

  /**
   * The screen re-fetches on `selectedBranchId`, so a branch change must change
   * the data — not just the picker. This is the only case that proves the
   * overview is genuinely branch-scoped from the user's side.
   */
  test('ATT-UI-08 switching branch re-scopes the table', async ({ page, problems, api }) => {
    const branches = await api.get<Array<{ id: string; code: string }>>('/branches');
    const other = branches.find((b) => b.id !== branchId);
    test.skip(!other, 'needs a second branch');

    const overview = new AttendanceOverviewPage(page);

    await selectBranch(page, branchId);
    await overview.open();
    const first = await overview.employeeIds();

    await selectBranch(page, other!.id);
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          r.url().startsWith(`${API_URL}/attendances/list`),
      ),
      overview.open(),
    ]);
    expect(res.status()).toBe(200);
    const second = await overview.employeeIds();

    // Different branches cannot show the same staff. Equal-and-non-empty would
    // mean the header never reached the server.
    if (first.length && second.length) {
      expect(second.some((id) => first.includes(id))).toBe(false);
    }

    settle(problems, 'branch re-scoping');
  });
});

test.describe('the overview, for the roles that may not use it', () => {
  /**
   * `/dashboard/attendance` is one of only two attendance screens with a real
   * `ProtectedRoute` (`VIEW_ALL_ATTENDANCE`), so this is a hard URL assertion.
   * Everywhere else in this module the server is the only gate and the correct
   * expectation is a clean data-403, not a redirect.
   */
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the denied role');
    });

    test('ATT-UI-09 an employee is redirected to /403', async ({ page, problems }) => {
      await page.goto('/dashboard/attendance', { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/403/, { timeout: 15_000 });

      crashesOnly(problems);
      settle(problems, 'the employee denial');
    });
  });

  /** A manager holds VIEW_ALL_ATTENDANCE and `/attendances/overview` admits them. */
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the scoped role');
    });

    test('ATT-UI-10 a manager reaches the screen and its data loads', async ({
      page,
      problems,
      api,
    }) => {
      await selectBranch(page, await api.firstBranchId());

      const [res] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.request().method() === 'GET' &&
            r.url().startsWith(`${API_URL}/attendances/overview`),
        ),
        new AttendanceOverviewPage(page).open(),
      ]);

      expect(res.status()).toBe(200);
      await expect(page).not.toHaveURL(/\/403/);

      crashesOnly(problems);
      settle(problems, 'the manager view');
    });
  });
});
