import { test, expect, settle } from '../../fixtures';
import { captureScreens } from '../../screens';

/**
 * The Talent hub, driven from a real browser.
 *
 * The page this replaces counted rewards and disciplinary actions in the
 * BROWSER, over one page of each list, and rendered a panel telling the reader
 * so. These cases pin that the panel is gone because the numbers became real —
 * not because the admission was deleted.
 *
 * Read-only.
 */

const HUB = '/dashboard/talent';

function watchHub(page: import('@playwright/test').Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/talent/hub-summary')) seen.push(r.url());
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

  test('asks the server once, and never lists rewards or disciplines', async ({
    page,
    problems,
  }) => {
    const listed: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      // The two API lists the old hub paged through in the browser to count.
      //
      // `/dashboard/` is excluded deliberately. Two KPI cards link to
      // `/dashboard/rewards` and `/dashboard/disciplines`, `StatCard` wraps each
      // card in a `<Link>`, and Next PREFETCHES every in-viewport link — so a
      // bare path match flags the router's own RSC request and reports a
      // fan-out that is not happening. The cards linking there is the point of
      // the cards.
      if (/\/(rewards|disciplines)(\?|$)/.test(u) && !u.includes('/dashboard/')) {
        listed.push(u);
      }
    });
    const calls = watchHub(page);
    await open(page);

    expect(calls.length, 'the hub never asked the server for anything').toBeGreaterThan(0);
    expect(listed, 'the hub is still paging a list to count it').toEqual([]);

    settle(problems, 'the talent hub aggregate');
  });

  test('no longer admits its own numbers are browser counts', async ({ page, problems }) => {
    await open(page);

    const body = await page.locator('main').innerText();
    expect(body, 'the counted-in-the-browser disclaimer is still on the page').not.toMatch(
      /counted in the browser/i,
    );

    settle(problems, 'the removed disclaimer');
  });

  test('leads with five cards, each linking somewhere', async ({ page, problems }) => {
    await open(page);

    const hrefs = await page
      .locator('a.stat-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(hrefs.length, 'the KPI row is not five cards').toBe(5);
    for (const h of [
      '/dashboard/appraisal',
      '/dashboard/training',
      '/dashboard/grievances',
      '/dashboard/rewards',
      '/dashboard/disciplines',
    ]) {
      expect(hrefs, `no KPI card opens ${h}`).toContain(h);
    }

    settle(problems, 'the talent KPI row');
  });

  test('calls the fifth card actions, not open cases', async ({ page, problems }) => {
    // `Discipline` has no status, no openedAt and no closedAt. "Active cases"
    // is not a question this schema can answer, and the card must not imply it
    // can.
    await open(page);

    const body = await page.locator('main').innerText();
    expect(body).toContain('Disciplinary actions');
    expect(body).toContain('there is no case to close');
    expect(body, 'the hub is claiming a discipline case lifecycle').not.toMatch(
      /active (discipline|disciplinary) case/i,
    );

    settle(problems, 'the discipline wording');
  });

  test('never prints a 0% appraisal rate when there is nothing to measure', async ({
    page,
    problems,
  }) => {
    await open(page);

    const card = page.locator('a.stat-card').first();
    const text = (await card.innerText()).trim();
    // Either a run exists and the rate is real, or the card says so and shows
    // an em dash. `0.0%` beside "No appraisal run yet" would be a claim that
    // nobody has been appraised, which is a different sentence.
    if (/No appraisal run yet|not resolved its scope/i.test(text)) {
      expect(text, 'an unknown appraisal rate is rendering as 0%').toContain('—');
    }

    settle(problems, 'the appraisal completion rate');
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

  test('carries no headcount figure — that is Organization’s job', async ({ page, problems }) => {
    await open(page);

    const body = await page.locator('main').innerText();
    for (const forbidden of ['Total employees', 'Active headcount', 'Share of workforce']) {
      expect(body, `the talent hub is drawing "${forbidden}"`).not.toContain(forbidden);
    }

    settle(problems, 'the talent/organization separation');
  });

  test('no rate ever exceeds 100%', async ({ page, problems }) => {
    await open(page);

    const text = await page.locator('main').innerText();
    const rates = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
    for (const r of rates) {
      expect(r, `a completion rate of ${r}% is more than everybody`).toBeLessThanOrEqual(100);
    }

    settle(problems, 'the talent rate arithmetic');
  });

  test('the visual pass', async ({ page, problems }) => {
    await open(page);
    await captureScreens(page, 'talent-hub');

    settle(problems, 'the talent hub screenshot pass');
  });
});
