import { test, expect, settle } from '../../fixtures';
import { captureScreens } from '../../screens';

/**
 * The Workplace hub, driven from a real browser.
 *
 * A FAILED read renders an em dash, because a zero would be a claim.
 *
 * Read-only.
 */

const HUB = '/dashboard/workplace';

function watchHub(page: import('@playwright/test').Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/workplace/hub-summary')) seen.push(r.url());
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

  test('asks the server once, not four times', async ({ page, problems }) => {
    const calls = watchHub(page);
    await open(page);

    expect(calls.length, 'the hub never asked the server for anything').toBeGreaterThan(0);

    settle(problems, 'the workplace hub aggregate');
  });

  test('leads with cards, each linking somewhere', async ({ page, problems }) => {
    await open(page);

    const hrefs = await page
      .locator('a.stat-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(hrefs.length, 'the KPI row rendered no cards').toBeGreaterThan(0);
    for (const h of ['/dashboard/assets', '/dashboard/letters']) {
      expect(hrefs, `no KPI card opens ${h}`).toContain(h);
    }

    settle(problems, 'the workplace KPI row');
  });

  test('itemises the composite attention card', async ({ page, problems }) => {
    // A composite of three signals is only readable if the card shows which
    // one produced the number.
    await open(page);

    const body = await page.locator('main').innerText();
    expect(body).toContain('Assets needing attention');
    // `[\s\S]` rather than `.` with the `s` flag: this project's tsconfig
    // targets below es2018, where `s` is a compile error.
    expect(body, 'the composite card does not say what is in it').toMatch(
      /in repair[\s\S]*lost[\s\S]*out of warranty/,
    );

    settle(problems, 'the asset attention composite');
  });

  test('never claims an asset is overdue for return', async ({ page, problems }) => {
    // `AssetAssignment` has no `returnDueDate`. There is no due date to miss,
    // so nothing on this page may say there is one.
    await open(page);

    const body = await page.locator('main').innerText();
    expect(body, 'the hub is inventing an asset return deadline').not.toMatch(
      /overdue (for )?return|return overdue|past due for return/i,
    );

    settle(problems, 'the absent return deadline');
  });

  test('says that rejection turnaround is not measurable', async ({ page, problems }) => {
    // `LetterRequest` has `rejectedReason` but no `rejectedAt`.
    await open(page);

    const body = await page.locator('main').innerText();
    expect(body).toContain('rejections carry no decision date');

    settle(problems, 'the turnaround caveat');
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

  test('the visual pass', async ({ page, problems }) => {
    await open(page);
    await captureScreens(page, 'workplace-hub');

    settle(problems, 'the workplace hub screenshot pass');
  });
});
