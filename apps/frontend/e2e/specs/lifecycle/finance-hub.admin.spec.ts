import { test, expect, settle } from '../../fixtures';
import { captureScreens } from '../../screens';

/**
 * The Finance hub, driven from a real browser.
 *
 * Rebuilt in Phase G onto the finalised Time & Attendance template, and moved
 * off five browser-side requests onto one aggregate. The case worth reading is
 * the arrears one: the page this replaces read `overdueAmount`/`daysOverdue`
 * off the overdue report, and the server sends `amountDue`/`overdueDays` — so
 * the Overdue figure rendered a formatted **zero** and every aging pill said
 * "overdue by 0 days". Nothing failed; the page just quietly lied.
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

  test('leads with five cards, each linking somewhere', async ({ page, problems }) => {
    await open(page);

    const hrefs = await page
      .locator('a.stat-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(hrefs.length, 'the KPI row is not five cards').toBe(5);
    for (const h of [
      '/dashboard/reimbursements',
      '/dashboard/travel',
      '/dashboard/advance-loans/reports',
      '/dashboard/budgets',
    ]) {
      expect(hrefs, `no KPI card opens ${h}`).toContain(h);
    }

    settle(problems, 'the finance KPI row');
  });

  test('says out loud that travel is per diem only', async ({ page, problems }) => {
    // There is no travel-actuals column, no expense table and no trip
    // settlement step in this schema. A card labelled "travel spend" with no
    // qualifier would be claiming something the data cannot support.
    await open(page);

    const body = await page.locator('main').innerText();
    expect(body).toContain('Travel spend (per diem)');
    expect(body).toContain('flights and hotels come in as claims');

    settle(problems, 'the travel qualifier');
  });

  test('never prints an arrears row at zero days', async ({ page, problems }) => {
    // The exact defect this rebuild closes. If the page ever reads a field the
    // server does not send again, every overdue row collapses to 0 and this
    // fails.
    await open(page);

    const body = await page.locator('main').innerText();
    expect(body, 'an arrears row is reporting 0 days overdue').not.toMatch(/\b0\s*d(ays)?\s*overdue/i);

    settle(problems, 'the arrears field names');
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
    // Payroll owns cost by department, and `budget-actuals` deliberately
    // subtracts reimbursement out of the payroll figure so the two are never
    // added together — two hubs drawing both is how that guard gets undone.
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
