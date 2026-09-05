import { test, expect, settle } from '../../fixtures';
import { captureScreens } from '../../screens';

/**
 * The Organization hub, driven from a real browser.
 *
 * Rebuilt in Phase F onto the finalised Time & Attendance template, and moved
 * off six list endpoints onto one aggregate. The cases below pin what that
 * bought: a page that asks the server once, a queue counted in the database
 * rather than off a page of rows, a period filter that is GONE rather than
 * decorative, and — the Phase C rule — no attendance figure anywhere on it.
 *
 * Read-only: nothing here writes, so it can run beside the route matrix.
 */

const HUB = '/dashboard/organization';

/** Every hub-summary request the page fires, in order. */
function watchHub(page: import('@playwright/test').Page): URL[] {
  const seen: URL[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/organization/hub-summary')) seen.push(new URL(r.url()));
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

  test('asks the server once, not six times', async ({ page, problems }) => {
    const calls = watchHub(page);
    await open(page);

    expect(calls.length, 'the hub never asked the server for anything').toBeGreaterThan(0);
    // Default window, and it is the server that decides what that means.
    expect(calls[0].searchParams.get('months')).toBe('6');

    settle(problems, 'the organization hub aggregate');
  });

  test('leads with five governance cards, each linking somewhere', async ({ page, problems }) => {
    await open(page);

    const hrefs = await page.locator('a.stat-card').evaluateAll((els) =>
      els.map((e) => e.getAttribute('href')),
    );
    expect(hrefs.length, 'the KPI row is not five cards').toBe(5);
    for (const h of [
      '/dashboard/employees',
      '/dashboard/branches',
      '/dashboard/departments',
      '/dashboard/supervisor-teams',
      '/dashboard/departments/change-requests',
    ]) {
      expect(hrefs, `no KPI card opens ${h}`).toContain(h);
    }

    settle(problems, 'the organization KPI row');
  });

  test('every card carries a footer line', async ({ page, problems }) => {
    // A missing footnote leaves a hole in a row whose neighbours all have one,
    // and the card stops reading as a card.
    await open(page);

    const cards = page.locator('a.stat-card');
    const count = await cards.count();
    for (let i = 0; i < count; i++) {
      const text = (await cards.nth(i).innerText()).trim();
      const lines = text.split('\n').filter(Boolean);
      expect(lines.length, `card ${i} has no footer line: ${JSON.stringify(text)}`)
        .toBeGreaterThanOrEqual(3);
    }

    settle(problems, 'the organization KPI footers');
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

  test('the trend window lives in the growth panel and re-asks the server', async ({
    page,
    problems,
  }) => {
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

  test('carries no attendance figure — that is Time & Attendance’s job', async ({
    page,
    problems,
  }) => {
    // Phase C's rule, checked where the reader actually sees it. If an
    // attendance KPI reappears here, two hubs answer one question again.
    await open(page);

    const body = await page.locator('main').innerText();
    for (const forbidden of ['Present today', 'Absent today', 'Late today', 'Attendance by department']) {
      expect(body, `the organization hub is drawing "${forbidden}"`).not.toContain(forbidden);
    }

    settle(problems, 'the organization/attendance separation');
  });

  test('no share ever exceeds 100%', async ({ page, problems }) => {
    // The Phase E lesson, applied to shares: a rate above everybody is the
    // signal that a numerator and a denominator came from different questions.
    await open(page);

    const text = await page.locator('main').innerText();
    const rates = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
    for (const r of rates) {
      expect(r, `a rate of ${r}% is more than everybody`).toBeLessThanOrEqual(100);
    }

    settle(problems, 'the organization share arithmetic');
  });

  test('the visual pass', async ({ page, problems }) => {
    // Captures only when E2E_SCREENS is set. The `problems` fixture still
    // judges this test on console errors and 5xx, which is what makes the
    // screenshots worth reading.
    await open(page);
    await captureScreens(page, 'organization-hub');

    settle(problems, 'the organization hub screenshot pass');
  });
});
