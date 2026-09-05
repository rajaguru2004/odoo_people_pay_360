import { chromium, request as playwrightRequest, type FullConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { API_URL, FRONTEND_URL, STORAGE_DIR } from './playwright.config';

/**
 * Mint one session per role, once, before any spec runs.
 *
 * Signing in through the UI in every spec costs a page load and a round trip per
 * test; doing it once here and handing each project a `storageState` costs one
 * per role per run. The session is written the way the app itself stores it —
 * `accessToken` and `user` in localStorage — because that is what lib/axios.ts
 * reads.
 */
const ACCOUNTS: Record<string, { email: string; password: string }> = {
  admin: { email: 'admin@peoplepay360.com', password: 'Admin@123' },
  hr: { email: 'hr@peoplepay360.com', password: 'Admin@123' },
  payroll: { email: 'payroll@peoplepay360.com', password: 'Admin@123' },
  employee: { email: 'employee@peoplepay360.com', password: 'Admin@123' },
};

export default async function globalSetup(_config: FullConfig) {
  mkdirSync(STORAGE_DIR, { recursive: true });

  const api = await playwrightRequest.newContext({ baseURL: API_URL });
  const browser = await chromium.launch();

  try {
    for (const [role, credentials] of Object.entries(ACCOUNTS)) {
      const response = await api.post('/auth/login', { data: credentials });

      if (!response.ok()) {
        // An EMPTY state file, not a crash. Only the roles whose accounts the
        // seed actually created can run; the rest fail on their first
        // assertion with a readable "not signed in", which is far easier to
        // diagnose than global setup aborting the entire run.
        console.warn(`[e2e] no session for "${role}" (${response.status()}) — seed it to enable that project`);
        writeFileSync(resolve(STORAGE_DIR, `${role}.json`), JSON.stringify({ cookies: [], origins: [] }));
        continue;
      }

      const body = await response.json();
      const { accessToken, user } = body.data;

      const context = await browser.newContext();
      await context.addInitScript(
        ([token, serialisedUser]) => {
          localStorage.setItem('accessToken', token as string);
          localStorage.setItem('user', serialisedUser as string);
          localStorage.setItem(
            'auth-storage',
            JSON.stringify({ state: { user: JSON.parse(serialisedUser as string), isAuthenticated: true }, version: 0 }),
          );
        },
        [accessToken, JSON.stringify(user)],
      );

      const page = await context.newPage();
      // The origin must be visited before localStorage exists to write to.
      await page.goto(FRONTEND_URL);
      await context.storageState({ path: resolve(STORAGE_DIR, `${role}.json`) });
      await context.close();
    }
  } finally {
    await browser.close();
    await api.dispose();
  }
}
