import { test, expect, settle, crashesOnly, renderOnly } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import {
  ScheduleOverviewPage,
  SCHEDULE_MONTH_LABEL,
  selectBranch,
} from '../../pages';

/**
 * The Schedule Calendar — a month × employee matrix, read-only.
 *
 * The screen has no create or edit path, so nothing here is a CRUD journey.
 * What it can get wrong is subtler and worse: it can render a grid that
 * disagrees with the data it was given. Three ways, all of them silent —
 *
 *   1. it can shade the wrong days as the weekend, because the work week is
 *      per branch and it used to read a company-wide setting (T17);
 *   2. it can render a column it never asked the server for, because the month
 *      range was built with `toISOString()` on a local midnight (T18);
 *   3. it can show an empty month when the request actually failed (T20).
 *
 * None of the three produces an error, a console warning or a visibly broken
 * page. They produce a confident, wrong answer — which is why this file asserts
 * the grid against the PAYLOAD the page received rather than against itself.
 *
 * ## The timezone trap
 *
 * `playwright.config.ts` pins `timezoneId: 'UTC'` for the browser and `TZ=UTC`
 * for the server. Under UTC the buggy and the fixed date arithmetic agree
 * exactly, so the default projects CANNOT reproduce T18 — a suite written
 * without this note would pass against a screen that hides a shift on the 31st
 * of every month. The regression block below sets its own zone, and it is the
 * single most important harness note in this phase.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** Seeded by `seed-e2e-baseline.ts` — see `SCHEDULE_MONTH` there. */
const ROSTERED = 'E2E-SCHFULL';
const FLEXIBLE = 'E2E-SCHFLEX';
const ON_LEAVE = 'E2E-SCHLEAVE';
const ON_OVERTIME = 'E2E-SCHOT';
const LAST_DAY_OF_MONTH = '2026-05-31';


/**
 * The branch the schedule baseline lives in.
 *
 * Not optional. The restored sessions in `.auth/` arrive with no branch
 * selected, and `BranchPicker` then writes `options[0]` on mount — which is
 * whichever branch sorts first, not Head Office. Every list on the screen is
 * branch-scoped, so a spec that does not say where it is looking asserts
 * against an empty grid and reports "the roster is missing" when the truth is
 * "the view is pointed somewhere else".
 */
async function pinBranch(
  page: Parameters<typeof selectBranch>[0],
  api: { get: <T>(path: string) => Promise<T> },
  code: string,
): Promise<string> {
  // `ApiClient.get` already unwraps the `{ success, data }` envelope, so this
  // receives the array itself. Written to accept either shape because reaching
  // for `.data` on an already-unwrapped list yields `undefined` silently, and
  // the failure then reads as "the branch is missing from the baseline".
  const res = await api.get<
    { id: string; code: string }[] | { data: { id: string; code: string }[] }
  >('/branches');
  const rows = Array.isArray(res) ? res : (res?.data ?? []);
  const branch = rows.find((b) => b.code === code);
  if (!branch) {
    throw new Error(
      `branch ${code} is missing from the baseline (saw: ${rows.map((b) => b.code).join(', ') || 'none'})`,
    );
  }
  await selectBranch(page, branch.id);
  return branch.id;
}

/**
 * Records every `/calendar/overview` request the page makes.
 *
 * `waitForResponse` is the wrong tool on this screen. Reaching the seeded month
 * means stepping the header, and every step fires its own request — so a waiter
 * armed before navigation resolves on an INTERMEDIATE month and the spec then
 * asserts the grid against a payload for some other month entirely.
 *
 * Deliberately records rather than filters by month: a matcher that only
 * accepted `startDate=2026-05-01` would make the T18 assertion circular, since
 * the whole defect is that the range for May did not start on the 1st. The
 * cases take the LAST request and then assert what it asked for.
 */
