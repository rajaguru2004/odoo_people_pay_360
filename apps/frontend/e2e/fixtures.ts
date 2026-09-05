import { test as base, expect, Page, APIRequestContext, request } from '@playwright/test';
import { API_URL } from './playwright.config';
import { ROLE_ACCOUNTS, RoleKey } from './global-setup';

/**
 * The shared harness.
 *
 * ## The failure fixture, and why it is the point
 *
 * A spec can only assert what its author thought to check. The common breakage
 * in this codebase is not "the button stopped working" — it is a shared
 * component throwing on a screen nobody was thinking about, which turns into a
 * blank page in production. No assertion names that.
 *
 * So every test here fails on evidence of breakage regardless of its own
 * assertions: an uncaught page error, a console `error`, a failed request, or a
 * 5xx response. That is what lets the route matrix be shallow and still be
 * worth running — it visits a hundred screens and the fixture does the judging.
 *
 * Known-noisy messages are filtered by `IGNORED_CONSOLE`, which is a list that
 * should be argued over and kept short. Anything added there is a screen we
 * have decided not to watch.
 */

/** Console noise that is not evidence of breakage. Keep this list small. */
const IGNORED_CONSOLE: RegExp[] = [
  // React DevTools nag.
  /Download the React DevTools/i,
  // Next's own prefetch chatter on a slow dev machine.
  /Failed to load resource: net::ERR_ABORTED/i,
  /**
   * A transport-level fetch failure, reported by the browser WITHOUT the URL
   * that produced it — which is what makes it unusable as evidence on its own.
   *
   * In practice these are the Google Fonts requests the theme presets make on
   * every screen (see THIRD_PARTY_HOSTS): on a machine that cannot reach
   * gstatic they fail, and the console line lands on whatever spec was running.
   * Dropping it costs nothing, because a first-party failure of the same kind
   * still shows up in `requestFailures` — which DOES carry the URL and is not
   * filtered for this app's own hosts.
   */
  /Failed to load resource: net::ERR_(CONNECTION_(CLOSED|RESET|REFUSED)|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)/i,
  /**
   * The dev server's HTTP/2 keep-alive giving up, again without a URL.
   *
   * Seen on a long serial run where the browser holds a connection open across
   * a slow backend call: Chromium pings, the ping is not answered in time, and
   * the connection is dropped and remade. Nothing in the app failed — the
   * request that rode on it is retried and succeeds, which is why it lands as a
   * console line and never as a non-2xx response. It is a property of the
   * machine's timing, so it attaches to whichever spec was open when the timer
   * expired, and it took down a loan approval case that never touched the
   * network path in question.
   */
  /Failed to load resource: net::ERR_HTTP2_PING_FAILED/i,
];

/**
 * Hosts the app pulls from that are NOT the app.
 *
 * The theme presets load their web font from Google Fonts at run time
 * (`theme/presets/*.ts`), so every screen makes a request to a third party. When
 * the machine running the suite cannot reach it — an offline CI box, a sandbox,
 * a flaky link — that failure lands on whichever screen happened to be open and
 * fails a test that has nothing to do with fonts.
 *
 * Their unreachability is an environment fact, not a regression in this app, so
 * it is filtered here. That the app depends on them at all is a real finding and
 * is recorded in docs/TESTING.md; filtering the noise is not the same as
 * accepting the dependency.
 */
const THIRD_PARTY_HOSTS: RegExp[] = [
  /^https?:\/\/fonts\.googleapis\.com\//,
  /^https?:\/\/fonts\.gstatic\.com\//,
];

const isThirdParty = (url: string) => THIRD_PARTY_HOSTS.some((re) => re.test(url));

/** Endpoints allowed to answer 4xx without failing a test. */
const EXPECTED_CLIENT_ERRORS: RegExp[] = [
  // Probed on every page; a 403 here is the answer, not a fault.
  /\/approval-workflows\/can-approve/,
  /\/dev-mode\/status/,
  // The route matrix deliberately visits screens a role may not have.
  /\/supervisors\/my-team/,
  // The machine's network changed underneath the browser — a laptop switching
  // Wi-Fi, a VPN reconnecting, a container's interface being renumbered. Chrome
  // reports it as a failed resource load, and it says nothing whatsoever about
  // the application. Left in the list rather than chased: a real app fault does
  // not describe itself as a changed network.
  /net::ERR_NETWORK_CHANGED/,
  /net::ERR_NETWORK_IO_SUSPENDED/,
];

