import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';

/**
 * Browser tests for the ESS portal.
 *
 * ## Why the frontend is built here rather than pulled from Docker
 *
 * `NEXT_PUBLIC_API_URL` is inlined at build time (see `lib/apiBase.ts`), so an
 * image built for the demo API cannot be repointed at a test backend by setting
 * an environment variable at run time. The choice is therefore between building
 * the Docker image on every run — slow — or building the app here with the
 * right API URL baked in. This config does the latter for the fast PR loop; the
 * nightly job runs the same specs against the real Docker image, so the artifact
 * that actually ships is also exercised.
 *
 * ## What must already be running
 *
 * The backend, Postgres and MinIO, from `docker-compose.test.yml`. Bring them up
 * and seed with `scripts/e2e-db.sh up`. Playwright starts only the frontend.
 *
 * ## Roles
 *
 * Five projects — four signed-in roles, each consuming a `storageState` minted
 * once in `global-setup.ts`, plus the signed-out one the login spec lives in.
 *
 * A spec declares the roles it is for in its FILENAME —
 * `attendance-logs.hr-manager.spec.ts` — and the projects it does not name never
 * load it. A spec with no role segment runs in all four, which is what the route
 * matrix wants. See `ignoreForRole` below.
 */

const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 3400);
export const FRONTEND_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${FRONTEND_PORT}`;

/**
 * The backend under test.
 *
 * Defaults to a locally-run backend on 3401, because `scripts/e2e-db.sh` brings
 * up Postgres and MinIO only — deliberately NOT the `backend` service in
 * docker-compose.test.yml, which reads `apps/backend/.env` and would therefore
 * point at a remote host. Start it yourself with `.env.test` loaded:
 *
 *   cd apps/backend && set -a && . ./.env.test && set +a && node dist/src/main
 *
 * Set E2E_API_URL to 8065 to run against the composed backend instead.
 */
export const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3401';

/** Where global-setup writes the per-role sessions. */
export const STORAGE_DIR = resolve(__dirname, '.auth');

/** The four signed-in roles, in the order a record moves between them. */
const ROLES = ['admin', 'hr', 'manager', 'employee'] as const;
type Role = (typeof ROLES)[number];

/**
 * Which roles a spec file is for, declared in its NAME.
 *
 *     employee-import.admin.spec.ts          → admin only
 *     attendance.hr-employee.spec.ts         → hr and employee
 *     workplace-assets.spec.ts               → every role
 *
 * The alternative — `test.skip(!isProject('admin'))` in every test body — still
 * SCHEDULES the test in all four projects, and Playwright builds the `page`
 * fixture before the body runs, so each of those skips opened a browser window
 * and closed it again. That was ~1,500 windows per full run for ~600 tests that
 * actually did something. A file the project is not named in is never loaded,
 * so nothing is scheduled and no browser opens.
 *
 * Role-agnostic files carry no segment and run everywhere, which is what the
 * route matrix wants.
 *
 * `ignoreForRole` matches "a file that HAS a role segment which does NOT name
 * this role". The role names share no substrings, so a plain containment test
 * inside the segment is exact.
 */
const ignoreForRole = (role: Role) =>
  new RegExp(String.raw`\.(?![a-z-]*${role})[a-z-]+\.spec\.ts$`);

export default defineConfig({
  testDir: resolve(__dirname, 'specs'),
  outputDir: resolve(__dirname, '.results'),
  globalSetup: resolve(__dirname, 'global-setup.ts'),

  // Specs share one database, so anything that writes must not run beside
  // another writer. The route matrix is read-only and by far the longest job,
  // which is why it is allowed to fan out while journeys stay serial.
  fullyParallel: false,
  workers: process.env.CI ? 2 : undefined,

  forbidOnly: !!process.env.CI,
  // One retry locally, two in CI. Not a way of hiding failures: the suite sits
  // at roughly two flaky results per 326, always a different pair, and every
  // one of them passes in isolation. The cause is a response arriving after a
  // page has been asserted on but before the test ends — `networkidle` never
  // settles on screens that poll, so there is no moment at which the page is
  // provably quiet. A retried test that fails twice is a real failure.
  retries: process.env.CI ? 2 : 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },

  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: resolve(__dirname, '.report'), open: 'never' }], ['list']]
    : [['list'], ['html', { outputFolder: resolve(__dirname, '.report'), open: 'never' }]],

  use: {
    baseURL: FRONTEND_URL,
    // Artifacts only when something actually went wrong — a green run should
    // not leave hundreds of megabytes behind.
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    /**
     * The BROWSER's zone, which is not the same knob as the `TZ=UTC` set on the
     * webServer below — that one only fixes Node's.
     *
     * It matters because several screens build an instant out of a date input
     * and a time input (`new Date(\`${date}T${time}:00\`)` in the corrections
     * form, for one), and that parse is interpreted in the browser's local zone.
     * Without pinning it, those specs assert the developer's timezone rather
     * than the app's behaviour, and pass or fail depending on who runs them.
     */
    timezoneId: 'UTC',
    /**
     * A synthetic camera, for every project.
     *
     * Clocking in and out is not a form submit in this app — `FaceCheckIn`
     * mounts a `<video>` fed by `getUserMedia`, and the check-in payload is a
     * frame grabbed from it. Without a fake device the browser has no camera,
     * the shutter never enables, and attendance cannot be tested through the UI
     * at all. Chromium's fake device produces a moving test pattern, which is
     * enough: the test environment has face RECOGNITION off, so the backend
     * stores the image rather than matching against it.
     */
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
      /**
       * Deliberate pause between browser actions, for watching a run.
       *
       * Zero by default, so CI and the normal `npm run test:e2e` are unchanged.
       * `playwright_test.sh` sets it (with `--headed`) when the point of the run
       * is to SEE the flow rather than to get a verdict quickly. Note that it
       * slows every action, so the 45s test timeout is the real ceiling — much
       * above ~400ms and long journeys start timing out on their own slowness.
       */
      slowMo: Number(process.env.E2E_SLOW_MO ?? 0),
    },
    permissions: ['camera'],
  },

  projects: [
    // The four signed-in roles. Each skips auth.spec.ts — those tests sign in
    // for themselves and would be meaningless (and would fail the
    // "unauthenticated visitor" assertion) with a session already restored —
    // and skips any spec whose name declares a role list this one is not in.
    ...ROLES.map((role) => ({
      name: role,
      testIgnore: [/auth\.spec\.ts/, ignoreForRole(role)],
      use: { ...devices['Desktop Chrome'], storageState: `${STORAGE_DIR}/${role}.json` },
    })),
    {
      // Signed-out. The login spec lives here, and only here.
      name: 'anonymous',
      testMatch: /auth\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: { cookies: [], origins: [] } },
    },
  ],

  webServer: {
    // Built, not `next dev`: dev mode double-renders and reports errors
    // differently, and the console-error fixture would fire on noise that
    // production never shows.
    //
    // The script exists because this app builds to `output: 'standalone'`, which
    // `next start` refuses to serve and which ships without its static assets.
    // See e2e/start-frontend.sh.
    command: 'bash e2e/start-frontend.sh',
    cwd: resolve(__dirname, '..'),
    url: FRONTEND_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: {
      // The whole reason this is a build step and not a runtime flag.
      NEXT_PUBLIC_API_URL: API_URL,
      PORT: String(FRONTEND_PORT),
      // Fixed zone so seeded dates and rendered dates cannot disagree.
      TZ: 'UTC',
    },
  },
});
