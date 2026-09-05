import { chromium } from 'playwright';
import zlib from 'node:zlib';

/**
 * Browser verification for the Microsoft Clarity integration.
 *
 * Deliberately NOT a Playwright spec, for the same reason as verify-ga4.mjs: it
 * needs no backend, no seeded database and no Docker, so it can be run against
 * any production build in about a minute.
 *
 *   cd apps/frontend
 *   export NEXT_PUBLIC_CLARITY_PROJECT_ID=y9zmq4qs0j
 *   export NEXT_PUBLIC_CLARITY_ALLOW_LOCALHOST=true   # both build AND start
 *   NEXT_DIST_DIR=.next-clarity-verify npm run build
 *   NEXT_DIST_DIR=.next-clarity-verify npx next start -p 3111 &
 *   node e2e/scripts/verify-clarity.mjs            # offline: structure + privacy
 *   node e2e/scripts/verify-clarity.mjs --live     # also reaches clarity.ms
 *
 * The localhost opt-in is required because the integration refuses to record a
 * developer machine by default — see `isRecordableHost()`. It is a BUILD-time
 * value like every `NEXT_PUBLIC_*`, so it has to be set for `npm run build`,
 * not only for the server. Without it the first check below fails with a null
 * src, which is the integration working as designed rather than a regression.
 *
 * TWO MODES, because they answer two different questions:
 *
 *   • **offline** (default) — clarity.ms is blocked, so `window.clarity` stays
 *     the queue shim and every command the app sent can be read back and
 *     asserted. This is where the privacy contract is proved: what is in the
 *     queue is exactly what would have been uploaded. The backend is stubbed
 *     in the browser, so nothing reaches a real server either.
 *
 *   • **--live** — the real tag is allowed to load and upload. The queue is
 *     drained by the real library and can no longer be inspected, so this mode
 *     asserts the NETWORK instead: the tag is fetched, and the session upload
 *     is accepted. It creates a real session in the Clarity project, which is
 *     the only way to prove ingestion from outside the dashboard.
 */

const LIVE = process.argv.includes('--live');
const BASE = 'http://localhost:3111';
const PROJECT_ID = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID || 'y9zmq4qs0j';
const USER = {
  id: '7c1e2a90-4d55-4f11-9b3c-8a2d6e4f0011',
  email: 'employee1@company.com',
  role: 'EMPLOYEE',
  isActive: true,
  employeeId: 'e-1',
  isGlobalBranchAccess: false,
  homeBranchId: 'br-ho',
  accessibleBranches: [{ id: 'br-ho', code: 'HO', name: 'Head Office' }],
  employee: {
    id: 'e-1', employeeCode: 'EMP001', fullName: 'Employee One', position: 'Analyst',
    department: { id: 'd-1', name: 'Engineering' },
  },
};

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

/** Every request the page made to Microsoft, with the status it came back as. */
const clarityRequests = [];
/**
 * What was actually uploaded, so masking can be checked over the wire.
 *
 * Kept as BUFFERS and gunzipped below. Clarity gzips the payload itself and
 * sends it without a `Content-Encoding` header, so `postData()` returns binary
 * as a lossy string — searching that for a name passes whatever the recording
 * contains, which is worse than not checking at all.
 */
const clarityUploads = [];
page.on('request', (req) => {
  if (req.url().includes('clarity.ms') && req.method() === 'POST') {
    const body = req.postDataBuffer();
    if (body) clarityUploads.push(body);
  }
});

/** Decompressed payloads, plus how many actually decompressed. */
function decodeUploads() {
  let decompressed = 0;
  const texts = clarityUploads.map((buf) => {
    try {
      const text = zlib.gunzipSync(buf).toString('utf8');
      decompressed += 1;
      return text;
    } catch {
      return buf.toString('utf8');
    }
  });
  return { text: texts.join('\n'), decompressed };
}
page.on('response', async (res) => {
  if (res.url().includes('clarity.ms')) {
    clarityRequests.push({ url: res.url(), method: res.request().method(), status: res.status() });
  }
});

// Page and RSC requests MUST pass through untouched — stubbing a router
// prefetch turns every client navigation into a hard reload. The build reads
// NEXT_PUBLIC_API_URL from apps/frontend/.env.local, so the API lives on its
// own origin and every request to it is answered locally: the real demo
// backend is never contacted by this script, in either mode.
const API = 'https://demo.ess.api.tools.thefusionapps.com';
const PAGE_PREFIXES = ['/_next', '/login', '/dashboard', '/checkin', '/verify', '/403', '/favicon'];
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.hostname.endsWith('clarity.ms')) {
    return LIVE ? route.continue() : route.abort();
  }
  if (url.origin !== BASE && url.origin !== API) return route.abort();
  const p = url.pathname;
  if (url.origin === BASE && (p === '/' || PAGE_PREFIXES.some((prefix) => p.startsWith(prefix)))) {
    return route.continue();
  }
  if (p === '/auth/me') return route.fulfill({ json: { success: true, data: USER } });
  if (p === '/auth/login') return route.fulfill({ json: { success: true, data: { user: USER, accessToken: 'tok' } } });
  if (p.startsWith('/system-settings')) return route.fulfill({ json: { success: true, data: {} } });
  return route.fulfill({ json: { success: true, data: [] } });
});

