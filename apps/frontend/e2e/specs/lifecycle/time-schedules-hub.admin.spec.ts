import { test, expect, settle } from '../../fixtures';
import { captureHub, captureTab } from './hub-screens';

/**
 * The Schedules hub, driven from a real browser.
 *
 * The page used to be four KPIs and two chip strips over a hard-coded
 * Monday–Sunday window with no way to move it. It now follows the same template
 * as `/dashboard/time` — five KPIs, a Week/Month/Year selector with ‹ › arrows,
 * a stacked coverage chart, a shift ranking, three insight panels and an action
 * strip — and every case below is a property that would otherwise let it report
 * a confident wrong answer.
 *
 * The selector opens on **Week**: a scheduler opens this page asking whether
 * the coming week is covered, not how 2026 went.
 *
 * Read-only: nothing here writes, so it can run beside the route matrix.
 *
 * It also captures the page. See `hub-screens.ts` for why a passing run still
 * needs images.
 */

const HUB = '/dashboard/schedules';
const REFERENCE = '/dashboard/time';

/** Every hub-summary request the page fires, in order. */
function watchHub(page: import('@playwright/test').Page): URL[] {
  const seen: URL[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/calendar/hub-summary')) seen.push(new URL(r.url()));
  });
  return seen;
}

async function open(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(HUB, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await expect(page.getByTestId('period-label')).not.toBeEmpty();
}

test.describe('as admin', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'admin', 'the hub is admin/HR navigation');
  });

  test('draws the roster from the server rather than from a fixed week', async ({
    page,
    problems,
  }) => {
    const calls = watchHub(page);
    await open(page);

    expect(calls.length, 'the hub never asked the server for anything').toBeGreaterThan(0);
    // Opens on the week: "is the coming week covered" is the question this
    // page is opened with.
    expect(calls[0].searchParams.get('period')).toBe('week');
    // The old page passed a startDate/endDate it computed itself. What a week
    // means depends on the branch working week, which only the server knows.
    expect(calls[0].searchParams.get('startDate')).toBeNull();

    settle(problems, 'the Schedules hub opening on the week');
  });

  test('the period tabs re-ask the server, and the label follows', async ({
    page,
    problems,
  }) => {
    const calls = watchHub(page);
    await open(page);

    const weekLabel = await page.getByTestId('period-label').innerText();

    await page.getByRole('button', { name: 'Month', exact: true }).click();
    await expect
      .poll(async () => page.getByTestId('period-label').innerText())
      .not.toBe(weekLabel);
    expect(calls[calls.length - 1].searchParams.get('period')).toBe('month');

    await page.getByRole('button', { name: 'Year', exact: true }).click();
    await expect.poll(async () => calls[calls.length - 1].searchParams.get('period')).toBe('year');
    // A year is labelled by the server too, so the client never guesses.
    await expect(page.getByTestId('period-label')).toHaveText(/^\d{4}$/);

    settle(problems, 'the Schedules period selector');
  });

  test('pages backwards with the anchor the server handed back', async ({
    page,
    problems,
  }) => {
    const calls = watchHub(page);
    await open(page);

    const before = await page.getByTestId('period-label').innerText();
    await page.getByRole('button', { name: /previous/i }).click();
    await expect
      .poll(async () => page.getByTestId('period-label').innerText())
      .not.toBe(before);

    const anchor = calls[calls.length - 1].searchParams.get('anchor');
    // Not "seven days ago" computed in the browser — the server's prevAnchor.
    expect(anchor, 'paging sent no anchor').toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // ...and the reset appears only once the reader is off the current window.
    await expect(page.getByRole('button', { name: /current/i })).toBeVisible();

    settle(problems, 'paging the Schedules window');
  });

  test('the coverage chart is stacked from real numbers, not painted on', async ({
    page,
    problems,
  }) => {
    await open(page);

    // Each band carries a `title` of "<label>: <value>" — the numbers the
    // server sent, not a fixed 32% decorative cap.
    const bands = page.locator('[title^="Scheduled: "], [title^="Unassigned: "]');
    await expect.poll(async () => bands.count()).toBeGreaterThan(0);

    const titles = await bands.evaluateAll((els) =>
      els.map((e) => e.getAttribute('title') ?? ''),
    );
    for (const t of titles) {
      const value = Number(t.split(': ')[1]);
      expect(Number.isFinite(value), `band "${t}" carried no number`).toBe(true);
      // A zero band is dropped rather than drawn, so anything present is real.
      expect(value).toBeGreaterThan(0);
    }

    settle(problems, 'the stacked coverage chart');
  });

  test('never claims more than 100% coverage', async ({ page, problems }) => {
    // The bug this pins: the calendar is per BRANCH, so a day one branch rests
    // and another works counts only the open branch in `expected` — while the
    // roster is company-wide. Dividing one by the other reported 150%.
    await open(page);

    for (const period of ['Week', 'Month', 'Year']) {
      await page.getByRole('button', { name: period, exact: true }).click();
      await page.waitForLoadState('networkidle').catch(() => {});
      const text = await page.locator('main').innerText();
      const rates = [...text.matchAll(/(\d{1,3}(?:\.\d)?)%/g)].map((m) => Number(m[1]));
      const over = rates.filter((r) => r > 100);
      expect(over, `${period} reported a rate above 100%`).toEqual([]);
    }

    settle(problems, 'coverage rates staying inside 100%');
  });

  test('offers no Add new button, and an Export that produces a file', async ({
    page,
    problems,
  }) => {
    await open(page);

    // Nothing is created from this hub.
    await expect(page.getByRole('button', { name: /^add new$/i })).toHaveCount(0);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /export/i }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^schedules-(week|month|year|today)-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/,
    );

    settle(problems, 'exporting the Schedules period');
  });

  test('every KPI card drills into the screen behind it', async ({ page, problems }) => {
    await open(page);

    const hrefs = await page
      .locator('a.stat-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));

    // Five, matching the template. Past that the numbers stop being a glance.
    expect(hrefs.length, 'the hub rendered no KPI cards').toBe(5);
    for (const href of hrefs) {
      expect(href, 'a KPI card led nowhere').toMatch(/^\/dashboard\/schedules/);
    }

    settle(problems, 'the Schedules KPI cards as links');
  });

  test('carries the whole template — strip, charts, panels and tiles', async ({
    page,
    problems,
  }) => {
    await open(page);

    // The layout is the deliverable: five KPIs, an action strip, a main chart
    // with a ranking beside it, three panels below, then the Go to tiles.
    await expect(page.locator('a.stat-card')).toHaveCount(5);
    await expect(page.getByText('Needs attention')).toBeVisible();
    await expect(page.getByText('Schedule coverage')).toBeVisible();
    await expect(page.getByText('Shift distribution')).toBeVisible();
    await expect(page.getByText('Roster status')).toBeVisible();
    await expect(page.getByText('Staff on shift')).toBeVisible();
    await expect(page.getByText('Department coverage')).toBeVisible();
    // `.first()` because the sidebar carries the same two links as the tiles —
    // which is the point of `ModuleNavTiles` building from the same navConfig.
    await expect(
      page.locator('a[href="/dashboard/schedules/overview"]').first(),
    ).toBeVisible();
    await expect(
      page.locator('a[href="/dashboard/schedules/shifts"]').first(),
    ).toBeVisible();

    settle(problems, 'the Schedules hub layout');
  });

  // ──────────────────────────────────────────────────────────────────────────
  test('capture: the reference hub and the Schedules hub, tab by tab', async ({
    page,
  }) => {
    // Not an assertion — a record. See `hub-screens.ts`: a passing run proves
    // the numbers, and proves nothing at all about whether the panels line up.
    await page.goto(REFERENCE, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('period-label')).not.toBeEmpty();
    await captureHub(page, 'reference-time-hub');

    await open(page);
    await captureHub(page, 'schedules-hub-week');
    await captureTab(page, 'Month', 'schedules-hub-month');
    await captureTab(page, 'Year', 'schedules-hub-year');
  });
});
