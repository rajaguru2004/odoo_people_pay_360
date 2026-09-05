import { test, expect, crashesOnly, renderOnly, settle } from '../fixtures';
import { ROUTES, Role, usableBy } from '../routes';

/**
 * Every route, every role.
 *
 * This is the suite that answers the question the whole effort started from:
 * "the backend tests passed, so why did a frontend change break an unrelated
 * screen?" It does not know what any screen is supposed to do. It opens each
 * one as each role and lets the failure fixture judge — an uncaught render
 * error, a console error, a 5xx, a dead request. A shared component that throws
 * is caught on every screen it touches, without a single assertion naming it.
 *
 * The assertions are deliberately shallow. Depth is the journey specs' job;
 * breadth is this one's, and breadth is what a manual checklist is worst at.
 *
 * It runs once per role project, so `test.info().project.name` is the role.
 */

/** The project name is the role, by construction of playwright.config.ts. */
function currentRole(): Role {
  return test.info().project.name as Role;
}

/** A Next.js error overlay or the framework's own crash page. */
async function assertNotAnErrorPage(page: import('@playwright/test').Page, path: string) {
  const body = (await page.locator('body').innerText().catch(() => '')) ?? '';

  // Next renders these verbatim when a route throws or is missing.
  for (const marker of ['Application error: a client-side exception', 'This page could not be found', 'Internal Server Error']) {
    expect(body, `${path} rendered Next's "${marker}" page`).not.toContain(marker);
  }
}

test.describe('route matrix', () => {
  // Read-only: nothing here writes, so the pages can be visited in one context
  // without interfering with each other.
  test.describe.configure({ mode: 'default' });

  for (const route of ROUTES) {
    test(`${route.path} renders or denies cleanly`, async ({ page, problems }) => {
      const role = currentRole();
      if (route.skip?.includes(role)) test.skip();

      const allowed = route.allowed.includes(role);

      // A defect that is recorded rather than hidden. `test.fail()` expects the
      // failure, so the suite is green while the bug stands — and goes red the
      // moment it is fixed, which is what makes the entry get removed.
      if (route.knownBroken?.roles.includes(role)) {
        test.fail(true, route.knownBroken.issue);
      }

      // The feature behind the screen is switched off in this environment, so
      // its 5xx is by design. Only a thrown render is still a failure.
      if (route.featureDisabled) renderOnly(problems);

      // A screen this role cannot USE will log that it could not load its data,
      // because the API correctly answered 403. That is the system working, so
      // only crashes are fatal there. For a screen the role is meant to use,
      // every console error still counts.
      //
      // `usableBy` rather than `allowed` on purpose: where the client guard is
      // weaker than the server — the auth-only leave screens, the unguarded
      // team screens — the role gets in but still cannot load anything.
      if (!usableBy(route).includes(role)) crashesOnly(problems);

      await page.goto(route.path, { waitUntil: 'domcontentloaded' });
      // The dashboard shell decides auth client-side, so give it a tick to
      // either render, redirect, or bounce to /403.
      await page.waitForLoadState('networkidle').catch(() => {});

      const landed = new URL(page.url()).pathname;

      // Nobody should ever be thrown back to the login page — every project
      // carries a valid session.
      expect(landed, `${route.path} bounced ${role} to login; the session did not survive`).not.toBe('/login');

      if (route.guarded && !allowed) {
        // A guarded route the role lacks must redirect to the 403 screen.
        expect(landed, `${route.path} let ${role} through; expected a redirect to /403`).toBe('/403');
      } else if (route.guarded && allowed) {
        expect(landed, `${route.path} denied ${role}, who should be allowed`).not.toBe('/403');
      }

      await assertNotAnErrorPage(page, route.path);

      // Something has to be on the screen. A silently empty body is the exact
      // shape of the failure this suite exists to catch.
      const text = await page.locator('body').innerText();
      expect(text.trim().length, `${route.path} rendered an empty page for ${role}`).toBeGreaterThan(0);

      // Judge the page here rather than at teardown: by this point it has
      // rendered and been asserted on, and anything arriving later is noise
      // from a request the test no longer cares about.
      settle(problems, route.path);
    });
  }
});

// The table's own consistency is pure data and needs no browser, so it is
// asserted in the unit project instead — see e2e/routes.test.ts. Running it
// here would repeat it once per role project for no added signal.
