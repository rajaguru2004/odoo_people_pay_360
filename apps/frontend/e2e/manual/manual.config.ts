import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';

/**
 * A config of its own, for the manual's screenshot pass.
 *
 * It deliberately does NOT reuse `e2e/playwright.config.ts`, for one reason:
 * that suite's `problems` fixture fails a test on any console error, failed
 * request or 5xx — which is exactly right when the question is "is the app
 * healthy", and exactly wrong when the question is "what does this screen look
 * like". A screen that logs a 403 for a feature the employee does not have is
 * still a screen the manual has to picture.
 *
 * Everything else is borrowed: the same `.auth/employee.json` session minted by
 * the suite's global setup, the same frontend on :3400, the same fake camera
 * (attendance check-in is a `getUserMedia` frame, not a form submit, so without
 * one the shutter never enables and the attendance figures cannot be taken).
 *
 * The stack is NOT started here. `scripts/manual-stack.sh` owns it, on ports of
 * its own (:3410/:3411, database `ess_e2e_manual`) so a suite running from the
 * same checkout cannot collide with it — and, more importantly, so that a
 * rebuild never happens underneath a running standalone server. When it does,
 * the server keeps serving HTML naming chunk hashes that are no longer on disk,
 * every chunk answers 500, and every screenshot is a white "Loading..." page
 * that the capture is perfectly happy to save.
 *
 *   scripts/manual-stack.sh up        # build + serve, and prove it can boot
 *   scripts/manual-stack.sh seed
 *   scripts/manual-stack.sh capture
 */

const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 3410);
const FRONTEND_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${FRONTEND_PORT}`;
const API_URL = process.env.E2E_API_URL ?? `http://127.0.0.1:${process.env.E2E_API_PORT ?? 3411}`;

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.manual\.ts$/,
  outputDir: resolve(__dirname, '..', '.manual', '.results'),

  // One browser, in order: the capture spec walks the portal the way a new
  // employee would, and several figures depend on state an earlier one created.
  fullyParallel: false,
  workers: 1,
  // Long, because a capture is navigate + settle + annotate for ~40 screens.
  timeout: 180_000,
  expect: { timeout: 10_000 },
  // A capture is not a verdict; a retry would just take the picture twice.
  retries: 0,
  reporter: [['list']],

  use: {
    baseURL: FRONTEND_URL,
    timezoneId: 'UTC',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    ...devices['Desktop Chrome'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
    permissions: ['camera'],
  },

  /**
   * Two projects, because the seed MINTS the session the capture pass consumes.
   *
   * A single project with `use.storageState` cannot express that: Playwright
   * resolves the path when the worker starts, so on a clean checkout the seed
   * itself dies with ENOENT on the very file it exists to create.
   */
  projects: [
    { name: 'seed', testMatch: /seed\.manual\.ts$/ },
    {
      // The ADMINISTRATOR book. Its session is pinned to the Muscat branch, so
      // every figure is taken inside the branch the manual is about rather than
      // across the whole company.
      name: 'admin',
      // `admin-recon` as well as `admin` — every admin-book spec.
      testMatch: /admin[\w-]*\.manual\.ts$/,
      use: { storageState: resolve(__dirname, '..', '.auth', 'manual-admin.json') },
    },
    {
      /**
       * The HR MANAGER's book. Same stack, same Muscat branch, same figures —
       * a different account, and that is the whole point. HR_MANAGER is offered
       * the administrator's menu minus the audit log, and plus an Approvals
       * inbox the administrator does not get. The sidebar and
       * the account name are in every screenshot, so those figures cannot be
       * borrowed from the admin capture — they have to be taken again as her.
       */
      name: 'hr',
      testMatch: /hr[\w-]*\.manual\.ts$/,
      use: { storageState: resolve(__dirname, '..', '.auth', 'manual-hr.json') },
    },
    {
      name: 'manual',
      testIgnore: /(seed|admin[\w-]*|hr[\w-]*)\.manual\.ts$/,
      use: {
        /**
         * The MANUAL's own subject — Salim Al Harthy at the Muscat branch —
         * not the suite's `employee1`. The distinction is not cosmetic:
         * employee1 sits at Head Office, and `branchId` is deliberately not
         * updatable on an employee, so the Oman figures this manual needs
         * cannot be taken as them.
         */
        storageState: resolve(__dirname, '..', '.auth', 'manual-employee.json'),
      },
    },
  ],

});