/**
 * Uncaught page errors, with their stacks.
 *
 * The stack matters: some screens throw under the stubbed API on their own —
 * `/dashboard/attendance` reads `stats.totalEmployees` from the `[]` this
 * script answers with, and does so with Clarity blocked entirely. Attributing
 * that to Clarity would be a false failure, so the check below looks at where
 * the error came from rather than counting them.
 */
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push({ message: e.message, stack: e.stack || '' }));
const clarityErrors = () =>
  pageErrors.filter((e) => /clarity/i.test(e.stack) || /clarity/i.test(e.message));
const describeErrors = (list) => list.map((e) => e.message).join('; ');

const readQueue = () =>
  page.evaluate(() => Array.from((window.clarity && window.clarity.q) || []).map((a) => Array.from(a)));

/** Everything seen across every document, so a redirect cannot hide a command. */
const all = [];
async function visit(path, settle = 1500) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(settle);
  const q = await readQueue();
  all.push(...q);
  return q;
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const tagValue = (key) => all.filter((c) => c[0] === 'set' && c[1] === key).map((c) => c[2]);
const identifies = () => all.filter((c) => c[0] === 'identify');

// ── 1. The tag is on the page at all ─────────────────────────────────────────
await visit('/login');
const src = await page.getAttribute('script#clarity-loader', 'src').catch(() => null);
check('tag loader rendered for the configured project',
  src === `https://www.clarity.ms/tag/${PROJECT_ID}`, String(src));

