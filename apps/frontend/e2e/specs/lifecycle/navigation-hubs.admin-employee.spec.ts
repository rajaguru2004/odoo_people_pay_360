import { test, expect, settle, crashesOnly } from '../../fixtures';
import { SidebarNav } from '../../pages';

/**
 * The sidebar's group rows, and the module hubs they now lead to.
 *
 * A group used to be a `<button>` that toggled its accordion and nothing else:
 * the hub href sat unused in the nav data, `/dashboard/schedules` 404'd when
 * typed, and the collapsed icon rail could not navigate at all — clicking an
 * icon merely prised the rail open. This file drives the two intents that now
 * share that row, from a real browser, because they are pointer behaviour and
 * a jsdom click proves less than it looks.
 *
 * The safety property is at the bottom: a hub's tiles come from the same
 * `buildMenu` output as the rail, so a hub can never offer a screen the
 * sidebar hides — otherwise we would be drawing our own links into /403.
 *
 * Read-only: nothing here writes, so it can run beside the route matrix.
 *
 * The rail cases deliberately start on a module hub rather than `/dashboard`.
 * The landing page's VisaExpiryWidget calls `/legal-documents/expiring`, which
 * answers 500 against the e2e database on a clean tree — an unrelated defect
 * that would otherwise fail every case here through `settle()`. The rail is
 * identical on every screen, so nothing is lost by standing somewhere quiet.
 */

const isProject = (name: string) => test.info().project.name === name;

/** Where the browser ended up, ignoring how it got there. */
function at(page: import('@playwright/test').Page): string {
  return new URL(page.url()).pathname;
}

async function open(page: import('@playwright/test').Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
}

/** The Payroll group's row in the rail: its label link and its chevron. */
function payrollGroup(page: import('@playwright/test').Page) {
  return {
    label: page.locator('aside a[href="/dashboard/payroll/overview"]').first(),
    chevron: page.getByRole('button', { name: /Payroll submenu/i }),
  };
}

