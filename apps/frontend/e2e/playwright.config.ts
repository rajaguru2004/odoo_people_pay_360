import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';

/**
 * Browser tests for the People Pay 360 portal.
 *
 * ## Why the frontend is BUILT here rather than pulled from an image
 *
 * `NEXT_PUBLIC_API_URL` is inlined at build time (see lib/apiBase.ts), so an
 * image built for one API cannot be repointed at a test backend with an
 * environment variable at run time. The choice is between rebuilding the image
 * every run — slow — or building the app here with the right API URL baked in.
 * This config does the latter for the fast PR loop.
 *
 * ## What must already be running
 *
 * The test backend and its Postgres, from docker-compose.test.yml. Bring them
 * up with `npm run e2e:up` at the repo root. Playwright starts only the
 * frontend.
 *
 * ## Roles
 *
 * A spec declares the roles it is for in its FILENAME —
 * `employees.hr-manager.spec.ts` — and a project whose role the name does not
 * list never loads it. A spec with no role segment runs in all of them.
 *
 * The alternative (`test.skip(...)` in the body) still SCHEDULES the test in
 * every project, and Playwright builds the `page` fixture before the body runs
 * — so each skip opens a browser window and closes it again. A file the project
 * is not named in is never loaded, so nothing is scheduled and no browser opens.
 */

const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 3410);
export const FRONTEND_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${FRONTEND_PORT}`;

/** The backend under test — the one from docker-compose.test.yml. */
export const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3411';

/** Where global-setup writes the per-role sessions. */
export const STORAGE_DIR = resolve(__dirname, '.auth');

const ROLES = ['admin', 'hr', 'payroll', 'employee'] as const;
type Role = (typeof ROLES)[number];

/**
 * "A file that HAS a role segment which does NOT name this role."
 * The role names share no substrings, so containment inside the segment is exact.
 */
const ignoreForRole = (role: Role) =>
  new RegExp(String.raw`\.(?![a-z-]*${role})[a-z-]+\.spec\.ts$`);

export default defineConfig({
  testDir: './specs',
  outputDir: './.results',
  fullyParallel: true,
  // A `.only` left in a spec silently narrows a CI run to one test that passes.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['html', { outputFolder: './.report', open: 'never' }], ['list']],

  use: {
    baseURL: FRONTEND_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  globalSetup: require.resolve('./global-setup'),

  projects: [
    // Signed OUT. The login spec lives here — it must start with no session.
    {
      name: 'anonymous',
      testMatch: /\.anon\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    ...ROLES.map((role) => ({
      name: role,
      testIgnore: [ignoreForRole(role), /\.anon\.spec\.ts$/],
      use: {
        ...devices['Desktop Chrome'],
        storageState: resolve(STORAGE_DIR, `${role}.json`),
      },
    })),
  ],

  webServer: {
    // A production build, not `next dev`: dev-mode compile-on-navigate makes
    // the first visit to each route slow enough to trip the default timeouts,
    // and it is not what ships.
    command: `npm run build && npx next start --port ${FRONTEND_PORT}`,
    url: FRONTEND_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_API_URL: API_URL,
      NEXT_DIST_DIR: '.next-e2e',
      // This is a PRODUCTION build, where the demo-account panel is off by
      // default. Switched on here so the suite exercises it — and so the
      // opt-in itself is covered, since a flag nothing ever sets is a flag
      // nobody notices has stopped working.
      NEXT_PUBLIC_DEMO_LOGINS: 'true',
    },
  },
});