if (!LIVE) {
  // ── 2. Anonymous screen ────────────────────────────────────────────────────
  check('queue exists before the tag has loaded', all.length > 0, `${all.length} commands`);
  check('sign-in screen named as its own module', tagValue('module').includes('auth'), JSON.stringify(tagValue('module')));
  check('no identifier invented for an anonymous visitor', identifies().length === 0);

  // ── 3. Signed-in session ───────────────────────────────────────────────────
  await page.evaluate((user) => {
    localStorage.setItem('accessToken', 'tok');
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user, isAuthenticated: true }, version: 0 }));
  }, USER);

  await visit('/dashboard/my-leaves', 2500);
  check('self-service screen tagged as its own module', tagValue('module').includes('self_service'),
    JSON.stringify(tagValue('module')));
  check('role attached to the session', tagValue('user_role').includes('EMPLOYEE'), JSON.stringify(tagValue('user_role')));
  check('branch access attached as a capability, not a location',
    tagValue('branch_access').includes('scoped'), JSON.stringify(tagValue('branch_access')));
  check('identified with a pseudonym, never the account id',
    /^u_[0-9a-f]{8}$/.test(identifies().at(-1)?.[1] || ''), String(identifies().at(-1)?.[1]));
  check('no friendly name sent — it would be shown in clear on the dashboard',
    identifies().every((c) => c.length <= 4 || c[4] === undefined), JSON.stringify(identifies().at(-1)));

  // ── 4. A record screen ─────────────────────────────────────────────────────
  // Asserted against the whole list rather than the last entry: this user is an
  // EMPLOYEE, so the portal's own permission guard sends them on to /403, and
  // the LAST page identified is that redirect. Both are correct — the screen
  // was reached and named before the guard fired.
  const identifiedPages = () => identifies().map((c) => c[3]);
  await visit('/dashboard/employees/3f9a1c2e-1b44-4d0a-9e77-2b6f9c1d5a10', 2500);
  check('record id masked out of the page name',
    identifiedPages().includes('/dashboard/employees/:id'), JSON.stringify(identifiedPages()));
  check('module reported as people', tagValue('module').includes('people'));
  check('the permission redirect is itself a named screen, not a masked id',
    identifiedPages().includes('/403') && tagValue('screen').includes('403'));

  // ── 5. Module coverage across the portal ───────────────────────────────────
  for (const [path, expected] of [
    ['/dashboard/attendance', 'attendance'],
    ['/dashboard/payroll/manage', 'payroll'],
    ['/dashboard/training', 'talent'],
  ]) {
    await visit(path, 900);
    check(`${path} tagged as module ${expected}`, tagValue('module').includes(expected));
    check(`${path} re-identified on the client navigation`,
      identifiedPages().includes(path), JSON.stringify(identifiedPages().slice(-3)));
  }

  // ── 6. Nothing confidential anywhere in the queue ──────────────────────────
  const payload = JSON.stringify(all);
  check('no account id in the payload', !payload.includes(USER.id));
  check('no address in the payload', !payload.includes('@company.com'));
  check('no employee name in the payload', !payload.includes('Employee One'));
  check('no uuid of any kind in the payload',
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(payload));

  // ── 7. The recording itself is masked where the HR data is ─────────────────
  await page.goto(BASE + '/dashboard/my-leaves', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  check('routed page masked in recordings',
    await page.locator('main[data-clarity-mask="true"]').count() > 0);
  check('user menu (own name, address, photo) masked',
    await page.locator('[data-clarity-mask="true"] p:has-text("Employee One")').count() > 0);
  check('shell left readable, so a recording still shows what was clicked',
    await page.locator('aside, nav, header').first().isVisible().catch(() => true));

  // ── 8. A hostile queue cannot break the portal ─────────────────────────────
  await page.evaluate(() => {
    window.clarity = () => { throw new Error('blocked'); };
  });
  pageErrors.length = 0;
  await page.goto(BASE + '/dashboard/my-leaves', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.clarity = () => { throw new Error('blocked'); };
  });
  await page.waitForTimeout(1500);
  check('page still renders when the queue throws', await page.locator('body').isVisible());
  check('no uncaught error from Clarity', clarityErrors().length === 0, describeErrors(clarityErrors()));

  console.log('\nTAGS SENT:');
  [...new Set(all.filter((c) => c[0] === 'set').map((c) => `${c[1]} = ${c[2]}`))].sort().forEach((t) => console.log(' ', t));
  console.log('\nPAGES IDENTIFIED:');
  [...new Set(identifies().map((c) => c[3]))].sort().forEach((p) => console.log(' ', p));
} else {
  // ── LIVE: prove Microsoft accepts the session ──────────────────────────────
  // A real browsing session, so the tag has something to upload.
  await page.evaluate((user) => {
    localStorage.setItem('accessToken', 'tok');
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user, isAuthenticated: true }, version: 0 }));
  }, USER);
  for (const path of ['/dashboard', '/dashboard/my-leaves', '/dashboard/attendance']) {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.mouse.move(200, 200);
    await page.mouse.move(600, 400);
  }
  // Clarity uploads on an interval and on page hide; both are given a chance.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(6000);

  const tag = clarityRequests.find((r) => r.url.includes(`/tag/${PROJECT_ID}`));
  check('tag fetched from clarity.ms', tag?.status === 200, JSON.stringify(tag));
  check('the real library replaced the queue shim',
    await page.evaluate(() => typeof window.clarity === 'function' && !window.clarity.q));
  const uploads = clarityRequests.filter((r) => r.method === 'POST' && r.status >= 200 && r.status < 300);
  check('session upload accepted by Clarity', uploads.length > 0,
    JSON.stringify(clarityRequests.filter((r) => r.method === 'POST').slice(0, 4)));
  check('no uncaught error from Clarity', clarityErrors().length === 0, describeErrors(clarityErrors()));

  // The masking contract, proved on the bytes that left the browser rather than
  // on the attributes that were supposed to cause it. The signed-in person's
  // name and address are rendered in the header of every screen walked above.
  const { text: uploaded, decompressed } = decodeUploads();
  check('something was actually uploaded to inspect', clarityUploads.length > 0,
    `${clarityUploads.length} payloads`);
  // Without this the four checks below are worthless: every search would miss
  // in compressed bytes and pass for the wrong reason.
  check('the upload could be decompressed and read', decompressed > 0,
    `${decompressed}/${clarityUploads.length} payloads gunzipped, ${uploaded.length} chars`);
  check('no employee name in the uploaded recording', !uploaded.includes('Employee One'));
  check('no address in the uploaded recording', !uploaded.includes('@company.com'));
  check('no account id in the uploaded recording', !uploaded.includes(USER.id));
  check('no employee code in the uploaded recording', !uploaded.includes('EMP001'));
  check('masked text present in the recording', (uploaded.match(/•/g) || []).length > 20,
    `${(uploaded.match(/•/g) || []).length} masked characters`);
  // The control. Without it, "no name in the upload" would also pass on an
  // upload that captured nothing at all — masking has to be selective to be
  // worth anything, and the shell plus the custom tags are what must survive.
  check('the shell and the tags ARE in the recording, so masking is selective',
    /Dashboard|Attendance|Leave/i.test(uploaded) && /EMPLOYEE|self_service/.test(uploaded));

  if (pageErrors.length) {
    // Not a Clarity failure — printed so a real one is never hidden behind it.
    console.log('\nOTHER PAGE ERRORS (stubbed API, present with Clarity blocked):');
    pageErrors.forEach((e) => console.log(' ', e.message));
  }

  console.log('\nCLARITY TRAFFIC:');
  clarityRequests.forEach((r) => console.log(` ${r.status} ${r.method} ${r.url.slice(0, 110)}`));
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
