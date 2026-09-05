import { test, expect, settle } from '../../fixtures';
import { captureScreens } from '../../screens';

/**
 * The Workplace hub, driven from a real browser.
 *
 * Two rules pull in opposite directions here, and both are checked. A FAILED
 * read renders an em dash, because a zero would be a claim. An EMPTY result
 * renders its real value — "no project is overdue" is true — but it must ship
 * beside how many projects carry no end date, or a zero reads as full coverage
 * rather than as no coverage.
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

  test('leads with five cards, each linking somewhere', async ({ page, problems }) => {
    await open(page);

    const hrefs = await page
      .locator('a.stat-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(hrefs.length, 'the KPI row is not five cards').toBe(5);
    for (const h of ['/dashboard/assets', '/dashboard/letters', '/dashboard/projects']) {
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

  test('draws all five project statuses', async ({ page, problems }) => {
    // `/projects/stats` returns four and drops PLANNING and CANCELLED, which is
    // why the old mix bar could not add up to the total printed beside it.
    await open(page);

    const body = await page.locator('main').innerText();
    expect(body).toContain('Project health');

    // The property that matters is that the panel ADDS UP. The old bar read
    // four statuses out of five, so its segments could not reconcile with the
    // total printed on the KPI card beside it — PLANNING and CANCELLED projects
    // simply vanished.
    //
    // Asserting that the word "Planning" appears would be asserting about the
    // seed, not the page: a status with no rows is correctly left out of the
    // legend, and the e2e baseline happens to hold two projects, both ACTIVE.
    const panel = page.locator('div').filter({ hasText: /^Project health/ }).last();
    const legend = await panel.innerText();
    const counts = [...legend.matchAll(/\n(\d+)\s+\d+%/g)].map((m) => Number(m[1]));
    const totalCard = await page.locator('a.stat-card', { hasText: 'Active projects' }).innerText();
    const total = Number(totalCard.match(/Of (\d+) not archived/)?.[1] ?? '0');
    if (counts.length && total > 0) {
      const summed = counts.reduce((a, n) => a + n, 0);
      expect(summed, 'the project mix does not add up to the project total').toBe(total);
    }

    settle(problems, 'the project status coverage');
  });

  test('ships overdue projects beside how many have no end date', async ({ page, problems }) => {
    await open(page);

    const cards = page.locator('a.stat-card');
    const count = await cards.count();
    let overdueCard = '';
    for (let i = 0; i < count; i++) {
      const text = await cards.nth(i).innerText();
      if (text.includes('Projects overdue')) overdueCard = text;
    }
    expect(overdueCard, 'there is no projects-overdue card').not.toBe('');
    // Either it names how many projects have no end date, or it says how many
    // are due soon. A bare number with no coverage line is the misleading case.
    expect(overdueCard, 'the overdue card says nothing about coverage').toMatch(
      /no end date|due in 30 days/i,
    );

    settle(problems, 'the overdue-project coverage line');
  });

  test('says that project figures do not narrow with the branch', async ({ page, problems }) => {
    // Assets and letters are branch-scoped; `Project` deliberately is not. The
    // asymmetry is disclosed rather than left for the reader to assume.
    await open(page);

    const body = await page.locator('main').innerText();
    expect(body).toContain('do not narrow with the branch selector');

    settle(problems, 'the branch-scope disclosure');
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