export interface PageProblems {
  consoleErrors: string[];
  pageErrors: string[];
  serverErrors: string[];
  requestFailures: string[];
  /**
   * Every non-2xx response, with its URL.
   *
   * Not asserted on directly — a 403 is often the correct answer, and the
   * matrix visits screens roles may not have. It exists so that the console's
   * useless "Failed to load resource: the server responded with a status of
   * 404" can be reported alongside the URL that actually produced it.
   */
  httpErrors: string[];
  /**
   * `strict` fails on any evidence of trouble. `crashes-only` fails on thrown
   * renders and 5xx alone — used when the role is not expected to be able to
   * use the screen, where a logged 403 is the correct outcome.
   */
  mode: 'strict' | 'crashes-only' | 'render-only';
  /**
   * Set once a spec has judged the page itself, which suppresses the automatic
   * judgement at teardown.
   *
   * Without this the assertion happens after the test body, and anything still
   * in flight when the body ends — a poll, a prefetch, a request cancelled by a
   * client-side redirect — lands in the window between the two and fails a test
   * that had already finished its work. That produced a different handful of
   * failures on every run, all of which passed in isolation.
   */
  settled: boolean;
}

/** Attaches listeners and returns the accumulating record. */
export function watchForProblems(page: Page): PageProblems {
  const problems: PageProblems = {
    consoleErrors: [],
    pageErrors: [],
    serverErrors: [],
    requestFailures: [],
    httpErrors: [],
    mode: 'strict',
    settled: false,
  };

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
    problems.consoleErrors.push(text);
  });

  // An uncaught exception during render — the blank-screen case.
  page.on('pageerror', (err) => {
    problems.pageErrors.push(err.message);
  });

  page.on('response', (res) => {
    const status = res.status();
    if (isThirdParty(res.url())) return;
    if (status >= 400) {
      const line = `${status} ${res.request().method()} ${res.url()}`;
      problems.httpErrors.push(line);
      if (status >= 500) problems.serverErrors.push(line);
    }
  });

  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? 'unknown';
    // Navigations the test itself aborted are not failures.
    if (failure === 'net::ERR_ABORTED') return;
    if (isThirdParty(req.url())) return;
    problems.requestFailures.push(`${req.method()} ${req.url()} — ${failure}`);
  });

  return problems;
}

/**
 * Judges the page now, and stops the fixture judging it again at teardown.
 * Call at the end of a spec body, once the page has done what it was asked.
 */
export function settle(problems: PageProblems, context = 'The page'): void {
  assertNoProblems(problems, context);
  problems.settled = true;
}

/**
 * Downgrades a page to crash-detection only.
 *
 * Needed because a console error is not always evidence of a bug. When a role
 * opens a screen that is not meant for it, the API answers 403 and the screen
 * logs that it could not load — which is the system working. An uncaught render
 * exception or a 5xx never is, and those stay fatal.
 */
export function crashesOnly(problems: PageProblems): void {
  problems.mode = 'crashes-only';
}

/**
 * Weakest judgement: only an uncaught render is a failure.
 *
 * For a screen whose backing feature is switched off in this environment, the
 * API answering 503 is the correct behaviour, so even a 5xx has to be tolerated.
 * The screen must still render rather than throw.
 */
export function renderOnly(problems: PageProblems): void {
  problems.mode = 'render-only';
}

export function assertNoProblems(problems: PageProblems, context: string): void {
  if (problems.mode === 'render-only') return assertRenders(problems, context);
  if (problems.mode === 'crashes-only') return assertNoCrashes(problems, context);
  return assertStrict(problems, context);
}

function assertRenders(problems: PageProblems, context: string): void {
  expect(problems.pageErrors.join('\n  '), `${context} threw during render`).toBe('');
}

/** Only the failures that are never correct: a thrown render, or a 5xx. */
export function assertNoCrashes(problems: PageProblems, context: string): void {
  const lines: string[] = [];
  if (problems.pageErrors.length) lines.push(`Uncaught page errors:\n  ${problems.pageErrors.join('\n  ')}`);
  if (problems.serverErrors.length) lines.push(`Server 5xx:\n  ${problems.serverErrors.join('\n  ')}`);

  if (lines.length && problems.httpErrors.length) {
    lines.push(`Non-2xx responses seen on this page:\n  ${problems.httpErrors.join('\n  ')}`);
  }

  expect(lines.join('\n\n'), `${context} crashed`).toBe('');
}

function assertStrict(problems: PageProblems, context: string): void {
  const lines: string[] = [];
  if (problems.pageErrors.length) lines.push(`Uncaught page errors:\n  ${problems.pageErrors.join('\n  ')}`);
  if (problems.serverErrors.length) lines.push(`Server 5xx:\n  ${problems.serverErrors.join('\n  ')}`);
  if (problems.consoleErrors.length) lines.push(`Console errors:\n  ${problems.consoleErrors.join('\n  ')}`);
  if (problems.requestFailures.length) lines.push(`Failed requests:\n  ${problems.requestFailures.join('\n  ')}`);

  // The browser's own wording for a failed fetch is "Failed to load resource:
  // the server responded with a status of 404" — with no URL, which makes it
  // unactionable on its own. Attach the non-2xx responses so the reader can see
  // what actually failed.
  if (lines.length && problems.httpErrors.length) {
    lines.push(`Non-2xx responses seen on this page:\n  ${problems.httpErrors.join('\n  ')}`);
  }

  expect(lines.join('\n\n'), `${context} produced browser errors`).toBe('');
}

