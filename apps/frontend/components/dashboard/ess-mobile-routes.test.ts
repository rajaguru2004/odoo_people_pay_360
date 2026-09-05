import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Every route the ESS phone UI points at must exist.
 *
 * This test has now caught the same defect twice, in two different files, which
 * is the whole argument for it being broad rather than component-shaped:
 *
 *  1. `MobileTabBar`'s Payslip tab pushed `/dashboard/my-payroll` — at the time
 *     a segment holding only `[id]/` and `gratuity/`, with no `page.tsx` of its
 *     own. A quarter of the bottom bar answered 404 (D-01).
 *  2. The dashboard's **Salary** quick action pushed the same dead route. The
 *     first version of this file only read `MobileTabBar.tsx`, so it passed
 *     while a tile on the home screen 404'd (D-17). A user found it.
 *
 * No other layer can see this. `routerMock.push` records any string a component
 * hands it; the browser audit only opens the routes a spec names; and the route
 * matrix is generated from `e2e/routes.ts`, which is a hand-written table that
 * never listed `/dashboard/my-payroll` because no page was ever there. The
 * filesystem is the oracle, because the filesystem is what the App Router
 * routes from.
 *
 * Read out of the SOURCE rather than by importing the modules: these are client
 * components pulling in next/navigation and next-intl, and this belongs in the
 * fast node project rather than behind a jsdom provider tree.
 */

const FRONTEND = join(__dirname, '..', '..');
const APP = join(FRONTEND, 'app');

/** Add a file here when it starts navigating. */
const GOVERNED = [
  'components/dashboard/MobileTabBar.tsx',
  'components/dashboard/EmployeeDashboardMobile.tsx',
];

const source = (rel: string) => readFileSync(join(FRONTEND, rel), 'utf8');

/**
 * `/dashboard/...` literals, static ones only.
 *
 * A template literal (`` `/dashboard/leaves/${id}` ``) is checked separately:
 * its interpolation is a record id, so what must exist is a dynamic segment,
 * not a page at that literal path.
 */
function staticRoutes(src: string): string[] {
  // `prefixes: [...]` is stripped first. Those strings are the segments a tab
  // LIGHTS UP on, not places it navigates to — the Attendance tab lights on
  // `/dashboard/attendance` while going to `/dashboard/my-attendance` — and a
  // prefix is deliberately allowed to be non-routable. Reading them as
  // destinations made this test fail on the very distinction it exists to draw.
  const withoutPrefixes = src.replace(/prefixes:\s*\[[^\]]*\]/g, 'prefixes: []');
  return [...withoutPrefixes.matchAll(/'(\/dashboard\/[a-z0-9/-]*)'/g)]
    .map((m) => m[1])
    .filter((r) => r !== '/dashboard');
}

/** `` `/dashboard/leaves/${x}` `` → the parent segment that needs a `[param]`. */
function dynamicParents(src: string): string[] {
  return [...src.matchAll(/`(\/dashboard\/[a-z0-9/-]*?)\/\$\{/g)].map((m) => m[1]);
}

const dirFor = (route: string) => join(APP, route.replace(/^\//, ''));

const hasDynamicChild = (dir: string) =>
  existsSync(dir) && readdirSync(dir).some((entry) => entry.startsWith('['));

const allStatic = [...new Set(GOVERNED.flatMap((f) => staticRoutes(source(f))))].sort();
const allDynamic = [...new Set(GOVERNED.flatMap((f) => dynamicParents(source(f))))].sort();

describe('the ESS phone UI points at routes that exist', () => {
  it('finds routes to check in every governed file', () => {
    // A guard on the guard: a refactor that changes how these hrefs are written
    // would otherwise leave the assertions below iterating over nothing and
    // passing silently — which is exactly how the Salary tile survived.
    for (const file of GOVERNED) {
      expect(staticRoutes(source(file)).length, `${file} exposes no routes to check`).toBeGreaterThan(0);
    }
    expect(allStatic.length).toBeGreaterThanOrEqual(8);
  });

  it.each(allStatic)('%s resolves to a page', (route) => {
    // `page.tsx` is what makes a segment routable. A directory holding only
    // `[id]/` renders nothing at its own path — which is the bug, twice.
    expect(existsSync(join(dirFor(route), 'page.tsx')), `${route} has no page.tsx`).toBe(true);
  });

  it.each(allDynamic.length ? allDynamic : ['(none)'])(
    '%s has a dynamic child for the id it interpolates',
    (parent) => {
      if (parent === '(none)') return;
      expect(hasDynamicChild(dirFor(parent)), `${parent} has no [param] segment`).toBe(true);
    },
  );
});

/**
 * The tab bar's lit-up prefixes.
 *
 * A prefix need NOT be routable itself — a segment reached only as `.../[id]`
 * would do — but it must exist, or the tab lights on nothing.
 */
describe('the tab bar lights on segments that exist', () => {
  const bar = source('components/dashboard/MobileTabBar.tsx');
  const prefixes = [...new Set(
    [...bar.matchAll(/prefixes:\s*\[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((p) => p[1])),
  )].sort();

  it('declares prefixes', () => {
    expect(prefixes.length).toBeGreaterThanOrEqual(5);
  });

  it.each(prefixes)('%s is a real segment', (prefix) => {
    expect(existsSync(dirFor(prefix)), `${prefix} is not a directory under app/`).toBe(true);
  });
});
