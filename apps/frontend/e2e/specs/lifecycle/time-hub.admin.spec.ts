import { test, expect, settle } from '../../fixtures';

/**
 * The Time & Attendance hub, driven from a real browser.
 *
 * The page used to be a template with numbers painted on: the trend chart was
 * ten hard-coded bars labelled "Jan 1 … Jan 10", the second insight card read
 * "+5.2% vs yesterday" whatever the data said, the third drew a fixed pair of
 * curves, and the Week/Month/Years tabs were wired to a `useState` nothing
 * read. Every case below is one of those, now answered by the server.
 *
 * The selector opens on **Today** and every KPI card follows it, changing label
 * with the period — a count under "Present today", a rate under "Attendance".
 *
 * Read-only: nothing here writes, so it can run beside the route matrix.
 */

const HUB = '/dashboard/time';

/** Every hub-summary request the page fires, in order. */
function watchHub(page: import('@playwright/test').Page): URL[] {
  const seen: URL[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/attendances/hub-summary')) seen.push(new URL(r.url()));
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

  test('draws the chart from the server rather than from hard-coded days', async ({
    page,
    problems,
  }) => {
    const calls = watchHub(page);
    await open(page);

    expect(calls.length, 'the hub never asked the server for anything').toBeGreaterThan(0);
    // Opens on today: "who is in" is the question this page is opened with.
    expect(calls[0].searchParams.get('period')).toBe('today');

    // A day draws its arrival curve, so switch to a window that draws days —
    // and wait for the label to actually change, not merely for the network to
    // go quiet, which it can do before the click has been handled at all.
    const dayLabel = await page.getByTestId('period-label').innerText();
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    await expect
      .poll(async () => page.getByTestId('period-label').innerText())
      .not.toBe(dayLabel);

    // The old chart's labels were literally "Jan 1".."Jan 10" in the source.
    const labels = await page
      .locator('main')
      .getByText(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}$/)
      .allInnerTexts();
    expect(labels.length, 'the trend chart drew no day labels').toBeGreaterThan(0);
    // Whatever month the seed database sits in, ten consecutive January days is
    // the fingerprint of the placeholder.
    expect(labels.slice(0, 10).join(',')).not.toBe(
      'Jan 1,Jan 2,Jan 3,Jan 4,Jan 5,Jan 6,Jan 7,Jan 8,Jan 9,Jan 10',
    );

    settle(problems, 'the attendance trend chart');
  });

  test('the period tabs re-ask the server, and the label follows', async ({ page, problems }) => {
    const calls = watchHub(page);
    await open(page);

    // Opens on Today, whose label is a single date.
    const dayLabel = await page.getByTestId('period-label').innerText();
    expect(calls[0].searchParams.get('period')).toBe('today');

    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect
      .poll(() => calls.some((u) => u.searchParams.get('period') === 'week'))
      .toBe(true);
    await expect
      .poll(async () => page.getByTestId('period-label').innerText())
      .not.toBe(dayLabel);

    await page.getByRole('button', { name: 'Year', exact: true }).click();
    await expect
      .poll(() => calls.some((u) => u.searchParams.get('period') === 'year'))
      .toBe(true);
    // A year label is just the year.
    await expect(page.getByTestId('period-label')).toHaveText(/^\d{4}$/);

    settle(problems, 'switching the reporting period');
  });

  test('pages backwards with the anchor the server handed back', async ({ page, problems }) => {
    const calls = watchHub(page);
    await open(page);

    const before = await page.getByTestId('period-label').innerText();
    // Nothing ahead of the current period, so forward is refused.
    await expect(page.getByRole('button', { name: 'Next period' })).toBeDisabled();

    await page.getByRole('button', { name: 'Previous period' }).click();
    await expect
      .poll(() => calls.some((u) => u.searchParams.get('anchor')))
      .toBe(true);
    await expect
      .poll(async () => page.getByTestId('period-label').innerText())
      .not.toBe(before);

    // Off the current period, forward opens up and a way back appears.
    await expect(page.getByRole('button', { name: 'Next period' })).toBeEnabled();
    // Named for what it does, so it cannot collide with the "Today" tab.
    await page.getByRole('button', { name: 'Back to the current period' }).click();
    await expect(page.getByTestId('period-label')).toHaveText(before);

    settle(problems, 'paging the reporting period');
  });

  test('the KPI cards follow the period, and change label with it', async ({
    page,
    problems,
  }) => {
    await open(page);

    const presentCard = page.locator('a.stat-card[href="/dashboard/attendance"]').first();
    // Today: a count, labelled as today's.
    await expect(presentCard).toContainText(/Present today/i);
    const dayText = await presentCard.innerText();

    await page.getByRole('button', { name: 'Month', exact: true }).click();
    await page.waitForLoadState('networkidle').catch(() => {});

    // Month: a RATE, under a label that says so. A month's "present" is a count
    // of employee-DAYS — several hundred — and printing that under "Present
    // today" would be a lie the reader cannot see.
    await expect(presentCard).toContainText(/Attendance/i);
    await expect(presentCard).not.toContainText(/Present today/i);
    await expect(presentCard).toContainText(/%/);
    expect(await presentCard.innerText()).not.toBe(dayText);

    // And back again.
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(presentCard).toContainText(/Present today/i);

    settle(problems, 'the KPI cards against the period selector');
  });

  test('the correction queue stays live whatever the period says', async ({
    page,
    problems,
  }) => {
    // A queue is what is waiting NOW. "Corrections raised last March" is not
    // something anybody acts on, so this one card never follows the selector.
    await open(page);

    const card = page.locator('a.stat-card[href="/dashboard/attendance/corrections"]').first();
    await expect(card).toContainText(/Corrections waiting/i);
    const before = await card.innerText();

    await page.getByRole('button', { name: 'Year', exact: true }).click();
    await page.waitForLoadState('networkidle').catch(() => {});

    await expect(card).toContainText(/Corrections waiting/i);
    expect(await card.innerText()).toBe(before);

    settle(problems, 'the correction queue against the period selector');
  });

  test('offers no Add new button, and an Export that produces a file', async ({
    page,
    problems,
  }) => {
    await open(page);

    // Nothing is created from this hub, so the button that did nothing is gone.
    await expect(page.getByRole('button', { name: /^add new$/i })).toHaveCount(0);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /export/i }).click(),
    ]);
    // A single day exports as a dated file; a window carries its range.
    expect(download.suggestedFilename()).toMatch(
      /^attendance-(\d{4}-\d{2}-\d{2}|(week|month|year)-.*)\.csv$/,
    );

    settle(problems, 'exporting the period');
  });

  test('never claims more attendance than there were people', async ({ page, problems }) => {
    // The bug this pins: expectation came from the branch calendar alone, so a
    // holiday people actually worked produced "106% of expected days worked".
    await open(page);

    for (const period of ['Today', 'Week', 'Month', 'Year']) {
      await page.getByRole('button', { name: period, exact: true }).click();
      await page.waitForLoadState('networkidle').catch(() => {});
      const text = await page.locator('main').innerText();
      const rates = [...text.matchAll(/(\d{1,3}(?:\.\d)?)%/g)].map((m) => Number(m[1]));
      const over = rates.filter((r) => r > 100);
      expect(over, `${period} reported a rate above 100%`).toEqual([]);
    }

    settle(problems, 'attendance rates staying inside 100%');
  });

  test('every KPI card drills into the screen behind it', async ({ page, problems }) => {
    await open(page);

    const hrefs = await page
      .locator('a.stat-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));

    expect(hrefs.length, 'the hub rendered no KPI cards').toBe(5);
    for (const href of hrefs) {
      expect(href, 'a KPI card led nowhere').toMatch(/^\/dashboard\//);
    }

    settle(problems, 'the KPI cards as links');
  });
});
