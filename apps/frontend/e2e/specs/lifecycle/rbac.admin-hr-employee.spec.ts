import { test, expect, settle, crashesOnly } from '../../fixtures';
import { SidebarNav } from '../../pages';

/**
 * Role separation, driven through the browser.
 *
 * The route matrix already visits every screen as every role, but it judges a
 * page in isolation. This file asserts the things that only make sense as a
 * comparison between roles — what the navigation offers, and whether a denial
 * actually lands somewhere sensible.
 *
 * Every case here is a regression test for a defect this suite found:
 *
 *   - `<ProtectedRoute>` with no props checked authentication only, so any
 *     employee reached the all-employees leave list.
 *
 * Read-only: nothing here writes, so it can run beside the matrix.
 *
 * The denial cases judge CRASHES only, not console output. `<ProtectedRoute>`
 * is placed INSIDE each page component rather than wrapped around it, so the
 * page's own data-fetching effects run before the guard's redirect takes
 * effect — the request goes out and is correctly refused with a 403, which the
 * screen logs. Harmless (the server is the authority) but it means a denied
 * navigation is never console-silent. Worth knowing; not worth restructuring
 * fifty pages over.
 */

const isProject = (name: string) => test.info().project.name === name;

/** Where the browser ended up, ignoring how it got there. */
async function landOn(page: import('@playwright/test').Page, path: string): Promise<string> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  return new URL(page.url()).pathname;
}

test.describe('the leave list is gated by permission, not merely by login', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the denial only happens for an employee');
    });

    test('an employee is turned away from the all-employees list', async ({ page, problems }) => {
      // `<ProtectedRoute>` with no requiredPermission is an authentication check,
      // so this screen — and the pending-approvals queue below — used to be open
      // to everybody who could log in.
      const landed = await landOn(page, '/dashboard/leaves');

      expect(landed, 'an employee reached the all-employees leave list').toBe('/403');
      crashesOnly(problems);
      settle(problems, 'denying an employee the leave list');
    });

    test('an employee is turned away from the pending-approvals queue', async ({ page, problems }) => {
      const landed = await landOn(page, '/dashboard/leaves/pending');

      expect(landed).toBe('/403');
      crashesOnly(problems);
      settle(problems, 'denying an employee the approvals queue');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the ESS side of the same screen');
    });

    test('an employee can still open their OWN leave request', async ({ page, problems }) => {
      // Deliberately NOT gated: /dashboard/my-leaves routes employees to
      // /dashboard/leaves/[id] to read their own request. Gating the detail page
      // by VIEW_ALL_LEAVES would have broken self-service, which is why the fix
      // stopped at the two list screens.
      await page.goto('/dashboard/my-leaves', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      const rows = page.locator('[data-testid="my-leave-row"]');
      test.skip((await rows.count()) === 0, 'no leave request seeded for this employee');

      const id = await rows.first().getAttribute('data-leave-id');
      const landed = await landOn(page, `/dashboard/leaves/${id}`);

      expect(landed, 'an employee was denied their own leave request').not.toBe('/403');
      settle(problems, 'an employee reading their own leave request');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'the allowed side of the same guard');
    });

    test('HR still reaches the leave list', async ({ page, problems }) => {
      const landed = await landOn(page, '/dashboard/leaves');

      expect(landed).toBe('/dashboard/leaves');
      settle(problems, 'HR opening the leave list');
    });
  });
});

test.describe('navigation offers only what the role may use', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'employee navigation');
    });

    test('an employee is offered no administrative destination', async ({ page, problems }) => {
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      const nav = new SidebarNav(page);
      const links = await nav.links();

      // Offering a link a role cannot use is not merely untidy: it produces a
      // 403 the user cannot act on, and hides the screens that do work.
      for (const forbidden of [
        '/dashboard/employees',
        '/dashboard/payroll/manage',
        '/dashboard/branches',
        '/dashboard/audit-logs',
        // The module hubs. A group header is a link now, so the admin menu's
        // group rows appear in this list at all — an employee's must not.
        '/dashboard/people',
        '/dashboard/organization',
        '/dashboard/system',
      ]) {
        expect(links, `the employee menu offered ${forbidden}`).not.toContain(forbidden);
      }

      settle(problems, 'the employee navigation');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin navigation');
    });

    test('an admin is offered the administrative destinations', async ({ page, problems }) => {
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      const nav = new SidebarNav(page);
      const links = await nav.links();

      expect(links).toContain('/dashboard/employees');
      settle(problems, 'the admin navigation');
    });
  });
});
