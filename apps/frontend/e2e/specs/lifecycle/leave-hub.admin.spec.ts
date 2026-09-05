import { test, expect, settle } from '../../fixtures';
import { captureHub, captureTab } from './hub-screens';

/**
 * The Leave & Overtime hub, driven from a real browser.
 *
 * The page used to be five KPIs and two meter lists with no period selector at
 * all — its overtime card was permanently the current calendar month whatever
 * else was on screen, because the endpoint behind it took a month and nothing
 * else. It now follows the `/dashboard/time` template.
 *
 * The case that matters most here is the KPI row **changing meaning** with the
 * period: a week wants "leave days", a year wants utilisation, because 4,180
 * employee-days is not a number anybody can hold. And Pending approvals must
 * NOT move with the window — a queue is what is waiting now.
 *
 * Read-only: nothing here writes, so it can run beside the route matrix.
 */

const HUB = '/dashboard/leave';

function watchHub(page: import('@playwright/test').Page): URL[] {
  const seen: URL[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/leave-requests/hub-summary')) seen.push(new URL(r.url()));
  });
  return seen;
}

async function open(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(HUB, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await expect(page.getByTestId('period-label')).not.toBeEmpty();
}

/** The five KPI labels, in row order. */
async function kpiLabels(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .locator('a.stat-card')
    .evaluateAll((els) =>
      els.map((e) => e.querySelector('.text-text-body')?.textContent?.trim() ?? ''),
    );
}

test.describe('as admin', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'admin', 'the hub is admin/HR navigation');
  });

  test('opens on the month, the cycle leave and overtime are read in', async ({
    page,
    problems,
  }) => {
    const calls = watchHub(page);
    await open(page);

    expect(calls.length, 'the hub never asked the server for anything').toBeGreaterThan(0);
    expect(calls[0].searchParams.get('period')).toBe('month');
    // One request, not the three the old page fanned out to.
    expect(calls.length).toBeLessThanOrEqual(2);

    settle(problems, 'the Leave hub opening on the month');
  });

  test('the KPI row changes MEANING with the period, not just its numbers', async ({
    page,
    problems,
  }) => {
    await open(page);

    const month = await kpiLabels(page);
    expect(month).toHaveLength(5);
    expect(month[0]).toMatch(/Requests this month/i);
    expect(month[2]).toMatch(/utilisation/i);

    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect.poll(async () => (await kpiLabels(page))[0]).toMatch(/Requests this week/i);
    const week = await kpiLabels(page);
    // A week is operational: who is off today, how many days went, hours worked.
    expect(week[2]).toMatch(/On leave today/i);
    expect(week[3]).toMatch(/Leave days/i);

    await page.getByRole('button', { name: 'Year', exact: true }).click();
    await expect.poll(async () => (await kpiLabels(page))[0]).toMatch(/Leave consumed/i);
    const year = await kpiLabels(page);
    // A year's headline is utilisation, not a day count nobody can hold.
    expect(year[2]).toMatch(/utilisation/i);
    expect(year.join('|')).not.toMatch(/Requests this/i);

    settle(problems, 'the Leave KPI row following the period');
  });

  test('the pending queue stays put whatever the period says', async ({
    page,
    problems,
  }) => {
    // A queue is what is waiting NOW. "Approvals pending last March" is not
    // something anybody acts on, so this one card never follows the selector.
    await open(page);

    const card = page.locator('a.stat-card[href="/dashboard/leaves/pending"]').first();
    await expect(card).toContainText(/Pending approvals/i);
    const before = await card.innerText();

    for (const period of ['Week', 'Year', 'Month']) {
      await page.getByRole('button', { name: period, exact: true }).click();
      await page.waitForLoadState('networkidle').catch(() => {});
      await expect(card).toContainText(/Pending approvals/i);
      expect(await card.innerText(), `${period} moved the pending queue`).toBe(before);
    }

    settle(problems, 'the pending queue against the period selector');
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

    expect(calls[calls.length - 1].searchParams.get('anchor')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expect(page.getByRole('button', { name: /current/i })).toBeVisible();

    settle(problems, 'paging the Leave window');
  });

  test('the trend agrees with the payload the page actually received', async ({
    page,
    problems,
  }) => {
    // Asserted against the RESPONSE rather than against a fixture, for the same
    // reason `time-schedule-overview.spec.ts` OVR-UI-02 does: this database is
    // shared with every other suite, so "there are bands" is a hostage to
    // whatever leave anybody else seeded. What must hold is that every non-zero
    // status in the payload is drawn, and nothing else is.
    let payload: any = null;
    page.on('response', async (r) => {
      if (!r.url().includes('/leave-requests/hub-summary')) return;
      payload = await r.json().catch(() => null);
    });

    await open(page);
    // The year is the window most likely to hold anything at all; either way
    // the assertion is against whatever came back for it.
    await page.getByRole('button', { name: 'Year', exact: true }).click();
    await expect.poll(async () => page.getByTestId('period-label').innerText()).toMatch(/^\d{4}$/);
    await page.waitForLoadState('networkidle').catch(() => {});

    expect(payload, 'the hub never answered').not.toBeNull();
    const trend = payload.data.trend as Array<Record<string, number>>;

    const drawn = await page
      .locator('[title*=": "]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));

    const LABELS = {
      approved: 'Approved',
      pending: 'Pending',
      rejected: 'Rejected',
      cancelled: 'Cancelled',
    } as const;

    for (const bucket of trend) {
      for (const [key, label] of Object.entries(LABELS)) {
        const value = bucket[key] ?? 0;
        if (value > 0) {
          // Cancelled included — the endpoint this replaced counted only three
          // statuses, so a cancelled request vanished from the chart entirely.
          expect(
            drawn,
            `${label} ${value} was in the payload but not drawn`,
          ).toContain(`${label}: ${value}`);
        }
      }
    }

    // ...and nothing was drawn that the payload does not contain.
    for (const title of drawn.filter((t) => /^(Approved|Pending|Rejected|Cancelled): /.test(t))) {
      const [label, raw] = title.split(': ');
      const key = Object.entries(LABELS).find(([, l]) => l === label)![0];
      expect(
        trend.some((b) => (b[key] ?? 0) === Number(raw)),
        `a "${title}" band matches no bucket in the payload`,
      ).toBe(true);
    }

    settle(problems, 'the stacked leave trend against its payload');
  });

  test('never claims a rate above 100%', async ({ page, problems }) => {
    await open(page);

    for (const period of ['Week', 'Month', 'Year']) {
      await page.getByRole('button', { name: period, exact: true }).click();
      await page.waitForLoadState('networkidle').catch(() => {});
      const text = await page.locator('main').innerText();
      const rates = [...text.matchAll(/(\d{1,3}(?:\.\d)?)%/g)].map((m) => Number(m[1]));
      const over = rates.filter((r) => r > 100);
      expect(over, `${period} reported a rate above 100%`).toEqual([]);
    }

    settle(problems, 'leave rates staying inside 100%');
  });

  test('offers no Add new button, and an Export that produces a file', async ({
    page,
    problems,
  }) => {
    await open(page);

    await expect(page.getByRole('button', { name: /^add new$/i })).toHaveCount(0);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /export/i }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^leave-overtime-(week|month|year|today)-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/,
    );

    settle(problems, 'exporting the Leave period');
  });

  test('every KPI card drills into the screen behind it', async ({ page, problems }) => {
    await open(page);

    const hrefs = await page
      .locator('a.stat-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));

    expect(hrefs.length, 'the hub rendered no KPI cards').toBe(5);
    for (const href of hrefs) {
      expect(href, 'a KPI card led nowhere').toMatch(
        /^\/dashboard\/(leaves|overtime)/,
      );
    }

    settle(problems, 'the Leave KPI cards as links');
  });

  test('carries the whole template — strip, charts, panels and tiles', async ({
    page,
    problems,
  }) => {
    await open(page);

    await expect(page.locator('a.stat-card')).toHaveCount(5);

    // Scoped to `main`: the sidebar carries "Leave Balances" and "Leave
    // Requests" of its own, so a page-wide text lookup is ambiguous by design
    // rather than by accident.
    const main = page.locator('main');
    await expect(main.getByText('Needs attention')).toBeVisible();
    for (const panel of [
      'Leave requests',
      'Leave type',
      'Request status',
      'Leave balance',
    ]) {
      await expect(
        main.getByText(panel, { exact: true }).first(),
        `the "${panel}" panel is missing`,
      ).toBeVisible();
    }
    // Either the overtime panel or its stand-in, depending on the kill switch.
    await expect(
      main
        .getByText('Overtime', { exact: true })
        .or(main.getByText('Approval rate', { exact: true }))
        .first(),
    ).toBeVisible();

    // By href, not by name: the sidebar carries the same links as the tiles, so
    // a role+name lookup is ambiguous by design.
    for (const href of ['/dashboard/leaves', '/dashboard/leaves/pending', '/dashboard/leaves/balances']) {
      await expect(page.locator(`a[href="${href}"]`).first()).toBeVisible();
    }

    settle(problems, 'the Leave hub layout');
  });

  // ──────────────────────────────────────────────────────────────────────────
  test('capture: the Leave hub, tab by tab', async ({ page }) => {
    await open(page);
    await captureHub(page, 'leave-hub-month');
    await captureTab(page, 'Week', 'leave-hub-week');
    await captureTab(page, 'Year', 'leave-hub-year');
  });
});
