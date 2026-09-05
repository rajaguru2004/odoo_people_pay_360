import { readdirSync, statSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { ALL_ROLES, ROUTES, Role, routesFor } from './routes';

/**
 * The route table's own consistency.
 *
 * Pure data, so it runs in the fast node project rather than in a browser — and
 * it runs even when the Docker stack is down, which matters because the most
 * likely way this table breaks is someone adding a page and forgetting it. The
 * last test below is the one that catches that.
 */

const APP_DIR = resolve(__dirname, '../app');

/** Every static route in the app tree, discovered the same way Next does. */
function discoverStaticRoutes(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    // Dynamic segments need a real record; the journey specs cover those.
    if (entry.startsWith('[')) continue;
    // Route groups like (auth) do not appear in the URL.
    const segment = entry.startsWith('(') ? '' : `/${entry}`;
    const childPrefix = `${prefix}${segment}`;

    if (readdirSync(full).includes('page.tsx')) found.push(childPrefix || '/');
    found.push(...discoverStaticRoutes(full, childPrefix));
  }
  return found;
}

describe('the route table', () => {
  it('lists every path exactly once', () => {
    // A duplicated path silently halves the coverage of one of the entries.
    const paths = ROUTES.map((r) => r.path);
    const seen = new Set<string>();
    const duplicates = paths.filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
    expect(duplicates, 'duplicate entries in ROUTES').toEqual([]);
  });

  it('names at least one role for every route', () => {
    for (const route of ROUTES) {
      expect(route.allowed.length, `${route.path} allows nobody`).toBeGreaterThan(0);
    }
  });

  it('uses only known role names', () => {
    for (const route of ROUTES) {
      for (const role of route.allowed) {
        expect(ALL_ROLES, `${route.path} names an unknown role`).toContain(role);
      }
    }
  });

  it('never lets usableBy exceed allowed', () => {
    // `usableBy` records where the SERVER is stricter than the client guard.
    // A role that can use a screen it cannot reach is a contradiction, and
    // would quietly turn the strict check back on for someone who gets
    // redirected before the page ever loads.
    for (const route of ROUTES) {
      if (!route.usableBy) continue;
      const extra = route.usableBy.filter((r) => !route.allowed.includes(r));
      expect(extra, `${route.path}: usableBy is wider than allowed`).toEqual([]);
    }
  });

  it('keeps the leave list screens gated by permission, not merely by login', () => {
    // These were wrapped in `<ProtectedRoute>` with no requiredPermission, which
    // checks authentication alone — so every signed-in user reached the
    // all-employees leave list and the pending-approvals queue. They now
    // require VIEW_ALL_LEAVES. If either regresses to an auth-only guard, this
    // is the test that notices.
    for (const path of ['/dashboard/leaves', '/dashboard/leaves/pending']) {
      const route = ROUTES.find((r) => r.path === path)!;
      expect(route.guarded, `${path} must stay guarded`).toBe(true);
      expect(route.allowed, `${path} must not admit every role`).not.toEqual(ALL_ROLES);
      expect(route.allowed, `${path} should be HR and above`).toEqual(['admin', 'hr', 'manager']);
    }
  });

  it('leaves every role with something to visit', () => {
    for (const role of ALL_ROLES as Role[]) {
      expect(routesFor(role).length, `${role} has no routes`).toBeGreaterThan(0);
    }
  });

  it('allows admin everywhere', () => {
    // Not a law of the system, but true of every screen today, and a screen an
    // employee may open while an admin may not is almost always a mistake in
    // this table. If a genuinely admin-excluded route ever appears, add it here
    // by name rather than deleting the check.
    const excludesAdmin = ROUTES.filter((r) => !r.allowed.includes('admin')).map((r) => r.path);
    expect(excludesAdmin, 'routes that exclude admin').toEqual([]);
  });

  it('gives every role a subset of what admin gets', () => {
    const adminRoutes = new Set(ROUTES.filter((r) => r.allowed.includes('admin')).map((r) => r.path));
    for (const route of ROUTES) {
      if (route.allowed.some((r) => r !== 'admin')) {
        expect(adminRoutes.has(route.path), `${route.path} is reachable by a non-admin but not admin`).toBe(true);
      }
    }
  });

  it('covers every static dashboard route in the app tree', () => {
    // The test that actually earns its keep: add a page under app/dashboard and
    // this fails until the matrix knows who is allowed to see it. Without it,
    // new screens quietly go untested.
    const discovered = discoverStaticRoutes(APP_DIR)
      .filter((p) => p.startsWith('/dashboard'))
      // dashboard-v2 is an alternative shell selected by a setting, not a route
      // a user navigates to.
      .filter((p) => !p.startsWith('/dashboard-v2'));

    const covered = new Set(ROUTES.map((r) => r.path));
    const missing = discovered.filter((p) => !covered.has(p)).sort();

    expect(missing, 'routes exist in app/ but are absent from e2e/routes.ts').toEqual([]);
  });

  it('lists no route that no longer exists', () => {
    const discovered = new Set(discoverStaticRoutes(APP_DIR));
    const stale = ROUTES.map((r) => r.path).filter((p) => !discovered.has(p));
    expect(stale, 'routes in e2e/routes.ts that no longer exist in app/').toEqual([]);
  });
});