function recordOverviewCalls(
  page: Parameters<typeof selectBranch>[0],
): { url: string; json: () => Promise<any> }[] {
  const calls: { url: string; json: () => Promise<any> }[] = [];
  page.on('response', (res) => {
    const url = res.url();
    if (
      url.startsWith(API_URL) &&
      url.includes('/calendar/overview') &&
      res.request().method() === 'GET'
    ) {
      calls.push({ url, json: () => res.json() });
    }
  });
  return calls;
}

/**
 * The overview request behind the month currently on screen.
 *
 * Not simply the last one recorded, for two reasons.
 *
 * First, stepping the header fires a request per step and the responses do not
 * necessarily arrive in the order they were sent, so "the last response" is
 * sometimes an earlier month's. Selected instead by the END of the range, whose
 * MONTH is the displayed month under both the defective and the fixed
 * arithmetic — the defect moved the range by a day, not by a month — which
 * keeps the T18 assertions about what was requested from being circular.
 *
 * Second, it POLLS. `goToMonth` returns as soon as the header reads the month
 * asked for, which happens on the click and not on the response; its
 * `networkidle` wait is best-effort and swallows its own timeout. Reading the
 * recorded calls immediately therefore races the last fetch, and the failure
 * looks like "the month has no data" rather than "the data has not arrived".
 */
async function callForMonth(
  calls: { url: string; json: () => Promise<any> }[],
  yearMonth: string,
) {
  const endsIn = (c: { url: string }) =>
    (new URL(c.url).searchParams.get('endDate') ?? '').startsWith(yearMonth);

  await expect
    .poll(() => calls.filter(endsIn).length, {
      message: `waiting for a /calendar/overview request ending inside ${yearMonth}`,
      timeout: 15000,
    })
    .toBeGreaterThan(0);

  const matching = calls.filter(endsIn);
  return matching[matching.length - 1];
}

/** The month the baseline roster lives in, as the range parameters spell it. */
const SCHEDULE_MONTH_PREFIX = '2026-05';