/**
 * An authenticated API client, for setting up what a journey needs without
 * clicking through six screens to create it. Setup via API, assertions via UI.
 */
export class ApiClient {
  /**
   * The branch this client is acting within, sent as `X-Branch-Id`.
   *
   * Not optional decoration: payroll runs are per-branch, and generating one
   * without a branch selected is refused outright ("Select a specific branch
   * before generating payroll"). The header is a view selector, never a grant —
   * the server still checks access.
   */
  private branchId: string | null = null;

  private constructor(
    private readonly ctx: APIRequestContext,
    readonly token: string,
  ) {}

  /** Scopes every subsequent request to one branch. Returns `this` to chain. */
  withBranch(branchId: string | null): this {
    this.branchId = branchId;
    return this;
  }

  /** The first active branch, for specs that just need *a* valid one. */
  async firstBranchId(): Promise<string> {
    const branches = await this.get<Array<{ id: string; code: string; isActive?: boolean }>>('/branches');
    const list = Array.isArray(branches) ? branches : [];
    const head = list.find((b) => b.code === 'HO') ?? list[0];
    if (!head) throw new Error('No branch exists — the baseline seed did not run');
    return head.id;
  }

  static async as(role: RoleKey): Promise<ApiClient> {
    const creds = ROLE_ACCOUNTS[role];
    return ApiClient.asAccount(creds.email, creds.password);
  }

  /**
   * Log in as ANY seeded account, not just one of the four Playwright roles.
   *
   * The approval-chain spec needs `employee2@company.com` — whom `employee1`
   * supervises — and adding it to `ROLE_ACCOUNTS` would mint a fifth
   * storageState and trip `global-setup.ts`'s `role === key.toUpperCase()`
   * assertion. A sibling factory keeps that machinery untouched.
   */
  static async asAccount(email: string, password: string): Promise<ApiClient> {
    const ctx = await request.newContext({ baseURL: API_URL });
    const res = await ctx.post('/auth/login', { data: { email, password } });
    const body = await res.json();
    const token = body?.data?.accessToken;
    if (!token) throw new Error(`API login failed for ${email}: ${res.status()}`);
    return new ApiClient(ctx, token);
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
    if (this.branchId) h['X-Branch-Id'] = this.branchId;
    return h;
  }

  async get<T = unknown>(path: string): Promise<T> {
    const res = await this.ctx.get(path, { headers: this.headers });
    return this.unwrap<T>(res, 'GET', path);
  }

  async post<T = unknown>(path: string, data: unknown): Promise<T> {
    const res = await this.ctx.post(path, { headers: this.headers, data });
    return this.unwrap<T>(res, 'POST', path);
  }

  async put<T = unknown>(path: string, data: unknown): Promise<T> {
    const res = await this.ctx.put(path, { headers: this.headers, data });
    return this.unwrap<T>(res, 'PUT', path);
  }

  async patch<T = unknown>(path: string, data: unknown): Promise<T> {
    const res = await this.ctx.patch(path, { headers: this.headers, data });
    return this.unwrap<T>(res, 'PATCH', path);
  }

  async delete(path: string): Promise<void> {
    const res = await this.ctx.delete(path, { headers: this.headers });
    if (!res.ok()) throw new Error(`DELETE ${path} failed: ${res.status()} ${await res.text()}`);
  }

  private async unwrap<T>(
    res: Awaited<ReturnType<APIRequestContext['get']>>,
    method: string,
    path: string,
  ): Promise<T> {
    const text = await res.text();
    if (!res.ok()) throw new Error(`${method} ${path} failed: ${res.status()} ${text}`);
    if (!text) return undefined as T;
    const body = JSON.parse(text);
    // The backend wraps everything as { success, data, message }.
    return (body?.data ?? body) as T;
  }

  async dispose(): Promise<void> {
    await this.ctx.dispose();
  }
}

/** Unique per run, so parallel or repeated runs cannot collide. */
export const runId = `pw${Date.now().toString(36)}`;

interface Fixtures {
  /** Accumulating browser problems for the current page. */
  problems: PageProblems;
  /** Admin-authenticated API client, disposed automatically. */
  api: ApiClient;
}

export const test = base.extend<Fixtures>({
  problems: async ({ page }, use) => {
    const problems = watchForProblems(page);
    await use(problems);
    // Asserted after the test body so a spec's own failure is reported first —
    // a test that already failed does not need a second, noisier error. Skipped
    // when the spec already called settle(), which is the deterministic path.
    if (!problems.settled) assertNoProblems(problems, 'The page');
  },

  api: async ({}, use) => {
    const client = await ApiClient.as('admin');
    await use(client);
    await client.dispose();
  },
});

export { expect };
export { EXPECTED_CLIENT_ERRORS };
