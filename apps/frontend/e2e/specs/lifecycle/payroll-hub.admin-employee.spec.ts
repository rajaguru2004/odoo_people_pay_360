import { test, expect, settle, renderOnly } from '../../fixtures';
import { captureHub } from './hub-screens';

/**
 * The Payroll hub, driven from a real browser.
 *
 * Rebuilt in Phase G onto the finalised Time & Attendance template, and moved
 * off seven browser-side requests onto one aggregate. The cases below pin what
 * that bought: a page that asks the server once, an open-run count that comes
 * from the database rather than off a twenty-row list, a KPI row that is always
 * five cards wide whatever the feature flags say, and — the rule this whole
 * hub turns on — money that only ever comes from LOCKED runs.
 *
 * Read-only: nothing here writes, so it can run beside the route matrix.
 */

const HUB = '/dashboard/payroll/overview';

/** Every hub-summary request the page fires, in order. */
function watchHub(page: import('@playwright/test').Page): URL[] {
  const seen: URL[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/payrolls/hub-summary')) seen.push(new URL(r.url()));
  });
  return seen;
}

/** The old fan-out. If any of these come back, the rebuild has regressed. */
function watchLegacy(page: import('@playwright/test').Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/payrolls/reports/')) seen.push(new URL(r.url()).pathname);
  });
  return seen;
}