test.describe('the schedule matrix, as an admin reads it', () => {
  // Per-project skip in a hook rather than at collection time: `test.info()` is
  // only bound once a test is running, and the whole file errors out if it is
  // read while the describe body is being evaluated.
  test.beforeEach(async ({ page, api }) => {
    test.skip(!isProject('admin'), 'the matrix is asserted once, as admin');
    await pinBranch(page, api, 'HO');
  });

  test('OVR-UI-01 the matrix renders the seeded month', async ({
    page,
    problems,
  }) => {
    const overview = new ScheduleOverviewPage(page);
    await overview.open();
    await overview.goToMonth(SCHEDULE_MONTH_LABEL);

    await expect(overview.row(ROSTERED)).toBeVisible();
    await expect(overview.row(FLEXIBLE)).toBeVisible();
    // 31 day columns, one per day of May.
    await expect(overview.dayHeader(1)).toBeVisible();
    await expect(overview.dayHeader(31)).toBeVisible();
    settle(problems);
  });

  test('OVR-UI-02 the grid agrees with the payload the page actually received', async ({
    page,
  }) => {
    // Matched on the API origin rather than on a path fragment: the Phase 1
    // trap was a matcher that also caught the Next.js route of the same name,
    // so the spec asserted against its own page's HTML request.
    const overview = new ScheduleOverviewPage(page);
    const calls = recordOverviewCalls(page);
    await overview.open();
    await overview.goToMonth(SCHEDULE_MONTH_LABEL);

    const body = await (
      await callForMonth(calls, SCHEDULE_MONTH_PREFIX)
    ).json();
    expect(body.data.schedules.length).toBeGreaterThan(0);

    // Every shift cell on screen has a row in the payload behind it. A grid
    // that rendered more cells than the server sent would be inventing roster.
    const cellCount = await page.getByTestId('schedule-shift-cell').count();
    expect(cellCount).toBeGreaterThan(0);
    expect(cellCount).toBeLessThanOrEqual(body.data.schedules.length);
  });

  test('OVR-UI-03 leave and overtime render as their own cell types', async ({
    page,
  }) => {
    const overview = new ScheduleOverviewPage(page);
    await overview.open();
    await overview.goToMonth(SCHEDULE_MONTH_LABEL);

    // The baseline gives one employee an approved leave (11th-13th) and another
    // approved overtime (18th). Three cell types, three different meanings.
    await expect(overview.row(ON_LEAVE)).toBeVisible();
    await expect(overview.row(ON_OVERTIME)).toBeVisible();
    await expect(
      page.getByTestId('schedule-leave-cell').first(),
    ).toBeVisible();
    await expect(
      page.getByTestId('schedule-overtime-cell').first(),
    ).toBeVisible();
  });

  test('OVR-UI-04 month navigation re-queries and the header follows', async ({
    page,
  }) => {
    const overview = new ScheduleOverviewPage(page);
    const calls = recordOverviewCalls(page);
    await overview.open();
    await overview.goToMonth(SCHEDULE_MONTH_LABEL);
    await callForMonth(calls, SCHEDULE_MONTH_PREFIX);

    await expect
      .poll(() => page.getByTestId('schedule-shift-cell').count())
      .toBeGreaterThan(0);

    await overview.nextMonth.click();
    await expect(overview.currentMonth).toHaveText('June 2026');
    // Wait for JUNE's response specifically, then for the grid to reflect it.
    // Comparing cell counts the instant the header changes races the re-render
    // and reads May's cells under June's title — which is also exactly the bug
    // this case exists to catch, so the wait has to be on the DATA arriving and
    // not on a timer.
    await callForMonth(calls, '2026-06');

    // June has none of the seeded roster, so the grid must empty out. A screen
    // that navigated the header without re-querying would keep May's cells.
    await expect
      .poll(() => page.getByTestId('schedule-shift-cell').count())
      .toBe(0);
  });

  test('OVR-UI-05 search and the department filter narrow the rows, and the counter agrees', async ({
    page,
  }) => {
    const overview = new ScheduleOverviewPage(page);
    await overview.open();
    await overview.goToMonth(SCHEDULE_MONTH_LABEL);

    await overview.search.fill('Rosa');
    await expect(overview.row(ROSTERED)).toBeVisible();
    await expect(overview.row(FLEXIBLE)).toHaveCount(0);

    // The counter is not decoration: it is the screen's own claim about how
    // many rows it is showing, and it can disagree with the grid.
    const shown = await page.locator('[data-testid^="schedule-employee-row-"]').count();
    await expect(overview.resultCount).toHaveText(String(shown));
  });

  test('OVR-UI-06 a filter matching nobody shows an honest empty state (T20)', async ({
    page,
  }) => {
    // Before the fix the screen rendered a bare header row with no body and no
    // message — indistinguishable from a month with no data, and from a failed
    // request.
    const overview = new ScheduleOverviewPage(page);
    await overview.open();
    await overview.goToMonth(SCHEDULE_MONTH_LABEL);

    await overview.search.fill('nobody-by-this-name');

    await expect(overview.empty).toBeVisible();
    await expect(
      page.locator('[data-testid^="schedule-employee-row-"]'),
    ).toHaveCount(0);
  });

  test('OVR-UI-07 a failed request shows an error, not an empty month (T20)', async ({
    page,
    problems,
  }) => {
    // The distinction the screen could not previously make. Every fetch
    // swallowed its error into `console.error` and fell back to `[]`, so a 403
    // or a 500 looked exactly like a quiet month — and the user had no way to
    // know they were reading nothing rather than reading zero.
    //
    // `renderOnly` rather than `crashesOnly`: the 500 below is INJECTED by this
    // test, so the harness seeing a 5xx on the page is the setup working, not a
    // defect. `crashesOnly` still treats a 5xx as fatal, which would fail the
    // one case whose whole subject is a 5xx.
    renderOnly(problems);
    await page.route(
      (url) => url.href.startsWith(API_URL) && url.href.includes('/calendar/overview'),
      (route) => route.fulfill({ status: 500, json: { message: 'boom' } }),
    );

    const overview = new ScheduleOverviewPage(page);
    await overview.open();

    await expect(overview.error).toBeVisible();
  });

  test('OVR-UI-08 the weekend shading follows the BRANCH, not the company (T17)', async ({
    page,
    api,
  }) => {
    // The assertion this whole finding turns on. `E2E-BR2` rests Friday and
    // Saturday; Head Office rests Saturday and Sunday. Switching the picker must
    // change WHICH columns are shaded — a screen reading the global setting
    // shades the same two either way and looks perfectly correct doing it.
    const overview = new ScheduleOverviewPage(page);

    /**
     * Which day-of-month columns the grid shades as non-working.
     *
     * Waits for the month's data first. The shading is driven by
     * `weeklyOffDays` from the RESPONSE, and while the fetch is in flight the
     * table is replaced by a spinner — so sampling immediately after
     * `goToMonth` reads zero headers and the case fails claiming that nothing
     * is shaded anywhere.
     */
    const shadedDays = async (
      calls: ReturnType<typeof recordOverviewCalls>,
    ): Promise<number[]> => {
      await callForMonth(calls, SCHEDULE_MONTH_PREFIX);
      await expect(overview.dayHeader(1)).toBeVisible();

      const attrs = await page
        .locator('[data-testid^="schedule-day-header-"]')
        .evaluateAll((nodes) =>
          nodes.map((n) => ({
            day: Number(
              (n.getAttribute('data-testid') ?? '').replace(
                'schedule-day-header-',
                '',
              ),
            ),
            weekend: n.getAttribute('data-weekend') === 'true',
          })),
        );
      return attrs.filter((a) => a.weekend).map((a) => a.day);
    };

    await pinBranch(page, api, 'HO');
    const hoCalls = recordOverviewCalls(page);
    await overview.open();
    await overview.goToMonth(SCHEDULE_MONTH_LABEL);
    const atHeadOffice = await shadedDays(hoCalls);

    await pinBranch(page, api, 'E2E-BR2');
    const br2Calls = recordOverviewCalls(page);
    await overview.open();
    await overview.goToMonth(SCHEDULE_MONTH_LABEL);
    const atBranchTwo = await shadedDays(br2Calls);

    expect(atHeadOffice.length).toBeGreaterThan(0);
    expect(atBranchTwo.length).toBeGreaterThan(0);
    // 2026-05-01 is a Friday: a rest day in E2E-BR2 (weeklyOffDays '4,5') and a
    // working day at Head Office ('0,6'). One date, two answers — which is what
    // a per-branch work week means, and what the screen could not express while
    // it read a single company-wide setting.
    expect(atHeadOffice).not.toEqual(atBranchTwo);
    expect(atBranchTwo).toContain(1);
    expect(atHeadOffice).not.toContain(1);
  });
});

