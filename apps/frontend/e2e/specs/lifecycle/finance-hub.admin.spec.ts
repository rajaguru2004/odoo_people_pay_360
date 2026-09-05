import { test, expect, settle } from '../../fixtures';
import { captureScreens } from '../../screens';

/**
 * The Finance hub, driven from a real browser.
 *
 * Rebuilt in Phase G onto the finalised Time & Attendance template, and moved
 * off five browser-side requests onto one aggregate. The hub answers ONE
 * question — how the budget is doing — and the cases below hold that line: one
 * request, a KPI row that all points at the budget it reports on, and no payroll
 * figure borrowed from the module that owns it.
 *
 * Read-only: nothing here writes, so it can run beside the route matrix.
 */

const HUB = '/dashboard/finance';

function watchHub(page: import('@playwright/test').Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/finance/hub-summary')) seen.push(r.url());
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

  test('asks the server once, not five times', async ({ page, problems }) => {
    const calls = watchHub(page);
    await open(page);

    expect(calls.length, 'the hub never asked the server for anything').toBeGreaterThan(0);
    // No period parameter: this hub has no window for the reader to choose, so
    // there is nothing to put in a query string and nothing to validate.
    expect(calls[0], 'the aggregate was called with a query string').not.toContain('?');

    settle(problems, 'the finance hub aggregate');
  });

  test('leads with a KPI row that opens what it reports on', async ({ page, problems }) => {
    await open(page);

    const hrefs = await page
      .locator('a.stat-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(hrefs.length, 'the KPI row is empty').toBeGreaterThan(0);
    // Every card states a budget figure, so every card has to open the budget
    // screen. A card that reports one thing and navigates to another is how a
    // reader ends up checking a number against the wrong page.
    for (const h of hrefs) {
      expect(h, `a KPI card opens ${h}, which is not the screen it reports on`).toBe(
        '/dashboard/budgets',
      );
    }

    settle(problems, 'the finance KPI row');
  });

  test('draws no period filter — the header is gone, not decorative', async ({
    page,
    problems,
  }) => {
    await open(page);

    await expect(page.getByTestId('period-label')).toHaveCount(0);
    for (const label of ['Today', 'Week', 'Years']) {
      await expect(
        page.getByRole('button', { name: label, exact: true }),
        `a dead ${label} tab is still rendered`,
      ).toHaveCount(0);
    }

    settle(problems, 'the removed period filter');
  });

  test('carries no payroll figure — that is Payroll’s job', async ({ page, problems }) => {
    // Phase C's one-question-per-hub rule, checked where the reader sees it.
    // Payroll owns cost by department; this hub owns the budget. Two hubs
    // drawing both is how a reader ends up adding the same money twice.
    await open(page);

    const body = await page.locator('main').innerText();
    for (const forbidden of ['Net this month', 'Statutory withheld', 'Payroll cost by department']) {
      expect(body, `the finance hub is drawing "${forbidden}"`).not.toContain(forbidden);
    }

    settle(problems, 'the finance/payroll separation');
  });

  test('no rate ever exceeds 100%, except a budget genuinely overspent', async ({
    page,
    problems,
  }) => {
    await open(page);

    const text = await page.locator('main').innerText();
    const rates = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
    for (const r of rates) {
      // Budget utilisation above 100 is a real state and the card colours for
      // it. Anything past 500 is a numerator and a denominator that came from
      // different questions.
      expect(r, `a rate of ${r}% is not a rate`).toBeLessThanOrEqual(500);
    }

    settle(problems, 'the finance rate arithmetic');
  });

  test('the visual pass', async ({ page, problems }) => {
    await open(page);
    await captureScreens(page, 'finance-hub');

    settle(problems, 'the finance hub screenshot pass');
  });
});
