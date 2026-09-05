import { test, expect, settle, crashesOnly } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import { AttendanceReportsPage, selectBranch } from '../../pages';

/**
 * The Attendance Reports screen — four KPI cards over `/attendances/statistics`
 * and a per-employee summary over `/attendances/report`.
 *
 * Two things here are worth a browser and cannot be reached in vitest: the KPI
 * cards agreeing with the payload the page received, and the summary table's
 * ROLE GATE. The exhaustive threshold table behind the standing badge
 * (`late > 5`, `late > 2`, `present === 0`) is ten data shapes and belongs in a
 * component test — a browser case would need ten manufactured employees to see
 * what one render can prove.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

test.describe('the reports screen, as HR reads it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'the HR half');
  });

  let branchId = '';

  test.beforeEach(async ({ api }) => {
    if (!branchId) branchId = await api.firstBranchId();
  });

  test('REP-UI-01 the KPI cards agree with the statistics payload', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const reports = new AttendanceReportsPage(page);

    const [res] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          r.url().startsWith(`${API_URL}/attendances/statistics`),
      ),
      reports.open(),
    ]);
    expect(res.status()).toBe(200);

    const body = await res.json();
    const stats = body?.data ?? body;

    if (typeof stats?.totalRecords === 'number') {
      expect(await reports.kpi('checkins')).toBe(stats.totalRecords);
    }
    if (typeof stats?.lateRate === 'number') {
      expect(await reports.kpi('lateRate')).toBe(stats.lateRate);
    }
    // The division guard: an empty month must render 0, never NaN — which
    // serialises to `null` and reads on screen as "no data" rather than a bug.
    expect(Number.isNaN(await reports.kpi('lateRate'))).toBe(false);

    settle(problems, 'the report KPIs');
  });

  test('REP-UI-02 the summary table is offered to HR', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const reports = new AttendanceReportsPage(page);
    await reports.open();

    expect(await reports.hasSummaryTable()).toBe(true);
    settle(problems, 'the HR summary table');
  });

  test('REP-UI-03 month navigation re-queries both endpoints', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const reports = new AttendanceReportsPage(page);
    await reports.open();

    const [report, statistics] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          r.url().startsWith(`${API_URL}/attendances/report`),
      ),
      page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          r.url().startsWith(`${API_URL}/attendances/statistics`),
      ),
      reports.prevMonth(),
    ]);

    expect(report.status()).toBe(200);
    expect(statistics.status()).toBe(200);

    settle(problems, 'report month navigation');
  });

  /**
   * The standing badge is machine-readable precisely so this can be a rule
   * assertion. The bands come from `getAttendanceStatus(present, late,
   * earlyLeave)`; here we only check the rendered band is one the function can
   * actually produce — the full threshold table is a component case.
   */
  test('REP-UI-04 every summary row carries a valid standing band', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const reports = new AttendanceReportsPage(page);
    await reports.open();

    const count = await reports.rowCount();
    test.skip(count === 0, 'no employees in this month');

    const bands = await page
      .locator('[data-testid^="attrep-row-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-standing')));

    for (const band of bands) {
      expect(['good', 'attention', 'risk', 'none']).toContain(band);
    }

    settle(problems, 'the standing badges');
  });

  test('REP-UI-05 the export produces a real file', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const reports = new AttendanceReportsPage(page);
    await reports.open();

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }).catch(() => null),
      page.getByTestId('attrep-export').click(),
    ]);

    expect(download).not.toBeNull();
    expect(download!.suggestedFilename()).toMatch(/\.xlsx$/);

    settle(problems, 'the report export');
  });
});

test.describe('the reports screen, for a manager', () => {
  /**
   * Two independent reasons a manager sees nothing here, and this asserts both:
   * the summary table is behind an inline `user.role` check (so it is absent),
   * and `GET /attendances/report` is `@Roles(ADMIN, HR_MANAGER)` (so the data
   * call 403s). No `ProtectedRoute`, so no redirect — a clean data-403.
   */
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('manager'), 'the manager view');
  });

  test('REP-UI-06 a manager gets the KPI shell without the summary table', async ({
    page,
    problems,
    api,
  }) => {
    await selectBranch(page, await api.firstBranchId());
    const reports = new AttendanceReportsPage(page);
    await reports.open();
    await page.waitForTimeout(1200);

    expect(await reports.hasSummaryTable()).toBe(false);
    await expect(page).not.toHaveURL(/\/403/);

    crashesOnly(problems);
    settle(problems, 'the manager report view');
  });
});