test.describe('the month range, from a timezone that is not UTC (T18)', () => {
  test.use({ timezoneId: 'Asia/Kolkata' });
  test.beforeEach(async ({ page, api }) => {
    test.skip(!isProject('admin'), 'the date arithmetic is role-independent');
    await pinBranch(page, api, 'HO');
  });

  test('OVR-UI-09 a shift on the last day of the month is fetched and visible', async ({
    page,
  }) => {
    const overview = new ScheduleOverviewPage(page);
    const calls = recordOverviewCalls(page);
    await overview.open();
    await overview.goToMonth(SCHEDULE_MONTH_LABEL);

    // The request itself is the primary evidence: the range must NAME the 1st
    // and the 31st. Under the defect, at +05:30, it named 2026-04-30 to
    // 2026-05-30 — the grid drew a column for the 31st and never asked for it.
    const call = await callForMonth(calls, SCHEDULE_MONTH_PREFIX);
    const params = new URL(call.url).searchParams;
    expect(params.get('startDate')).toBe('2026-05-01');
    expect(params.get('endDate')).toBe('2026-05-31');

    // And the payload carries the row the old range would have missed.
    const body = await call.json();
    const onLastDay = body.data.schedules.filter(
      (s: { date: string }) => s.date === LAST_DAY_OF_MONTH,
    );
    expect(onLastDay.length).toBeGreaterThan(0);

    // Which the grid then renders, in the column it drew for it.
    await expect(overview.dayHeader(31)).toBeVisible();
    await expect(overview.cell(ROSTERED, LAST_DAY_OF_MONTH)).toBeVisible();
  });

  test('OVR-UI-10 the grid asks for exactly the days it draws', async ({
    page,
  }) => {
    // The general form, and the property that makes the defect impossible
    // rather than merely fixed at one end: every column rendered has to be
    // inside the range requested. Off by one in either direction and this fails.
    const overview = new ScheduleOverviewPage(page);
    const calls = recordOverviewCalls(page);
    await overview.open();
    await overview.goToMonth(SCHEDULE_MONTH_LABEL);

    const params = new URL(
      (await callForMonth(calls, SCHEDULE_MONTH_PREFIX)).url,
    ).searchParams;
    const start = params.get('startDate')!;
    const end = params.get('endDate')!;
    const days =
      (Date.parse(end) - Date.parse(start)) / (24 * 60 * 60 * 1000) + 1;

    const drawn = await page
      .locator('[data-testid^="schedule-day-header-"]')
      .count();
    expect(drawn).toBe(days);
  });
});

