import { chromium } from 'playwright';

/**
 * Browser verification for the GA4 integration.
 *
 * Deliberately NOT a Playwright spec: it needs no backend, no seeded database
 * and no Docker, so it can be run against any production build in about a
 * minute. `e2e/specs/` stays the place for journeys that need real data.
 *
 *   cd apps/frontend
 *   NEXT_PUBLIC_GA_MEASUREMENT_ID=G-TEST123456 npm run build
 *   NEXT_PUBLIC_GA_MEASUREMENT_ID=G-TEST123456 npx next start -p 3111 &
 *   node e2e/scripts/verify-ga4.mjs
 *
 * The backend is stubbed inside the browser and gtag.js is blocked, so nothing
 * this script does reaches a real server — including the demo API named in
 * apps/frontend/.env.local.
 */

const BASE = 'http://localhost:3111';
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

// Page and RSC requests MUST pass through untouched — stubbing a router
// prefetch turns every client navigation into a hard reload.
// This build reads NEXT_PUBLIC_API_URL from apps/frontend/.env.local, so the
// API lives on its own origin. EVERY request to it is answered locally — the
// real demo backend is never contacted by this script.
const API = 'https://demo.ess.api.tools.thefusionapps.com';
const PAGE_PREFIXES = ['/_next', '/login', '/dashboard', '/checkin', '/verify', '/403', '/favicon'];
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== BASE && url.origin !== API) return route.abort(); // incl. gtag.js
  const p = url.pathname;
  if (url.origin === BASE && (p === '/' || PAGE_PREFIXES.some((prefix) => p.startsWith(prefix)))) {
    return route.continue();
  }
  if (p === '/auth/me') return route.fulfill({ json: { success: true, data: USER } });
  if (p === '/auth/login') return route.fulfill({ json: { success: true, data: { user: USER, accessToken: 'tok' } } });
  if (p.startsWith('/system-settings')) return route.fulfill({ json: { success: true, data: {} } });
  return route.fulfill({ json: { success: true, data: [] } });
});

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const readQueue = () => page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)));

/** Everything seen across every document, so a redirect cannot hide an event. */
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
const views = () => all.filter((c) => c[0] === 'event' && c[1] === 'page_view').map((c) => c[2]);
const viewOf = (p) => views().find((v) => v.page_path === p);
const eventsNamed = (n) => all.filter((c) => c[0] === 'event' && c[1] === n).map((c) => c[2]);

// ── 1. Anonymous screen ──────────────────────────────────────────────────────
const first = await visit('/login');
check('gtag queue exists', first.length > 0, `${first.length} commands`);
check('js command comes first', first[0]?.[0] === 'js');
check('config turns automatic page_view off',
  first[1]?.[0] === 'config' && first[1]?.[2]?.send_page_view === false, JSON.stringify(first[1]?.[2]));
check('page_view for /login', viewOf('/login')?.module === 'auth', JSON.stringify(viewOf('/login')));

// ── 2. Signed-in session ─────────────────────────────────────────────────────
await page.evaluate((user) => {
  localStorage.setItem('accessToken', 'tok');
  localStorage.setItem('user', JSON.stringify(user));
  localStorage.setItem('auth-storage', JSON.stringify({ state: { user, isAuthenticated: true }, version: 0 }));
}, USER);

await visit('/dashboard/my-leaves', 2500);
check('self-service screen counted as its own module',
  viewOf('/dashboard/my-leaves')?.module === 'self_service', JSON.stringify(viewOf('/dashboard/my-leaves')));
const props = all.find((c) => c[0] === 'set' && c[1] === 'user_properties');
check('role attached as a user property', props?.[2]?.user_role === 'EMPLOYEE', JSON.stringify(props?.[2]));
const uid = all.find((c) => c[0] === 'set' && typeof c[1] === 'object' && c[1]?.user_id);
check('user_id is pseudonymous', /^u_[0-9a-f]{8}$/.test(uid?.[1]?.user_id || ''), uid?.[1]?.user_id);
check('a live session reports as session_restored, not as a login',
  eventsNamed('session_restored').length >= 1 && eventsNamed('login').length === 0);

// ── 3. A record screen ───────────────────────────────────────────────────────
await visit('/dashboard/employees/3f9a1c2e-1b44-4d0a-9e77-2b6f9c1d5a10', 2500);
check('record id masked out of the page path',
  !!viewOf('/dashboard/employees/:id'), JSON.stringify(views().map((v) => v.page_path)));
check('module reported as people', viewOf('/dashboard/employees/:id')?.module === 'people');

// ── 4. Module coverage across the portal ─────────────────────────────────────
for (const [path, expected] of [
  ['/dashboard/attendance', 'attendance'],
  ['/dashboard/leaves', 'leave'],
  ['/dashboard/payroll/manage', 'payroll'],
  ['/dashboard/budgets', 'finance'],
  ['/dashboard/training', 'talent'],
  ['/dashboard/assets', 'workplace'],
]) {
  await visit(path, 900);
  check(`page_view for ${path} reports module ${expected}`, viewOf(path)?.module === expected,
    JSON.stringify(viewOf(path)?.module));
}

await visit('/403', 900);
check('the permission-denied page is a screen, not a masked id',
  viewOf('/403')?.module === 'system', JSON.stringify(views().map((v) => v.page_path)));
check('session_restored is once per browser session, not once per reload',
  eventsNamed('session_restored').length === 1, `${eventsNamed('session_restored').length} seen`);

// ── 5. A real sign-in journey, through the app's own axios instance ─────────
await page.evaluate(() => {
  localStorage.clear();
  sessionStorage.clear();
});
await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
await page.locator('input[type="email"]').fill('employee1@company.com');
await page.locator('input[type="password"]').fill('secret123');
await page.locator('button[type="submit"]').click();
await page.waitForTimeout(2500);
all.push(...(await readQueue()));

check('sign-in recorded as a login event', eventsNamed('login').length >= 1,
  JSON.stringify(eventsNamed('login')[0]));
const write = all.filter((c) => c[0] === 'event' && c[2]?.method === 'POST').map((c) => [c[1], c[2]]);
check('the POST behind it recorded as an api_action with a clean endpoint',
  write.some(([name, params]) => name === 'api_action' && params.endpoint === '/auth/login'
    && params.module === 'auth' && params.outcome === 'success'),
  JSON.stringify(write));
check('the password typed into the form never leaves the browser',
  !JSON.stringify(all).includes('secret123'));

// ── 6. Nothing confidential anywhere in the queue ────────────────────────────
const payload = JSON.stringify(all);
check('no account id in the payload', !payload.includes(USER.id));
check('no address in the payload', !payload.includes('@company.com'));
check('no employee name in the payload', !payload.includes('Employee One'));
check('no uuid of any kind in the payload',
  !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(payload));

// ── 7. A hostile queue cannot break the portal ───────────────────────────────
await page.goto(BASE + '/dashboard/my-leaves', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { window.dataLayer = { push: () => { throw new Error('blocked'); } }; });
pageErrors.length = 0;
await page.goto(BASE + '/dashboard/my-leaves', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
check('page still renders when the queue throws', await page.locator('body').isVisible());
check('no uncaught error from analytics', pageErrors.length === 0, pageErrors.join('; '));

console.log('\nDISTINCT SCREENS MEASURED:');
[...new Set(views().map((v) => `${v.module}  ${v.page_path}`))].sort().forEach((v) => console.log(' ', v));
console.log('\nNON page_view EVENTS:');
all.filter((c) => c[0] === 'event' && c[1] !== 'page_view').forEach((c) => console.log(' ', c[1], JSON.stringify(c[2])));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
