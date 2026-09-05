import { mkdirSync, writeFileSync } from 'fs';
import { API_URL, FRONTEND_URL, STORAGE_DIR } from './playwright.config';

/**
 * Mints one signed-in session per role, once, before any spec runs.
 *
 * Logging in through the form in every spec would add a page load and a round
 * trip to each test and make the login screen a single point of failure for the
 * whole suite. Instead each role logs in over the API here and the resulting
 * session is written as a Playwright `storageState`.
 *
 * That works because this app keeps its session entirely in `localStorage` —
 * there is no cookie and no `middleware.ts`. Four keys have to be present, and
 * they are exactly what `authStore.login()` writes:
 *
 *   accessToken   read by the axios request interceptor
 *   refreshToken  written as a copy of the access token (there is no real one)
 *   user          read by authService.getUser() on boot
 *   auth-storage  zustand's persisted slice — without it the dashboard layout
 *                 briefly believes it is signed out and redirects to /login
 *
 * `locale-storage` is pinned to `en` so selectors never have to survive the
 * Arabic translation, and `branch-storage` is cleared so no run inherits a
 * branch selection from another.
 *
 * The login spec deliberately does NOT use these — it drives the real form.
 */

/** Accounts from `prisma/seed.ts` plus the MANAGER added by seed-e2e-baseline. */
export const ROLE_ACCOUNTS = {
  admin: { email: 'admin@company.com', password: 'Admin@123' },
  hr: { email: 'hr.manager@company.com', password: 'Password123!' },
  manager: { email: 'manager@company.com', password: 'Password123!' },
  employee: { email: 'employee1@company.com', password: 'Password123!' },
} as const;

export type RoleKey = keyof typeof ROLE_ACCOUNTS;

interface LoginResult {
  accessToken: string;
  user: Record<string, unknown>;
}

async function login(email: string, password: string): Promise<LoginResult> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.data?.accessToken) {
    throw new Error(
      `Login failed for ${email}: ${res.status} ${JSON.stringify(body)}\n` +
        `Is the test stack up and seeded? Try: scripts/e2e-db.sh up`,
    );
  }
  return { accessToken: body.data.accessToken, user: body.data.user };
}

/** The storageState shape Playwright restores into the browser. */
function toStorageState(origin: string, { accessToken, user }: LoginResult) {
  return {
    cookies: [],
    origins: [
      {
        origin,
        localStorage: [
          { name: 'accessToken', value: accessToken },
          // The app stores the access token twice; there is no refresh token.
          { name: 'refreshToken', value: accessToken },
          { name: 'user', value: JSON.stringify(user) },
          {
            name: 'auth-storage',
            value: JSON.stringify({
              // Must match authStore's `partialize`.
              state: { user, isAuthenticated: true },
              version: 0,
            }),
          },
          { name: 'locale-storage', value: JSON.stringify({ state: { locale: 'en' }, version: 0 }) },
          { name: 'branch-storage', value: JSON.stringify({ state: { selectedBranchId: null }, version: 0 }) },
        ],
      },
    ],
  };
}

/**
 * Fails fast with a useful message rather than 200 timeouts.
 *
 * Probes `/` and accepts any non-5xx, matching `test/live/live-cycle.live-e2e.ts`.
 * There is deliberately no `/health` route on this backend, so asking for one
 * would wait out the whole timeout against a perfectly healthy server.
 */
async function waitForApi(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(API_URL);
      if (res.status >= 200 && res.status < 500) return;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Backend at ${API_URL} did not answer within ${timeoutMs}ms (last: ${lastError})`);
}

export default async function globalSetup(): Promise<void> {
  await waitForApi();
  mkdirSync(STORAGE_DIR, { recursive: true });

  const origin = new URL(FRONTEND_URL).origin;

  for (const [role, creds] of Object.entries(ROLE_ACCOUNTS) as [RoleKey, { email: string; password: string }][]) {
    const session = await login(creds.email, creds.password);
    writeFileSync(
      `${STORAGE_DIR}/${role}.json`,
      JSON.stringify(toStorageState(origin, session), null, 2),
    );

    // A session whose role is not what the suite assumes would make every
    // permission assertion meaningless — catch it here, not in a spec.
    const actual = session.user?.role;
    const expected = role === 'hr' ? 'HR_MANAGER' : role.toUpperCase();
    if (actual !== expected) {
      throw new Error(`${creds.email} has role ${actual}, expected ${expected}. Re-seed the test database.`);
    }
  }
}