test.describe('who may reach the schedule screens', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager or employee', () => {
    test.beforeEach(() => {
      test.skip(
      !isProject('manager') && !isProject('employee'),
      'roles that must not reach the schedule screens',
    );
    });

    test('OVR-UI-11 a manager and an employee are refused (T24)', async ({
      page,
      problems,
    }) => {
      // The screen is `VIEW_ALL_SCHEDULES`, which resolves to ADMIN + HR_MANAGER.
      // The sidebar's own role array said `['ADMIN','MANAGER']` and was never read
      // by the filter — dead config that stated the opposite of the truth twice
      // over. `routes.ts` + `rbac.spec.ts` own the redirect assertion; this case
      // exists so the schedules module has its own record of it.
      crashesOnly(problems);
      const overview = new ScheduleOverviewPage(page);
      await overview.open();

      await expect(page).toHaveURL(/\/403|\/dashboard$/);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin or hr', () => {
    test.beforeEach(() => {
      test.skip(
      !isProject('admin') && !isProject('hr'),
      'only the roles that may reach the screen can prove the redirect',
    );
    });

    test('OVR-UI-12 /dashboard/schedules answers with the hub rather than a 404 (T23)', async ({
      page,
      problems,
    }) => {
      // The sidebar group's own `href` had no `page.tsx`. Unreachable by click —
      // a parent with children renders as a toggler — but reachable by URL and by
      // the back button, where it produced a Next 404 inside the dashboard shell.
      //
      // The first fix was a client-side redirect to the overview, and this case
      // asserted that redirect. The module-landing work then replaced it with a
      // real hub (`app/dashboard/schedules/page.tsx`), so the URL now STAYS put
      // and offers the overview as a tile — which is what
      // `navigation-hubs.admin-employee.spec.ts:137` has asserted ever since.
      // The two cases disagreed and this one was left red; it now pins the
      // behaviour that actually ships.
      crashesOnly(problems);
      const overview = new ScheduleOverviewPage(page);
      await overview.openIndex();

      await expect(page).toHaveURL(/\/dashboard\/schedules$/);
      // Still reachable in one click — the point of the original fix survives.
      await expect(
        page.locator('a[href="/dashboard/schedules/overview"]').first(),
      ).toBeVisible();
    });
  });
});
