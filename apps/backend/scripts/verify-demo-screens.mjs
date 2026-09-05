/**
 * Demo screen sweep: calls the API the way the dashboard does, once per screen,
 * scoped to one branch, and reports every endpoint that answers with nothing.
 *
 * Why an HTTP script and not a query: a screen is empty when its ENDPOINT is
 * empty, which is not the same as its table being empty — most inbox screens
 * filter by status, several read a different category than the one seeded, and
 * everything is branch-scoped by a middleware that a direct query bypasses.
 * Counting rows said the Muscat demo was complete while four screens were blank.
 *
 * Usage (backend must be running):
 *   node scripts/verify-demo-screens.mjs [branchCode] [apiUrl]
 *
 * A 403 on the two developer-mode screens is expected: they are gated behind the
 * step-up developer token, not behind data.
 */
const API = process.argv[3] ?? process.env.API_URL ?? 'http://localhost:3001';
const BRANCH_CODE = process.argv[2] ?? 'SMP-MCT';
const CREDS = [
  ['admin@company.com', 'Admin@123'],
  ['admin@company.com', 'Password123!'],
  ['aarav.sharma@sample.hrms.local', 'Password123!'],
  ['kabir.gupta@sample.hrms.local', 'Password123!'],
];

const ENDPOINTS = `
/dashboard/overview /dashboard/activities /dashboard/alerts /dashboard/attendance-summary
/dashboard/employee-stats /dashboard/payroll-summary /dashboard/turnover-stats /dashboard/contract-alerts
/employees /employees/directory /employees/hub-summary /employees/statistics /employees/stats/profile-completion
/employees/without-active-contract
/departments /departments/tree /branches /teams /organization/hub-summary
/contracts /contracts/expiring /contracts/statistics /contracts/termination-requests/pending /contracts/termination-requests/history
/attendances/list /attendances/today/all /attendances/statistics /attendances/hub-summary /attendances/overview
/attendance-corrections /attendance-corrections/pending
/calendar/hub-summary /holidays
/leave-requests /leave-requests/pending /leave-requests/hub-summary /leave-balances /leave-balances/company-overview
/leave-balances/leave-types /leave-encashment/policies /leave-encashment/carry-forward/runs
/overtime /overtime/pending /overtime-policies
/timesheets /timesheets/pending /work-logs/timer/status
/payrolls /payrolls/hub-summary /payroll-batches /payroll-calendars
/payrolls/reports/register?month=__M__&year=__Y__ /payrolls/reports/cost?month=__M__&year=__Y__ /payrolls/reports/variance?month=__M__&year=__Y__ /payrolls/reports/statutory-summary?month=__M__&year=__Y__
/payrolls/reports/gratuity-liability
/salary-components /grades /gratuity/rules /gratuity/liability /final-settlements /final-settlements/variants
/employee-recoveries/kinds /employee-transfers
/banks /banks/branch-countries /banking-config /bank-change-requests /bank-change-requests/migration/candidates
/travel-requests /travel-requests/on-trip
/budgets /garnishments
/assets /assets/summary /assets/assignments/open /assets/clearance/reports/outstanding
/training/courses /training/sessions /training/nominations
/appraisal/runs /projects /projects/stats /tasks /tasks/stats /task-dashboard/manager
/letters /letters/templates /grievances /rewards /disciplines
/legal-documents /legal-documents/expiring /legal-documents/summary
/document-vault/employee/__EMP__ /legal-documents/expiring?days=30
/approval-workflows /approval-workflows/inbox /approval-workflows/kinds
/supervisors/teams /profile-templates /profile-templates/active /library-items /system-settings
`.trim().split(/\s+/);

const size = (body) => {
  const d = body?.data ?? body;
  if (Array.isArray(d)) return d.length;
  if (d && typeof d === 'object') {
    for (const k of ['items', 'data', 'rows', 'results', 'employees', 'requests', 'records']) {
      if (Array.isArray(d[k])) return d[k].length;
    }
    const nums = Object.values(d).filter((v) => typeof v === 'number');
    if (nums.length && nums.every((n) => n === 0)) return 0;
    const arrays = Object.values(d).filter(Array.isArray);
    if (arrays.length && arrays.every((a) => a.length === 0) && !nums.some((n) => n > 0)) return 0;
    return Object.keys(d).length ? -3 : 0; // -3 = object with content
  }
  return d == null ? 0 : -3;
};

const main = async () => {
  let token = null, who = null;
  for (const [email, password] of CREDS) {
    const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (r.ok) { const j = await r.json(); token = j?.data?.accessToken ?? j?.accessToken ?? j?.data?.token ?? j?.token; who = email; if (token) break; }
  }
  if (!token) { console.error('LOGIN FAILED'); process.exit(1); }
  console.log('logged in as', who);

  const H = { authorization: `Bearer ${token}` };
  const brRes = await fetch(`${API}/branches`, { headers: H });
  const brBody = await brRes.json();
  const list = brBody?.data?.branches ?? brBody?.data ?? brBody;
  const muscat = (Array.isArray(list) ? list : []).find((b) => b.code === BRANCH_CODE);
  if (!muscat) { console.error(`${BRANCH_CODE} NOT VISIBLE`, JSON.stringify(brBody).slice(0, 300)); process.exit(1); }
  const BH = { ...H, 'x-branch-id': muscat.id };

  const empRes = await fetch(`${API}/employees?limit=50`, { headers: BH });
  const empBody = await empRes.json();
  const all = empBody?.data?.employees ?? empBody?.data ?? [];
  // A brand-new joiner legitimately has an empty vault; probe someone tenured.
  const anyEmp = all.find((e) => e.employeeCode === 'SMP-EMP-019') ?? all[0];
  const now = new Date();

  const empty = [], errors = [], ok = [];
  for (const raw of ENDPOINTS) {
    const path = raw
      .replace('__EMP__', anyEmp?.id ?? '')
      .replace('__M__', String(now.getUTCMonth() + 1))
      .replace('__Y__', String(now.getUTCFullYear()));
    let res, body;
    try { res = await fetch(`${API}${path}`, { headers: BH }); body = await res.json(); }
    catch (e) { errors.push(`${path} EXC ${e.message}`); continue; }
    if (!res.ok) { errors.push(`${path} ${res.status} ${String(body?.message ?? '').slice(0, 60)}`); continue; }
    const n = size(body);
    if (n === 0) empty.push(path);
    else ok.push(`${path}=${n === -3 ? 'obj' : n}`);
  }
  console.log(`\nEMPTY (${empty.length}):\n` + empty.join('\n'));
  console.log(`\nERRORS (${errors.length}):\n` + errors.join('\n'));
  console.log(`\nOK (${ok.length}): ` + ok.join('  '));
};
main();
