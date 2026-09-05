import { test, expect, settle } from '../../fixtures';
import { captureScreens } from '../../screens';

/**
 * The People hub, driven from a real browser.
 *
 * Rebuilt in Phase F onto the finalised Time & Attendance template. The hub
 * owns the employee LIFECYCLE — deadlines and movements — and two Phase C rules
 * are checked here where the reader actually sees them: no headcount-by-
 * department chart (that is Organization's), and no who-is-in-today figure
 * (that is Time & Attendance's).
 *
 * Permits stay on their own requests on purpose, so a 403 from the visa module
 * quietens two cards instead of blanking the page. That separation is pinned by
 * the component suite; here we only check the page survives the real one.
 *
 * Read-only: nothing here writes, so it can run beside the route matrix.
 */

const HUB = '/dashboard/people';

function watchHub(page: import('@playwright/test').Page): URL[] {
  const seen: URL[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/employees/hub-summary')) seen.push(new URL(r.url()));
  });
  return seen;
}

async function open(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(HUB, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await expect(page.locator('a.stat-card').first()).toBeVisible();
}

test.describe('as admin', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'admin', 'the hub is admin/HR navigation');
  });

  test('reads the lifecycle from one aggregate', async ({ page, problems }) => {
    const calls = watchHub(page);
    await open(page);

    expect(calls.length, 'the hub never asked the server for anything').toBeGreaterThan(0);
    expect(calls[0].searchParams.get('months')).toBe('6');
    // Not swallowed by `@Get(':id')` — a 404 here means the route order slipped.
    const res = await page.request.get(
      new URL('/employees/hub-summary', page.url()).toString(),
    ).catch(() => null);
    if (res) expect(res.status()).not.toBe(404);

    settle(problems, 'the people hub aggregate');
  });

  test('leads with five lifecycle cards, each linking somewhere', async ({ page, problems }) => {
    await open(page);

    const hrefs = await page.locator('a.stat-card').evaluateAll((els) =>
      els.map((e) => e.getAttribute('href')),
    );
    expect(hrefs.length, 'the KPI row is not five cards').toBe(5);
    for (const h of [
      '/dashboard/employees',
      '/dashboard/contracts',
      '/dashboard/contracts/terminations',
      '/dashboard/approvals',
    ]) {
      expect(hrefs, `no KPI card opens ${h}`).toContain(h);
    }

    settle(problems, 'the people KPI row');
  });

  test('every card carries a footer line', async ({ page, problems }) => {
    await open(page);

    const cards = page.locator('a.stat-card');
    const count = await cards.count();
    for (let i = 0; i < count; i++) {
      const text = (await cards.nth(i).innerText()).trim();
      const lines = text.split('\n').filter(Boolean);
      expect(lines.length, `card ${i} has no footer line: ${JSON.stringify(text)}`)
        .toBeGreaterThanOrEqual(3);
    }

    settle(problems, 'the people KPI footers');
  });

  test('draws no period filter — the header is gone, not decorative', async ({
    page,
    problems,
  }) => {
    await open(page);

    await expect(page.getByTestId('period-label')).toHaveCount(0);
    for (const label of ['Today', 'Years']) {
      await expect(
        page.getByRole('button', { name: label, exact: true }),
        `a dead ${label} tab is still rendered`,
      ).toHaveCount(0);
    }

    settle(problems, 'the removed period filter');
  });

  test('the trend window lives in the chart it moves', async ({ page, problems }) => {
    const calls = watchHub(page);
    await open(page);

    await page.getByRole('button', { name: '12M', exact: true }).click();
    await expect
      .poll(() => calls.some((c) => c.searchParams.get('months') === '12'), {
        message: 'switching to 12M never re-queried the server',
      })
      .toBe(true);

    settle(problems, 'the 6M/12M switch');
  });

  test('draws no headcount distribution and no who-is-in-today figure', async ({
    page,
    problems,
  }) => {
    await open(page);

    const body = await page.locator('main').innerText();
    for (const forbidden of [
      'Where people sit',
      'Department workforce',
      'On leave today',
      'Present today',
    ]) {
      expect(body, `the people hub is drawing "${forbidden}"`).not.toContain(forbidden);
    }

    settle(problems, 'the people hub boundaries');
  });

  test('states the identity its trend chart draws', async ({ page, problems }) => {
    // A line that could be a stock or a flow is two different charts until it
    // says which one it is.
    await open(page);
    await expect(page.getByText('Ending headcount = starting + joiners − leavers')).toBeVisible();

    settle(problems, 'the workforce trend hint');
  });

  test('no rate ever exceeds 100%', async ({ page, problems }) => {
    await open(page);

    const text = await page.locator('main').innerText();
    const rates = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
    for (const r of rates) {
      expect(r, `a rate of ${r}% is more than everybody`).toBeLessThanOrEqual(100);
    }

    settle(problems, 'the people hub rate arithmetic');
  });

  test('the visual pass', async ({ page, problems }) => {
    await open(page);
    await captureScreens(page, 'people-hub');

    settle(problems, 'the people hub screenshot pass');
  });
});