test.describe('as admin', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the module hubs are the admin/HR navigation');
  });

  test('clicking a group label opens its hub instead of only expanding', async ({ page, problems }) => {
    await open(page, '/dashboard/workplace');

    await payrollGroup(page).label.click();
    await page.waitForURL('**/dashboard/payroll/overview');

    expect(at(page)).toBe('/dashboard/payroll/overview');
    // The hub's whole purpose: the group's children, reachable from the page.
    await expect(page.locator('a[href="/dashboard/payroll/manage"]').first()).toBeVisible();

    settle(problems, 'opening the payroll hub from the rail');
  });

  test('the chevron expands the group without navigating', async ({ page, problems }) => {
    // Two sibling controls on one row. If the chevron ever swallows the link's
    // click — or a nested button/anchor gets reintroduced — this catches it.
    await open(page, '/dashboard/workplace');
    const { chevron } = payrollGroup(page);

    await expect(chevron).toHaveAttribute('aria-expanded', 'false');
    await chevron.click();

    await expect(chevron).toHaveAttribute('aria-expanded', 'true');
    expect(at(page), 'expanding a group navigated').toBe('/dashboard/workplace');
    await expect(page.locator('aside a[href="/dashboard/payroll/manage"]')).toBeVisible();

    settle(problems, 'expanding a group in place');
  });

  test('a collapsed rail icon navigates rather than prising the rail open', async ({ page, problems }) => {
    // The win this feature is for: with breadcrumbs above and tiles on the hub,
    // a user working from the 80px rail never has to expand it.
    await open(page, '/dashboard/workplace');

    // The floating toggle on the rail's edge; title flips with its state.
    await page.locator('aside button[title="Collapse Menu"]').click();
    await expect(page.locator('aside button[title="Expand Menu"]')).toBeVisible();

    await page.locator('aside a[href="/dashboard/finance"]').first().click();
    await page.waitForURL('**/dashboard/finance');

    expect(at(page)).toBe('/dashboard/finance');
    // Still collapsed — navigating did not force the rail open.
    await expect(page.locator('aside button[title="Expand Menu"]')).toBeVisible();

    settle(problems, 'navigating from the collapsed rail');
  });

  test('every screen carries a breadcrumb trail above its content', async ({ page, problems }) => {
    // Derived from the nav tree, so a page that declares nothing still gets
    // one. It sits in the page body, not the header — the header carries the
    // page title and its description and has no room for a third line.
    await open(page, '/dashboard/payroll/manage');

    const trail = page.locator('main nav[aria-label="Breadcrumb"]').first();
    await expect(trail).toBeVisible();
    await expect(page.locator('header nav[aria-label="Breadcrumb"]')).toHaveCount(0);
    // The title and description keep the header to themselves. The heading is
    // the page's own declared title ("Payroll Management"), which is a
    // different string from the nav label the crumb uses — both are correct,
    // and the header is not where the trail lives.
    await expect(page.locator('header h1')).toHaveText(/Payroll Management/i);
    await expect(trail.getByText('Payroll', { exact: true })).toBeVisible();
    await expect(trail.getByText('Run Payroll', { exact: true })).toBeVisible();
    // Rooted at the module, so nothing in the trail leads to the main dashboard.
    await expect(trail.locator('a[href="/dashboard"]')).toHaveCount(0);

    // The section crumb is the way back up to the hub.
    await trail.locator('a[href="/dashboard/payroll/overview"]').click();
    await page.waitForURL('**/dashboard/payroll/overview');
    expect(at(page)).toBe('/dashboard/payroll/overview');

    settle(problems, 'the derived breadcrumb trail');
  });

  test('a hub tile reaches the screen it names', async ({ page, problems }) => {
    await open(page, '/dashboard/workplace');

    await page.locator('main a[href="/dashboard/assets"]').first().click();
    await page.waitForURL('**/dashboard/assets');

    expect(at(page)).toBe('/dashboard/assets');
    settle(problems, 'following a hub tile');
  });

  test('the schedules hub answers where a 404 used to be', async ({ page, problems }) => {
    // This URL is the Schedules group's href. Nothing linked to it, so typing
    // it or coming back to it after a redirect hit Next's "page not found".
    await open(page, '/dashboard/schedules');

    expect(at(page)).toBe('/dashboard/schedules');
    await expect(page.locator('a[href="/dashboard/schedules/overview"]').first()).toBeVisible();

    settle(problems, 'the schedules hub');
  });

  test('a hub offers nothing the rail withholds', async ({ page, problems }) => {
    // Both are built from navConfig; this is the assertion that keeps them
    // from drifting apart and handing the user a link into /403.
    await open(page, '/dashboard/payroll/overview');

    const railHrefs = await new SidebarNav(page).links();
    const tileHrefs = await page
      .locator('section a[href^="/dashboard"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));

    expect(tileHrefs.length, 'the hub rendered no tiles at all').toBeGreaterThan(0);
    for (const href of tileHrefs) {
      expect(railHrefs, `the hub offered ${href}, which the sidebar does not`).toContain(href);
    }

    settle(problems, 'hub tiles against the rail');
  });
});

test.describe('as employee', () => {
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the denial path');
  });

  test('an employee typing a hub URL is refused', async ({ page, problems }) => {
    await open(page, '/dashboard/people');

    expect(at(page), 'an employee reached an admin module hub').toBe('/403');

    // The guard runs inside the page, so its own fetches go out and are
    // correctly refused before the redirect lands; only a crash is fatal here.
    crashesOnly(problems);
    settle(problems, 'refusing an employee a module hub');
  });

  test('the self-service rail still navigates on a group click', async ({ page, problems }) => {
    // Employees get no hubs — their groups already point at their primary
    // screen, so the same row behaviour must simply take them there.
    await open(page, '/dashboard');

    await page.locator('aside a[href="/dashboard/my-attendance"]').first().click();
    await page.waitForURL('**/dashboard/my-attendance');

    expect(at(page)).toBe('/dashboard/my-attendance');
    settle(problems, 'an employee group row');
  });
});