async function open(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(HUB, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  // The KPI row is the last thing to settle, so waiting on it means the whole
  // page has data rather than skeletons.
  await expect(page.locator('a.stat-card').first()).toBeVisible();
}

test.describe('as admin', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'admin', 'the hub is admin/HR navigation');
  });

  test('asks the server once, and never through the old report endpoints', async ({
    page,
    problems,
  }) => {
    const calls = watchHub(page);
    const legacy = watchLegacy(page);
    await open(page);

    expect(calls.length, 'the hub never asked the server for anything').toBeGreaterThan(0);
    expect(calls[0].searchParams.get('months')).toBe('6');
    // Five of the seven old requests were `/payrolls/reports/*`, each of which
    // loads every payroll item and every payslip line for a period.
    expect(legacy, 'the hub fell back to the report endpoints').toEqual([]);

    settle(problems, 'the payroll hub aggregate');
  });

  test('leads with exactly five cards, each linking somewhere', async ({ page, problems }) => {
    await open(page);

    const cards = page.locator('a.stat-card');
    // The old hub pushed Settlements and Gratuity in behind a feature flag, so
    // the row was four to six wide and the grid changed shape under the reader.
    await expect(cards).toHaveCount(5);

    const hrefs = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    for (const href of hrefs) expect(href).toMatch(/^\/dashboard\//);

    settle(problems, 'the payroll KPI row');
  });

  test('carries no period filter in the header — the window lives on the chart', async ({
    page,
    problems,
  }) => {
    await open(page);

    // Today/Week/Month/Year is Time & Attendance's control. This hub reports on
    // a period the SERVER resolves, and says which one it landed on.
    for (const dead of ['Today', 'Week', 'Year', 'Years']) {
      await expect(
        page.getByRole('button', { name: dead, exact: true }),
        `${dead} tab should not exist on the payroll hub`,
      ).toHaveCount(0);
    }
    // The only control is the trend window, and it sits on the panel it moves.
    await expect(page.getByRole('button', { name: '6M', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '12M', exact: true })).toBeVisible();

    settle(problems, 'the payroll hub header');
  });

  test('the trend window re-queries, and the approval queue does not follow it', async ({
    page,
    problems,
  }) => {
    const calls = watchHub(page);
    await open(page);

    // The queue moved onto the Run pipeline panel — the panel that is about
    // runs — when the KPI row was rebuilt around the money. It is still
    // unwindowed, and that is what this case has always been about.
    const queue = page.locator('[data-testid^="payroll-queue-"]');
    const before = (await queue.count())
      ? (await queue.first().innerText()).replace(/\s+/g, ' ')
      : 'empty';

    await page.getByRole('button', { name: '12M', exact: true }).click();
    await expect
      .poll(() => calls.some((c) => c.searchParams.get('months') === '12'), {
        timeout: 15_000,
      })
      .toBe(true);
    await page.waitForLoadState('networkidle').catch(() => {});

    // A queue is what is waiting NOW: an open run older than the chart's window
    // is exactly the one somebody needs to be told about.
    const after = (await queue.count())
      ? (await queue.first().innerText()).replace(/\s+/g, ' ')
      : 'empty';
    expect(after, 'the approval queue moved with the chart window').toBe(before);

    settle(problems, 'the payroll trend window');
  });

  test('the KPI row answers cost, take-home, statutory, coverage and readiness', async ({
    page,
    problems,
  }) => {
    await open(page);

    const cards = page.locator('a.stat-card');
    await expect(cards).toHaveCount(5);
    // Gross and the statutory line were nowhere on this hub: it reported what
    // people took home and never what the run cost or what the regulator took.
    await expect(cards.filter({ hasText: /^Gross payroll/ })).toHaveCount(1);
    await expect(cards.filter({ hasText: /^Net paid/ })).toHaveCount(1);
    await expect(cards.filter({ hasText: /contributions/ })).toHaveCount(1);
    await expect(cards.filter({ hasText: 'Total employees' })).toHaveCount(1);
    await expect(cards.filter({ hasText: 'Ready to pay' })).toHaveCount(1);

    settle(problems, 'the payroll KPI subjects');
  });

  test('every exception on the page is a link to the screen that clears it', async ({
    page,
    problems,
  }) => {
    await open(page);

    // The rule this pins: a figure that names a problem must not be a dead end.
    // Readiness meters, the coverage names and the run queue all drill.
    const drillables = page.locator(
      '[data-testid^="payroll-queue-"], [data-testid="coverage-missing-employee"], [data-testid^="compliance-link-"]',
    );
    const count = await drillables.count();
    for (let i = 0; i < count; i++) {
      await expect(drillables.nth(i)).toHaveAttribute('href', /^\/dashboard\//);
    }

    settle(problems, 'the payroll drill-through');
  });

  test('money is only ever reported for locked runs', async ({ page, problems }) => {
    await open(page);

    const net = page.locator('a.stat-card').filter({ hasText: /^Net paid/ });
    await expect(net).toHaveCount(1);
    const text = (await net.innerText()).replace(/\s+/g, ' ');

    // Either a real amount for a finalised period, or an explicit "not
    // finalised" — never a confident zero standing in for unfinished work.
    const finalised = /Locked runs in/.test(text);
    if (finalised) {
      expect(text, 'a finalised period printed no amount').toMatch(/[0-9]/);
    } else {
      expect(text).toMatch(/No locked run in .+ yet/);
      expect(text).toContain('—');
    }

    settle(problems, 'the payroll money card');
  });

  test('names the period it resolved to, rather than leaving the reader guessing', async ({
    page,
    problems,
  }) => {
    await open(page);
    // Runs are generated after a month ends, so the hub anchors on the newest
    // month that actually holds one — and has to say which.
    await expect(page.getByText(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\b/).first())
      .toBeVisible();
    settle(problems, 'the payroll reporting period');
  });

  test('draws the whole template: strip, chart, breakdown, three panels, tiles', async ({
    page,
    problems,
  }) => {
    await open(page);

    await expect(page.getByText('Needs attention')).toBeVisible();
    await expect(page.getByText('Payroll paid')).toBeVisible();
    await expect(page.getByText('Run pipeline')).toBeVisible();
    await expect(page.getByText('Processing coverage')).toBeVisible();
    await expect(page.getByText('Payment readiness')).toBeVisible();
    await expect(page.getByText('Where the money goes')).toBeVisible();
    // The Go-to tiles come from navConfig, so a tile can never offer a route
    // the rail withholds.
    await expect(page.getByRole('heading', { name: 'Go to' })).toBeVisible();

    settle(problems, 'the payroll hub template');
  });

  test('readiness never prints a rate it could not compute', async ({ page, problems }) => {
    await open(page);

    const card = page.locator('a.stat-card').filter({ hasText: 'Ready to pay' });
    const text = (await card.innerText()).replace(/\s+/g, ' ');

    // A branch with no banking country has no required fields, so everybody
    // would validate as ready. That is a fabricated all-clear, and the card
    // must show an em dash instead.
    if (/No banking country configured/.test(text)) {
      expect(text, 'an unknown readiness printed a percentage').toContain('—');
      expect(text).not.toMatch(/\d+%/);
    } else {
      expect(text).toMatch(/(\d+%|—)/);
    }

    settle(problems, 'the payroll readiness card');
  });

  test('a failed aggregate shows dashes and refuses to say all-clear', async ({
    page,
    problems,
  }) => {
    // The 500 below is the POINT of this case, so the strict guard would fail
    // on the very thing being tested. `renderOnly` still holds the claim that
    // matters: the page must survive it rather than throwing.
    renderOnly(problems);

    // The quiet failure this whole hub is built against: an aggregate that did
    // not load rendering as a confident zero.
    await page.route('**/payrolls/hub-summary*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    );

    await page.goto(HUB, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.locator('a.stat-card').first()).toBeVisible();

    const cards = page.locator('a.stat-card');
    await expect(cards).toHaveCount(5);
    for (let i = 0; i < 5; i++) {
      await expect(cards.nth(i)).toContainText('—');
    }

    await expect(page.getByText('Payroll is on track — nothing is waiting.')).toHaveCount(0);
    await expect(page.getByText(/could not be read/i).first()).toBeVisible();
  });

  test('captures the hub for the screenshot pass', async ({ page }) => {
    await open(page);
    await captureHub(page, 'payroll-hub');
  });
});

test.describe('who may reach it', () => {
  test('an employee is refused the payroll hub', async ({ page }) => {
    test.skip(test.info().project.name !== 'employee', 'the denial path is the employee project');

    await page.goto(HUB, { waitUntil: 'domcontentloaded' });
    // ProtectedRoute sends a role that may not read this to /403 rather than
    // rendering an empty hub, which would look like "payroll is empty".
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
      .not.toBe(HUB);
  });
});
